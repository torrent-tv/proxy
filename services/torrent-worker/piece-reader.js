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

import { findSharedStore } from "../piece-store/shared-piece-store.js";
import { bytesOf, Urgency, urgencyName } from "../demand/index.js";
import { demandFor } from "../download/registry.js";
import { logger } from "../../utils/logger.js";
import {
  askFastestWiresFor,
  canPlaceRequests,
  describePieceTail,
  duplicateTailFor
} from "./fastest-wires.js";
import { minimumBufferFrom, requiredSpeedFrom } from "../supply-margin.js";

/** Only waits at least this long are reported; sequential reading stays silent. */
const PIECE_WAIT_LOG_MS = 1_000;

/** Distinguishes concurrent readers to the piece store. Never reused. */
let readerSequence = 0;

/**
 * How far ahead of the read head pieces are asked for.
 *
 * A read is open-ended — ffmpeg opens its input as `bytes <position>-<EOF>` and
 * keeps it for the whole film — so taking the requested range literally asks
 * for everything from the seek point to the end of the file at once. That is
 * what a seek used to do: the swarm was told the entire tail was wanted, went
 * at it from its first missing piece, and the one piece the decoder was blocked
 * on arrived only when the sequential scan reached it. Measured on a 4.7 GB
 * film: a seek to 89.1% took 93 s and pulled 2.47 GB.
 *
 * So the reader asks for a window and moves it as it goes. The size is a
 * compromise the caller cannot yet express: the right unit is seconds of
 * playback (duration and size are both known — to the transcode session, not to
 * this thread), and 32 MB is about 34 s of a 1080p film but only a few seconds
 * of a disc remux. Sizing it from the real byte rate is a follow-up; what
 * matters here is that it is bounded and moving rather than "to the end".
 */
const READ_WINDOW_BYTES = 32 * 1024 * 1024;

/**
 * The pieces a reader at `pieceIndex` wants next, clamped to its own range.
 *
 * @param {{ pieceIndex: number, lastPiece: number, windowPieces: number }} params
 * @returns {{ from: number, to: number }}
 */
export function readWindowFor({ pieceIndex, lastPiece, windowPieces }) {
  const span = Math.max(1, windowPieces);
  return { from: pieceIndex, to: Math.min(lastPiece, pieceIndex + span - 1) };
}

/**
 * How wide the window should be after a piece that made the reader wait — or
 * did not.
 *
 * The swarm's surplus is what pays for this. Measured 2026-08-17 on the field
 * torrent: 5.1-5.9 MB/s delivered against a film consumed at about 1 MB/s, and
 * the reader still blocked 47 times in two minutes, median 1.5 s, worst 4.5 s.
 * A fivefold surplus never became distance ahead of the head, because the
 * window is a fixed number of seconds of playback and everything past it is
 * ordinary background fill at no priority.
 *
 * So the window follows the evidence: every wait that mattered widens it by a
 * piece, every piece that was already there narrows it back toward the size the
 * caller asked for. Nothing here is chosen — the wait is measured, the
 * threshold is the one that already defines "a wait worth recording", and the
 * ceiling is this reader's share of the store's memory, so widening can never
 * cost more than the store can hold.
 *
 * @param {{ current: number, base: number, ceiling: number, waitedMs: number, waitThresholdMs: number }} params
 * @returns {number}
 */
export function nextWindowPieces({ current, base, ceiling, waitedMs, waitThresholdMs }) {
  const floor = Math.max(1, Math.floor(base));
  const top = Math.max(floor, Math.floor(ceiling));
  const now = Math.min(top, Math.max(floor, Math.floor(current)));
  if (waitedMs >= waitThresholdMs) {
    return Math.min(top, now + 1);
  }
  return Math.max(floor, now - 1);
}

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
 * @param {{ isCancelled: () => boolean }} cancellation
 * @returns {Promise<void>}
 */
function whenPieceReady(torrent, index, cancellation) {
  if (torrent.bitfield?.get(index)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    /** @param {number} verifiedIndex */
    const onVerified = (verifiedIndex) => {
      if (verifiedIndex === index) {
        cleanup();
        resolve();
      }
    };
    const onDestroyed = () => {
      cleanup();
      reject(new Error(`Torrent went away while waiting for piece ${index}.`));
    };
    // Cancellation is polled rather than pushed: a superseded seek destroys the
    // read, and without this the wait would outlive it and hold a pin.
    const poll = setInterval(() => {
      if (cancellation.isCancelled()) {
        cleanup();
        reject(new Error(`Read cancelled while waiting for piece ${index}.`));
      }
    }, 250);

    function cleanup() {
      clearInterval(poll);
      torrent.removeListener("verified", onVerified);
      torrent.removeListener("close", onDestroyed);
    }

    torrent.on("verified", onVerified);
    torrent.once("close", onDestroyed);

    // The piece may have arrived between the check above and this listener.
    if (torrent.bitfield?.get(index)) {
      cleanup();
      resolve();
    }
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
 * @param {number} [params.windowBytes] - How far ahead of the read head to ask
 *   the swarm for. Defaults to {@link READ_WINDOW_BYTES}; a caller that knows
 *   the media's byte rate should size it in seconds of playback instead.
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
 * sustain to survive this supply (`1 + worst wait / median interval`), and the
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
 * @returns {{ requiredSpeed: number, worstWaitSec: number, medianIntervalSec: number, samples: number, minimumBufferSec: number } | null}
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
 * Waits split by whether the blocked piece was steered onto another peer.
 *
 * The steering is visible per wait already — how many peers held the piece, how
 * many were asked, what the tail looked like. What was NOT visible is what it
 * bought, and that cannot be read off one line: it is the difference between
 * the waits where a second peer was asked and the waits where none could be.
 * Kept per file, reported with the same summary, so a session says by number
 * whether the swap shortens the tail instead of leaving it to impression.
 *
 * @type {Map<string, { swapped: number[], alone: number[] }>}
 */
const waitsBySteering = new Map();

/**
 * Record one wait against the band the reader was stopped in.
 *
 * What this replaces: until 2026-09-02 each read was assigned at random to one
 * of two ways of claiming — one band or four — and the waits were sorted by
 * which. The comparison never decided anything, and could not: the split halved
 * the sample for each arm, so on 2026-08-28 there were nine reads in one arm and
 * three in the other and the ten-wait threshold was never reached in either; on
 * 2026-08-29 the two arms printed together for the first and only time, as forty
 * waits against one.
 *
 * This is the more useful question anyway. A wait belongs to a LEVEL, and the
 * level says whether a width is wrong rather than whether the whole scheme is:
 * long waits in the band being watched mean the urgent window is too narrow,
 * long waits further out mean the lead is.
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

function noteSteeringOutcome(key, waitedMs, steered) {
  let split = waitsBySteering.get(key);
  if (!split) {
    split = { swapped: [], alone: [] };
    waitsBySteering.set(key, split);
  }
  const into = steered ? split.swapped : split.alone;
  into.push(waitedMs);
  while (into.length > SUPPLY_WAIT_HISTORY) {
    into.shift();
  }
}

/**
 * What the split says, or null while one side of it is still empty — a
 * comparison needs both.
 *
 * @param {string} key
 * @returns {string | null}
 */
function describeSteering(key) {
  const split = waitsBySteering.get(key);
  if (!split || split.swapped.length === 0 || split.alone.length === 0) {
    return null;
  }
  const middle = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return (
    `steered ${split.swapped.length} waits median ${middle(split.swapped)}ms, ` +
    `unsteered ${split.alone.length} waits median ${middle(split.alone)}ms`
  );
}

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
    `to survive this swarm (worst stall ${demand.worstWaitSec.toFixed(2)}s, one every ` +
    `${demand.medianIntervalSec.toFixed(2)}s of running, ${demand.samples} stall(s) ` +
    `from ${demand.waits} wait(s)) — ` +
    `and the smallest buffer that hides it is ${buffer ? buffer.seconds.toFixed(1) : "?"}s` +
    // What steering the blocked piece onto another peer bought, as the
    // difference between the waits where it placed something and the waits
    // where it could not. Absent until both sides have a sample, because a
    // comparison with one side empty is not a comparison.
    (describeSteering(key) ? ` — ${describeSteering(key)}` : "") +
    // The comparison this release exists to make. Read it first.
    (describeWaitLevels(key) ? ` — ${describeWaitLevels(key)}` : "")
  );
}

/**
 * The segment length the buffer figure is stated against. The reader does not
 * know the session's own, and this is a REPORT rather than a decision — the
 * decision, when it is made, will use the session's real one.
 */
const SEGMENT_SECONDS_FOR_BUFFER = 4;

export async function* readFragments({
  torrent,
  fileIndex,
  start,
  end,
  cancellation,
  windowBytes = READ_WINDOW_BYTES
}) {
  const store = findSharedStore(torrent);
  if (!store) {
    throw new Error("This torrent is not backed by a shared piece store.");
  }
  // What this reader wants goes here and nowhere else. `SwarmSelection` is the
  // only thing that turns any of it into a request to the swarm, so a reader
  // can no longer contradict the background fill or the pool.
  const { register, selection } = demandFor(torrent);

  const file = torrent.files?.[fileIndex];
  if (!file) {
    throw new Error(`File ${fileIndex} not found.`);
  }

  const pieceLength = torrent.pieceLength;
  // Piece numbers are torrent-wide, so a file's own offsets have to be lifted
  // into the torrent's address space first.
  const absoluteStart = file.offset + start;
  const absoluteEnd = file.offset + end;
  const firstPiece = Math.floor(absoluteStart / pieceLength);
  const lastPiece = Math.floor(absoluteEnd / pieceLength);

  // This reader owns what it asks for, and gives it back when it is done. The
  // window is a STREAM selection: those are removed by exact bounds and several
  // identical ones coexist — WebTorrent's own source calls that "in a way a
  // count" — so N readers on one torrent produce the union of their windows,
  // and each one leaving takes away only its own. That is what makes several
  // parallel readers (the codec probe's head and tail, subtitles, one input per
  // viewer) cooperate instead of overwrite each other.
  //
  // The previous code selected the whole requested range, marked all of it
  // critical, and never deselected anything — so ffmpeg's opening
  // `bytes 0-<EOF>` left a permanent selection over the entire file, and no
  // later prioritisation could outrank it.
  const basePieces = Math.max(1, Math.ceil(Math.max(1, windowBytes) / pieceLength));
  // What the window is RIGHT NOW. It starts at what the caller sized in seconds
  // of playback and grows while the reader keeps being made to wait — see
  // `nextWindowPieces`.
  let windowPieces = basePieces;
  /**
   * The widest this reader may go: its share of what the store can hold in
   * memory. Measured rather than chosen — the capacity is the store's own, and
   * the number of readers is how many windows are declared on it right now.
   *
   * @returns {number}
   */
  const ceilingPieces = () => {
    const capacity = Number(store?.capacity);
    if (!Number.isFinite(capacity) || capacity <= 0) {
      return basePieces;
    }
    const readers = Math.max(1, store.protectedRanges?.().length ?? 1);
    return Math.max(basePieces, Math.floor(capacity / readers));
  };
  /** @type {{ from: number, to: number } | null} */
  let window = null;
  /** @type {{ from: number, to: number } | null} */
  let blockedStated = false;
  /**
   * Drops the pin of the fragment currently in the consumer's hands, if it
   * still holds one. See where it is assigned.
   *
   * @type {(() => void) | null}
   */
  let releaseHeldPin = null;

  // Identity of this read, so the store can tell one reader's window from
  // another's. Each read gets its own; `readerSequence` never repeats within a
  // process.
  const readerId = `read-${(readerSequence += 1)}`;

  /**
   * Set when the window JUMPS, cleared by the first wait after it.
   *
   * The wait that follows a jump is the cost of the jump: the pieces at the new
   * position have not been asked for yet, and the encoder is restarting. It is
   * not evidence about how well this swarm SUSTAINS a read, which is the only
   * thing `requiredSpeed` is about — and letting it in is what collapsed the
   * quality offer 131 ms after the seek measured on 2026-08-18, refusing every
   * re-encoded rung on the strength of one jump.
   *
   * @type {boolean}
   */
  let waitBelongsToJump = false;

  /** What the consumer has taken from this read, in bytes. */
  let deliveredBytes = 0;
  // How often this read had to stop, and for how long in total. Reported at the
  // end whatever the outcome, so a read that never stopped is counted too.
  let waitCount = 0;
  let waitedTotalMs = 0;
  const readStartedAt = Date.now();

  /**
   * Where the reader's claim starts: the first piece it does not already have. Everything between the read position and that piece
   * is on disk or in memory, so claiming it asks the swarm for what we hold.
   *
   * @param {number} pieceIndex
   * @returns {number}
   */
  const firstMissingFrom = (pieceIndex) => {
    for (let index = pieceIndex; index <= lastPiece; index += 1) {
      if (!torrent.bitfield?.get?.(index)) {
        return index;
      }
    }
    return pieceIndex;
  };


  /**
   * State one band as a need, in bytes.
   *
   * The claimant carries the level, so the four bands of one reader are four
   * claimants and each is replaced on its own — restating the near band does
   * not disturb what was said about the tail.
   *
   * @param {{ from: number, to: number, urgency: number }} band
   * @returns {void}
   */
  const stateBand = (band) => {
    const range = bytesOf({
      fileOffset: Number(file.offset),
      fileLength: Number(file.length),
      from: band.from,
      to: band.to,
      pieceLength
    });
    if (!range) {
      return;
    }
    register.state({
      claimant: `${readerId}:${urgencyName(band.urgency)}`,
      fileIndex,
      byteStart: range.byteStart,
      byteEnd: range.byteEnd,
      urgency: band.urgency
    });
  };

  /**
   * Move the window the reader is working through.
   *
   * It states NOTHING to the swarm. What should be downloaded ahead of a viewer
   * is the priority map's answer, stated once for the whole file by the side
   * that knows where the viewers are; a read is consumption, not a forecast.
   *
   * A read used to declare a rolling window of its own — the piece it wanted
   * and two bands beyond it — and with fifteen reads on one file that was
   * fifteen windows on a piece store holding sixteen pieces. Half of all
   * evictions then took a piece a reader had declared, two thirds of reads came
   * back from disk, and the bytes handed out stopped being the file's: twenty-
   * two source-parse errors, a segment the player refused, and an empty picture
   * for six minutes (field 2026-09-05).
   *
   * What the window is still for: the pieces to mark critical when the reader
   * is actually stopped, and the range to bring back from disk after a jump.
   *
   * @param {number} pieceIndex
   * @returns {void}
   */
  /**
   * Where the priority map puts one piece, in the map's own levels.
   *
   * A stated window is file-relative — `bytesOf` subtracts the file's offset
   * within the torrent — so the piece is put in that frame before it is looked
   * up, or every answer belongs to some other part of the torrent.
   *
   * @param {number} pieceIndex
   * @returns {number | null}
   */
  const mapLevelOf = (pieceIndex) =>
    register.urgencyAt(fileIndex, pieceIndex * pieceLength - Number(file.offset));

  const moveWindowTo = (pieceIndex) => {
    const anchor = firstMissingFrom(pieceIndex);
    const next = readWindowFor({ pieceIndex: anchor, lastPiece, windowPieces });
    if (window && window.from === next.from && window.to === next.to) {
      return;
    }
    const isJump = !window || next.from > window.to || next.from < window.from;
    window = next;
    if (isJump) {
      waitBelongsToJump = true;
      // A jump — a seek, not the window sliding along — can land on pieces that
      // are already downloaded but have been spilled to disk. Bring the whole
      // window back at once instead of one disk round trip per piece as the
      // reader reaches them.
      const revived = store.warmRange?.(next.from, next.to) ?? 0;
      if (revived > 0) {
        logger.info(
          `piece-reader: reviving ${revived} spilled piece(s) of ${next.from}-${next.to} ` +
            `for a jump to ${(start / 1024 / 1024).toFixed(0)}MB of "${file.name}"`
        );
      }
    }
  };

  try {
    for (let pieceIndex = firstPiece; pieceIndex <= lastPiece; pieceIndex += 1) {
      if (cancellation.isCancelled()) {
        return;
      }

      const pieceStart = pieceIndex * pieceLength;
      const fromWithinPiece = Math.max(absoluteStart, pieceStart) - pieceStart;
      const toWithinPiece = Math.min(absoluteEnd, pieceStart + pieceLength - 1) - pieceStart;

      moveWindowTo(pieceIndex);

      if (!torrent.bitfield?.get(pieceIndex)) {
        // Everything from here to the end of the window is wanted NOW, so all
        // of it is marked, not just the piece under the head. `critical`
        // enables hotswap: a block reserved by a slow peer is re-requested from
        // a faster one instead of holding up the reader. Measured 2026-08-04
        // with only the blocked piece marked, the first segment after a seek
        // took 7.2 s while its four 4 MB pieces arrived one after another at
        // ~2.2 MB/s, with waits of 1.3 s and 2.8 s on single pieces.
        //
        // This is not the old behaviour returning: that marked the whole
        // REQUESTED RANGE, which for ffmpeg's input means every piece to the
        // end of the file — hundreds of them, at which point the flag says
        // nothing. A window is what a reader genuinely needs next.
        // Stated as its own need at the level that is being waited on, which
        // is what carries the permission to take a block from a slow peer.
        // Nothing here calls the library: `reconcile` reads what is stated.
        stateBand({ from: pieceIndex, to: window.to, urgency: Urgency.BLOCKED });
        blockedStated = true;
        selection.reconcile();
      }

      const waitStartedAt = Date.now();
      // What the WHOLE torrent received while this one piece was missing. It is
      // the reading that separates the two causes a wait can have, and neither
      // could be told from the other before: bytes arriving briskly throughout
      // mean the swarm had capacity and this piece was stuck behind the wire
      // that reserved it — the blocked-piece tail; bytes barely moving mean
      // there was nothing to be had, and no reordering of requests would have
      // helped. Asked of 2026-08-31, when a session with 4-5 peers of 38 known
      // waited 41.32 s at worst and the log could not say which it was.
      const downloadedAtWaitStart = Number(torrent?.downloaded) || 0;
      // The reader is blocked, so this piece is now the only thing that matters
      // on this torrent: hand it to the fastest wires that hold it. A block is
      // reserved for exactly one wire, and the read ends when the slowest
      // holder delivers — measured 2026-08-17, the swarm had a fivefold surplus
      // of bandwidth and the reader still waited 1.0-4.5 s, 47 times in two
      // minutes, on pieces five peers already had.
      let pushed = { asked: 0, attempted: 0, considered: 0, fastestBytesPerSecond: 0 };
      // The tail as it stood at an attempt that placed NOTHING — the state the
      // duplication work has to answer, and the only one worth a line. Sampled
      // at that instant rather than once up front, because the steering runs
      // again every half second and the piece changes under it; the last such
      // reading is kept, so the line describes the most recent failure.
      let tailWhenNothingPlaced = null;
      // What duplicating the tail placed, summed over the wait. Measured
      // 2026-08-19 on a real swarm: the blocks a reader waits on are 2-14 of
      // 512 and sit on wires the library considers fast, so its own hotswap
      // never fires for them — see `duplicateTailFor`.
      let duplicated = 0;
      const pushToFastest = () => {
        try {
          const result = askFastestWiresFor(torrent, pieceIndex);
          if (result.asked === 0) {
            tailWhenNothingPlaced = describePieceTail(torrent, pieceIndex);
          }
          // Every attempt, not only the ones where nothing else could be placed.
          // The ordinary steering asks for whatever blocks are still free; the
          // read, meanwhile, ends when the LAST block arrives, and that block is
          // reserved to one wire whether or not other blocks could be asked for.
          // Field 2026-09-03: 46.3 s on one piece, ordinary requests placed on
          // 54 of 87 attempts throughout, and a tail of 3 blocks of 512 held by
          // wires at 51-99 KB/s to the end — while duplication, which ran only
          // on the 33 attempts that placed nothing, managed 5 blocks in the
          // whole wait. `duplicateTailFor` bounds itself by the tail's length,
          // so a piece that is merely still arriving is left alone.
          duplicated += duplicateTailFor(torrent, pieceIndex).duplicated;
          pushed = {
            asked: pushed.asked + result.asked,
            refusedWhileReserved:
              (pushed.refusedWhileReserved ?? 0) + (result.refusedWhileReserved ?? 0),
            // Summed like the successes, so the line compares two totals over
            // the same attempts instead of a total against a snapshot.
            attempted: (pushed.attempted ?? 0) + result.attempted,
            considered: result.considered,
            fastestBytesPerSecond: result.fastestBytesPerSecond
          };
        } catch (error) {
          // The entry is internal to the library; if a version changes it, this
          // lever stops working and that must be visible rather than silent.
          logger.warn(`piece-reader: could not steer piece ${pieceIndex} — ${error?.message ?? error}`);
        }
      };
      if (canPlaceRequests(torrent)) {
        pushToFastest();
      } else {
        // Nothing can be placed at all on this build, so the tail is the whole
        // of the answer.
        tailWhenNothingPlaced = describePieceTail(torrent, pieceIndex);
        logger.warn(
          "piece-reader: this webtorrent build offers no way to place a request; " +
            "the blocked piece cannot be steered onto a faster peer"
        );
      }
      // Sampled while waiting rather than after: once the piece lands, nothing
      // is outstanding on it any more and every count reads zero.
      let supply = null;
      const supplyProbe = setInterval(() => {
        const sample = pieceSupply(torrent, pieceIndex);
        if (!supply || sample.blocks > supply.blocks) {
          supply = sample;
        }
        // Wires come and go, and their speeds change: a holder that was slow a
        // moment ago may now be the fastest one available.
        pushToFastest();
      }, 500);
      // Counted for exactly as long as this reader is inside the wait, so that
      // background work can stand aside while the viewer's own reading is
      // starving. The `finally` is what makes it safe: a cancelled or failed
      // read must not leave the torrent looking permanently blocked, which
      // would stop that background work for the rest of the session.
      countBlockedReader(torrent?.infoHash, 1);
      try {
        await whenPieceReady(torrent, pieceIndex, cancellation);
      } finally {
        countBlockedReader(torrent?.infoHash, -1);
        clearInterval(supplyProbe);
      }
      // What a reader spent waiting for data, attributed to the exact piece. A
      // seek's cost is dominated by the first segment after the encoder
      // restarts (measured 9.2-9.4 s), and without this there is no way to say
      // whether that is the swarm, the picker, or ffmpeg. Logged only when the
      // wait is long enough to matter, so ordinary sequential reading is silent.
      const waitedMs = Date.now() - waitStartedAt;
      // Where the map puts this piece, read once and used by both the
      // attribution below and the line beside it.
      const wantedBy = mapLevelOf(pieceIndex);
      // The window answers to what just happened: a wait means the lead was too
      // short, an immediate hit means it is longer than it needs to be. Applied
      // before the logging below so the line reports the window the next piece
      // will actually use.
      if (waitBelongsToJump) {
        // Recorded nowhere: see `waitBelongsToJump`. Said out loud, because a
        // gap in the supply history is otherwise indistinguishable from a swarm
        // that never made the reader wait.
        logger.info(
          `piece-reader: ${waitedMs}ms on the first piece after a jump — the cost of moving, ` +
            `not of this swarm's supply, so it is not counted against the quality offer`
        );
        waitBelongsToJump = false;
      } else {
        const supplyKey = `${torrent?.infoHash ?? "?"}/${file?.name ?? "?"}`;
        noteSteeringOutcome(supplyKey, waitedMs, pushed.asked > 0 || duplicated > 0);
        // Which level of the priority map the reader was stopped in. A wait
        // belongs to a level, and the level says whether that zone is asked for
        // too late — the reader itself no longer has an opinion about it.
        noteWaitLevel(
          supplyKey,
          waitedMs,
          wantedBy ?? Urgency.BLOCKED
        );
        waitCount += 1;
        waitedTotalMs += waitedMs;
        noteSupplyWait(supplyKey, file?.name ?? "", waitedMs);
      }
      const widened = nextWindowPieces({
        current: windowPieces,
        base: basePieces,
        ceiling: ceilingPieces(),
        waitedMs,
        waitThresholdMs: PIECE_WAIT_LOG_MS
      });
      if (widened !== windowPieces) {
        windowPieces = widened;
      }
      if (waitedMs >= PIECE_WAIT_LOG_MS) {
        const rateKbps = Math.round(pieceLength / 1024 / (waitedMs / 1000));
        // Two rates, side by side, and no verdict word between them: the swarm's
        // own delivery during the wait against what this piece managed. Both are
        // measured; which one a reader calls "the cause" follows from the pair
        // without a threshold having to be chosen here. Far apart means the
        // bytes were flowing and this piece was not among them; close together,
        // or both near zero, means there was nothing to deliver.
        const swarmBytes = Math.max(0, (Number(torrent?.downloaded) || 0) - downloadedAtWaitStart);
        const swarmKbps = Math.round(swarmBytes / 1024 / (waitedMs / 1000));
        logger.info(
          `piece-reader: waited ${waitedMs}ms for piece ${pieceIndex} ` +
            `(${pieceIndex - firstPiece + 1} of ${lastPiece - firstPiece + 1} in a read from ` +
            `${(start / 1024 / 1024).toFixed(0)}MB of "${file.name}") ` +
            `— ${rateKbps}KB/s on this piece while the swarm delivered ` +
            `${swarmKbps}KB/s (${(swarmBytes / 1024 / 1024).toFixed(1)}MB) across the torrent, ` +
            `${Number(torrent?.numPeers) || 0} peers connected; ` +
            (supply
              ? `${supply.holders}/${supply.peers} peers had it, ${supply.askedOf} were asked, ` +
                `${supply.blocks} blocks (${Math.round((supply.blocks * 16384) / 1024)}KB) in flight at peak`
              : "no sample taken") +
            // What WE did about it, so the next session says whether steering
            // the piece onto faster holders shortens the tail — by number
            // rather than by impression.
            `; steered onto ${pushed.asked} of ${pushed.attempted} asks (${pushed.considered} peers held it)` +
            // How often a fast peer we picked was refused because every block
            // was already spoken for and the library declined to take one from
            // a slow holder. Its thresholds are constants, not settings: the
            // asker must be above 16 KB/s, the holder below 48 KB/s and twice
            // as slow. A number here is what would justify replacing that rule;
            // a zero says the thresholds are not what we are short of.
            ((pushed.refusedWhileReserved ?? 0) > 0
              ? `; ${pushed.refusedWhileReserved} refused with every block reserved`
              : "") +
            (pushed.fastestBytesPerSecond > 0
              ? `, fastest ${Math.round(pushed.fastestBytesPerSecond / 1024)}KB/s`
              : "") +
            // Only when the steering placed nothing, which is the case that
            // decides whether duplicating the tail is worth building: it says
            // how much of the piece is still missing and which wires are
            // holding it, slowest first.
            (tailWhenNothingPlaced
              ? `; tail ${tailWhenNothingPlaced.missing}/${tailWhenNothingPlaced.chunks} blocks missing, held by ` +
                (tailWhenNothingPlaced.outstanding.length > 0
                  ? tailWhenNothingPlaced.outstanding
                    .map((wire) => `${wire.blocks}@${Math.round(wire.bytesPerSecond / 1024)}KB/s` +
                      (wire.choking ? " (choking)" : ""))
                    .join(" ")
                  : "nobody")
              : "") +
            // What we did about the tail, so the next session says by number
            // whether a second copy of those blocks shortens the wait.
            (duplicated > 0 ? `; duplicated ${duplicated} blocks` : "") +
            // Where the priority map puts this piece. A wait at the level the
            // viewer is about to reach is a different fault from a wait on the
            // speculative tail, and the reader states nothing of its own that
            // could be read instead.
            `; the map wants it ${wantedBy === null
              ? "nowhere — nobody asked for this piece"
              : urgencyName(wantedBy)}`
        );
      }

      // Pinned BEFORE it is located, and before any await that could let an
      // eviction run: the offset is only meaningful while the piece is held.
      store.pin(pieceIndex);
      let located = null;
      try {
        located = await store.reside(pieceIndex);
      } catch (error) {
        store.unpin(pieceIndex);
        throw error;
      }

      if (!located) {
        store.unpin(pieceIndex);
        throw new Error(`Piece ${pieceIndex} is verified but absent from the store.`);
      }

      let releasedThisPiece = false;
      // Remembered so the generator can drop it itself. The pin is taken here
      // and the consumer is expected to release it — but a consumer that
      // ABANDONS the iterator never gets the chance, and a seek abandons it
      // every time: the encoder is killed, the response is torn down, and the
      // loop is left between two fragments. Field 2026-08-06: after one seek
      // every slot in the store was pinned, the store answered
      // `Every resident piece is pinned; no slot can be freed` — to the
      // WebTorrent client, which closed the store and destroyed the torrent —
      // and the session died with `File 0 not found`.
      releaseHeldPin = () => {
        if (!releasedThisPiece) {
          releasedThisPiece = true;
          store.unpin(pieceIndex);
        }
      };
      // What the consumer takes, counted as it is handed over: for a viewer this
      // is the film's own byte rate, which is what the band widths are derived
      // against.
      deliveredBytes += toWithinPiece - fromWithinPiece + 1;
      yield {
        pieceIndex,
        buffer: located.buffer,
        offset: located.offset + fromWithinPiece,
        length: toWithinPiece - fromWithinPiece + 1,
        release() {
          if (releasedThisPiece) {
            return;
          }
          releasedThisPiece = true;
          store.unpin(pieceIndex);
        }
      };
      // Handed back, and released by the consumer or not at all — either way
      // this reader no longer owes anything for it.
      releaseHeldPin = null;
    }
  } finally {
    // A fragment handed out and never released is a slot lost for the life of
    // the process. Reached on every exit, including the consumer walking away.
    if (releaseHeldPin) {
      releaseHeldPin();
      releaseHeldPin = null;
    }
    // What this read did, said once at its end and under EVERY outcome: how
    // much it delivered, and how much of that time it spent stopped. Said even
    // when it never stopped, because "no wait" is the result worth counting and
    // a line printed only beside a wait cannot report it.
    const readSeconds = (Date.now() - readStartedAt) / 1000;
    if (deliveredBytes > 0) {
      logger.info(
        `read "${String(file?.name ?? "?").slice(0, 40)}" ` +
        `delivered=${(deliveredBytes / 1e6).toFixed(1)}MB in ${readSeconds.toFixed(1)}s ` +
        `waits=${waitCount} waited=${(waitedTotalMs / 1000).toFixed(1)}s`
      );
    }
    // Reached on completion, on cancellation, on a throw, and when the consumer
    // stops iterating — a claim left behind would keep the swarm fetching for a
    // reader that no longer exists.
    if (blockedStated) {
      register.withdraw(`${readerId}:${urgencyName(Urgency.BLOCKED)}`);
    }
    // Once, after everything has been withdrawn — and it releases this reader's
    // hold on memory as well, because both views come from the same statement.
    selection.reconcile();
  }
}
