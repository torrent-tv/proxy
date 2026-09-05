/**
 * @file What starting and stopping an encoder costs on THIS host.
 *
 * Two figures, and both are terms in the one decision anybody makes about a
 * running encoder: let it drive on through material that already exists, or
 * stop it and start another where the material is missing.
 *
 * Before this file neither was measured here. The start was a single reading
 * taken once on one machine and written into the code as a constant; the stop
 * and the wait for the first output were not counted at all, so the comparison
 * priced only one side of itself and always answered the same way.
 *
 * Readings are kept and read as their median: one starved start must not decide
 * the rule, and a host that has since become busy must be able to change the
 * answer.
 */

/**
 * How many recent readings a figure is taken from. The same reasoning as the
 * other learned figures in this proxy: long enough that one reading does not
 * move the answer, short enough that the answer still follows the host.
 */
const RECENT_READINGS = 20;

/**
 * The middle of a set of readings, or null when there are none.
 *
 * Written here rather than borrowed from the general helper one level up: this
 * layer states facts and imports nothing above itself, and four lines of
 * arithmetic are not worth breaking that for.
 *
 * @param {number[]} values
 * @returns {number | null}
 */
function middleOf(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export class RunCosts {
  /** How long dying took, in milliseconds. @type {number[]} */
  #dying = [];

  /** How long the first output took to appear, in milliseconds. @type {number[]} */
  #firstOutput = [];

  /**
   * Take the two readings a finished run carries. Either may be absent — a run
   * that was never told to stop did not die on command, and one that produced
   * nothing has no first output — and an absent reading is not a zero.
   *
   * @param {{ dyingMs?: number | null, firstOutputMs?: number | null }} ended
   */
  note(ended) {
    if (Number.isFinite(ended?.dyingMs)) {
      RunCosts.#keep(this.#dying, /** @type {number} */ (ended.dyingMs));
    }
    if (Number.isFinite(ended?.firstOutputMs)) {
      RunCosts.#keep(this.#firstOutput, /** @type {number} */ (ended.firstOutputMs));
    }
  }

  /**
   * @param {number[]} readings
   * @param {number} value
   */
  static #keep(readings, value) {
    readings.push(value);
    while (readings.length > RECENT_READINGS) {
      readings.shift();
    }
  }

  /**
   * The two costs in seconds, from this host's own readings.
   *
   * Zero where nothing has been measured yet. Zero understates both, so a plan
   * that has no readings prices moving an encoder as cheaper than it is — which
   * is why the plan keeps a run it cannot compare rather than moving it.
   *
   * @returns {{ killCostSec: number, firstByteWaitSec: number, samples: number }}
   */
  seconds() {
    return {
      killCostSec: (middleOf(this.#dying) ?? 0) / 1000,
      firstByteWaitSec: (middleOf(this.#firstOutput) ?? 0) / 1000,
      samples: Math.min(this.#dying.length, this.#firstOutput.length)
    };
  }
}
