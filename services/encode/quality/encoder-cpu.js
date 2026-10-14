/**
 * @file The CPU this proxy's FFmpeg processes used between two readings of the
 * machine (torrent-tv/meta#178).
 *
 * A process's own counter says what it used since it started, and is gone once
 * it has ended. Counting only processes present in both readings left out every
 * run that started or ended between them: on Home Assistant a run of one piece
 * started and ended between two readings 5 s apart, used 6.65 s of CPU, and
 * both readings said `ffmpeg=0%` (r41). The availability left to encoders is
 * the machine's load less theirs, so an encoder left out made the machine look
 * busier with other work than it was.
 *
 * So three parts, each counted once:
 *  1. a process in both readings: what its counter moved;
 *  2. a process started after the first reading: its whole counter;
 *  3. a process that ended between them: what the kernel added to this
 *     process's ended-children time (`cutime + cstime`), less what the first
 *     reading already counted of it.
 * A part that cannot be told — a process that was there but unread, an
 * ended-children time that went back, no such time at all while a process
 * ended — makes the answer incomplete: a lower bound, never a measured zero.
 */

/**
 * @typedef {object} EncoderReading
 * @property {number} takenAt - Wall clock, ms.
 * @property {Map<number, number>} byPid - CPU seconds of each live FFmpeg process read.
 * @property {Map<number, number>} [startedAt] - When each of them was spawned, wall clock ms.
 * @property {number | null} endedChildren - This process's ended-children CPU seconds.
 */

/**
 * @param {EncoderReading} previous
 * @param {EncoderReading} sample
 * @returns {{ seconds: number, complete: boolean } | null} Null when nothing at all was read.
 */
export function encoderCpuBetween(previous, sample) {
  const endedKnown = Number.isFinite(previous.endedChildren) && Number.isFinite(sample.endedChildren);
  if (sample.byPid.size === 0 && previous.byPid.size === 0 && !endedKnown) return null;
  let seconds = 0, complete = true;
  for (const [pid, now] of sample.byPid) {
    const before = previous.byPid.get(pid);
    if (before !== undefined) {
      if (now >= before) seconds += now - before;
      else complete = false;
    } else if (sample.startedAt?.get(pid) > previous.takenAt) {
      seconds += now;
    } else {
      complete = false;
    }
  }
  let countedOfEnded = 0, ended = 0;
  for (const [pid, before] of previous.byPid) {
    if (sample.byPid.has(pid)) continue;
    countedOfEnded += before;
    ended += 1;
  }
  if (endedKnown) {
    const rest = sample.endedChildren - previous.endedChildren - countedOfEnded;
    if (rest >= 0) seconds += rest;
    else complete = false;
  } else if (ended > 0) {
    complete = false;
  }
  return { seconds, complete };
}
