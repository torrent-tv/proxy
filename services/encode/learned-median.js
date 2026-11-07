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

import { scatterOf } from "../../utils/median.js";

/**
 * How many of the most recent readings the median is taken over.
 *
 * A statement about how much of the past still describes the host, not a
 * measured quantity, and it is written as one rather than dressed up as one.
 * It lives here because it is a property of this rule and not of any one cost:
 * all four learn the same way, and it was declared in the session manager under
 * a name that claimed it was about decoding while three of the four used it.
 */
export const READINGS_KEPT = 7;

export { medianOf, scatterOf } from "../../utils/median.js";

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
