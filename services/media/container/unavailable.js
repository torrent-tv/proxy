/**
 * @file Bytes that are not here yet, said as such.
 *
 * A container reads a file it does not hold: the bytes arrive off a swarm, in
 * whatever order the swarm delivers them. So every read has three outcomes —
 * the bytes, a statement the bytes make ("there is no Cues element"), and "the
 * bytes are not here yet" — and only the first two are facts about the file.
 *
 * Until 2026-10-01 the third came back as `null`, the same value the readers
 * return for "the element is absent". Every container then read a read that
 * had not arrived as an element that does not exist, and everything that
 * remembered a container's answer remembered that as a fact for the life of the
 * process: an embedded subtitle track planned with no clusters while its Cues
 * table was still downloading showed nothing for a whole session
 * (`research/subtitles-never-appear-2026-10-01.md`). The same shape was in the
 * container choice, the track table, the keyframe table, MP4's `moov` and AVI's
 * `idx1`.
 *
 * So a read that cannot be answered now THROWS this, and the rule for anything
 * that keeps an answer is one line: a value or a proven absence may be kept;
 * this may not.
 */

/** Thrown where the bytes a reading needs have not arrived. */
export class BytesUnavailable extends Error {
  /**
   * @param {number} start
   * @param {number} end - Inclusive.
   * @param {number} received - How many bytes the read did return.
   */
  constructor(start, end, received) {
    super(`bytes ${start}-${end} of the file are not available yet (${received} of ${end - start + 1} received)`);
    this.name = "BytesUnavailable";
    this.start = start;
    this.end = end;
    this.received = received;
  }
}

/**
 * Whether an error says "not here yet" rather than "something is wrong".
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isUnavailable(error) {
  return error instanceof BytesUnavailable || /** @type {any} */ (error)?.name === "BytesUnavailable";
}

/**
 * A reader that answers with every byte asked for, or throws.
 *
 * The range is clamped to the file first, so a reading that asks past the end
 * of a short file — a head window over a file smaller than the window — is
 * answered with what the file has, and that is complete. Anything shorter than
 * the clamped range is a read that did not finish: a stream that ended early,
 * a piece that is not downloaded, a store that could not serve it.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} read
 * @param {number} fileSize
 * @returns {(start: number, end: number) => Promise<Buffer>}
 */
export function strictReader(read, fileSize) {
  return async (start, end) => {
    const last = Math.min(end, fileSize - 1);
    if (!(start >= 0) || last < start) {
      return Buffer.alloc(0);
    }
    const bytes = await read(start, last);
    const wanted = last - start + 1;
    const received = bytes ? bytes.length : 0;
    if (received < wanted) {
      throw new BytesUnavailable(start, last, received);
    }
    return received === wanted ? bytes : bytes.subarray(0, wanted);
  };
}
