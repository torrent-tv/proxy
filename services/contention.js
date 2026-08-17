/**
 * @file What a second job costs on this machine — measured, because it is not
 * the sum of two prices.
 *
 * Measured on the addon host 2026-08-18, decoding the same clip:
 *
 * | what else was running | decode speed | cost |
 * |---|---|---|
 * | nothing (cold) | 2.10-2.25x | 0.46 s/s |
 * | nothing (hot, 68 °C) | 2.30-2.33x | 0.43 s/s |
 * | one encoder | 0.79-0.90x | 1.18 s/s |
 * | two encoders | 0.56-0.64x | 1.67 s/s |
 *
 * The same work costs **2.6× more** with one encoder beside it and 3.7× with
 * two. Heat is not the cause — the hot idle machine was the fastest of all.
 * Four cores share one narrow path to memory, and decoding and encoding both
 * saturate it.
 *
 * That contradicts the shape of the budget, not just its constants. Everything
 * in the quality offer adds seconds of work per second of content — this
 * encode, plus that decode, plus what is already committed — and these readings
 * say two jobs that each fit alone do not fit together. The availability
 * correction in `available-share.js` does not cover it either: that subtracts
 * the share of the machine taken by work nobody has been charged for, while
 * this is our own work colliding with itself.
 *
 * So the penalty is measured rather than derived, at startup, on the host it
 * describes — and beyond the range that was measured it does not extrapolate:
 * it holds the largest reading and says so, because nothing here knows what a
 * fourth job would do.
 */

/**
 * Penalties measured on this host, keyed by how many OTHER jobs were running.
 *
 * @typedef {Map<number, number>} ContentionPenalties
 */

/**
 * The multiplier for a job's cost when `othersRunning` other jobs share the
 * machine.
 *
 * @param {number} othersRunning
 * @param {ContentionPenalties | null} measured
 * @returns {{ penalty: number, measured: boolean, from: number }}
 *   `from` is the reading it came from — equal to `othersRunning` when one was
 *   measured for exactly that many, and the largest available otherwise.
 */
export function contentionPenalty(othersRunning, measured) {
  const others = Number.isFinite(othersRunning) ? Math.max(0, Math.round(othersRunning)) : 0;
  if (others === 0) {
    // Alone on the machine is what every benchmark measures, so there is
    // nothing to correct.
    return { penalty: 1, measured: true, from: 0 };
  }
  if (!(measured instanceof Map) || measured.size === 0) {
    // Nothing measured: the honest multiplier is 1, and the caller's own log
    // says the prediction is uncorrected. Inventing a penalty would be the
    // same mistake as inventing a fill rate.
    return { penalty: 1, measured: false, from: 0 };
  }
  const exact = measured.get(others);
  if (Number.isFinite(exact) && exact > 0) {
    return { penalty: exact, measured: true, from: others };
  }
  // Beyond what was measured, hold the largest reading rather than continue the
  // curve. Two readings say nothing about the shape past them, and a budget
  // that extrapolates a memory bottleneck will be wrong in whichever direction
  // it guesses.
  let largestKey = 0;
  let largestValue = 1;
  for (const [key, value] of measured) {
    if (key <= others && key > largestKey && Number.isFinite(value) && value > 0) {
      largestKey = key;
      largestValue = value;
    }
  }
  if (largestKey === 0) {
    return { penalty: 1, measured: false, from: 0 };
  }
  return { penalty: largestValue, measured: true, from: largestKey };
}

/**
 * A cost, corrected for what else will be running.
 *
 * @param {number} costSecondsPerSecond - As the benchmarks priced it, alone.
 * @param {number} othersRunning
 * @param {ContentionPenalties | null} measured
 * @returns {number}
 */
export function costWithContention(costSecondsPerSecond, othersRunning, measured) {
  if (!Number.isFinite(costSecondsPerSecond) || costSecondsPerSecond <= 0) {
    return costSecondsPerSecond;
  }
  return costSecondsPerSecond * contentionPenalty(othersRunning, measured).penalty;
}

/**
 * Turn measured decode speeds into penalties.
 *
 * @param {number} aloneSpeed - Decode speed with the machine to itself.
 * @param {Array<{ others: number, speed: number }>} beside - One reading per
 *   number of other jobs running.
 * @returns {ContentionPenalties | null} Null when the alone reading is missing,
 *   since every penalty is relative to it.
 */
export function penaltiesFrom(aloneSpeed, beside) {
  if (!Number.isFinite(aloneSpeed) || aloneSpeed <= 0) {
    return null;
  }
  const penalties = new Map();
  for (const reading of Array.isArray(beside) ? beside : []) {
    const others = Number.isFinite(reading?.others) ? Math.round(reading.others) : null;
    const speed = Number(reading?.speed);
    if (others === null || others <= 0 || !Number.isFinite(speed) || speed <= 0) {
      continue;
    }
    // Cost is the reciprocal of speed, so the penalty is the reciprocal ratio.
    // A job that runs at half the speed costs twice as much.
    const penalty = aloneSpeed / speed;
    // Below 1 would mean the machine got FASTER for being busier. It happens in
    // the noise on a fast host, and it is not a discovery — it is a reading
    // that says there is no penalty to measure here.
    penalties.set(others, penalty > 1 ? penalty : 1);
  }
  return penalties.size > 0 ? penalties : null;
}
