/**
 * @file Whether a viewer's buffer will run dry before another output could have
 * the piece they need (roadmap item 98).
 *
 * THE RULE, stated by the user 2026-09-27: a move to a smaller output is
 * prepared when, on the buffer's present trend, the viewer's buffer ends
 * sooner than the piece they need would be closed on the new output. A buffer
 * that falls without that threat moves nothing — a trend down is ordinary
 * between two segments and while a cushion is being spent.
 *
 * WHEN IT IS JUDGED. On each report of the viewer, and the next judgement comes
 * with their next report. So the question asked is whether the buffer lasts
 * until the new piece would be ready IF THE MOVE WAITED FOR THAT NEXT REPORT:
 *
 *     secondsToEmpty <= secondsToReady + reportGapSec
 *
 * where `secondsToEmpty` is what they hold divided by how fast it drains, and
 * `reportGapSec` is the interval between their last two reports. Every term is
 * measured; nothing here is chosen.
 *
 * A time to ready that is not known is not assumed to be short: with nothing to
 * show there is time left, a draining buffer is a threat.
 */

/**
 * @param {object} params
 * @param {number} params.bufferedSec - What the viewer holds now.
 * @param {number | null} params.slope - The buffer's trend, seconds of film per
 *   second; negative while it drains. Null when not yet known.
 * @param {number} params.reportGapSec - The interval between the viewer's last
 *   two reports.
 * @param {number | null} params.secondsToReady - How long the new output would
 *   take to close the piece the viewer needs; null when not known.
 * @returns {{ threat: boolean, secondsToEmpty: number | null }}
 */
export function drainThreat({ bufferedSec, slope, reportGapSec, secondsToReady }) {
  if (!Number.isFinite(slope) || slope >= 0) {
    return { threat: false, secondsToEmpty: null };
  }
  const held = Number.isFinite(bufferedSec) && bufferedSec > 0 ? bufferedSec : 0;
  const secondsToEmpty = held / -slope;
  if (!Number.isFinite(secondsToReady) || secondsToReady < 0) {
    return { threat: true, secondsToEmpty };
  }
  const gap = Number.isFinite(reportGapSec) && reportGapSec > 0 ? reportGapSec : 0;
  return { threat: secondsToEmpty <= secondsToReady + gap, secondsToEmpty };
}
