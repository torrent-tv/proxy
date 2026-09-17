/**
 * @file One stated need: bytes of one file, by one claimant, at one urgency.
 *
 * **Bytes, not pieces.** A piece is how the protocol verifies data and how
 * memory is allocated; it is not the unit anything else should count in.
 * Counting in pieces means dividing and rounding down at every boundary, and
 * that rounding is where a real failure lives: with 16 MiB pieces a 64 MB
 * allowance is four places, while two readers asking for 96 MB each want six —
 * every resident piece then ends up pinned, the read returns zero bytes, and
 * ffmpeg takes that for the end of the file. In bytes the shortage is plain;
 * in pieces it is hidden behind a floor. The single conversion lives in
 * `pieces.js`.
 */

/**
 * A range of one file that somebody says they will need.
 */
export class Window {
  /**
   * @param {object} params
   * @param {string} params.claimant - Who states it. A release names this, so a
   *   stray release matches nothing rather than cancelling somebody else's
   *   need.
   * @param {number} params.fileIndex - Which file of the torrent.
   * @param {number} params.byteStart - First byte, inclusive.
   * @param {number} params.byteEnd - Last byte, inclusive.
   * @param {number} params.urgency - A value of {@link import("./Urgency.js").Urgency}.
   */
  constructor({ claimant, fileIndex, byteStart, byteEnd, urgency }) {
    if (typeof claimant !== "string" || claimant.length === 0) {
      throw new Error("A window needs a claimant to release it by.");
    }
    if (!Number.isInteger(fileIndex) || fileIndex < 0) {
      throw new Error(`File index must be a non-negative integer, got ${fileIndex}.`);
    }
    if (!Number.isInteger(byteStart) || byteStart < 0) {
      throw new Error(`Byte start must be a non-negative integer, got ${byteStart}.`);
    }
    if (!Number.isInteger(byteEnd) || byteEnd < byteStart) {
      throw new Error(`Byte end must be an integer at or after ${byteStart}, got ${byteEnd}.`);
    }
    if (!Number.isInteger(urgency) || urgency < 0) {
      throw new Error(`Urgency must be a non-negative integer, got ${urgency}.`);
    }
    this.claimant = claimant;
    this.fileIndex = fileIndex;
    this.byteStart = byteStart;
    this.byteEnd = byteEnd;
    this.urgency = urgency;
    Object.freeze(this);
  }

  /** How many bytes this window covers. */
  get byteLength() {
    return this.byteEnd - this.byteStart + 1;
  }

  /**
   * Whether two windows cover any of the same bytes of the same file.
   *
   * @param {Window} other
   * @returns {boolean}
   */
  overlaps(other) {
    return this.fileIndex === other.fileIndex
      && this.byteStart <= other.byteEnd
      && other.byteStart <= this.byteEnd;
  }

  /**
   * Whether two windows are the same statement — same file, same bytes, same
   * urgency, same claimant.
   *
   * @param {Window} other
   * @returns {boolean}
   */
  equals(other) {
    return other instanceof Window
      && this.claimant === other.claimant
      && this.fileIndex === other.fileIndex
      && this.byteStart === other.byteStart
      && this.byteEnd === other.byteEnd
      && this.urgency === other.urgency;
  }

  /** @returns {string} */
  toString() {
    return `${this.claimant} wants ${this.fileIndex}:${this.byteStart}-${this.byteEnd}`;
  }
}

/**
 * The union of a set of ranges of ONE file, in order, with touching and
 * overlapping ones merged.
 *
 * The union and not the sum: a viewer's picture and sound are read by two
 * readers of the same file whose windows overlap by construction, and adding
 * them would report a demand that is not there.
 *
 * @param {Array<{ byteStart: number, byteEnd: number }>} ranges
 * @returns {Array<{ byteStart: number, byteEnd: number }>}
 */
export function unionOf(ranges) {
  const sorted = [...ranges].sort((left, right) => left.byteStart - right.byteStart);
  /** @type {Array<{ byteStart: number, byteEnd: number }>} */
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    // `+ 1` because ranges are inclusive: 0-99 and 100-199 are one run of 200
    // bytes, not two runs with nothing between them.
    if (last && range.byteStart <= last.byteEnd + 1) {
      last.byteEnd = Math.max(last.byteEnd, range.byteEnd);
      continue;
    }
    merged.push({ byteStart: range.byteStart, byteEnd: range.byteEnd });
  }
  return merged;
}
