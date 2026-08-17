/**
 * @file What speed a step must run at, and how much buffer a viewer needs —
 * both derived from the supply's own interruptions rather than chosen by hand.
 *
 * The two numbers this replaces were guesses. The speed margin was 1.5, and on
 * the field session of 2026-08-17 a step admitted by it ran at 1.05x and
 * stalled; the pre-buffer target was 25 s, which is sixteen seconds of waiting
 * before the picture starts that nobody had shown to be necessary.
 *
 * Both follow from the same two measured quantities, and from nothing else:
 *
 *   W — how long a read waits for a piece it needs (the worst recent one);
 *   T — how long there is between such waits (the median recent interval).
 *
 * **The margin.** A step producing at speed `v` gains `v - 1` seconds of
 * cushion for every second it runs, and an interruption of `W` seconds costs
 * `W`. It therefore survives its own supply only if what it gains between
 * interruptions exceeds what one costs:
 *
 *     (v - 1) × T > W        i.e.        v > 1 + W / T
 *
 * On the field torrent: waits every 2.22 s, worst 3.16 s, so the honest bar is
 * 2.42 — against the 1.5 that was assumed, and the 1.05 that was measured. The
 * same arithmetic explains why a copied stream never stalls: at 8x it gains
 * 15.5 s between interruptions and loses at most 4.8 s.
 *
 * **The buffer.** It must cover the worst interruption that can arrive before
 * it can be refilled, whichever source that interruption comes from, plus the
 * segment being played — which must be whole:
 *
 *     B = segment duration + max(W_supply, D_production, T_transfer)
 *
 * On the same session that is 7-9 s rather than 25. It rises by itself when a
 * session's interruptions grow, which is what makes it safe to lower: the
 * figure is continuously measured, not chosen once.
 *
 * Every quantity here is measured. Nothing in this file is a coefficient, and
 * nothing smooths, weights or decays anything.
 */

/**
 * One measured interruption: how long a read waited, and when the wait ended.
 *
 * @typedef {object} SupplyWait
 * @property {number} waitedMs - How long the read was blocked.
 * @property {number} at - Wall-clock ms when the wait ended.
 */

/**
 * The speed a step must sustain to survive this file's supply on this swarm.
 *
 * Returns null when the evidence does not exist yet — fewer than two waits
 * means no interval has been observed, and an interval invented from one point
 * would be exactly the kind of number this file exists to remove. A caller with
 * null must say it does not know, never substitute a default.
 *
 * @param {SupplyWait[]} waits - Recent waits, in any order.
 * @returns {{ requiredSpeed: number, worstWaitSec: number, medianIntervalSec: number, samples: number } | null}
 */
export function requiredSpeedFrom(waits) {
  const ordered = usableWaits(waits);
  if (ordered.length < 2) {
    return null;
  }
  const worstWaitSec = Math.max(...ordered.map((wait) => wait.waitedMs)) / 1000;
  const intervals = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const gapMs = ordered[index].at - ordered[index - 1].at;
    if (gapMs > 0) {
      intervals.push(gapMs / 1000);
    }
  }
  if (intervals.length === 0) {
    return null;
  }
  const medianIntervalSec = median(intervals);
  if (!(medianIntervalSec > 0)) {
    return null;
  }
  return {
    requiredSpeed: 1 + worstWaitSec / medianIntervalSec,
    worstWaitSec,
    medianIntervalSec,
    samples: ordered.length
  };
}

/**
 * The smallest buffer at which no interruption reaches the viewer.
 *
 * Each term is the worst OBSERVED value over a recent window, and a term with
 * nothing observed contributes nothing rather than a guess. The segment is
 * always included: the one being played has to be whole.
 *
 * @param {object} observed
 * @param {number} observed.segmentSeconds - The session's segment duration.
 * @param {number} [observed.worstSupplyWaitSec] - Longest wait for a piece.
 * @param {number} [observed.worstProductionGapSec] - Longest gap between
 *   consecutive segments beyond their own length: what a step at 1.0x costs.
 * @param {number} [observed.worstTransferSec] - Longest time to move one
 *   segment over the channel to the viewer.
 * @returns {{ seconds: number, from: string } | null} Null when the segment
 *   duration is unknown, since then nothing here can be stated.
 */
export function minimumBufferFrom(observed = {}) {
  const segmentSeconds = Number(observed.segmentSeconds);
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) {
    return null;
  }
  const terms = [
    { name: "supply", seconds: positiveOrZero(observed.worstSupplyWaitSec) },
    { name: "production", seconds: positiveOrZero(observed.worstProductionGapSec) },
    { name: "transfer", seconds: positiveOrZero(observed.worstTransferSec) }
  ];
  const worst = terms.reduce(
    (largest, term) => (term.seconds > largest.seconds ? term : largest),
    { name: "none", seconds: 0 }
  );
  return {
    seconds: segmentSeconds + worst.seconds,
    // Which interruption sets the figure, so a session's log says what the
    // viewer is actually waiting for rather than only how long.
    from: worst.name
  };
}

/**
 * Waits that can be reasoned about, oldest first.
 *
 * @param {SupplyWait[]} waits
 * @returns {SupplyWait[]}
 */
function usableWaits(waits) {
  if (!Array.isArray(waits)) {
    return [];
  }
  return waits
    .filter((wait) => Number.isFinite(wait?.waitedMs) && wait.waitedMs > 0 && Number.isFinite(wait?.at))
    .sort((left, right) => left.at - right.at);
}

/**
 * @param {number[]} values - Non-empty.
 * @returns {number}
 */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function positiveOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}
