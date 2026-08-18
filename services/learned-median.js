/**
 * @file Publishing a value that is learned from repeated readings.
 *
 * Four costs are learned this way — what a file costs to decode, what copying
 * it costs, what a soundtrack costs, what the torrent costs per megabyte — and
 * each has the same two decisions to make: which figure the readings amount to,
 * and when a new figure replaces the published one.
 *
 * The first is the median, because one starved moment must not drag the answer.
 *
 * The second used to be "more than five per cent", a figure nobody measured.
 * It is now the scatter of the readings themselves: a median that has moved
 * further than its own readings disagree with each other has moved for a
 * reason, and one that has not is the same answer read again. Republishing
 * costs something real — every session recomputes its offer, on the path that
 * serves every playlist, init and segment — so the question is worth asking,
 * but it is answered from the measurements rather than from a constant.
 */

/**
 * The middle of a set of readings, or null when there are none.
 *
 * @param {number[]} values
 * @returns {number | null}
 */
export function medianOf(values) {
  const usable = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  if (usable.length === 0) {
    return null;
  }
  const sorted = [...usable].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * How far the readings sit from their own middle — the median of their
 * distances to it.
 *
 * The median distance rather than the mean one, for the same reason the value
 * itself is a median: a single disturbed reading describes the disturbance, not
 * the host.
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
  const distances = (Array.isArray(values) ? values : [])
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.abs(value - middle));
  return medianOf(distances);
}

/**
 * Whether a newly computed median should replace the published one.
 *
 * @param {number | null} published - What every session is answering with now.
 * @param {number} median - What the readings say today.
 * @param {number[]} readings - The readings that median came from.
 * @returns {boolean}
 */
export function movedBeyondScatter(published, median, readings) {
  if (!Number.isFinite(median)) {
    return false;
  }
  if (!Number.isFinite(published)) {
    return true; // nothing published yet; the first answer is always news
  }
  const scatter = scatterOf(readings);
  if (scatter === null) {
    return true;
  }
  return Math.abs(median - published) > scatter;
}
