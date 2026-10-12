/**
 * @file When the viewer reaches a piece, and how long a run takes to serve it:
 * the two terms that keep an encoder input's copy from making the viewer wait
 * (torrent-tv/meta#178).
 *
 * Field 2026-10-12, an AVI on Home Assistant: after a seek back to 100 s the
 * input of run `#27..#224` — 222.4 MB, copied in 7.7 s — was prepared ahead of
 * a piece the viewer reached about 8 s later, and the picture stood 13.2 s. A
 * stretch is sized so that its copy takes no longer than an open; for a piece
 * the viewer reaches soon the copy has to leave room for the run to serve it.
 */

/**
 * Seconds until the viewer reaches piece `index`, from the output's map.
 *
 * A zone states `withinSeconds` for its near edge (`output/Timeline.js`); a
 * piece inside it is that much film further on. The nearest zone holding the
 * piece decides. Null where no zone holds it or the grid is unknown.
 *
 * @param {{ from: number, to: number, withinSeconds?: number }[]} zones
 * @param {number[] | null | undefined} grid - Where each piece begins, in seconds of film.
 * @param {number} index
 * @returns {number | null}
 */
export function secondsUntilPiece(zones, grid, index) {
  if (!Array.isArray(grid) || !Number.isFinite(grid[index])) return null;
  let nearest = null;
  for (const zone of zones) {
    if (!(index >= zone.from && index <= zone.to) || !Number.isFinite(zone.withinSeconds) || !Number.isFinite(grid[zone.from])) continue;
    const seconds = Math.max(0, zone.withinSeconds) + (grid[index] - grid[zone.from]);
    if (nearest === null || seconds < nearest) nearest = seconds;
  }
  return nearest;
}

/**
 * Seconds from a run's start at `from` to piece `serves` being served.
 *
 * The open (spawn and first input, without encoding its first piece, as
 * `EncodeRuns` measures it), the film from `from` through `serves` at the
 * output's speed, and — where a piece is published only when the file after it
 * closes — that next piece too. Null when a term is unknown.
 *
 * @param {{ open?: number | null, speed?: number | null, grid?: number[] | null, from: number, serves: number, waitsForNext?: boolean }} params
 * @returns {number | null}
 */
export function secondsToServe({ open, speed, grid, from, serves, waitsForNext = false }) {
  if (!Number.isFinite(open) || open < 0 || !Number.isFinite(speed) || !(speed > 0) || !Array.isArray(grid)) return null;
  const last = waitsForNext && Number.isFinite(grid[serves + 2]) ? serves + 2 : serves + 1;
  const film = grid[last] - grid[from];
  return Number.isFinite(film) && film > 0 ? open + film / speed : null;
}
