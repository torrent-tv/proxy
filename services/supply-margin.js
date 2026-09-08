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
 *   W — how long the supply is INTERRUPTED (the worst recent stall);
 *   T — how long the encoder RUNS between two stalls (the median recent gap).
 *
 * Both words are load-bearing, and getting either wrong is what produced a
 * demanded speed of 4422x on 2026-08-31.
 *
 * A stall is not a wait. Several readers walk one file — the picture and each
 * audio rendition — so a piece that has not arrived blocks all of them, and
 * their waits end within milliseconds of each other. Counted as separate
 * interruptions they gave an interval of 0.00 s. Waits are therefore merged into
 * the stretches during which the supply was not delivering, however many readers
 * noticed.
 *
 * And T is the RUNNING time, from the end of one stall to the start of the next
 * — not the spacing between their ends, which includes a stall's own duration
 * and so credits the encoder with cushion it was not building.
 *
 * **The margin.** A step producing at speed `v` gains `v - 1` seconds of
 * cushion for every second it runs, and an interruption of `W` seconds costs
 * `W`. It therefore survives its own supply only if what it gains between
 * interruptions exceeds what one costs:
 *
 *     (v - 1) × T > W        i.e.        v > 1 + W / T
 *
 * On the field torrent: stalls of 1.49 s with 0.73 s of running between them,
 * the worst 3.16 s, so the honest bar is 5.33 — against the 1.5 that was
 * assumed, and the 1.05 that was measured. (An earlier reading of the same data
 * gave 2.42 by using the end-to-end spacing; it was too low in the same
 * direction as the guess it replaced.) The same arithmetic explains why a copied
 * stream never stalls: at 8x it gains 10.7 s between stalls and loses at most
 * 4.8 s.
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
  // One INTERRUPTION, not one wait. Several readers walk the same file — the
  // picture and each audio rendition — and a piece that has not arrived blocks
  // all of them at once. Counted as separate interruptions, those simultaneous
  // waits gave a near-zero interval and therefore a required speed of thousands:
  // measured 2026-08-31, `worst wait 13.26s, one every 0.00s, 2 measured` became
  // 4422.00x, and every quality step was refused against it.
  const interruptions = mergeOverlapping(ordered);
  if (interruptions.length < 2) {
    // One interruption shows no interval, and an interval invented from one
    // point is exactly what this file exists to remove.
    return null;
  }
  const worstWaitSec = Math.max(...interruptions.map((one) => one.end - one.start)) / 1000;
  const intervals = [];
  for (let index = 1; index < interruptions.length; index += 1) {
    // From the END of one interruption to the START of the next: that is the
    // stretch the encoder actually runs for and builds cushion in. Measuring
    // end-to-end instead counted each interruption's own duration as part of
    // the recovery it is supposed to be recovered from.
    const gapMs = interruptions[index].start - interruptions[index - 1].end;
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
  // THE SHARE OF ITS TIME THE READING LOST, over the stretch actually observed.
  //
  // The model is unchanged and it was always right: if a fraction `f` of the
  // time is spent not delivering, then producing one second of film takes
  // `1/(1 - f)` seconds, so a step must run that much faster than realtime.
  // What was wrong was the two quantities fed into it — the WORST single
  // interruption divided by the MEDIAN gap between interruptions, a maximum
  // over a median, from two populations that need not be the same events at
  // all. It asks what would happen if the worst interruption recurred at the
  // typical rate, which is a compound case that never occurs, and it divides by
  // a gap that goes to zero whenever interruptions arrive in a burst.
  //
  // Field 2026-09-08: 0.79 s (one jump, on a file already downloaded whole)
  // over 0.01 s (the gaps inside a burst of microsecond waits) gave 158.60x,
  // and the quality budget refused every step against it forty times in one
  // session. The same measurements as a share of time lost give 1.00x, because
  // that is what a reading of a complete file loses.
  //
  // The denominator here cannot vanish: it is the span the interruptions are
  // spread over, which contains them.
  // OVER WHOLE CYCLES, from the first interruption's start to the last one's
  // start. That window holds exactly one running stretch per interruption in
  // it, so the share does not depend on where the window happens to be cut —
  // measured to the last interruption's END it counts one interruption more
  // than it counts running stretches, and the same supply then reads 1.54x or
  // 1.45x according to nothing but the moment the log line was printed.
  const last = interruptions.length - 1;
  const spanSec = (interruptions[last].start - interruptions[0].start) / 1000;
  const lostSec = interruptions
    .slice(0, last)
    .reduce((total, one) => total + (one.end - one.start), 0) / 1000;
  // A span that is all interruption says the supply delivered nothing at all
  // while it was watched. There is no speed that survives that, and saying a
  // huge number is less honest than saying it is not a speed question — so the
  // largest figure any step is ever compared against is stated and named.
  const lostShare = spanSec > 0 ? Math.min(0.99, lostSec / spanSec) : 0;
  return {
    requiredSpeed: 1 / (1 - lostShare),
    lostShare,
    spanSec,
    lostSec,
    worstWaitSec,
    medianIntervalSec,
    // Interruptions, not waits: what the figure is derived from. The two differ
    // whenever more than one reader walks the file, and reporting the raw count
    // is what made the 4422x line look better evidenced than it was — "24
    // measured" was 24 waits over far fewer actual stalls.
    samples: interruptions.length,
    waits: ordered.length
  };
}

/**
 * Waits joined into the interruptions they actually were.
 *
 * A wait spans `[at - waitedMs, at]`. Two that overlap or touch are one stretch
 * during which the supply was not delivering, however many readers noticed it.
 *
 * @param {SupplyWait[]} ordered - Usable waits, oldest END first.
 * @returns {Array<{ start: number, end: number }>} Disjoint, in time order.
 */
function mergeOverlapping(ordered) {
  const spans = ordered
    .map((wait) => ({ start: wait.at - wait.waitedMs, end: wait.at }))
    .sort((left, right) => left.start - right.start);
  /** @type {Array<{ start: number, end: number }>} */
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
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
