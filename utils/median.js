/**
 * @file The one median (torrent-tv/meta#294).
 *
 * Every place that needs the middle of a set of readings takes it from here, so
 * that two logs saying "median" mean the same thing. Layers that may not import
 * `utils/` (`viewer/`, `encode/output/`, `media/container/`) are handed the
 * function instead.
 */

/**
 * The finite readings, ascending, as a new array.
 *
 * @param {number[]} values
 * @returns {number[]}
 */
function sortedFinite(values) {
  return (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
}

/**
 * The middle of a set of readings, or null when there are none. Readings that
 * are not finite numbers are left out; on an even count the two middle
 * readings are averaged.
 *
 * @param {number[]} values
 * @returns {number | null}
 */
export function medianOf(values) {
  const sorted = sortedFinite(values);
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * The element at index floor(n / 2) of the sorted finite readings: the upper of
 * the two middle readings on an even count, never their mean, so a count stays
 * an integer. Null when there are none.
 *
 * @param {number[]} values
 * @returns {number | null}
 */
export function upperMiddleOf(values) {
  const sorted = sortedFinite(values);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
}

/**
 * How far the readings sit from their own middle: the median of their
 * distances to it. The median distance rather than the mean one, for the same
 * reason the value itself is a median: a single disturbed reading describes the
 * disturbance, not the host.
 *
 * @param {number[]} values
 * @returns {number | null} Null when there is nothing to measure. Zero is a
 *   real answer: readings that all agree disagree by nothing.
 */
export function scatterOf(values) {
  const middle = medianOf(values);
  if (middle === null) {
    return null;
  }
  return medianOf(sortedFinite(values).map((value) => Math.abs(value - middle)));
}
