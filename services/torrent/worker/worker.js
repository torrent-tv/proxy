/**
 * @file The torrent thread: WebTorrent and nothing else.
 *
 * Everything that made the main thread unresponsive lives here now — peer
 * connections, buffer concatenation, piece bookkeeping, garbage collection from
 * all of it. The main thread keeps only what owes a viewer a prompt answer.
 *
 * This file deliberately holds no HTTP, no session logic and no knowledge of
 * HLS: it answers the commands in `protocol.js` and streams bytes back. That
 * boundary is what keeps the split honest — anything added here will compete
 * with the torrent for this thread, which is exactly the problem being solved.
 *
 * The existing `TorrentPool` is reused wholesale rather than reimplemented. It
 * already carries the parts that took field failures to get right — idle
 * removal, the global disk cap with LRU eviction, seek-aware piece
 * prioritisation, adaptive upload — and none of that changes by moving threads.
 */

// MUST stay first: it redirects `webrtc-polyfill` to a JavaScript WebRTC stack
// before WebTorrent can reach the native one. Two isolates using
// node-datachannel at once abort the process, and the torrent's wss trackers
// create peer connections of their own.
import { isUsableTorrentHandle } from "./handle-state.js";
import "./install-webrtc-shim.js";
import { parentPort, workerData } from "node:worker_threads";
import { createSendStream } from "./channel.js";
import { readFragments, supplyFiguresFor } from "./piece-reader.js";
import {
  warmResumePosition
} from "./resume-warm.js";
import { fillFileInBackground } from "./background-fill.js";
import { demandFor } from "../download/registry.js";
import { heldRangesOf, ownsItsMemory, readHeldBytes } from "./held-bytes.js";
import { CompletedFiles, completedFilesRoot } from "../../storage/files/CompletedFiles.js";
import { pieceFromWholeFiles, pieceIsInWholeFiles } from "../../storage/files/piece-from-whole-file.js";
import { Command, Event } from "./protocol.js";
import { filesInUse } from "./files-in-use.js";
import { createWholeSources } from "./whole-sources.js";
import { wholeFileStats } from "./whole-file-stats.js";
import { startMemoryReport, WORKER_MEMORY_SAMPLE_MS } from "../../storage/memory-report.js";
import { forwardLogsTo, logger } from "../../../utils/logger.js";

/**
 * Everything this thread logs goes to the main thread, which owns the file.
 *
 * Two threads cannot both write it — they would race on the rotation and could
 * interleave mid-line — so there is one writer and this is how everyone else
 * reaches it. Set before anything else runs, because a line written before this
 * point reaches the console only, and the console is destroyed by every
 * release.
 *
 * Until 2026-09-02 only the `log` function below took this route. Modules that
 * called `logger.*` directly — the piece reader, the torrent pool, the
 * background fill, the container track reader, the subtitle walk — wrote into a
 * copy of the logger that had no file, and every one of their lines was lost:
 * measured over a whole 49 938-line file, not one of them was in it.
 */
forwardLogsTo((level, message) => {
  // THE LEVEL TRAVELS TOO. It was dropped here, so every line this thread wrote
  // — a warning about a spill that failed, an error about a torrent that went
  // away — arrived on the other side as information and was coloured and
  // recorded as such.
  parentPort.postMessage({ type: Event.LOG, level, message });
});

// Imported dynamically, and that is load-bearing: static imports are RESOLVED
// during linking, before any module body runs, so a statically imported pool
// would drag in WebTorrent — and with it the real `webrtc-polyfill` — before
// the hook above had a chance to register. Verified the hard way: with a static
// import the process still aborted, and the stack named the genuine polyfill.
const { TorrentPool, resolveDhtBootstrap } = await import("../torrent-pool.js");
const { SharedPieceStore, collectStoreStats, findSharedStore, machineReserveBytes, memoryClaim, pieceBufferCollection, reviseSpillBudgets, reviseStoreBudgets } =
  await import("../../storage/piece-store/shared-piece-store.js");

// Resolved before the client exists, because the client builds its DHT in its
// own constructor and the addresses have to be in hand by then. Awaiting here
// costs the few milliseconds of a DNS answer, once, on a thread that has not
// been asked for anything yet.
const dhtBootstrap = await resolveDhtBootstrap();

const pool = new TorrentPool({
  memoryBytes: workerData?.memoryBytes,
  dhtBootstrap,
  pieceStore: SharedPieceStore
});

/** Torrents by sourceKey — the main thread names them, this thread owns them. */
const torrentsByKey = new Map();

/**
 * How each source was named when it was added, so a torrent that has since been
 * destroyed can be added again. Kept separately from {@link torrentsByKey}
 * because that map holds the promise, not the recipe.
 *
 * @type {Map<string, { sourceType: string, source: string }>}
 */
const sourceRecipes = new Map();
/** In-flight reads, so a cancel can stop one mid-body. */
const readsById = new Map();
/**
 * What each in-flight read is reading. A read whose pieces are all here waits
 * for nothing and so states nothing in the demand register; this is how the
 * thread knows it is still open.
 *
 * @type {Map<number, { torrent: object, fileIndex: number }>}
 */
const openReads = new Map();

/**
 * Shorthand for this file. The same path as `logger.info` anywhere else in the
 * thread — kept only because it reads better at the hundred call sites here.
 *
 * @param {string} message
 * @returns {void}
 */
function log(message) {
  logger.info(message);
}

/**
 * The torrent for a sourceKey, waiting for it if it is still being added.
 *
 * The map holds a PROMISE, registered the moment the add begins rather than
 * when it finishes. That distinction is the whole fix: adding a magnet takes as
 * long as its metadata does — seconds to tens of seconds — and until 2.9.77
 * everything naming that source in the meantime was told `Unknown source`,
 * which is false. The source exists; it is not ready. Reproduced with a magnet
 * nobody seeds: stats, the file listing and a read all failed instantly while
 * the add was still in flight, which on the loading screen shows up as no
 * peers, no progress, and a plan request that fails before the torrent has had
 * a chance to start.
 *
 * A source that was never added still throws, which is the honest answer.
 *
 * @param {string} sourceKey
 * @returns {Promise<import("webtorrent").Torrent>}
 */
/**
 * The torrent for a sourceKey IF there is one, and never one that has to be
 * built to answer.
 *
 * The other half of the pair above, for the questions that are about something
 * going away: a departure is not a reason to add anything, and the answer
 * "there is nothing here" is a complete answer to them.
 *
 * @param {string} sourceKey
 * @returns {Promise<import("webtorrent").Torrent | null>}
 */
async function knownTorrent(sourceKey) {
  const pending = torrentsByKey.get(sourceKey);
  if (!pending) {
    return null;
  }
  const torrent = await pending.catch(() => null);
  return isUsableTorrentHandle(torrent) ? torrent : null;
}

/**
 * The torrent for one file, but never one rebuilt for a file held whole.
 *
 * For the questions that steer or measure a download: a file held whole has no
 * download, and rebuilding its torrent to be told so is what made the torrent
 * come back after every removal (see `whole-sources.js`). The torrent is still
 * used while it exists.
 *
 * @param {string} sourceKey
 * @param {number} fileIndex
 * @returns {Promise<import("webtorrent").Torrent | null>}
 */
async function torrentUnlessWhole(sourceKey, fileIndex) {
  return wholeSources.fileOf(sourceKey, fileIndex) ? knownTorrent(sourceKey) : requireTorrent(sourceKey);
}

async function requireTorrent(sourceKey) {
  const pending = torrentsByKey.get(sourceKey);
  if (!pending) {
    throw new Error(`Unknown source ${sourceKey}.`);
  }
  const torrent = await pending;
  if (isUsableTorrentHandle(torrent)) {
    return torrent;
  }
  // The pool destroys a torrent that has gone unread for a quarter of an hour,
  // and under disk pressure. It clears its OWN map when it does; this one it
  // knows nothing about, so the promise here went on resolving to a corpse: a
  // destroyed torrent keeps its object but loses its files. Every later session
  // for that source then failed the same way — the plan and the codec probe
  // answered from cache in milliseconds, nothing waited for metadata because
  // everything believed the torrent was known, and ffmpeg's first read died on
  // `File N not found` 130 ms in, after which the session answered 500 for
  // ever. Measured 2026-08-06 on two sessions in a row, both from a phone,
  // which is what made it look like a mobile problem.
  const recipe = sourceRecipes.get(sourceKey);
  if (!recipe) {
    torrentsByKey.delete(sourceKey);
    throw new Error(`Source ${sourceKey} is gone and cannot be re-added.`);
  }
  const revived = pool.getTorrent(recipe.sourceType, recipe.source);
  torrentsByKey.set(sourceKey, revived);
  revived.catch(() => {
    if (torrentsByKey.get(sourceKey) === revived) {
      torrentsByKey.delete(sourceKey);
    }
  });
  return revived;
}


/**
 * Fragments waiting for the main thread to say it has finished reading them,
 * keyed by request id. One per read, because only one fragment is in flight.
 *
 * @type {Map<number, () => void>}
 */
const fragmentWaiters = new Map();

/**
 * Wake a read that is waiting for a fragment to be confirmed.
 *
 * Used both by the confirmation itself and by cancellation — a cancelled read
 * will never be confirmed, and without this it would wait forever holding a pin.
 *
 * @param {number} id
 * @returns {void}
 */
function settleFragment(id) {
  const done = fragmentWaiters.get(id);
  if (done) {
    fragmentWaiters.delete(id);
    done();
  }
}

/**
 * Send one fragment's position and wait until the main thread is done with it.
 *
 * The pin is dropped only after the confirmation, because until then the other
 * thread may still be reading those exact bytes.
 *
 * @param {number} id
 * @param {import("./piece-reader.js").PieceFragment} fragment
 * @returns {Promise<void>}
 */
function sendFragment(id, fragment) {
  return new Promise((resolve) => {
    fragmentWaiters.set(id, () => {
      fragment.release();
      resolve();
    });
    parentPort.postMessage({
      type: Event.FRAGMENT,
      id,
      pieceIndex: fragment.pieceIndex,
      buffer: fragment.buffer,
      offset: fragment.offset,
      length: fragment.length
    });
  });
}

/**
 * Stream a byte range back as CHUNK messages.
 *
 * Reads through WebTorrent's own read stream — which serves already-downloaded
 * pieces from disk and waits for the rest — and forwards it in
 * {@link STREAM_CHUNK_BYTES} pieces, transferring ownership of each so nothing
 * is copied across the boundary. `createSendStream` applies the backpressure,
 * so a fast disk cannot outrun the main thread and rebuild the queue in memory.
 *
 * @param {object} params
 * @param {number} params.id - Request id; CHUNK/READ_END carry it.
 * @param {string} params.sourceKey
 * @param {number} params.fileIndex
 * @param {number | null} params.start - Inclusive, or null for the whole file.
 * @param {number | null} params.end - Inclusive.
 * @returns {Promise<void>}
 */
async function streamRange({ id, sourceKey, fileIndex, start, end, windowBytes }) {
  const torrent = await requireTorrent(sourceKey);
  const file = torrent.files?.[fileIndex];
  if (!file) {
    throw new Error(`File ${fileIndex} not found in ${sourceKey}.`);
  }

  const sender = createSendStream({ port: parentPort, requestId: id });
  readsById.set(id, sender);
  openReads.set(id, { torrent, fileIndex });

  const rangeStart = start ?? 0;
  const rangeEnd = end ?? file.length - 1;

  let failed = false;
  try {
    // Positions in shared memory, not bytes: the main thread maps the same pool
    // and reads each fragment in place, so nothing is copied and nothing is
    // transferred. See `piece-reader.js`.
    for await (const fragment of readFragments({
      torrent,
      fileIndex,
      start: rangeStart,
      end: rangeEnd,
      cancellation: sender,
      windowBytes
    })) {
      if (sender.isCancelled()) {
        fragment.release();
        break;
      }
      // One fragment in flight at a time. Each one holds a piece pinned, and
      // the store guarantees only two resident pieces at its smallest budget —
      // holding two pins while asking for a third would deadlock it against
      // itself. The round trip costs ~100 µs against a piece worth megabytes,
      // so there is nothing to win by overlapping them.
      await sendFragment(id, fragment);
    }
  } catch (error) {
    // The end-of-read marker means "the body is complete". Sending it after a
    // failure told the reader the file simply ended — a truncated segment that
    // ffmpeg reported as `Stream ends prematurely`, with the real cause thrown
    // away. Let the error propagate instead; the command handler reports it and
    // the main thread fails the stream.
    failed = true;
    throw error;
  } finally {
    readsById.delete(id);
    openReads.delete(id);
    // Any fragment still awaiting confirmation will never get one now; settling
    // it here releases its pin rather than leaking a held slot.
    settleFragment(id);
    if (!failed) {
      sender.end();
    }
    // Nothing else to tear down: the reader owns no stream of its own, and a
    // cancelled read stops at its next fragment boundary because it polls the
    // same `sender` for cancellation.
  }
}

/**
 * Run one command and return its result.
 *
 * @param {string} command
 * @param {object} params
 * @param {number} id
 * @returns {Promise<unknown>}
 */
async function runCommand(command, params, id) {
  switch (command) {
    case Command.ADD_SOURCE: {
      // Registered before it resolves, so anything naming this source while it
      // is being added waits for it instead of being told it does not exist.
      // Reusing the same promise for a repeated add also collapses two callers
      // racing to open the same torrent into one.
      sourceRecipes.set(params.sourceKey, {
        sourceType: params.sourceType,
        source: params.source
      });
      let pending = torrentsByKey.get(params.sourceKey);
      if (!pending) {
        pending = pool.getTorrent(params.sourceType, params.source);
        torrentsByKey.set(params.sourceKey, pending);
        // A failed add must not be remembered, or every later attempt at this
        // source replays the same failure. The handler also marks the rejection
        // as observed, so it cannot surface as an unhandled one.
        pending.catch(() => {
          if (torrentsByKey.get(params.sourceKey) === pending) {
            torrentsByKey.delete(params.sourceKey);
          }
        });
      }
      // A torrent removed because it was downloaded whole is answered for by
      // what was written down when it went: a destroyed torrent keeps its object
      // and empties its `files`, so it would hand a viewer opening the film an
      // empty list, and rebuilding it here would bring it back on every stream
      // and stats request, which all come through this command. Any other
      // destroyed torrent is rebuilt, because its files still need it.
      const added = await pending;
      const described = isUsableTorrentHandle(added) ? null : wholeSources.describe(params.sourceKey);
      if (described) {
        return described;
      }
      const torrent = isUsableTorrentHandle(added) ? added : await requireTorrent(params.sourceKey);
      return {
        infoHash: torrent.infoHash,
        name: torrent.name,
        // The unit the swarm delivers and the store keeps. Said to the main
        // thread as a number so a reading there can size its portions to it
        // without knowing what a piece is.
        pieceLength: Number(torrent.pieceLength) || 0,
        // Files cross as plain data; the objects stay here.
        files: (torrent.files ?? []).map((file, index) => ({
          index,
          name: file.name,
          path: file.path,
          length: file.length
        }))
      };
    }

    case Command.LIST_FILES: {
      const described = (await knownTorrent(params.sourceKey)) ? null : wholeSources.describe(params.sourceKey);
      if (described) {
        return described.files;
      }
      const torrent = await requireTorrent(params.sourceKey);
      return (torrent.files ?? []).map((file, index) => ({
        index,
        name: file.name,
        path: file.path,
        length: file.length
      }));
    }

    case Command.HELD_TORRENTS: {
      // Which films this proxy has right now, and how much of each. Answered
      // from the live client rather than from the main thread's map of
      // stand-ins, which is only cleared on shutdown and would name films this
      // proxy let go of hours ago.
      const held = [];
      for (const torrent of pool.client?.torrents ?? []) {
        const infoHash = String(torrent?.infoHash ?? "");
        if (!infoHash) {
          continue;
        }
        held.push({
          infoHash,
          // A viewer sent here for a film nobody has downloaded any of gains
          // nothing, so the share is reported and the decision is made where
          // the viewer is.
          progress: Number.isFinite(torrent?.progress) ? torrent.progress : 0,
          bytes: Number.isFinite(torrent?.downloaded) ? torrent.downloaded : 0
        });
      }
      return { held };
    }

    case Command.TORRENT_TOTALS: {
      // Downloaded and uploaded are counted apart: hashing every downloaded
      // byte is work of a different order from sending one back to the swarm,
      // and adding them would price both at whatever the mixture happened to
      // be.
      let downloaded = 0;
      let uploaded = 0;
      for (const torrent of pool.client?.torrents ?? []) {
        const gotBytes = Number(torrent?.downloaded);
        const sentBytes = Number(torrent?.uploaded);
        downloaded += Number.isFinite(gotBytes) ? gotBytes : 0;
        uploaded += Number.isFinite(sentBytes) ? sentBytes : 0;
      }
      return { downloaded, uploaded };
    }


    case Command.FILL_FILE: {
      const torrent = await torrentUnlessWhole(params.sourceKey, params.fileIndex);
      return {
        started: torrent ? fillFileInBackground(torrent, params.fileIndex, params.sourceKey) : false
      };
    }

    case Command.FILL_TORRENT: {
      const torrent = wholeSources.isWhole(params.sourceKey)
        ? await knownTorrent(params.sourceKey)
        : await requireTorrent(params.sourceKey);
      return { started: torrent ? pool.fillTorrentAsCapacityAllows(torrent) : false };
    }

    case Command.WARM_POSITION: {
      const torrent = await torrentUnlessWhole(params.sourceKey, params.fileIndex);
      if (!torrent) {
        return { started: false };
      }
      return {
        started: await warmResumePosition(
          torrent,
          params.fileIndex,
          params.sourceKey,
          params.positionSeconds,
          {
            // Told by the main thread, which is where what a file states about
            // itself is read.
            durationSeconds: params.durationSeconds,
            fetchRegion: (start, bytes) =>
              pool.prefetchFileRegion(torrent, params.fileIndex, start, bytes)
          }
        )
      };
    }


    case Command.FILE_STATS: {
      const torrent = await torrentUnlessWhole(params.sourceKey, params.fileIndex);
      if (!torrent) {
        return wholeFileStats(wholeSources.fileOf(params.sourceKey, params.fileIndex)?.length ?? 0);
      }
      const stats = pool.getFileStats(torrent, params.fileIndex, {
        resumeAnchorByteStart: params.resumeAnchorByteStart ?? null
      });
      // What this file's own interruptions demand, measured by the reader in
      // this thread. It travels with the stats because the caller asking for
      // them is the one that has to decide with them — the browser's smallest
      // safe buffer, and the speed a quality step must sustain. Null until a
      // second interruption has been seen: one wait shows no interval, and an
      // interval invented from one point is exactly what this work removes.
      const file = Array.isArray(torrent?.files) ? torrent.files[params.fileIndex] : null;
      return {
        ...stats,
        supply: supplyFiguresFor(torrent?.infoHash, file?.name, params.segmentSeconds ?? 4)
      };
    }

    case Command.PRIORITY_MAP: {
      // A MAP WITH NOTHING IN IT MUST NOT BRING A TORRENT BACK. It is what is
      // said when the last viewer of a file leaves, which is also when the
      // torrent may be on its way out — and `requireTorrent` rebuilds a dead
      // handle from its recipe, so asking that way would re-add a torrent in
      // order to be told that nothing is wanted of it.
      const zones = Array.isArray(params.zones) ? params.zones : [];
      // Nor may one for a file held whole, which has nothing left to fetch.
      const torrent = zones.length === 0
        ? await knownTorrent(params.sourceKey)
        : await torrentUnlessWhole(params.sourceKey, params.fileIndex);
      if (torrent) {
        pool.applyPriorityMap(torrent, params.fileIndex, zones, params.durationSeconds);
      }
      return true;
    }

    case Command.PRIORITIZE: {
      const torrent = await torrentUnlessWhole(params.sourceKey, params.fileIndex);
      if (torrent) {
        pool.prioritizeByteRange(torrent, params.fileIndex, params.byteStart, params.windowBytes, {
          wholeFileRead: params.wholeFileRead === true
        });
      }
      return true;
    }

    case Command.PREFETCH_EDGES: {
      const torrent = await torrentUnlessWhole(params.sourceKey, params.fileIndex);
      return torrent ? pool.prefetchFileEdges(torrent, params.fileIndex, params.options ?? {}) : undefined;
    }

    case Command.READ_RANGE: {
      // Streams its own reply; the caller's promise resolves once the body has
      // been fully sent, which is what lets the client await completion.
      await streamRange({
        id,
        sourceKey: params.sourceKey,
        fileIndex: params.fileIndex,
        start: params.start ?? null,
        end: params.end ?? null,
        windowBytes: params.windowBytes
      });
      return true;
    }

    case Command.CANCEL_READ: {
      readsById.get(params.readId)?.cancel();
      // A cancelled read will never have its outstanding fragment confirmed, so
      // wake it here — otherwise it waits forever with a piece pinned.
      settleFragment(params.readId);
      return true;
    }

    case Command.HELD_RANGES: {
      const torrent = await torrentUnlessWhole(params.sourceKey, params.fileIndex);
      if (!torrent) {
        const length = wholeSources.fileOf(params.sourceKey, params.fileIndex)?.length ?? 0;
        return { ranges: length > 0 ? [[0, length - 1]] : [] };
      }
      return { ranges: heldRangesOf(torrent, params.fileIndex) };
    }

    case Command.READ_HELD: {
      const torrent = await requireTorrent(params.sourceKey);
      const bytes = await readHeldBytes(torrent, params.fileIndex, params.start, params.end, logger);
      return { bytes };
    }

    case Command.SPILL_ALLOWANCE: {
      // The disk has one owner and it is on the main thread, where the segments
      // are. What arrives is this thread’s whole share; the stores divide it
      // between themselves.
      return reviseSpillBudgets(Number(params.bytes));
    }

    case Command.MEMORY_ALLOWANCE: {
      // Memory has one owner, on the main thread, and it is the same owner the
      // disk has — the two resources trade, so they cannot be divided apart.
      reviseStoreBudgets(Number(params.bytes));
      return memoryClaim();
    }

    case Command.WHOLE_FILES_ALLOWANCE: {
      // Whole files are held on this thread and the disk has one owner, on the
      // other. What arrives is their share; what goes back is what they hold
      // after it, which is what the owner divides by next time.
      const after = await completedFiles.allow(Number(params.bytes));
      return after.bytes;
    }

    case Command.DESTROY_ALL: {
      torrentsByKey.clear();
      sourceRecipes.clear();
      await pool.destroyAll();
      return true;
    }

    default:
      throw new Error(`Unknown torrent-worker command: ${command}`);
  }
}

parentPort.on("message", async (message) => {
  // Chunk acknowledgements are not commands — they release backpressure on an
  // in-flight read.
  if (message?.type === Event.CHUNK_ACK) {
    readsById.get(message.id)?.ack();
    return;
  }

  // The main thread has finished reading a fragment out of shared memory, so
  // its piece may be unpinned and the read may continue.
  if (message?.type === Event.FRAGMENT_DONE) {
    settleFragment(message.id);
    return;
  }

  const { command, id, params } = message ?? {};
  try {
    const result = await runCommand(command, params ?? {}, id);
    // A held read's bytes are handed over rather than copied, and only when
    // the buffer is the whole of its own memory (`ownsItsMemory`): anything
    // else would take memory the store or another read still uses with it.
    const transfer = command === Command.READ_HELD && ownsItsMemory(result?.bytes) ? [result.bytes.buffer] : [];
    parentPort.postMessage({ type: Event.RESULT, id, result }, transfer);
  } catch (error) {
    parentPort.postMessage({ type: Event.ERROR, id, error: error?.message ?? String(error) });
  }
});

/**
 * How often the piece store reports what it has been doing.
 *
 * The store decides whether a read costs nothing or costs a disk trip, and
 * until 2.9.75 nothing about it reached the log — a field oddity would have had
 * no evidence to work from. Reported only when something changed, so an idle
 * proxy stays quiet.
 */
// The torrent worker's OWN isolate, reported from inside it. The piece pool is
// a `SharedArrayBuffer` allocated here, so the main thread's counters cannot
// see it however carefully they are read — which is half the reason 650 MB of a
// 893 MB process had no explanation on 2026-08-28 (roadmap item 2).
// A second between readings, a minute between lines unless the heap moved by
// 25 MB, and a heap snapshot of THIS isolate on every new high-water above
// 400 MB. Three deaths — 2026-08-30 14:00 and 23:19, and
// 2026-08-31 13:27 — went from a 30 MB heap to the 2240 MB ceiling inside one
// sixty-second gap, and the only snapshots ever written were of the main
// isolate, whose heap is 26 MB. So the isolate that dies has never once been
// looked at (roadmap item 2, `research/worker-heap-oom-2026-08-31.md`).
startMemoryReport({
  log,
  readStores: collectStoreStats,
  // Beside the isolate's own figures, and on the SAME line, because the
  // question they answer together is whether the off-heap mass is buffers this
  // thread still refers to or buffers the collector has not reached yet. On
  // separate timers the two were up to a minute apart and could not be
  // compared at all (roadmap item 2).
  readExtra: describePieceBuffers,
  scope: "thread",
  label: "torrent worker",
  intervalMs: WORKER_MEMORY_SAMPLE_MS,
  quietMs: 60_000,
  changeBytes: 25 * 1024 * 1024,
  snapshotDir: workerData?.stateDir || undefined,
  snapshotFloorBytes: 400 * 1024 * 1024,
  snapshotGrowthBytes: 400 * 1024 * 1024,
  keepSnapshots: 3
});

const STORE_REPORT_INTERVAL_MS = 60_000;

/** Last reported reserve, so an unchanged one stays silent. */
let lastClaimsWithdrawn = 0;
let lastReserveBytes = 0;

/** Last reported figures per store, so unchanged ones stay silent. */
const lastReported = new Map();

setInterval(() => {
  // What the machine can spare NOW, not what it could spare when each store was
  // created. With per-piece buffers a lowered ceiling is honoured immediately:
  // excess pieces are evicted to disk and their memory is reclaimable.
  // What the machine has been seen to need for everything that is not us. It
  // starts at nothing and grows only on evidence, so it is worth saying when it
  // moves — it is the one term of the budget that comes from observation of
  // other processes rather than from our own readers.
  const reserveBefore = machineReserveBytes();
  for (const revised of reviseStoreBudgets()) {
    if (revised.evicted > 0) {
      log(
        `piece-store "${revised.name.slice(0, 40)}": allowance is now ` +
        `${Math.round(revised.ceilingBytes / 1048576)}MB, evicted ${revised.evicted} piece(s) to meet it` +
        (revised.releasedBlocks > 0 ? `, gave back ${revised.releasedBlocks} block(s) of memory` : "") +
        ` — now ${Math.round(revised.committedBytes / 1048576)}MB committed`
      );
    } else if (revised.belowActiveDemand) {
      log(
        `piece-store "${revised.name.slice(0, 40)}": the machine's share is smaller than active read demand, ` +
        `so the allowance is held at ${Math.round(revised.ceilingBytes / 1048576)}MB ` +
        "— a store cannot finish a read if it cannot hold the pieces that read is using"
      );
    } else if (revised.committedBytes > revised.ceilingBytes) {
      log(
        `piece-store "${revised.name.slice(0, 40)}": allowance is now ` +
        `${Math.round(revised.ceilingBytes / 1048576)}MB and ` +
        `${Math.round(revised.committedBytes / 1048576)}MB is committed — ` +
        `all resident pieces are pinned, cannot shrink yet`
      );
    }
  }
  // WHAT THE ANNOUNCEMENTS ACTUALLY DID. The stores count every piece they
  // stopped being able to produce; this counts the ones where the library did
  // still hold a claim and it was taken back. The GAP between the two is the
  // reading: announcements far above withdrawals mean the stores are mostly
  // dropping pieces that were never completed, and a withdrawal count stuck at
  // zero while announcements climb means the mechanism is not reaching the
  // torrent at all.
  if (pool.claimsWithdrawn !== lastClaimsWithdrawn) {
    lastClaimsWithdrawn = pool.claimsWithdrawn;
    log(
      `torrent-pool: ${pool.claimsWithdrawn} piece claim(s) withdrawn — pieces this proxy ` +
      "had dropped and has now told the swarm it needs again"
    );
  }
  const reserveNow = machineReserveBytes();
  if (reserveNow !== reserveBefore || reserveNow !== lastReserveBytes) {
    lastReserveBytes = reserveNow;
    log(
      `piece-store: leaving ${Math.round(reserveNow / 1048576)}MB for everything else on this ` +
      "machine — the largest fall in available memory this process has seen and did not cause"
    );
  }
  for (const stats of collectStoreStats()) {
    const signature =
      `${stats.fromMemory}/${stats.fromDisk}/${stats.spills}/${stats.revivals}/` +
      `${stats.blockedByPins}/${stats.evictedOnRevise}/${stats.spillFailures}/` +
      `${stats.evictedProtected}/${stats.demand?.unionPieces ?? 0}/${stats.admittedToDisk}/` +
      `${stats.blocksAllocated}/${stats.blocksFree}/${stats.blocksReleased}/${stats.withdrawn}`;
    if (lastReported.get(stats.name) === signature) {
      continue;
    }
    lastReported.set(stats.name, signature);

    const reads = stats.fromMemory + stats.fromDisk;
    const fromMemoryShare = reads > 0 ? ((stats.fromMemory / reads) * 100).toFixed(1) : "—";
    log(
      `piece-store "${stats.name.slice(0, 40)}": resident=${stats.resident}/${stats.capacity} ` +
      `(${Math.round((stats.residentBytes || 0) / 1048576)}MB of ` +
      `${Math.round((stats.budgetBytes || 0) / 1048576)}MB allowed) ` +
      `committed=${Math.round((stats.committedBytes || 0) / 1048576)}MB ` +
      `blocks=${stats.blocksAllocated} (${stats.blocksFree} spare) ` +
      `on-disk=${Math.round((stats.spilledBytes || 0) / 1048576)}MB ` +
      `pinned=${stats.pinned} spilled=${stats.spilled} reads=${reads} (${fromMemoryShare}% from memory) ` +
      `spills=${stats.spills} revivals=${stats.revivals}` +
      (stats.blockedByPins > 0 ? ` no-block-for=${stats.blockedByPins}` : "") +
      (stats.admittedWithoutSlot > 0 ? ` to-disk-for-want-of-memory=${stats.admittedWithoutSlot}` : "") +
      (stats.stillMs > 1000 ? ` nothing-moved-for=${Math.round(stats.stillMs / 1000)}s` : "") +
      (stats.evictedOnRevise > 0 ? ` evictedOnRevise=${stats.evictedOnRevise}` : "") +
      // How many pieces this store stopped being able to produce and said so,
      // which is what makes the eviction's own bargain checkable: every one of
      // these is a piece the torrent has been told to fetch again if it is ever
      // wanted. A session where this climbs while reads keep succeeding is the
      // bargain working; before 2026-09-12 the figure did not exist and the
      // claim was never withdrawn at all.
      (stats.withdrawn > 0 ? ` withdrawn=${stats.withdrawn}` : "") +
      (stats.spillFailures > 0 ? ` spill-failures=${stats.spillFailures}` : "") +
      (stats.outstanding > 0 ? ` outstanding=${stats.outstanding}` : "")
    );
    // Why it spills, on its own line because it is a different question from
    // how much it holds. Three facts, and between them they say whether the
    // thrashing is a policy to fix or arithmetic to accept: what the readers
    // together are asking to keep against what the store may hold; how many
    // evictions had to take a piece a reader had declared it wants; and how
    // long a piece stayed on disk before it was wanted back. On 2026-09-02 a
    // session did 6565 spills and 7575 revivals with 53.6% of reads served
    // from memory, and nothing recorded which of the three was the cause
    // (roadmap item 9).
    const demand = stats.demand;
    if (demand && demand.readers > 0) {
      const age = stats.revivalAgeMedianMs;
      log(
        `piece-store "${stats.name.slice(0, 40)}" demand: ${demand.readers} reader(s) want ` +
        `${demand.unionPieces} piece(s) of ${demand.capacity} the store may hold ` +
        `(widest window ${demand.widestPieces})` +
        // NAMED, because the count read as five encoders on a session that had
        // two: a "reader" is whoever declared a range, and four of the five
        // were zones of the priority map. Choosing between narrowing the
        // windows and raising the allowance was guesswork without this.
        ` [${demand.names.join(" ")}]` +
        (stats.evictedProtected > 0
          ? `; ${stats.evictedProtected} of ${stats.spills} eviction(s) took a piece a reader had declared`
          : "; no eviction has taken a declared piece") +
        (stats.evictedWithDistance > 0
          ? `, a victim lay ${(stats.evictedDistanceSum / stats.evictedWithDistance).toFixed(1)} ` +
            "piece(s) from the nearest window on average"
          : "") +
        (age === null
          ? "; nothing has come back from disk yet"
          : `; a revived piece had been on disk ${(age / 1000).toFixed(1)}s (median of ` +
            `${stats.revivalAgeSamples}, ${stats.revivedWithinFiveSeconds} of them within 5s)`) +
        `; of ${stats.admittedInsideWindow + stats.admittedOutsideWindow} piece(s) admitted ` +
        `${stats.admittedOutsideWindow} were in nobody's window, ${stats.admittedToDisk} of those ` +
        "went straight to disk" +
        `; ${stats.blocksAllocated} block(s) of memory exist, ${stats.blocksFree} of them spare` +
        (stats.reuseGapMs === null
          ? ", none re-used yet"
          : `, a block waits up to ${(stats.reuseGapMs / 1000).toFixed(1)}s before it is wanted again`) +
        `, ${stats.blocksReleased} given back` +
        (stats.spillsSkipped > 0
          ? `; ${stats.spillsSkipped} of ${stats.spills} eviction(s) needed no write, the disk already had them`
          : "") +
        (stats.returnedWhilePinned > 0
          ? `; ${stats.returnedWhilePinned} BLOCK(S) WERE RECYCLED WHILE STILL BEING READ`
          : "")
      );
    }
  }
}, STORE_REPORT_INTERVAL_MS).unref();

/**
 * The blocks of piece memory this thread has allocated against the pieces the
 * stores hold in them.
 *
 * Not per store: the collector is per thread, and the question is about the
 * thread. With a pool one block serves many pieces, so a number of allocations
 * that keeps climbing while the stores hold a steady number of pieces means
 * blocks are being made and thrown away instead of re-used.
 *
 * @returns {string}
 */
function describePieceBuffers() {
  const collection = pieceBufferCollection();
  if (collection.released === 0) {
    return "";
  }
  const alive = collection.released - collection.collected;
  const held = collectStoreStats().reduce((sum, stats) => sum + (stats.resident || 0), 0);
  return (
    `memory blocks ${collection.released} allocated, ${collection.collected} collected, ` +
    `${alive} still alive against ${held} piece(s) the stores hold`
  );
}

/**
 * Say that pieces of the actively-read files of one torrent have arrived.
 *
 * It used to WALK them — reading each file's new subtitle clusters and pushing
 * the cues it found. That put the cue reading, and with it a container parse,
 * in the thread that owns the swarm; the walk is on the main thread now and
 * this announces the one fact only this thread can know.
 *
 * Which files: the ones anything is stated for — a viewer's own picture and
 * soundtrack through the priority map, and the ends of a file that is open. It
 * replaced a count of readers, which said the same thing by keeping a second
 * copy of it.
 *
 * @param {string} sourceKey
 * @param {object} torrent
 * @returns {void}
 */
function announceArrivals(sourceKey, torrent) {
  const fileIndexes = [...demandFor(torrent).register.files()];
  if (fileIndexes.length === 0) {
    return;
  }
  parentPort.postMessage({ type: Event.PIECES_ARRIVED, sourceKey, fileIndexes });
}


/**
 * Torrents already wired to warm their subtitle cues the moment a piece
 * verifies, so the same torrent is not listened to twice.
 *
 * @type {WeakSet<object>}
 */
const arrivalsWired = new WeakSet();

/**
 * A piece becoming readable is the actual event a cue can be pulled from —
 * "downloaded", not "about to be encoded or copied": what a viewer reaches is
 * decided by the read window ahead of the playhead, not by which of the two
 * paths a segment takes, and the piece exists (and is worth reading for
 * subtitles) whichever one that is. `verified` is WebTorrent's own signal for
 * exactly that instant, set at the same place the bitfield itself is (`
 * _markVerified`), so nothing here is guessing at readiness a different way.
 *
 * @param {string} sourceKey
 * @param {object} torrent
 * @returns {void}
 */
function ensureArrivalsWired(sourceKey, torrent) {
  if (arrivalsWired.has(torrent)) {
    return;
  }
  arrivalsWired.add(torrent);
  torrent.on("verified", () => announceArrivals(sourceKey, torrent));
}

/**
 * How often arrivals are announced regardless, as a fallback beside the
 * per-piece `verified` listener above — it catches a listener attached after
 * pieces had already verified, and anything the event path might otherwise
 * miss. Cheap: the walk it wakes skips clusters it has already read.
 */
const ARRIVAL_ANNOUNCE_INTERVAL_MS = 3_000;

setInterval(() => {
  for (const [sourceKey, torrent] of pool.torrents) {
    ensureArrivalsWired(sourceKey, torrent);
    announceArrivals(sourceKey, torrent);
  }
}, ARRIVAL_ANNOUNCE_INTERVAL_MS).unref();

/**
 * Files this proxy has downloaded whole. One directory, two readers of it: this
 * thread writes them, the main thread serves them without asking anybody.
 */
const completedFiles = new CompletedFiles({ root: completedFilesRoot() });
const wholeSources = createWholeSources({ find: (infoHash, fileIndex) => completedFiles.find(infoHash, fileIndex) });

/**
 * Which torrent a set of files belongs to.
 *
 * The piece store hands its own files back without knowing what they are; this
 * thread does know, and a file carries its torrent.
 *
 * @param {object[]} files
 * @returns {string}
 */
const infoHashOf = (files) => String(files?.[0]?._torrent?.infoHash ?? "").toLowerCase();

// WHERE A PIECE COMES FROM WHEN NEITHER TIER HAS IT. Handed to every store this
// pool builds, so a film already assembled into a file is read from that file:
// which is what lets its spilled copy be dropped as the duplicate it has become,
// and what lets a torrent be destroyed and added again without fetching a byte.
pool.buildStoresWith({
  readPieceElsewhere: ({ index, pieceLength, length, files }) =>
    pieceFromWholeFiles({
      index,
      pieceLength,
      length,
      files,
      wholeFileAt: (fileIndex) => completedFiles.find(infoHashOf(files), fileIndex)
    }),
  isPieceElsewhere: ({ index, pieceLength, length, files }) =>
    pieceIsInWholeFiles({
      index,
      pieceLength,
      length,
      files,
      wholeFileAt: (fileIndex) => completedFiles.find(infoHashOf(files), fileIndex)
    })
});
void completedFiles.adopt(() => null).then((adopted) => {
  if (adopted > 0) {
    logger.info(
      `whole files: took up ${adopted} file(s) a previous life left in ${completedFiles.root}`
    );
  }
});

/**
 * How often whole files are looked for.
 *
 * The work itself is one pass over the files of each torrent asking a boolean
 * the library already keeps; writing one out happens at most once per file,
 * ever.
 */
const WHOLE_FILE_SWEEP_MS = 10_000;

/** Files being written out right now, so a sweep does not start a second one. */
const beingKept = new Set();

/**
 * Keep every file that is now whole, and let go of a torrent that has nothing
 * left to fetch.
 *
 * The instruction this serves, 2026-09-11: as soon as a torrent is fully
 * downloaded, downloading stops, the torrent is deleted, and what was
 * downloaded stays for as long as it is wanted.
 *
 * `file.done` is the library's own answer to "is every piece of this file
 * here", and `torrent.done` to "is that true of every file". The second is a
 * strong condition and will not fire for a season pack of which one episode is
 * watched — nothing fetches the other four — and that is right: the instruction
 * is about a torrent downloaded WHOLE.
 *
 * @returns {Promise<void>}
 */
async function keepWholeFiles() {
  for (const [sourceKey, torrent] of [...pool.torrents]) {
    // Lower case, because that is what the source key carries and the main
    // thread looks these up by the key alone.
    const infoHash = String(torrent?.infoHash ?? "").toLowerCase();
    if (!infoHash || !Array.isArray(torrent.files)) {
      continue;
    }
    // What anybody wants of this torrent or is reading from it now.
    const wanted = filesInUse({
      torrent,
      windows: demandFor(torrent).register.windows(),
      openReads: openReads.values()
    });
    for (const [fileIndex, file] of torrent.files.entries()) {
      const key = `${infoHash}/${fileIndex}`;
      if (file?.done !== true || completedFiles.find(infoHash, fileIndex) || beingKept.has(key)) {
        continue;
      }
      // NOT WHILE ANYBODY WANTS IT. Writing a film out is a read of the whole
      // of it and a write of the whole of it — a gigabyte and a half on the
      // file this was measured against — and doing that beside a viewer takes
      // the disk and the piece store from them for nothing they asked for. The
      // file is complete; it will still be complete when they leave.
      if (wanted.has(fileIndex)) {
        continue;
      }
      beingKept.add(key);
      try {
        const kept = await completedFiles.keep({
          infoHash,
          fileIndex,
          length: file.length,
          name: file.name,
          open: () => file.createReadStream()
        });
        if (kept) {
          logger.info(
            `whole files: kept "${file.name}" (${Math.round(kept.length / 1048576)}MB) — ` +
            "it is a file now, and reading it needs no torrent"
          );
          // The pieces it was built from are a second copy of the same bytes.
          // Nothing is lost by dropping them: a read that wants one of them is
          // answered from the file.
          const store = findSharedStore(torrent);
          const dropped = store?.dropDuplicatesHeldElsewhere?.() ?? 0;
          if (dropped > 0) {
            logger.info(
              `whole files: dropped ${dropped} spilled piece(s) of "${file.name}" — ` +
              "the film was on this disk twice and is not any more"
            );
          }
          parentPort.postMessage({
            type: Event.FILE_COMPLETE,
            infoHash,
            fileIndex,
            path: kept.path,
            length: kept.length,
            name: kept.name
          });
        }
      } catch (error) {
        logger.warn(`whole files: could not keep "${file?.name}": ${error?.message ?? error}`);
      } finally {
        beingKept.delete(key);
      }
    }
    // EVERYTHING, WITHOUT EXCEPTION, AND EVERY BYTE OF IT A FILE ON DISK. The
    // torrent has no job left: there is nothing to fetch, and this proxy does
    // not seed what nobody is watching.
    //
    // Safe to destroy only because a piece can now be read out of those files:
    // a path that asks for this source again adds the torrent back, and what it
    // verifies it reads from the files rather than from the swarm. Not while
    // anybody is reading it, for the same reason the writing above waits.
    const isWhole =
      torrent.done === true &&
      torrent.files.every((unused, fileIndex) => completedFiles.find(infoHash, fileIndex) !== null);
    if (isWhole && wanted.size === 0) {
      logger.info(
        `whole files: "${torrent.name}" is downloaded whole and saved — removing the torrent, keeping the files`
      );
      // THE RECIPE STAYS, and so does the entry that leads to it. Everything
      // that asks this thread about a source — the track table, the media
      // info, the keyframe table, the stats the browser polls — comes through
      // `requireTorrent`, which adds a torrent back when the one it holds is
      // no longer usable. Deleting the entry here would turn a viewer
      // returning to this film into `Unknown source`, which is a worse failure
      // than the one this removal is for.
      //
      // What the torrent finds when it comes back is the whole files: its
      // store reads pieces from them, so it fetches nothing. It is added with
      // verification skipped, and that is not a shortcut — the file was
      // written out of pieces this client had already hashed, and its size was
      // checked against what the torrent says. Re-hashing a gigabyte and a
      // half to learn what we wrote down is a minute of a viewer's time for
      // nothing.
      wholeSources.remember(sourceKey, {
        infoHash: torrent.infoHash,
        name: torrent.name,
        pieceLength: Number(torrent.pieceLength) || 0,
        files: torrent.files.map((file, index) => ({ index, name: file.name, path: file.path, length: file.length }))
      });
      pool.remove(torrent, "downloaded-whole");
      pool.addWholeSource(sourceKey);
    }
  }
}

setInterval(() => {
  void keepWholeFiles();
}, WHOLE_FILE_SWEEP_MS).unref();

/**
 * Keeps this thread alive ON PURPOSE — the one interval left accounted for
 * (no `.unref()`).
 *
 * Every other recurring handle here is unref'd, upload is disabled by
 * default, and idle peer connections close about half a minute after the
 * traffic stops — so once nothing is being read, every handle can be gone
 * at once, the event loop drains, and this thread ends BY ITSELF. Node then
 * tears the isolate down, that teardown touches memory some native module
 * has already freed, and the fault (SIGSEGV inside `uv_timer_stop`, reached
 * through `PerIsolatePlatformData::Shutdown`) kills the whole process at
 * once — HTTP server, tunnel, data channels — before any JS handler runs.
 * Field evidence: two deaths on 2026-08-22 (15:50:12 and 16:12:21 UTC),
 * each ~35 s after the last byte of traffic, identical core dumps;
 * same crash family as the utp-native faults of 2026-08-18..21
 * (`research/worker-thread-drain-crash-2026-08-22.md`).
 *
 * An empty repeating interval costs nothing, keeps the loop from draining
 * while the process lives, and thereby keeps that teardown path — and the
 * corrupted structure inside it — unreachable, whichever module is guilty.
 */
const WORKER_KEEPALIVE_INTERVAL_MS = 5_000;

setInterval(() => {
  void process.uptime();
}, WORKER_KEEPALIVE_INTERVAL_MS);

/**
 * Say why this thread is ending, from inside it, before anything is torn down.
 *
 * The crash of 2026-08-27 15:40 is `node::worker::Worker::Run()` returning and
 * node faulting as it closes what was left on this loop. The parent DOES watch
 * for an unexpected exit and has a line ready for it — but that line never
 * printed, because the fault happens during this thread's own teardown, before
 * the parent's `exit` event is delivered. So the one reading that would name
 * the cause was being eaten by the failure it was meant to explain.
 *
 * These handlers run first, synchronously, and write through the same channel
 * as every other line here. `beforeExit` means the loop drained despite the
 * keepalive above; `exit` means the thread is going whatever the reason. The
 * list of what was still holding the loop open is the part that says which.
 */
process.on("beforeExit", (code) => {
  log(
    `thread is about to end because the event loop drained (code ${code}) — ` +
    `still open: ${describeActiveResources()}`
  );
});

process.on("exit", (code) => {
  log(`thread ending with code ${code} — still open: ${describeActiveResources()}`);
});

process.on("uncaughtException", (error) => {
  log(`thread hit an uncaught error: ${error?.stack ?? error}`);
});

process.on("unhandledRejection", (reason) => {
  log(`thread hit an unhandled rejection: ${reason?.stack ?? reason}`);
});

/**
 * What is still holding this thread's event loop open, as node names it.
 *
 * @returns {string} A tally per resource kind, or why it could not be read.
 */
function describeActiveResources() {
  try {
    const names = process.getActiveResourcesInfo?.() ?? [];
    if (names.length === 0) {
      return "nothing";
    }
    const tally = new Map();
    for (const name of names) {
      tally.set(name, (tally.get(name) ?? 0) + 1);
    }
    return [...tally].map(([name, count]) => `${name}x${count}`).join(" ");
  } catch (error) {
    return `unreadable (${error?.message ?? error})`;
  }
}

log("torrent worker started");
