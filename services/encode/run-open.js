/**
 * @file How long a run took to open its original input (torrent-tv/meta#178).
 *
 * Measured from the run's spawn to the name of its first closed piece, less
 * what encoding that piece costs at the run's speed, and less the time
 * FFmpeg's reads waited for the stretch being copied: that wait is the copy's,
 * and the stretch is sized from the open. The input states those waits on the
 * wall clock, so they are taken up to the wall-clock moment the first piece
 * was named — the run's start plus its time to that name, not that time alone,
 * which as a moment lay before every wait and counted none of them.
 */

/**
 * @param {object} params
 * @param {number | null} params.firstNamedMs - Spawn to the first piece's name, pauses left out.
 * @param {number | null} params.firstNamedWallMs - The same on the wall clock, pauses included.
 * @param {number} params.startedAt - The run's spawn on the wall clock, ms.
 * @param {((until: number) => number) | null | undefined} params.waitedBefore - The input's wall-clock waits for its copy before `until`, ms.
 * @param {number} params.pieceSeconds - The first piece's film.
 * @param {number} params.speed - Film seconds per second; 0 when not known.
 * @returns {{ openSeconds: number, waitedMs: number } | null} Null where any term is unknown.
 */
export function runOpenOf({ firstNamedMs, firstNamedWallMs, startedAt, waitedBefore, pieceSeconds, speed }) {
  if (!Number.isFinite(firstNamedMs) || !(pieceSeconds > 0) || !(speed > 0)) return null;
  const waitedMs = Number.isFinite(firstNamedWallMs) && startedAt > 0 && typeof waitedBefore === "function"
    ? waitedBefore(startedAt + firstNamedWallMs)
    : 0;
  return { waitedMs, openSeconds: Math.max(0, (firstNamedMs - waitedMs) / 1000 - pieceSeconds / speed) };
}
