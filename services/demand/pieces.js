/**
 * @file The one place bytes become piece numbers.
 *
 * Everything else counts in bytes. A piece is what the protocol hashes and what
 * memory is allocated in, and nothing outside these functions should have to
 * know its length. Before 2026-09-02 the division was done in three places —
 * the memory allowance, the reader's window, the eviction ceiling — each
 * rounding down on its own, and the rounding was where a real failure lived:
 * with 16 MiB pieces a 64 MB allowance is four places while two readers asking
 * for 96 MB each want six, and the shortage was invisible because both figures
 * had already been floored.
 *
 * Pure arithmetic on numbers: no torrent, no file object, nothing to stub.
 */

/**
 * The pieces that hold a byte range of a file.
 *
 * Inclusive at both ends, because a byte range that ends inside a piece still
 * needs that whole piece: the protocol delivers and verifies nothing smaller.
 *
 * @param {object} params
 * @param {number} params.fileOffset - Where the file starts within the torrent.
 * @param {number} params.byteStart - First byte wanted, relative to the file.
 * @param {number} params.byteEnd - Last byte wanted, relative to the file.
 * @param {number} params.pieceLength
 * @returns {{ from: number, to: number } | null} Null when the range is not a
 *   range, or the piece length is not usable.
 */
export function piecesOf({ fileOffset, byteStart, byteEnd, pieceLength }) {
  if (!Number.isFinite(pieceLength) || pieceLength <= 0) {
    return null;
  }
  if (!Number.isFinite(fileOffset) || fileOffset < 0) {
    return null;
  }
  if (!Number.isFinite(byteStart) || !Number.isFinite(byteEnd) || byteEnd < byteStart) {
    return null;
  }
  return {
    from: Math.floor((fileOffset + Math.max(0, byteStart)) / pieceLength),
    to: Math.floor((fileOffset + byteEnd) / pieceLength)
  };
}

/**
 * The bytes of a file that a piece range covers, clamped to the file.
 *
 * The inverse of {@link piecesOf}, and here for the same reason: a caller that
 * still thinks in pieces — the reader, which walks a file piece by piece
 * because that is what arrives — states its need in bytes like everyone else,
 * and the conversion stays in this one file rather than being written out
 * again at the boundary.
 *
 * @param {object} params
 * @param {number} params.fileOffset - Where the file starts within the torrent.
 * @param {number} params.fileLength
 * @param {number} params.from - First piece, inclusive.
 * @param {number} params.to - Last piece, inclusive.
 * @param {number} params.pieceLength
 * @returns {{ byteStart: number, byteEnd: number } | null}
 */
export function bytesOf({ fileOffset, fileLength, from, to, pieceLength }) {
  if (!Number.isFinite(pieceLength) || pieceLength <= 0) {
    return null;
  }
  if (!Number.isFinite(fileOffset) || !Number.isFinite(fileLength) || fileLength <= 0) {
    return null;
  }
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
    return null;
  }
  const byteStart = Math.max(0, from * pieceLength - fileOffset);
  const byteEnd = Math.min(fileLength - 1, (to + 1) * pieceLength - 1 - fileOffset);
  return byteEnd < byteStart ? null : { byteStart, byteEnd };
}

/**
 * How many pieces a number of bytes needs, at worst.
 *
 * At worst, because a range of one byte can still straddle two pieces. Used
 * where a budget in bytes has to be turned into places, and rounding the other
 * way would promise room that is not there.
 *
 * @param {number} bytes
 * @param {number} pieceLength
 * @returns {number}
 */
export function piecesNeededFor(bytes, pieceLength) {
  if (!Number.isFinite(pieceLength) || pieceLength <= 0 || !Number.isFinite(bytes) || bytes <= 0) {
    return 0;
  }
  return Math.ceil(bytes / pieceLength) + 1;
}

/**
 * How many whole pieces fit in a number of bytes.
 *
 * The other direction, and it rounds DOWN: a budget buys only the places it can
 * pay for in full.
 *
 * @param {number} bytes
 * @param {number} pieceLength
 * @returns {number}
 */
export function piecesWithin(bytes, pieceLength) {
  if (!Number.isFinite(pieceLength) || pieceLength <= 0 || !Number.isFinite(bytes) || bytes <= 0) {
    return 0;
  }
  return Math.floor(bytes / pieceLength);
}

/**
 * Split a byte range into a few ranges, nearest to a point first.
 *
 * For the gap behind the playhead. WebTorrent walks a selection from its start
 * upwards — `for (piece = next.from + next.offset; piece <= next.to; piece++)` —
 * so one claim over everything behind the viewer would be fetched from the
 * beginning of the file, which is the end furthest from where a backward seek
 * would land. Split, and the part nearest the playhead is stated first.
 *
 * @param {object} params
 * @param {number} params.byteStart - First byte of the gap.
 * @param {number} params.byteEnd - Last byte of the gap, nearest the playhead.
 * @param {number} params.parts - How many ranges to split into.
 * @returns {Array<{ byteStart: number, byteEnd: number }>} Nearest first.
 */
export function nearestFirst({ byteStart, byteEnd, parts }) {
  if (!Number.isFinite(byteStart) || !Number.isFinite(byteEnd) || byteEnd < byteStart) {
    return [];
  }
  const count = Number.isInteger(parts) && parts > 0 ? parts : 1;
  const total = byteEnd - byteStart + 1;
  const each = Math.ceil(total / count);
  const ranges = [];
  for (let end = byteEnd; end >= byteStart; end -= each) {
    ranges.push({ byteStart: Math.max(byteStart, end - each + 1), byteEnd: end });
  }
  return ranges;
}
