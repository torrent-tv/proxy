/**
 * @file What the torrent itself costs this machine, per megabyte it moves.
 *
 * Downloading, verifying every piece and pushing segments down a data channel
 * are work on the same box as the encoder, and they scale with what is moved.
 * The reading is taken only while nothing is encoding, because that is the one
 * moment the spending needs no arithmetic to attribute: what the process uses
 * then is the torrent's.
 *
 * Except that it is not all the torrent's, and that is what this file exists
 * for. Measured on the addon host 2026-08-18, one session reported **145.4 ms
 * per megabyte over 8.7 MB** and **23.1 ms per megabyte over 54 MB** — the same
 * host, the same minute, a sixfold disagreement that follows the size of the
 * interval rather than anything about the torrent. A process with nothing to do
 * still runs its timers, its tunnel and its session sweeps, and that draw does
 * not shrink when fewer megabytes move: divided by a small number it swamps the
 * answer. A minimum-megabytes threshold stood against exactly this and did not
 * hold, because a chosen number was standing in for a measured one.
 *
 * The draw is measurable. An interval in which nothing encodes and the torrents
 * move no bytes at all costs whatever this process spends anyway; subtract that
 * from an interval which did move bytes, and what remains is the torrent's.
 */

/**
 * The share of one core this process draws while it has nothing to do.
 *
 * @param {{ cpuSeconds: number, elapsedSeconds: number }} interval - CPU seconds
 *   already divided by the number of cores, so the figure is comparable with
 *   the wall seconds every other cost in the budget is stated in.
 * @returns {number | null} Null when the interval cannot be divided.
 */
export function baseDrawFrom({ cpuSeconds, elapsedSeconds }) {
  if (!Number.isFinite(cpuSeconds) || !Number.isFinite(elapsedSeconds) || !(elapsedSeconds > 0)) {
    return null;
  }
  if (!(cpuSeconds >= 0)) {
    return null;
  }
  return cpuSeconds / elapsedSeconds;
}

/**
 * What one megabyte cost, once the draw that would have been spent anyway is
 * taken off.
 *
 * The draw is subtracted, so what is left is only as certain as the draw is.
 * The draw's own readings disagree with each other by a measured amount, and
 * over an interval that disagreement is worth `scatter × elapsed` seconds of
 * CPU: a reading whose remainder is smaller than that measures the wobble in
 * the subtraction rather than the torrent. This is what the removed
 * minimum-megabytes threshold was reaching for, arrived at from the readings
 * instead of from a chosen size — a small interval fails it because little was
 * moved in it, and a large one passes on the same arithmetic.
 *
 * @param {{ cpuSeconds: number, elapsedSeconds: number, megabytes: number, baseDraw: number | null, drawScatter?: number | null }} interval
 * @returns {number | null} Seconds of work per megabyte, or null when this
 *   interval cannot say — no base draw measured yet, nothing moved, or the
 *   interval spent no more than the draw and its own uncertainty account for.
 */
export function costPerMegabyteFrom({ cpuSeconds, elapsedSeconds, megabytes, baseDraw, drawScatter = null }) {
  if (!Number.isFinite(cpuSeconds) || !Number.isFinite(elapsedSeconds) || !(elapsedSeconds > 0)) {
    return null;
  }
  if (!Number.isFinite(megabytes) || !(megabytes > 0)) {
    return null;
  }
  if (!Number.isFinite(baseDraw) || !(baseDraw >= 0)) {
    // Nothing measured to subtract. Publishing the whole spending as the
    // torrent's is what produced the 145 ms/MB reading, so this interval says
    // nothing instead.
    return null;
  }
  const attributable = cpuSeconds - baseDraw * elapsedSeconds;
  if (!(attributable > 0)) {
    // The draw accounts for everything this interval spent. Not a discovery
    // that the torrent is free — a reading with nothing left in it.
    return null;
  }
  const uncertainty = Number.isFinite(drawScatter) && drawScatter > 0 ? drawScatter * elapsedSeconds : 0;
  if (!(attributable > uncertainty)) {
    // What is left is inside the disagreement between the draw's own readings.
    // Dividing it by a small number of megabytes is how 145 ms/MB was reported
    // on a host that costs 23.
    return null;
  }
  return attributable / megabytes;
}
