/**
 * @file What the supply's own interruptions require of a quality step, and of
 * the buffer in front of the viewer.
 *
 * Both figures are chosen by hand today — a speed margin of 1.5 and a 25-second
 * prebuffer — and both stand for a quantity that is measured every few seconds
 * anyway: how long a read waits for a piece, and how often that happens.
 *
 * The arithmetic, from the measurements of 2026-08-17:
 *
 *   A step producing at speed `v` gains `v - 1` seconds of cushion per second
 *   of playback. An interruption of `W` seconds costs `W`. So a step survives
 *   its own supply exactly when it can rebuild what one interruption takes
 *   before the next one arrives:
 *
 *       (v - 1) × T > W   ⇔   v > 1 + W / T
 *
 *   On the field torrent that day: waits of 1.49 s median, 3.16 s worst, one
 *   every 2.22 s → a required speed of 1.67 against the 1.5 chosen by hand, and
 *   against 1.05 actually measured, which is why it stalled. A copy running at
 *   8x gains 15.5 s between interruptions against 1.5-4.8 s lost, which is the
 *   same formula explaining why a copy never stalls.
 *
 *   The buffer follows from the same numbers: it must hold the segment being
 *   played, whole, plus the worst interruption that can arrive before it can be
 *   refilled — whichever source that interruption comes from.
 *
 *       B_min = segment duration + max(W_supply, D_production, T_transfer)
 *
 *   7-9 s on that torrent, against the 25 s in the browser today.
 *
 * Every term is measured, none is chosen, and the figures rise by themselves
 * when a session's interruptions grow — which is what makes lowering the buffer
 * safe. Pure: no torrent, no clock of its own, no state beyond the samples it
 * is given.
 */

/**
 * How many recent interruptions are kept per file. Enough for a median to mean
 * something, short enough that a swarm which has recovered is not judged by how
 * it behaved ten minutes ago.
 */
const SAMPLE_LIMIT = 24;

/**
 * A reading of one interruption: how long the reader waited, and when.
 *
 * @typedef {object} Interruption
 * @property {number} waitedMs
 * @property {number} at - Epoch milliseconds when the wait ENDED.
 */

/**
 * Add one interruption to a record, keeping only the recent ones.
 *
 * @param {Interruption[]} samples - Existing readings, oldest first.
 * @param {Interruption} interruption
 * @returns {Interruption[]} A new array; the input is not modified.
 */
export function withInterruption(samples, interruption) {
  const kept = Array.isArray(samples) ? samples : [];
  if (!Number.isFinite(interruption?.waitedMs) || !Number.isFinite(interruption?.at)) {
    return kept;
  }
  const next = [...kept, { waitedMs: Math.max(0, interruption.waitedMs), at: interruption.at }];
  return next.length > SAMPLE_LIMIT ? next.slice(next.length - SAMPLE_LIMIT) : next;
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * What the recent interruptions amount to.
 *
 * The interval between interruptions is measured between the readings
 * themselves, so a file that is read steadily and rarely blocked reports a long
 * interval and asks little of the step.
 *
 * @param {Interruption[]} samples
 * @returns {{ samples: number, medianWaitSeconds: number, worstWaitSeconds: number, medianGapSeconds: number }}
 */
export function summariseInterruptions(samples) {
  const readings = Array.isArray(samples) ? samples : [];
  if (readings.length === 0) {
    return { samples: 0, medianWaitSeconds: 0, worstWaitSeconds: 0, medianGapSeconds: 0 };
  }
  const waits = readings.map((entry) => entry.waitedMs / 1000);
  const gaps = [];
  for (let index = 1; index < readings.length; index += 1) {
    const gap = (readings[index].at - readings[index - 1].at) / 1000;
    if (gap > 0) {
      gaps.push(gap);
    }
  }
  return {
    samples: readings.length,
    medianWaitSeconds: median(waits),
    worstWaitSeconds: Math.max(...waits),
    medianGapSeconds: median(gaps)
  };
}

/**
 * The speed a step must run at to survive this supply, or null when the supply
 * has not interrupted often enough to say.
 *
 * Null is a real answer and must not be replaced by a number: with one reading
 * there is no interval at all, and inventing one is how a margin comes to be
 * chosen by hand again. A caller with no figure keeps whatever it used before
 * and says so.
 *
 * The worst wait is used rather than the median, because a step that only
 * survives the typical interruption stalls on the others — and a stall is what
 * the viewer sees, not an average.
 *
 * @param {{ samples: number, worstWaitSeconds: number, medianGapSeconds: number }} summary
 * @returns {number | null}
 */
export function requiredSpeedFrom(summary) {
  if (!summary || summary.samples < 2 || !(summary.medianGapSeconds > 0)) {
    return null;
  }
  return 1 + summary.worstWaitSeconds / summary.medianGapSeconds;
}

/**
 * The smallest buffer at which no spinner appears: the segment being played,
 * whole, plus the worst interruption that can arrive before it can be refilled.
 *
 * Each term is the worst OBSERVED over a recent window, and a term nobody has
 * measured contributes nothing rather than a guess.
 *
 * @param {{ segmentSeconds: number, supplySeconds?: number, productionSeconds?: number, transferSeconds?: number }} terms
 * @returns {number}
 */
export function minimumBufferSeconds(terms) {
  const segment = Number.isFinite(terms?.segmentSeconds) && terms.segmentSeconds > 0
    ? terms.segmentSeconds
    : 0;
  const worst = Math.max(
    Number.isFinite(terms?.supplySeconds) ? terms.supplySeconds : 0,
    Number.isFinite(terms?.productionSeconds) ? terms.productionSeconds : 0,
    Number.isFinite(terms?.transferSeconds) ? terms.transferSeconds : 0
  );
  return segment + Math.max(0, worst);
}
