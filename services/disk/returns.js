/**
 * @file How long after material stops being read somebody asks for it again.
 *
 * The one term of "how long do we keep this" that nothing measures. Everything
 * else in that decision is a measured quantity — re-downloading a piece from
 * the swarm is ~1430 ms on the field host, re-making a segment is its own
 * encode time, and the disk has an owner that prices holding it. Only the
 * return is unknown, and `IDLE_KEEP_MS` is a guess standing in for it.
 *
 * IT IS MEASURABLE HERE AND NOWHERE ELSE. A session opened on an output whose
 * segments are still on disk IS a return, and its age is known exactly: the
 * store records when each output was last read. Nothing needs to be inferred.
 *
 * This changes no behaviour. It records, and says what it has seen once in a
 * while, so that after a week of ordinary use the period can be derived from
 * what viewers actually do instead of from what a period felt like.
 */

/** How many returns are kept. Enough to see a shape, few enough to say in a line. */
const KEPT = 200;

export class Returns {
  /** Ages in milliseconds, newest last. @type {number[]} */
  #ages = [];

  /** Sessions opened on material this proxy no longer had. */
  #cold = 0;

  /** Sessions opened on material that was still there. */
  #warm = 0;

  /**
   * Note a session being opened on an output.
   *
   * @param {object} params
   * @param {number | null} params.lastReadAt - When that output was last read,
   *   or null where this proxy has never held it.
   * @param {number} params.now
   * @returns {void}
   */
  note({ lastReadAt, now }) {
    if (!Number.isFinite(lastReadAt) || lastReadAt === null || lastReadAt <= 0) {
      this.#cold += 1;
      return;
    }
    this.#warm += 1;
    this.#ages.push(Math.max(0, now - /** @type {number} */ (lastReadAt)));
    while (this.#ages.length > KEPT) {
      this.#ages.shift();
    }
  }

  /**
   * What the returns look like, or null while there have been none.
   *
   * The MEDIAN and the LONGEST, because those are the two the period has to sit
   * between: shorter than the median throws away material half the returns
   * wanted, and longer than the longest keeps material no return has ever
   * reached.
   *
   * @returns {{ warm: number, cold: number, medianMs: number, longestMs: number } | null}
   */
  shape() {
    if (this.#ages.length === 0) {
      return null;
    }
    const sorted = [...this.#ages].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return {
      warm: this.#warm,
      cold: this.#cold,
      medianMs: sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
      longestMs: sorted[sorted.length - 1]
    };
  }

  /**
   * One line, for the log, or null while there is nothing to say.
   *
   * @param {number} keepMs - What is being kept for now, so the reading and the
   *   guess it will replace stand side by side.
   * @returns {string | null}
   */
  describe(keepMs) {
    const shape = this.shape();
    if (shape === null) {
      return null;
    }
    return (
      `returns: ${shape.warm} session(s) opened on material still held, ` +
      `${shape.cold} on material gone; median ${minutes(shape.medianMs)} after the last read, ` +
      `longest ${minutes(shape.longestMs)} — kept for ${minutes(keepMs)}`
    );
  }
}

/**
 * @param {number} ms
 * @returns {string}
 */
function minutes(ms) {
  return `${Math.round(ms / 60000)}min`;
}
