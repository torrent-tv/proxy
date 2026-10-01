/**
 * @file What of a file the torrent already HOLDS, and reading it without
 * asking the swarm for anything.
 *
 * Two questions, and both are the torrent's own: which pieces have arrived is
 * its bitfield, and reading a piece it has is its store. They are here because
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
 * Whole because a piece is the unit the swarm delivers and the unit the
 * bitfield counts: a range that is half a piece short cannot be read, so
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
  if (!file || !Number.isFinite(pieceLength) || pieceLength <= 0 || !torrent?.bitfield) {
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
    if (torrent.bitfield.get(index)) {
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
  if (!file || !Number.isFinite(pieceLength) || pieceLength <= 0 || !torrent?.bitfield) {
    return false;
  }
  const offset = Number(file.offset) || 0;
  const first = Math.floor((offset + start) / pieceLength);
  const last = Math.floor((offset + end) / pieceLength);
  for (let index = first; index <= last; index += 1) {
    if (!torrent.bitfield.get(index)) {
      return false;
    }
  }
  return true;
}

/**
 * How long a read of bytes the torrent HOLDS may take before it is taken to be
 * a fault.
 *
 * Not a measurement and nothing is derived from it: the bytes are checked to be
 * held before the read starts, so a read that does not finish is a store that
 * failed to serve what it has, and the line it writes says so. Until 2026-10-01
 * this read was started on bytes that had NOT arrived, the stream waited for
 * them, and this was the bound that gave it up — 36 such reads gave up at once
 * at a torrent's open, and one of them was the Cues table of the file being
 * watched.
 */
const READ_ABANDON_MS = 30_000;

/**
 * Read a byte range of a file straight from the store, without asking the swarm
 * for anything.
 *
 * Answered at once with null where any piece under the range has not arrived:
 * "not here" is the whole answer, and nothing is waited for or requested.
 *
 * The bytes come back in a buffer that owns its whole memory — not a slice of
 * Node's shared pool and not a view of the store's own blocks — so the reply can
 * hand that memory to the other thread instead of copying it, and nothing the
 * store or another read still uses goes with it.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {number} start
 * @param {number} end - Inclusive.
 * @param {{ info: Function }} [logger]
 * @returns {Promise<Buffer | null>}
 */
export function readHeldBytes(torrent, fileIndex, start, end, logger = null) {
  const file = torrent?.files?.[fileIndex];
  if (!file || !(end >= start) || !(start >= 0)) {
    return Promise.resolve(null);
  }
  const last = Math.min(end, Number(file.length) - 1);
  if (!isRangeHeld(torrent, fileIndex, start, last)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const chunks = [];
    let stream;
    try {
      stream = file.createReadStream({ start, end: last });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let abandon = null;
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (abandon !== null) {
        clearTimeout(abandon);
      }
      if (value === null) {
        stream.destroy?.();
      }
      resolve(value);
    };
    abandon = setTimeout(() => {
      logger?.info(
        `subtitles: a read of ${start}-${last} in "${String(file.name).slice(0, 40)}" ` +
        `was held but not served in ${READ_ABANDON_MS / 1000}s and was given up — the store failed to serve bytes it has`
      );
      settle(null);
    }, READ_ABANDON_MS);
    abandon.unref?.();
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => settle(ownedCopyOf(chunks)));
    stream.on("error", () => settle(null));
  });
}

/**
 * The chunks as one buffer over memory of its own.
 *
 * @param {Uint8Array[]} chunks
 * @returns {Buffer}
 */
function ownedCopyOf(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  // `allocUnsafeSlow` never takes from the shared pool, so the buffer is the
  // whole of its ArrayBuffer and may be transferred.
  const owned = Buffer.allocUnsafeSlow(total);
  let at = 0;
  for (const chunk of chunks) {
    owned.set(chunk, at);
    at += chunk.length;
  }
  return owned;
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
