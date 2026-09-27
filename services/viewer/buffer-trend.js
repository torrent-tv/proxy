/**
 * @file Which way a viewer's buffer is going, from what their page said about
 * it (roadmap item 98).
 *
 * The buffer does not move smoothly: it rises a whole segment at a time when a
 * segment arrives and falls a second per second while the picture plays. So one
 * reading against the next says nothing — it catches either the rise or the
 * fall. The trend is taken over the SHORTEST run of recent readings that spans
 * at least one segment's duration, which is the period of that rise and fall,
 * and fitted by least squares. Nothing here is chosen: the span is the segment
 * duration of the output the viewer watches, and the caller supplies it.
 *
 * Fewer than two readings, or readings that do not yet span one segment, say
 * nothing, and the answer is null.
 */

/**
 * @typedef {{ at: number, seconds: number }} BufferReading - When the page said
 *   it (ms) and the seconds of film it held.
 */

/**
 * The index of the oldest reading of the shortest run, ending at the newest,
 * whose time span is at least `spanSec`; -1 when no run spans it.
 *
 * @param {BufferReading[]} readings - Oldest first.
 * @param {number} spanSec
 * @returns {number}
 */
export function trendRunStart(readings, spanSec) {
  if (!Array.isArray(readings) || readings.length < 2 || !(spanSec > 0)) {
    return -1;
  }
  const newest = readings[readings.length - 1].at;
  for (let index = readings.length - 2; index >= 0; index -= 1) {
    if ((newest - readings[index].at) / 1000 >= spanSec) {
      return index;
    }
  }
  return -1;
}

/**
 * The buffer's trend in seconds of film per second of time — negative while it
 * is draining — and the interval between the viewer's last two reports, which
 * is how long it will be before this viewer is heard from again.
 *
 * @param {BufferReading[]} readings - Oldest first.
 * @param {number} spanSec - The segment duration of the output they watch.
 * @returns {{ slope: number, reportGapSec: number } | null}
 */
export function bufferTrend(readings, spanSec) {
  const start = trendRunStart(readings, spanSec);
  if (start < 0) {
    return null;
  }
  const run = readings.slice(start);
  const origin = run[0].at;
  const count = run.length;
  let sumT = 0;
  let sumB = 0;
  for (const reading of run) {
    sumT += (reading.at - origin) / 1000;
    sumB += reading.seconds;
  }
  const meanT = sumT / count;
  const meanB = sumB / count;
  let numerator = 0;
  let denominator = 0;
  for (const reading of run) {
    const t = (reading.at - origin) / 1000 - meanT;
    numerator += t * (reading.seconds - meanB);
    denominator += t * t;
  }
  if (!(denominator > 0)) {
    return null;
  }
  const last = readings[readings.length - 1].at;
  const beforeLast = readings[readings.length - 2].at;
  return { slope: numerator / denominator, reportGapSec: Math.max(0, (last - beforeLast) / 1000) };
}
