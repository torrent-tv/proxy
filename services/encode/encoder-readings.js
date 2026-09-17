/**
 * @file Turning two readings of a running encoder into a speed.
 *
 * ffmpeg reports `speed=` cumulatively, over the whole run. That figure counts
 * every second the encoder spent SIGSTOPped by the look-ahead cap, and a COPY
 * spends most of its life there — it reaches the cap in about fifteen seconds
 * and then waits a minute. Read that way, a copy running at eight times
 * realtime reports 1.6x and falling; filed as the price of copying, it would
 * refuse quality rungs on arithmetic that had measured a pause.
 *
 * The difference between two readings of an uninterrupted stretch does not have
 * that fault, and it is the same technique the startup benchmarks use.
 */

/**
 * @typedef {object} EncoderReading
 * @property {number} takenAt - Wall clock, in milliseconds.
 * @property {number} processedSeconds - Output position ffmpeg has reached.
 */

/**
 * Speed between two readings, or null when the pair cannot answer.
 *
 * @param {EncoderReading | null} previous
 * @param {EncoderReading | null} current
 * @param {number} minimumWindowSec - The narrowest stretch worth dividing by.
 * @returns {number | null} Video seconds produced per second of clock.
 */
export function speedFromReadings(previous, current, minimumWindowSec) {
  if (!previous || !current) {
    return null;
  }
  const wallSeconds = (current.takenAt - previous.takenAt) / 1000;
  const producedSeconds = current.processedSeconds - previous.processedSeconds;
  if (!Number.isFinite(wallSeconds) || !Number.isFinite(producedSeconds)) {
    return null;
  }
  // A window too narrow to divide by, or one in which nothing was produced —
  // the second happens when a run has just been repositioned and has not yet
  // reached the position it is restarting from.
  if (!(wallSeconds >= minimumWindowSec) || !(producedSeconds > 0)) {
    return null;
  }
  return producedSeconds / wallSeconds;
}
