/**
 * @file Turning two work samples of a running encoder into a speed.
 *
 * ffmpeg reports `speed=` cumulatively, over the whole run: every second the
 * encoder was stopped and every second its input waited for the swarm is in
 * the denominator. A copy at eight times realtime that waits a minute reads
 * 1.6x; a copy that waited 32.93 s and 43.91 s for two pieces read 0.21x in the
 * field on 2026-10-01, and the forecast carried that over the whole film while
 * charging the same download separately.
 *
 * A run's work sample (`EncodeRun.workSample`) states the film made and the
 * milliseconds of the run's OWN work, with input waits and stops taken out
 * (`RunClock`). Two samples of one run give its processing speed over the
 * stretch between them, whatever that stretch's length: the samples are taken
 * at ffmpeg's own progress reports, so there is no window to choose.
 */

/**
 * @typedef {object} WorkSample
 * @property {number} at - Wall clock, in milliseconds.
 * @property {number} producedSeconds - Film this run has made.
 * @property {number} workingMs - The run's own working time so far.
 */

/**
 * Processing speed between two samples of one run, or null when the pair
 * cannot answer: nothing made, or no working time between them.
 *
 * @param {WorkSample | null} previous
 * @param {WorkSample | null} current
 * @returns {number | null} Film seconds made per second of the run's own work.
 */
export function speedFromWork(previous, current) {
  if (!previous || !current) {
    return null;
  }
  const producedSeconds = current.producedSeconds - previous.producedSeconds;
  const workingSeconds = (current.workingMs - previous.workingMs) / 1000;
  if (!(producedSeconds > 0) || !(workingSeconds > 0)) {
    return null;
  }
  return producedSeconds / workingSeconds;
}
