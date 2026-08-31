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
 * already carries the parts that took field failures to get right — refcounted
 * file claims, idle removal, the global disk cap with LRU eviction, seek-aware
 * piece prioritisation, adaptive upload — and none of that changes by moving
 * threads.
 */

// MUST stay first: it redirects `webrtc-polyfill` to a JavaScript WebRTC stack
// before WebTorrent can reach the native one. Two isolates using
// node-datachannel at once abort the process, and the torrent's wss trackers
// create peer connections of their own.
import { isUsableTorrentHandle } from "./handle-state.js";
import "./install-webrtc-shim.js";
import { parentPort, workerData } from "node:worker_threads";
import { createSendStream } from "./channel.js";
import { createFileClaims } from "./file-claims.js";
import { readFragments, supplyFiguresFor } from "./piece-reader.js";
import { cuesHeldFor, declaredSubtitleTracksOf, subtitleTracksOf, warmSubtitleCues } from "./subtitle-cues.js";
import { CONTAINER_HEAD_BYTES, containerTracksOf } from "./container-tracks.js";
import { Command, Event } from "./protocol.js";
import { startMemoryReport, WORKER_MEMORY_SAMPLE_MS } from "../memory-report.js";

// Imported dynamically, and that is load-bearing: static imports are RESOLVED
// during linking, before any module body runs, so a statically imported pool
// would drag in WebTorrent — and with it the real `webrtc-polyfill` — before
// the hook above had a chance to register. Verified the hard way: with a static
// import the process still aborted, and the stack named the genuine polyfill.
const { TorrentPool, resolveDhtBootstrap } = await import("../torrent-pool.js");
const { collectStoreStats, pieceBufferCollection, reviseStoreBudgets } = await import("../piece-store/shared-piece-store.js");

// Resolved before the client exists, because the client builds its DHT in its
// own constructor and the addresses have to be in hand by then. Awaiting here
// costs the few milliseconds of a DNS answer, once, on a thread that has not
// been asked for anything yet.
const dhtBootstrap = await resolveDhtBootstrap();

const pool = new TorrentPool({
  maxDiskBytes: workerData?.maxDiskBytes,
  memoryBytes: workerData?.memoryBytes,
  dhtBootstrap
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
/** File claims, each with its own identity — see `file-claims.js`. */
const fileClaims = createFileClaims();
/** In-flight reads, so a cancel can stop one mid-body. */
const readsById = new Map();

/**
 * Forward a log line to the main thread, so worker output is not lost or
 * interleaved separately from everything else.
 *
 * @param {string} message
 * @returns {void}
 */
function log(message) {
  parentPort.postMessage({ type: Event.LOG, message });
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

  // Hold the file for as long as this read runs. The caller also acquires it,
  // but that acquire and its release are separate messages from another thread
  // and can be reordered; this one cannot, because it lives entirely inside the
  // read. Without it the idle sweep saw a zero reader count and removed the
  // torrent AND its store mid-read — field 2026-08-02: "removed idle torrent
  // ... and its store", after which every subsequent read hung and ffmpeg got
  // an empty input.
  const releaseRead = pool.acquireFile(torrent, fileIndex);

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
    // Any fragment still awaiting confirmation will never get one now; settling
    // it here releases its pin rather than leaking a held slot.
    settleFragment(id);
    releaseRead();
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
      const torrent = await pending;
      return {
        infoHash: torrent.infoHash,
        name: torrent.name,
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
      const torrent = await requireTorrent(params.sourceKey);
      return (torrent.files ?? []).map((file, index) => ({
        index,
        name: file.name,
        path: file.path,
        length: file.length
      }));
    }

    case Command.ACQUIRE_FILE: {
      const torrent = await requireTorrent(params.sourceKey);
      // Every acquire is its own claim. Sharing one per file meant the first
      // reader to finish released the hold while others were still reading.
      return fileClaims.open(
        params.sourceKey,
        params.fileIndex,
        pool.acquireFile(torrent, params.fileIndex)
      );
    }

    case Command.RELEASE_FILE: {
      const released = fileClaims.close(params.claimId);
      if (!released) {
        // Not fatal — but it means a release arrived twice or after teardown,
        // and silence here is what let the previous scheme look healthy.
        log(`release for unknown file claim ${params.claimId}`);
      }
      return released;
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

    case Command.SUBTITLE_TRACKS: {
      const torrent = await requireTorrent(params.sourceKey);
      return {
        tracks: await subtitleTracksOf(torrent, params.fileIndex, params.sourceKey),
        declared: await declaredSubtitleTracksOf(torrent, params.fileIndex, params.sourceKey)
      };
    }

    case Command.CONTAINER_TRACKS: {
      const torrent = await requireTorrent(params.sourceKey);
      return {
        tracks: await containerTracksOf(torrent, params.fileIndex, params.sourceKey, {
          // The header of a file nobody is playing has usually not arrived at
          // all — a sidecar soundtrack is asked about before anyone has chosen
          // it. Its head is a few hundred kilobytes, and without them there is
          // nothing to read.
          prefetchEdges: () =>
            pool.prefetchFileEdges(torrent, params.fileIndex, {
              headBytes: CONTAINER_HEAD_BYTES,
              tailBytes: 0,
              timeoutMs: 60_000
            })
        })
      };
    }

    case Command.SUBTITLE_CUES: {
      const torrent = await requireTorrent(params.sourceKey);
      const held = await cuesHeldFor(torrent, params.fileIndex, params.sourceKey, params.trackNumber);
      return {
        cues: held.cues,
        coveredClusters: held.coveredClusters,
        indexedClusters: held.indexedClusters,
        codecId: held.track?.codecId ?? "",
        codecPrivate: held.track?.codecPrivate ?? "",
        language: held.track?.language ?? ""
      };
    }

    case Command.FILE_STATS: {
      const torrent = await requireTorrent(params.sourceKey);
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

    case Command.PRIORITIZE: {
      const torrent = await requireTorrent(params.sourceKey);
      pool.prioritizeByteRange(torrent, params.fileIndex, params.byteStart, params.windowBytes, {
        wholeFileRead: params.wholeFileRead === true
      });
      return true;
    }

    case Command.PREFETCH_EDGES: {
      const torrent = await requireTorrent(params.sourceKey);
      return pool.prefetchFileEdges(torrent, params.fileIndex, params.options ?? {});
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

    case Command.DESTROY_ALL: {
      fileClaims.closeAll();
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
    parentPort.postMessage({ type: Event.RESULT, id, result });
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

/** Last reported figures per store, so unchanged ones stay silent. */
const lastReported = new Map();

setInterval(() => {
  // What the machine can spare NOW, not what it could spare when each store was
  // created. With per-piece buffers a lowered ceiling is honoured immediately:
  // excess pieces are evicted to disk and their memory is reclaimable.
  for (const revised of reviseStoreBudgets()) {
    if (revised.evicted > 0) {
      log(
        `piece-store "${revised.name.slice(0, 40)}": allowance is now ` +
        `${Math.round(revised.ceilingBytes / 1048576)}MB, evicted ${revised.evicted} piece(s) to meet it — ` +
        `now ${Math.round(revised.committedBytes / 1048576)}MB committed`
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
  for (const stats of collectStoreStats()) {
    const signature = `${stats.fromMemory}/${stats.fromDisk}/${stats.spills}/${stats.revivals}/${stats.blockedByPins}/${stats.evictedOnRevise}/${stats.spillFailures}`;
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
      `on-disk=${Math.round((stats.spilledBytes || 0) / 1048576)}MB ` +
      `pinned=${stats.pinned} spilled=${stats.spilled} reads=${reads} (${fromMemoryShare}% from memory) ` +
      `spills=${stats.spills} revivals=${stats.revivals}` +
      (stats.blockedByPins > 0 ? ` blocked-by-pins=${stats.blockedByPins}` : "") +
      (stats.evictedOnRevise > 0 ? ` evictedOnRevise=${stats.evictedOnRevise}` : "") +
      (stats.spillFailures > 0 ? ` spill-failures=${stats.spillFailures}` : "") +
      (stats.outstanding > 0 ? ` outstanding=${stats.outstanding}` : "")
    );
  }
  // Not per store: the collector is per thread, and the question it answers —
  // is anything of ours outliving a piece — is about the thread. Printed
  // whenever the two disagree by more than the pieces actually held, which is
  // the only shape worth looking at (roadmap item 2).
  const collection = pieceBufferCollection();
  const outstandingBuffers = collection.released - collection.collected;
  const heldNow = collectStoreStats().reduce((sum, stats) => sum + (stats.resident || 0), 0);
  if (outstandingBuffers > heldNow) {
    log(
      `piece buffers: ${collection.released} let go, ${collection.collected} collected — ` +
      `${outstandingBuffers} still alive against ${heldNow} the store holds. ` +
      "A gap that keeps widening means a reference of ours outlives the piece; " +
      "a gap that does not means whatever grows is below us, in the allocator"
    );
  }
}, STORE_REPORT_INTERVAL_MS).unref();

/**
 * Walk subtitle cues for every actively-read file of one torrent, and PUSH
 * whatever came out new to the main thread — which is what makes a browser's
 * copy current without it having asked.
 *
 * @param {string} sourceKey
 * @param {object} torrent
 * @returns {void}
 */
function warmActiveFiles(sourceKey, torrent) {
  const usage = pool.fileUsageByTorrent.get(torrent);
  if (!usage) {
    return;
  }
  for (const fileIndex of usage.keys()) {
    const key = `${sourceKey}:${fileIndex}`;
    // A trigger that arrives while the previous pass is still walking is
    // dropped, not queued. `verified` fires per piece, so on a fast download
    // these arrive many times a second; the walk is serialized per file anyway,
    // and a queue of identical passes would only postpone the one that has
    // something new to find.
    if (warmupInFlight.has(key)) {
      continue;
    }
    warmupInFlight.add(key);
    warmSubtitleCues(torrent, fileIndex, sourceKey)
      .then((fresh) => {
        for (const entry of fresh) {
          const span = entry.spanStartSeconds === null
            ? "empty"
            : `${entry.spanStartSeconds.toFixed(1)}-${entry.spanEndSeconds.toFixed(1)}s`;
          log(
            `subtitle push ${sourceKey.slice(0, 8)}:${fileIndex} track ${entry.trackIndex}: ` +
            `${entry.cues.length} new cue(s) covering ${span}, ` +
            `clusters walked ${entry.walkedClusters}/${entry.indexedClusters}, cursor ${entry.cursor}, ` +
            "posting to main thread"
          );
          parentPort.postMessage({
            type: Event.SUBTITLE_CUES_READY,
            sourceKey,
            fileIndex,
            trackIndex: entry.trackIndex,
            cues: entry.cues,
            language: entry.language,
            cursor: entry.cursor
          });
        }
      })
      .catch((error) => {
        log(`subtitle warmup ${sourceKey}:${fileIndex} failed: ${error instanceof Error ? error.message : error}`);
      })
      .finally(() => {
        warmupInFlight.delete(key);
      });
  }
}

/**
 * Files whose warmup pass has not finished yet, by `sourceKey:fileIndex`.
 *
 * @type {Set<string>}
 */
const warmupInFlight = new Set();

/**
 * Torrents already wired to warm their subtitle cues the moment a piece
 * verifies, so the same torrent is not listened to twice.
 *
 * @type {WeakSet<object>}
 */
const subtitleWarmupWired = new WeakSet();

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
function ensureSubtitleWarmupWired(sourceKey, torrent) {
  if (subtitleWarmupWired.has(torrent)) {
    return;
  }
  subtitleWarmupWired.add(torrent);
  torrent.on("verified", () => warmActiveFiles(sourceKey, torrent));
}

/**
 * How often an actively-read file's subtitle cues are walked ahead of being
 * asked for, as a fallback beside the per-piece `verified` listener above —
 * catches a listener attached after pieces already verified, and anything the
 * event path might otherwise miss. Cheap once caught up (`warmSubtitleCues`
 * skips clusters it has already read).
 */
const SUBTITLE_WARMUP_INTERVAL_MS = 3_000;

setInterval(() => {
  for (const [sourceKey, torrent] of pool.torrents) {
    ensureSubtitleWarmupWired(sourceKey, torrent);
    warmActiveFiles(sourceKey, torrent);
  }
}, SUBTITLE_WARMUP_INTERVAL_MS).unref();

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
