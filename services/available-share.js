/**
 * @file How much of the machine a new encoder can actually have.
 *
 * The encoder benchmark measures a QUIET host: one ffmpeg, nothing else. A real
 * encode runs on a machine that is also downloading, hashing and serving, and
 * on the addon host that machine was measured 99 % busy — `ffmpeg=52-60%
 * proxy=17-24% system=99%` — while a step predicted at 1.83x ran at 1.01-1.12x
 * (2026-08-17).
 *
 * What this corrects is ONLY the part nobody has been charged for. That
 * distinction is the whole of the file, because the alternative has already
 * shipped once and broke the product: in 2.21.0 the budget ADDED what else was
 * running while the per-file costs were being LEARNED from runs that already
 * contained that other work, so every cost was counted twice, every re-encoded
 * step was refused, and the quality menu emptied itself down to the one copied
 * height (fixed in 2.21.1).
 *
 * So: our own encoders are priced by the concurrency arithmetic, and the
 * proxy's own work — the torrent, the hashing, the delivery — is priced per
 * megabyte moved. Both are already in the budget. What is NOT in it is
 * everything else the machine does: the kernel, the container runtime, whatever
 * else the owner runs on their box. That is what is subtracted here, and
 * nothing more.
 */

/**
 * The share of the machine available to a new encoder.
 *
 * @param {object} reading - Fractions of the WHOLE machine (all cores), as
 *   `shareOfMachine` reports them.
 * @param {number | null} reading.systemBusy - Everything the machine is doing.
 * @param {number | null} reading.encoderShare - Our own ffmpeg processes.
 * @param {number | null} reading.proxyShare - The proxy process itself.
 * @returns {{ share: number, unattributed: number, known: boolean }}
 *   `known` is false when the host does not report its own load — then the
 *   share is 1 and the caller must say it is uncorrected rather than pretend.
 */
export function availableShareFrom(reading = {}) {
  const systemBusy = finite(reading.systemBusy);
  if (systemBusy === null) {
    // No reading at all: not every host has /proc. An uncorrected prediction is
    // the honest answer, and the caller says so.
    return { share: 1, unattributed: 0, known: false };
  }
  const ours = (finite(reading.encoderShare) ?? 0) + (finite(reading.proxyShare) ?? 0);
  // Rounding, and the two readings being taken microseconds apart, can put our
  // own share fractionally above the system total. Below zero is not a
  // measurement of anything.
  const unattributed = clamp(systemBusy - ours, 0, 1);
  return { share: clamp(1 - unattributed, 0, 1), unattributed, known: true };
}

/**
 * Apply the correction to a predicted speed.
 *
 * A speed is work per unit time, so a machine that can give a new encoder only
 * `share` of itself produces `share ×` the speed the benchmark measured alone.
 *
 * @param {number} predictedSpeed - From the quiet-host benchmark.
 * @param {{ share: number, known: boolean }} availability
 * @returns {number}
 */
export function correctForAvailability(predictedSpeed, availability) {
  if (!Number.isFinite(predictedSpeed) || predictedSpeed <= 0) {
    return predictedSpeed;
  }
  if (!availability?.known) {
    return predictedSpeed;
  }
  return predictedSpeed * availability.share;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finite(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

/**
 * @param {number} value
 * @param {number} low
 * @param {number} high
 * @returns {number}
 */
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}
