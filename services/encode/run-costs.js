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
   * What this host was measured to do at startup, before any viewer existed.
   *
   * WITHOUT IT BOTH FIGURES ARE ZERO AT A COLD OPEN, and zero does not read as
   * "not measured" — it reads as "free". The whole comparison the plan makes is
   * between leaving an encoder where it stands, which costs the remainder of its
   * warm-up, and moving it, which costs the killing plus a warm-up from the
   * beginning. Subtract one from the other and what is left is the killing plus
   * the time the run has already lived — the warm-up a move throws away. Set the
   * warm-up to zero and that difference collapses to zero as well: keeping and
   * moving cost exactly the same, the tie falls to position, and any advantage
   * however small wins. Field 2026-09-08: an encoder moved between two adjacent
   * numbers every half second, produced nothing, and was killed each time.
   *
   * Readings from real runs replace it as they arrive; this is where the plan
   * starts from, not where it stays.
   *
   * @type {{ firstByteWaitSec: number, killCostSec: number } | null}
   */
  #atStartup = null;

  /**
   * Take what the startup measurement found on this host.
   *
   * @param {{ firstByteWaitSec: number, killCostSec: number } | null} measured
   * @returns {void}
   */
  noteStartup(measured) {
    this.#atStartup =
      Number.isFinite(measured?.firstByteWaitSec) && measured.firstByteWaitSec > 0
        ? { firstByteWaitSec: measured.firstByteWaitSec, killCostSec: Math.max(0, measured.killCostSec ?? 0) }
        : null;
  }

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
    // MEASURED OR ABSENT, and absent is said as zero rather than as a guess.
    //
    // There was an `Infinity` here for a while, for the cost of a move, on the
    // reasoning that an unmeasured price must not license an irreversible act.
    // It was an exception in a model that needs none, and it is not required: a
    // first piece cannot appear faster than it takes to ENCODE one, and how fast
    // this host encodes is measured before any viewer exists. The floor is
    // derived from that where the arithmetic is, and every figure here stays a
    // plain reading or a plain zero.
    //
    // `firstByteWaitSec` is spawn to first piece, so it already contains one
    // piece's encoding. Whoever uses it separates the two, because the piece
    // costs more when encoders share the machine and the spawn does not.
    return {
      killCostSec: (middleOf(this.#dying) ?? 0) / 1000 || (this.#atStartup?.killCostSec ?? 0),
      firstByteWaitSec:
        (middleOf(this.#firstOutput) ?? 0) / 1000 || (this.#atStartup?.firstByteWaitSec ?? 0),
      samples: Math.min(this.#dying.length, this.#firstOutput.length)
    };
  }
}
