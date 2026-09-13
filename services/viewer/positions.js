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
 * @returns {number[]} A segment number per present viewer, unsorted.
 */
export function viewerSegmentsOn({ sessions, outputKey, segmentAt, now }) {
  const at = [];
  for (const session of sessions) {
    if (session.outputKey !== outputKey) {
      continue;
    }
    for (const viewer of viewersOf(session).values()) {
      if (!viewer.isPresent()) {
        continue;
      }
      const seconds = viewer.positionSeconds(now);
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

/**
 * Where a viewer of one output is, in seconds of film, NOW.
 *
 * One reading with one owner, and a function of time rather than a stored
 * number: a viewer states where their picture is, and the clock carries it
 * forward between statements.
 *
 * Three readings ranked by priority used to answer this — a seek, the start of
 * the last segment requested, the position the output was opened at — with a
 * second function saying which had answered. They were three different
 * quantities wearing one name, two of them written at different rates, so the
 * answer alternated between them several times a second and every encoder
 * followed it.
 *
 * Without a name, the FURTHEST viewer: what lies behind them has already been
 * made, so that is what a reading about no particular person wants. With
 * nobody present at all, where the output was opened.
 *
 * @param {object} session
 * @param {string} [consumerId] - Whose position.
 * @param {number} [now]
 * @returns {number} Seconds, never negative.
 */
export function viewerSecondsOn(session, consumerId = "", now = Date.now()) {
  const named = consumerId ? session?.viewers?.get(consumerId) ?? null : null;
  if (named) {
    return Math.max(0, named.positionSeconds(now) ?? 0);
  }
  let furthest = null;
  for (const viewer of viewersOf(session).values()) {
    if (!viewer.isPresent()) {
      continue;
    }
    const seconds = viewer.positionSeconds(now);
    if (Number.isFinite(seconds)) {
      furthest = furthest === null ? seconds : Math.max(furthest, seconds);
    }
  }
  const opened = Number(session?.progress?.startPositionSeconds);
  return Math.max(0, furthest ?? (Number.isFinite(opened) ? opened : 0));
}

/**
 * The earliest film anybody present is standing on, across several outputs.
 *
 * WHAT IT IS FOR: a soundtrack is created at a position, and a track begun
 * where the leader stands has nothing to give the viewer behind them. So the
 * earliest, and across every rung of the picture, because two viewers of one
 * film may be on different ones.
 *
 * This is a fact about PEOPLE and it decides one parameter of an output. It
 * does not place encoders: which encoder works where is the priority map's
 * answer and nothing here is consulted for it.
 *
 * @param {Iterable<object>} sessions
 * @param {number} [now]
 * @returns {number | null} Seconds, or null when nobody is present.
 */
export function earliestViewerSecondsOn(sessions, now = Date.now()) {
  let earliest = null;
  for (const session of sessions ?? []) {
    for (const viewer of viewersOf(session).values()) {
      if (!viewer.isPresent()) {
        continue;
      }
      const seconds = viewer.positionSeconds(now);
      if (Number.isFinite(seconds)) {
        earliest = earliest === null ? seconds : Math.min(earliest, seconds);
      }
    }
  }
  return earliest;
}
