/**
 * @file Reading a byte range as positions in shared memory, not as bytes.
 *
 * The pieces already live in a `SharedArrayBuffer` the main thread can map. So
 * the torrent thread does not need to hand over any bytes at all: it can say
 * *where* a piece sits and let the other side read it there. What crosses the
 * boundary is two numbers per piece.
 *
 * That is the whole point of the exercise. The alternative — copying each piece
 * into memory we own and transferring it — costs 18.84 ms per 10 MB segment on
 * the field host, and costs it **on the critical path**, in the thread that is
 * also running the torrent, at the moment a viewer is waiting for that segment.
 * Here the copy is gone entirely rather than moved.
 *
 * Two obligations come with it, and both are enforced rather than assumed:
 *
 *  - a piece being read is **pinned**, so eviction cannot take the memory out
 *    from under the reader mid-read;
 *  - the pin is released only once the other thread reports it has finished
 *    with those bytes — not when they were sent, because nothing was sent.
 */

import { pieceStoreOf } from "../piece-store-of.js";
import { urgencyName } from "../demand/index.js";
import { demandFor } from "../download/registry.js";
import { logger } from "../../../utils/logger.js";
import { minimumBufferFrom, requiredSpeedFrom } from "../supply-margin.js";

/** Only waits at least this long are reported; sequential reading stays silent. */
const PIECE_WAIT_LOG_MS = 1_000;


/**
 * Who is working on the piece a reader is blocked on, right now.
 *
 * The open question about a seek: a single 8 MiB piece takes 3.0-4.6 s to
 * arrive while the swarm as a whole is moving 4-6 MB/s, so roughly 2 MB/s is
 * reaching the piece that is actually being waited for. Whether that is because
 * few peers hold it, few are being asked, or each is slow cannot be told apart
 * from the outside — these three counts tell them apart.
 *
 * `wire.requests` is what has been asked of that peer and not yet answered; a
 * block is 16 KB, so `blocks x 16 KB` is the work in flight on this piece.
 *
 * @param {import("webtorrent").Torrent} torrent
 * @param {number} pieceIndex
 * @returns {{ peers: number, holders: number, askedOf: number, blocks: number }}
 */
export function pieceSupply(torrent, pieceIndex) {
  const wires = Array.isArray(torrent?.wires) ? torrent.wires : [];
  let holders = 0;
  let askedOf = 0;
  let blocks = 0;
  for (const wire of wires) {
    if (wire?.peerPieces?.get?.(pieceIndex)) {
      holders += 1;
    }
    const requests = Array.isArray(wire?.requests) ? wire.requests : [];
    const forThisPiece = requests.filter((request) => request?.piece === pieceIndex).length;
    if (forThisPiece > 0) {
      askedOf += 1;
      blocks += forThisPiece;
    }
  }
  return { peers: wires.length, holders, askedOf, blocks };
}

/**
 * Wait until a piece has been downloaded and verified.
 *
 * WebTorrent announces this as `verified`. The bitfield is re-checked after the
 * listener is attached because the piece can complete in between, and a missed
 * event here would wait forever.
 *
 * @param {import("webtorrent").Torrent} torrent
 * @param {number} index
 * @param {{ isCancelled: () => boolean, onCancel?: (listener: () => void) => () => void }} cancellation
 * @returns {Promise<void>}
 */
function whenPieceReady(torrent, index, cancellation, wanted) {
  if (torrent.bitfield?.get(index)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let stopListening = () => {};
    let finished = false;
    /** @param {number} verifiedIndex */
    const onVerified = (verifiedIndex) => {
      if (verifiedIndex === index) {
        cleanup();
        resolve();
      }
    };
    const onMapChanged = () => {
      if (wanted()) return;
      cleanup();
      const error = new Error(`Piece ${index} is outside the source priority map.`);
      error.code = "SOURCE_RANGE_NOT_WANTED";
      error.canRetry = false;
      reject(error);
    };
    const onDestroyed = () => {
      cleanup();
      reject(new Error(`Torrent went away while waiting for piece ${index}.`));
    };
    // A superseded seek destroys the read, and without this the wait would
    // outlive it and hold a pin. The read's own stream says so the moment it
    // happens; it was polled every 250 ms before. A cancellation that cannot
    // announce itself is one that is never cancelled (a test's plain object).
    if (cancellation.isCancelled()) {
      reject(new Error(`Read cancelled while waiting for piece ${index}.`));
      return;
    }
    function cleanup() {
      finished = true;
      stopListening();
      torrent.removeListener("verified", onVerified);
      torrent.removeListener("close", onDestroyed);
      torrent.removeListener("priority-map-changed", onMapChanged);
    }

    torrent.on("verified", onVerified);
    torrent.once("close", onDestroyed);
    torrent.on("priority-map-changed", onMapChanged);
    stopListening = cancellation.onCancel?.(() => {
      cleanup();
      reject(new Error(`Read cancelled while waiting for piece ${index}.`));
    }) ?? (() => {});
    if (finished) {
      stopListening();
      return;
    }

    // The piece may have arrived between the check above and this listener.
    if (torrent.bitfield?.get(index)) {
      cleanup();
      resolve();
    } else onMapChanged();
  });
}

/**
 * A fragment of a read: where to find it, and how to let it go.
 *
 * @typedef {object} PieceFragment
 * @property {number} pieceIndex
 * @property {number} offset - Byte offset into the shared pool.
 * @property {number} length
 * @property {() => void} release - Drops this fragment's pin. Call exactly once.
 */

/**
 * Walk a byte range of a file, yielding each piece's position in shared memory.
 *
 * Yields at most one fragment per piece; the first and last are usually partial.
 * The caller must `release()` every fragment it receives, including on failure —
 * an unreleased pin permanently costs a slot.
 *
 * @param {object} params
 * @param {import("webtorrent").Torrent} params.torrent
 * @param {number} params.fileIndex
 * @param {number} params.start - Inclusive, relative to the file.
 * @param {number} params.end - Inclusive, relative to the file.
 * @param {{ isCancelled: () => boolean }} params.cancellation
 * @returns {AsyncGenerator<PieceFragment>}
 */
/**
 * The last interruptions this file's readers met, newest last.
 *
 * Bounded and per file, because both figures derived from it describe THIS
 * file on THIS swarm: a piece is 8 MiB here and 512 KiB elsewhere, and a swarm
 * that answers in 200 ms today may not tomorrow. Nothing is stored beyond the
 * process — a restart starts from no evidence, which is the honest state.
 *
 * @type {Map<string, Array<{ waitedMs: number, at: number }>>}
 */
const supplyWaits = new Map();

/** How many interruptions are kept per file. */
const SUPPLY_WAIT_HISTORY = 40;

/** How often the derived figures are printed, at most. */
const SUPPLY_REPORT_INTERVAL_MS = 30_000;

/** When each file's figures were last printed. */
const supplyReportedAt = new Map();

/**
 * Record one interruption and, at most twice a minute, say what it implies.
 *
 * The two figures are the whole of roadmap item 3: the speed a step must
 * sustain to survive this supply (`1 / (1 - the share of time lost)`), and the
 * smallest buffer that hides an interruption from the viewer. Both are printed
 * before either is USED, so the field says whether the arithmetic describes
 * reality before anything is decided by it.
 *
 * @param {string} key - Something stable per file.
 * @param {string} label - What to call it in the log.
 * @param {number} waitedMs
 * @returns {void}
 */
/**
 * What this file's recent interruptions demand, for a caller that has to decide
 * something with them.
 *
 * Exported because the figures are measured HERE — the reader is the only place
 * that knows how long it waited — while the decisions they feed are made
 * elsewhere: the smallest buffer that hides an interruption goes to the browser,
 * and the speed a step must sustain goes to the quality offer.
 *
 * @param {string} infoHash
 * @param {string} fileName
 * @param {number} segmentSeconds - The session's own segment duration.
 * @returns {{ requiredSpeed: number, worstWaitSec: number, medianIntervalSec: number, lostShare: number, spanSec: number, lostSec: number, samples: number, minimumBufferSec: number } | null}
 */
export function supplyFiguresFor(infoHash, fileName, segmentSeconds) {
  const history = supplyWaits.get(`${infoHash ?? "?"}/${fileName ?? "?"}`);
  const demand = requiredSpeedFrom(history ?? []);
  if (!demand) {
    return null;
  }
  const buffer = minimumBufferFrom({
    segmentSeconds,
    worstSupplyWaitSec: demand.worstWaitSec
  });
  return {
    requiredSpeed: demand.requiredSpeed,
    worstWaitSec: demand.worstWaitSec,
    medianIntervalSec: demand.medianIntervalSec,
    samples: demand.samples,
    minimumBufferSec: buffer ? buffer.seconds : null
  };
}

/**
 * Record one wait against the priority level of the requested piece. The level
 * identifies which part of the priority map needs more lead time.
 *
 * @param {string} key
 * @param {number} waitedMs
 * @param {number} urgency
 * @returns {void}
 */
function noteWaitLevel(key, waitedMs, urgency) {
  let byLevel = waitsByLevel.get(key);
  if (!byLevel) {
    byLevel = new Map();
    waitsByLevel.set(key, byLevel);
  }
  const waits = byLevel.get(urgency) ?? [];
  waits.push(waitedMs);
  while (waits.length > SUPPLY_WAIT_HISTORY) {
    waits.shift();
  }
  byLevel.set(urgency, waits);
}

/**
 * Where the waits fell, by level, or null while nothing has waited.
 *
 * @param {string} key
 * @returns {string | null}
 */
function describeWaitLevels(key) {
  const byLevel = waitsByLevel.get(key);
  if (!byLevel || byLevel.size === 0) {
    return null;
  }
  const middle = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return [...byLevel.entries()]
    .sort(([left], [right]) => left - right)
    .map(([urgency, waits]) =>
      `${urgencyName(urgency)} ${waits.length} waits median ${middle(waits)}ms ` +
      `worst ${Math.max(...waits)}ms`)
    .join(", ");
}

/**
 * Waits split by the level the reader was stopped in.
 *
 * @type {Map<string, Map<number, number[]>>}
 */
const waitsByLevel = new Map();

/**
 * How many readers are blocked on a torrent AT THIS MOMENT, by infohash.
 *
 * Not a history and not an average: the question it answers is "is anything the
 * viewer is watching waiting for the swarm right now", and the only honest
 * answer is a count of readers currently inside a wait.
 *
 * It exists so that work which is NOT what the viewer is watching — fetching a
 * soundtrack or a subtitle file they may switch to later — can proceed while the
 * swarm has room and stand aside the instant it does not. That ordering is the
 * whole of the requirement: the picture and the track being played come first,
 * the other tracks next, and reading the film far ahead last.
 *
 * @type {Map<string, number>}
 */
const blockedReaders = new Map();

/**
 * How many stalls a torrent's readers have had, ever. Only differences between
 * two readings of it mean anything.
 *
 * @type {Map<string, number>}
 */
const stallsSeen = new Map();

/**
 * Whether any reader on this torrent is waiting for a piece right now.
 *
 * @param {string} infoHash
 * @returns {boolean}
 */
export function readersAreBlockedOn(infoHash) {
  return (blockedReaders.get(infoHash) ?? 0) > 0;
}

/**
 * How many times a reader on this torrent has been blocked since the process
 * started.
 *
 * Exists so that work of lower importance can ask "did the viewer stall while I
 * was busy?" — which is a different and stricter question than "is the viewer
 * stalled right now". On a swarm delivering exactly what the film needs, a
 * background fetch that only pauses DURING a stall still takes bandwidth
 * between them, and the stalls are the proof it had none to spare. Field
 * 2026-08-31: the swarm delivered 200-600 KB/s against the 399 KB/s the film
 * needs, and the picture stood still 145.6 s.
 *
 * @param {string} infoHash
 * @returns {number}
 */
export function stallsSeenOn(infoHash) {
  return stallsSeen.get(infoHash) ?? 0;
}

/**
 * @param {string} infoHash
 * @param {number} delta
 * @returns {void}
 */
function countBlockedReader(infoHash, delta) {
  if (!infoHash) {
    return;
  }
  if (delta > 0) {
    stallsSeen.set(infoHash, (stallsSeen.get(infoHash) ?? 0) + 1);
  }
  const next = (blockedReaders.get(infoHash) ?? 0) + delta;
  if (next > 0) {
    blockedReaders.set(infoHash, next);
    return;
  }
  blockedReaders.delete(infoHash);
}

function noteSupplyWait(key, label, waitedMs) {
  const history = supplyWaits.get(key) ?? [];
  history.push({ waitedMs, at: Date.now() });
  while (history.length > SUPPLY_WAIT_HISTORY) {
    history.shift();
  }
  supplyWaits.set(key, history);

  const now = Date.now();
  if (now - (supplyReportedAt.get(key) ?? 0) < SUPPLY_REPORT_INTERVAL_MS) {
    return;
  }
  const demand = requiredSpeedFrom(history);
  if (!demand) {
    return;
  }
  supplyReportedAt.set(key, now);
  const buffer = minimumBufferFrom({
    segmentSeconds: SEGMENT_SECONDS_FOR_BUFFER,
    worstSupplyWaitSec: demand.worstWaitSec
  });
  logger.info(
    `supply "${label.slice(0, 40)}": a step must run at ${demand.requiredSpeed.toFixed(2)}x ` +
    // "Interruption", not "wait": several readers walk one file — the picture
    // and each audio rendition — so one missing piece produces one stall and
    // several waits. Saying how many of each is what makes the figure readable;
    // reporting the waits alone made `2 measured` look like two interruptions
    // 3 ms apart, and the demanded speed came out at 4422x.
    // THE NUMBERS THE FIGURE IS MADE OF, so a wrong one can be seen to be wrong.
    // The share of time lost is what the speed now comes from; the worst stall
    // and the typical gap are printed beside it because they are what the
    // cushion is sized by and what the old formula divided one by the other.
    `to survive this swarm (lost ${demand.lostSec.toFixed(2)}s of ${demand.spanSec.toFixed(2)}s ` +
    `= ${(demand.lostShare * 100).toFixed(1)}%, worst stall ${demand.worstWaitSec.toFixed(2)}s, ` +
    `one every ${demand.medianIntervalSec.toFixed(2)}s of running, ${demand.samples} stall(s) ` +
    `from ${demand.waits} wait(s)) — ` +
    `and the smallest buffer that hides it is ${buffer ? buffer.seconds.toFixed(1) : "?"}s` +
    // Attribute source waits to the level declared by the shared map.
    (describeWaitLevels(key) ? ` — ${describeWaitLevels(key)}` : "")
  );
}

/**
 * The segment length the buffer figure is stated against. The reader does not
 * know the session's own, and this is a REPORT rather than a decision — the
 * decision, when it is made, will use the session's real one.
 */
const SEGMENT_SECONDS_FOR_BUFFER = 4;

export async function* readFragments({ torrent, fileIndex, start, end, cancellation }) {
  const store = pieceStoreOf(torrent);
  const file = torrent.files?.[fileIndex];
  if (!store || !file) throw new Error("The source file or shared piece store is unavailable.");
  const pieceLength = torrent.pieceLength;
  const absoluteStart = file.offset + start, absoluteEnd = file.offset + end;
  const first = Math.floor(absoluteStart / pieceLength), last = Math.floor(absoluteEnd / pieceLength);
  const { register } = demandFor(torrent);
  let release = null;
  try {
    for (let index = first; index <= last; index++) {
      if (cancellation.isCancelled()) return;
      const pieceStart = index * pieceLength;
      const wanted = () => register.windows().some(window => window.fileIndex === fileIndex &&
        window.byteStart + file.offset < pieceStart + pieceLength && window.byteEnd + file.offset >= pieceStart);
      let retries = 0;
      while (true) {
        const waitAt = Date.now();
        countBlockedReader(torrent.infoHash, 1);
        try { await whenPieceReady(torrent, index, cancellation, wanted); }
        finally { countBlockedReader(torrent.infoHash, -1); }
        const waitedMs = Date.now() - waitAt;
        if (index > first && waitedMs >= PIECE_WAIT_LOG_MS) {
          const key = `${torrent.infoHash ?? "?"}/${file.name ?? "?"}`;
          noteSupplyWait(key, file.name ?? "", waitedMs);
          const level = register.urgencyAt(fileIndex, Math.max(0, pieceStart - file.offset));
          if (level !== null) noteWaitLevel(key, waitedMs, level);
        }
        if (cancellation.isCancelled()) return;
        store.pin(index);
        let located;
        try { located = await store.reside(index); }
        catch (error) { store.unpin(index); throw error; }
        if (!located) {
          store.unpin(index);
          if (retries++ === 0) continue;
          throw new Error(`Piece ${index} was withdrawn from the store and did not come back.`);
        }
        let released = false;
        release = () => { if (!released) { released = true; store.unpin(index); } };
        const from = Math.max(absoluteStart, pieceStart) - pieceStart;
        const through = Math.min(absoluteEnd, pieceStart + pieceLength - 1) - pieceStart;
        yield { pieceIndex: index, buffer: located.buffer, offset: located.offset + from,
          length: through - from + 1, release };
        release();
        release = null;
        break;
      }
    }
  } finally { release?.(); }
}
