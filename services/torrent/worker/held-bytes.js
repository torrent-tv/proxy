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
 * How long a read of bytes the torrent already holds may take before it is
 * given up.
 *
 * Not a measurement and nothing is derived from it: such a read either answers
 * or it does not, and this is the point past which it is presumed lost — so
 * that one stream which never ends cannot hold a file's walk, and with it the
 * browser's own request for its subtitles, for the rest of the session.
 */
const READ_ABANDON_MS = 30_000;

/**
 * Read a byte range of a file straight from the store, without asking the swarm
 * for anything.
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
        `did not finish in ${READ_ABANDON_MS / 1000}s and was given up`
      );
      settle(null);
    }, READ_ABANDON_MS);
    abandon.unref?.();
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => settle(Buffer.concat(chunks)));
    stream.on("error", () => settle(null));
  });
}
