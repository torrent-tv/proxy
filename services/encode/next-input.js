/**
 * @file When a run asks for the input of the run after it (torrent-tv/meta#178).
 *
 * Asked as soon as the run's own stretch was copied, the next input was copied
 * while the run opened: a background run on Home Assistant started with its
 * 108.7 MB, the next 115.6 MB were copied at once, the proxy took 1.5-2 cores,
 * and the share left to encoders fell from 65 % to 10-16 % before either had
 * a piece (r37). Asked at the run's first piece, it still has the rest of the
 * run to be ready in — unless preparing an input of this output was measured
 * to take longer than that rest at this output's speed, or the run is one
 * piece, whose first piece is its last.
 */

/**
 * Whether the next input waits for this run's first piece.
 *
 * @param {object} params
 * @param {number | null} params.preparedInMs - How long this output's last input took from being asked for to being ready.
 * @param {number} params.speed - This output's processing speed, film seconds per second; 0 when not known.
 * @param {number} params.restSeconds - The film this run makes after its first piece.
 * @returns {boolean}
 */
export function nextInputAtFirstPiece({ preparedInMs, speed, restSeconds }) {
  if (!Number.isFinite(preparedInMs) || !(speed > 0) || !(restSeconds > 0)) return false;
  return preparedInMs < restSeconds / speed * 1000;
}
