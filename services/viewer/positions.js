/**
 * @file Where the viewers of one output stand.
 *
 * Asked by whatever has to give disk back: what lies behind every viewer has
 * been played and will not be wanted again unless somebody seeks back, and what
 * lies ahead of the furthest will be wanted eventually. So an answer of "nobody"
 * is the strongest statement there is — everything that output holds is worth
 * less than anything anybody is on their way to.
 *
 * Pure: it is handed the sessions, the clock and a way to turn seconds into a
 * segment number, and it holds none of them.
 */

import { viewersOf } from "./Viewer.js";

/**
 * @param {object} params
 * @param {Iterable<{ outputKey?: string }>} params.sessions - Every live session.
 * @param {string} params.outputKey - The output being asked about.
 * @param {(session: object, seconds: number) => number} params.segmentAt - Which
 *   segment of THAT session's timeline a moment of film falls in.
 * @param {number} params.now
 * @param {number} params.staleAfterMs - Silence longer than any a watching
 *   viewer can produce.
 * @returns {number[]} A segment number per present viewer, unsorted.
 */
export function viewerSegmentsOn({ sessions, outputKey, segmentAt, now, staleAfterMs }) {
  const at = [];
  for (const session of sessions) {
    if (session.outputKey !== outputKey) {
      continue;
    }
    for (const viewer of viewersOf(session).values()) {
      if (!viewer.isPresent(now, staleAfterMs)) {
        continue;
      }
      const seconds = viewer.positionSeconds();
      if (!Number.isFinite(seconds)) {
        continue;
      }
      const index = segmentAt(session, /** @type {number} */ (seconds));
      if (Number.isInteger(index) && index >= 0) {
        at.push(index);
      }
    }
  }
  return at;
}
