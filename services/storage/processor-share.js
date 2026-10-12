/**
 * @file How fast the torrents may download, so that downloading does not take
 * the processor the encoders need (torrent-tv/meta#178).
 *
 * Field 2026-10-11, Home Assistant: an AVI re-encoded at 720x400 needed 2.3 s
 * of one core per second of film. While the torrent downloaded 4.5-9.8 MB/s —
 * mostly far ahead of the viewer — its thread took 56-63 % of a core, ffmpeg
 * got 176-182 %, below real time, and the viewer saw the spinner; once the
 * download stopped ffmpeg got 216-261 % and there were no stops.
 *
 * THE MODEL, every term a share of the WHOLE MACHINE. The processor the proxy
 * has, `C`, is the share other processes leave (`encode/available-share.js`)
 * less what this process draws doing nothing priced. Every watched file `f` of
 * every torrent advances at a film speed `s`: its running encoders take `s·k_f`
 * (`k_f` the machine's seconds per second of film, the inverse of the encode
 * speed) and its download `s·w_f·c` (`w_f` its bytes per second of film, `c`
 * the machine's seconds per byte the torrent thread spends). One speed for all
 * is the division under which the slowest file is as fast as it can be:
 *
 *     s* = C / Σ_f (k_f + w_f·c),    download rate = max(s*, 1) · Σ_f w_f
 *
 * Up to 2.97.7 `C` was counted in cores while `k` and `c` were shares of the
 * machine, so on the four-core addon host the limit was about four times
 * looser than this model.
 *
 * Downloading faster than `s*·w` only piles bytes ahead while the encoders
 * starve; what is fetched first within the rate is the priority map's order.
 * The rate never falls below the films' own byte rate, `Σ w`, because below it
 * the viewer stops whatever the encoders get. Where `s* < 1` or the swarm
 * gives less than the rate, stops cannot be avoided, and the start forecast,
 * reading the speeds measured under this rate, waits for them at the start
 * and after a seek. With nothing encoding `k` is zero and the download has the
 * processor. A term nobody has measured contributes nothing: an unmeasured
 * price of a byte leaves the download unlimited.
 */

/**
 * @param {object} params
 * @param {number} params.availableShare - The share of the machine other processes leave, 0..1.
 * @param {number} params.baseDraw - The share of the machine this process draws doing nothing priced.
 * @param {number | null} params.costPerMegabyte - The machine's seconds per megabyte the torrent moves.
 * @param {{ bytesPerFilmSecond: number, encodeCostSec: number }[]} params.files - Watched files.
 * @returns {{ filmSpeed: number, bytesPerSecond: number, capacity: number }}
 *   `capacity` is a share of the machine; `bytesPerSecond` is Infinity where
 *   the download is not limited.
 */
export function downloadShare({ availableShare, baseDraw, costPerMegabyte, files }) {
  const capacity = Math.max(0, availableShare - baseDraw);
  // A byte whose price is not measured, or costs nothing, takes nothing from
  // the encoders: there is then no share to keep the download to.
  const perByte = Number.isFinite(costPerMegabyte) && costPerMegabyte > 0 ? costPerMegabyte / 1e6 : 0;
  const bytes = files.reduce((sum, file) => sum + file.bytesPerFilmSecond, 0);
  const demand = files.reduce((sum, file) => sum + file.encodeCostSec + file.bytesPerFilmSecond * perByte, 0);
  const filmSpeed = capacity / demand;
  const bytesPerSecond = perByte > 0 ? Math.max(filmSpeed, 1) * bytes : Infinity;
  return { filmSpeed, capacity, bytesPerSecond: Number.isFinite(bytesPerSecond) && bytes > 0 ? bytesPerSecond : Infinity };
}
