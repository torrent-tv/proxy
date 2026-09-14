/**
 * @file A viewer's statement about itself, taken in.
 *
 * The VIEWER layer's own entry point, and the whole of what happens when a page
 * says where it is: the output the reporter has on screen is resolved, the
 * statement reaches the person it is about, and readings that have gone stale
 * stop deciding for the people still here.
 *
 * It lived in the session manager, which is a description of an OUTPUT, and the
 * two questions were tangled there: whether this is a measurement of a LINK,
 * and whether this is a statement by a VIEWER. Required to be both, a page that
 * had measured nothing could say nothing — see `Viewer.report`.
 *
 * Given the sessions and the registry as plain values, so nothing here knows
 * how a session is found, what a variant is, or that there is an encoder.
 */

import { activeOutputFor } from "./active-output.js";

/**
 * Take one report from one viewer.
 *
 * @param {object} params
 * @param {{ get: (id: string) => object | undefined }} params.sessions - Every live session, by id.
 * @param {{ of: (session: object, consumerId: string) => import("./Viewer.js").Viewer }} params.viewers
 * @param {string} params.sessionId - The session the page addresses, which is
 *   always the picture's: the browser is not told which rung it is on.
 * @param {object} params.report - What they said about themselves.
 * @param {number} [params.now]
 * @returns {boolean} False when no such session is live, which is the page
 *   reporting into one that has been disposed.
 */
export function recordViewerReport({ sessions, viewers, sessionId, report, now = Date.now() }) {
  const named = sessions.get(sessionId);
  if (!named || named.state === "disposed") {
    return false;
  }
  const consumerId = typeof report?.consumerId === "string" ? report.consumerId : "";
  // The stream on screen is the reporter's own: with two viewers on two rungs,
  // one report says nothing about the other's encoder.
  const session = activeOutputFor({ base: named, consumerId, sessions, viewers });
  viewers.of(session, consumerId).report(report, now);
  return true;
}
