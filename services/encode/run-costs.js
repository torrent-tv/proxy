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
   * @param {{ dyingMs?: number | null, firstOutputMs?: number | null,
   *   livedMs?: number | null }} ended - `livedMs` is how long a run that
   *   produced NOTHING was alive, which is a lower bound on the first output.
   */
  note(ended) {
    // A RUN THAT PRODUCED NOTHING IS A MEASUREMENT TOO — of a lower bound. It
    // says the first output takes at least as long as this run lived, which is
    // a fact and not an estimate, and it is the only reading a thrash can
    // supply: every run in one is killed before it finishes anything.
    //
    // Without it the figure that prices a move could only ever be learned from
    // runs that survived, so the state in which moves are ruinous was exactly
    // the state in which their cost stayed unknown.
    if (!Number.isFinite(ended?.firstOutputMs) && Number.isFinite(ended?.livedMs) && ended.livedMs > 0) {
      RunCosts.#keep(this.#firstOutput, /** @type {number} */ (ended.livedMs));
    }
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
    const dying = middleOf(this.#dying);
    const first = middleOf(this.#firstOutput);
    return {
      // UNKNOWN IS NOT ZERO, and for a cost it is not a small number either: it
      // is the figure that makes the act it prices never worth doing. Reported
      // as 0, an unmeasured move was FREE in the plan's arithmetic, so any gain
      // however small justified it — and moving an encoder is irreversible,
      // because the process it kills cannot be un-killed.
      //
      // The blindness was self-sustaining: `#firstOutput` only takes a reading
      // from a run that produced something, and a run killed 0.8 s after
      // starting produces nothing. So a thrash prevented the measurement that
      // would have stopped it. Field 2026-09-08: 39 moves in one session, 24 of
      // them between three adjacent numbers — #58 to #59, #59 to #58, #58 to
      // #60, #60 to #58, six times each — while the picture stood still for
      // 116.7 s.
      //
      // TWO QUESTIONS, NOT ONE, and they take the unknown differently.
      //
      // PLACING an encoder where there is none has no alternative: the film gets
      // made or it does not. So an unmeasured cost must not stand in the way,
      // and the honest figure is what has been measured or nothing.
      //
      // MOVING one has an alternative — leave it alone — and it is
      // irreversible, because the process it kills cannot be un-killed. There
      // an unmeasured cost must not license the act, and `Infinity` is the
      // identity of the comparison that consumes it: "nobody has measured what
      // this costs" and "never worth doing" are the same statement about an
      // action whose price is unknown.
      //
      // Reported as 0 for both, an unmeasured move was FREE in the plan's
      // arithmetic, so a gain of a fraction of a second justified it. And the
      // blindness was self-sustaining: `#firstOutput` takes a reading only from
      // a run that produced something, and every run in a thrash is killed
      // before it finishes anything.
      killCostSec: (dying ?? 0) / 1000,
      firstByteWaitSec: (first ?? 0) / 1000,
      moveCostSec:
        first === null
          ? Number.POSITIVE_INFINITY
          : ((dying ?? 0) + first) / 1000,
      samples: Math.min(this.#dying.length, this.#firstOutput.length)
    };
  }
}
