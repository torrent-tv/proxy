import { pieceStoreOf } from "../piece-store-of.js";

/**
 * @file What of a file the torrent already HOLDS, and reading it without
 * asking the swarm for anything.
 *
 * Storage answers both questions: which pieces remain available, and how to
 * read them. The library bitfield is not a second availability authority.
 * They are here because
 * of that and for no other reason — everything else that used to keep them
 * company, the subtitle plan and the cue walk and the cursor a browser follows,
 * is what a FILE says about itself and moved to the thread the sessions are on
 * (2026-09-15).
 *
 * **Why the subtitle walk cannot use the ordinary range read.** That one
 * declares demand: it registers a window, steers the swarm toward the piece it
 * is stopped on, and waits. Right for a viewer waiting on a segment, wrong
 * here — switching subtitles on must never pull bytes the viewer is not waiting
 * for, which is the rule the walk has kept since it was written. So these two
 * read the store and say "not here" rather than fetching.
 *
 * **The held ranges are answered as a LIST, not asked piece by piece.** The
 * walk asks "is this cluster downloaded" for every cluster of the file — on the
 * field files that is hundreds of questions per pass, and a pass runs every
 * three seconds. One list per pass costs one message; the same answers asked
 * one at a time cost hundreds of round trips for a walk that is meant to be
 * free when there is nothing new to find.
 */

/**
 * The byte ranges of one file that are downloaded WHOLE.
 *
 * Whole because a piece is the unit storage retains: a range that is half a
 * piece short cannot be read, so
 * reporting it would be reporting bytes that are not there.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @returns {Array<[number, number]>} Ascending, non-overlapping, inclusive
 *   offsets WITHIN the file. Empty when nothing of it has arrived, or when the
 *   torrent cannot say — which reads the same way: nothing may be walked yet.
 */
export function heldRangesOf(torrent, fileIndex) {
  const file = torrent?.files?.[fileIndex];
  const pieceLength = Number(torrent?.pieceLength);
  const store = pieceStoreOf(torrent);
  if (!file || !Number.isSafeInteger(pieceLength) || pieceLength <= 0 || typeof store?.locationOf !== "function") {
    return [];
  }
  const offset = Number(file.offset) || 0;
  const length = Number(file.length) || 0;
  if (!(length > 0)) {
    return [];
  }
  const first = Math.floor(offset / pieceLength);
  const last = Math.floor((offset + length - 1) / pieceLength);
  /** @type {Array<[number, number]>} */
  const ranges = [];
  let runStart = -1;
  for (let index = first; index <= last; index += 1) {
    if (store.locationOf(index) !== "missing") {
      if (runStart < 0) {
        runStart = index;
      }
      continue;
    }
    if (runStart >= 0) {
      ranges.push(rangeWithin(runStart, index - 1, pieceLength, offset, length));
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    ranges.push(rangeWithin(runStart, last, pieceLength, offset, length));
  }
  return ranges;
}

/**
 * A run of whole pieces, as offsets within the file.
 *
 * @param {number} firstPiece
 * @param {number} lastPiece
 * @param {number} pieceLength
 * @param {number} offset - Where the file begins in the torrent.
 * @param {number} length - How long the file is.
 * @returns {[number, number]}
 */
function rangeWithin(firstPiece, lastPiece, pieceLength, offset, length) {
  const start = Math.max(0, firstPiece * pieceLength - offset);
  const end = Math.min(length - 1, (lastPiece + 1) * pieceLength - 1 - offset);
  return [start, end];
}

/**
 * Whether every piece under an inclusive range of a file has arrived.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {number} start
 * @param {number} end - Inclusive.
 * @returns {boolean}
 */
export function isRangeHeld(torrent, fileIndex, start, end) {
  const file = torrent?.files?.[fileIndex];
  const pieceLength = Number(torrent?.pieceLength);
  const store = pieceStoreOf(torrent);
  if (!file || !Number.isSafeInteger(pieceLength) || pieceLength <= 0 || typeof store?.locationOf !== "function" ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= file.length) {
    return false;
  }
  const offset = Number(file.offset) || 0;
  const first = Math.floor((offset + start) / pieceLength);
  const last = Math.floor((offset + end) / pieceLength);
  for (let index = first; index <= last; index += 1) {
    if (store.locationOf(index) === "missing") {
      return false;
    }
  }
  return true;
}

/**
 * Read downloaded bytes through storage only. Availability and acquisition of
 * all input holds are one synchronous operation before the first disk read.
 * Missing input returns null without selecting pieces or opening a torrent
 * file stream. The returned allocation can be transferred to another thread.
 */
export async function readHeldBytes(torrent, fileIndex, start, end, logger = null) {
  const file = torrent?.files?.[fileIndex];
  const pieceLength = Number(torrent?.pieceLength);
  const store = pieceStoreOf(torrent);
  if (!file || !store || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end < start || start >= Number(file.length) || !(pieceLength > 0)) return null;
  const last = Math.min(end, Number(file.length) - 1);
  const absoluteStart = (Number(file.offset) || 0) + start;
  const absoluteEnd = (Number(file.offset) || 0) + last;
  const firstPiece = Math.floor(absoluteStart / pieceLength);
  const lastPiece = Math.floor(absoluteEnd / pieceLength);
  const indexes = Array.from({ length: lastPiece - firstPiece + 1 }, (_, index) => firstPiece + index);
  const release = store.holdAvailable(indexes);
  if (!release) return null;
  try {
    const owned = Buffer.allocUnsafeSlow(last - start + 1);
    for (const index of indexes) {
      const from = Math.max(absoluteStart, index * pieceLength);
      const to = Math.min(absoluteEnd, (index + 1) * pieceLength - 1);
      const wanted = to - from + 1;
      const bytes = await new Promise((resolve, reject) => {
        store.get(index, { offset: from - index * pieceLength, length: wanted }, (error, value) => {
          if (error) reject(error);
          else resolve(value);
        });
      });
      if (!bytes || bytes.length !== wanted) return null;
      owned.set(bytes, from - absoluteStart);
    }
    return owned;
  } catch (error) {
    logger?.info?.(`held read ${fileIndex}:${start}-${last} failed: ${error?.message ?? error}`);
    return null;
  } finally {
    release();
  }
}

/** The last missing-piece line said per torrent, so a wait is named once and not on every arrival. */
const missingSaid = new WeakMap();

/** Acquire every input piece before copying any of the segment's ranges. */
export async function readHeldRanges(torrent, fileIndex, ranges, maxBytes, logger = null) {
  const file = torrent?.files?.[fileIndex];
  const pieceLength = Number(torrent?.pieceLength);
  const store = pieceStoreOf(torrent);
  if (!file || !store || !Array.isArray(ranges) || ranges.length === 0 ||
    !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !(pieceLength > 0)) return null;
  const indexes = new Set();
  const pieceSpans = new Map();
  let bytes = 0;
  for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
    const range = ranges[rangeIndex];
    if (!Array.isArray(range) || range.length !== 2) return null;
    const [start, end] = range;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= file.length) return null;
    bytes += end - start + 1;
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) return null;
    const absoluteStart = (Number(file.offset) || 0) + start;
    const absoluteEnd = (Number(file.offset) || 0) + end;
    const first = Math.floor(absoluteStart / pieceLength);
    const last = Math.floor(absoluteEnd / pieceLength);
    for (let index = first; index <= last; index++) {
      indexes.add(index);
      const pieceStart = index * pieceLength;
      const span = pieceSpans.get(index) ?? { start: Number.POSITIVE_INFINITY, end: -1, ranges: [] };
      span.start = Math.min(span.start, Math.max(absoluteStart, pieceStart));
      span.end = Math.max(span.end, Math.min(absoluteEnd, pieceStart + pieceLength - 1));
      span.ranges.push({ rangeIndex, absoluteStart, absoluteEnd });
      pieceSpans.set(index, span);
    }
  }
  const release = store.holdAvailable([...indexes]);
  if (!release) {
    // Say which pieces are not here: an input that waits for them waits until
    // somebody asks the swarm for them, and nothing else names them.
    const missing = [...indexes].filter((index) => store.locationOf(index) === "missing");
    const said = `${fileIndex}:${missing.join(",")}`;
    if (missingSaid.get(torrent) !== said) {
      missingSaid.set(torrent, said);
      logger?.info?.(`held ranges of file ${fileIndex}: piece(s) ${missing.join(", ") || "none"} not in storage ` +
        `(${indexes.size} piece(s) asked, have=${missing.map((index) => torrent.bitfield?.get?.(index) ? 1 : 0).join("")})`);
    }
    return null;
  }
  try {
    const result = ranges.map(([start, end]) => Buffer.allocUnsafeSlow(end - start + 1));
    for (const [index, span] of pieceSpans) {
      const pieceStart = index * pieceLength;
      const offset = span.start - pieceStart;
      const length = span.end - span.start + 1;
      const buffer = await new Promise((resolve, reject) => {
        store.get(index, { offset, length }, (error, value) => {
          if (error) reject(error);
          else resolve(value);
        });
      });
      if (!buffer || buffer.length !== length) return null;
      for (const { rangeIndex, absoluteStart, absoluteEnd } of span.ranges) {
        const from = Math.max(absoluteStart, pieceStart);
        const to = Math.min(absoluteEnd, pieceStart + pieceLength - 1);
        const sourceStart = from - span.start;
        result[rangeIndex].set(buffer.subarray(sourceStart, sourceStart + to - from + 1), from - absoluteStart);
      }
    }
    return result;
  } catch (error) {
    logger?.info?.(`held ranges read ${fileIndex} failed: ${error?.message ?? error}`);
    return null;
  } finally {
    release();
  }
}
/**
 * Whether a buffer may be TRANSFERRED to another thread: it must be the whole of
 * a plain ArrayBuffer. A slice of the shared pool would take every other
 * buffer in the pool with it, and shared memory cannot be transferred at all.
 *
 * @param {unknown} bytes
 * @returns {boolean}
 */
export function ownsItsMemory(bytes) {
  return (
    bytes instanceof Uint8Array &&
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  );
}
