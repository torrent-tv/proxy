/**
 * @file How long until a piece of an output is closed, from what is measured
 * about that output's runs (torrent-tv/meta#178).
 *
 * Asked when a viewer is moved between two outputs of one height while a piece
 * given to them from the output on screen is not closed yet: the piece is then
 * given by whichever output closes it sooner. Every term is a reading of this
 * machine; a term that is not known makes the answer unknown, never a guess.
 */

/**
 * Seconds until the piece is closed on its output, or null when that cannot be
 * said.
 *
 * 1. A closed piece: 0.
 * 2. A live run whose stretch holds the piece: the film from where the run has
 *    reached to the piece's end, at the output's speed, plus what is left of
 *    the run's opening when it has produced nothing yet.
 * 3. No such run: a run opened here for it — the output's measured opening and
 *    the whole piece at its speed.
 *
 * @param {object} what
 * @param {boolean} what.closed
 * @param {number} what.index - The piece.
 * @param {number} what.pieceStart - Where the piece begins, seconds of film.
 * @param {number} what.pieceEnd - Where it ends.
 * @param {Array<{ from: number, to: number, startedAt: number, startSeconds: number, reachedSeconds: number | null }>} what.runs
 *   The output's live runs: their stretch (`to` −1 for one with no end), when
 *   each started, where it began and how far it has produced.
 * @param {number | null} what.speed - Seconds of film the output makes per second.
 * @param {number | null} what.openSeconds - What opening a run costs this output.
 * @param {number} what.now
 * @returns {number | null}
 */
export function secondsUntilClosed({ closed, index, pieceStart, pieceEnd, runs, speed, openSeconds, now }) {
  if (closed) {
    return 0;
  }
  if (!(speed > 0) || !Number.isFinite(pieceStart) || !Number.isFinite(pieceEnd) || pieceEnd <= pieceStart) {
    return null;
  }
  const holding = runs.filter((run) => run.from <= index && (run.to < 0 || run.to >= index));
  let best = null;
  for (const run of holding) {
    const reached = Number.isFinite(run.reachedSeconds) && run.reachedSeconds > run.startSeconds
      ? run.reachedSeconds : null;
    let seconds;
    if (reached !== null) {
      seconds = Math.max(0, pieceEnd - reached) / speed;
    } else {
      if (!Number.isFinite(openSeconds)) continue;
      const opened = Math.max(0, (now - run.startedAt) / 1000);
      seconds = Math.max(0, openSeconds - opened) + Math.max(0, pieceEnd - run.startSeconds) / speed;
    }
    best = best === null ? seconds : Math.min(best, seconds);
  }
  if (best !== null) {
    return best;
  }
  if (holding.length > 0 || !Number.isFinite(openSeconds)) {
    return null;
  }
  return openSeconds + (pieceEnd - pieceStart) / speed;
}
