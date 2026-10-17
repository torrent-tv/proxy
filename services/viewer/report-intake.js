/**
 * @file A viewer's statement about itself, taken in.
 *
 * The VIEWER layer's own entry point, and the whole of what happens when a page
 * says where it is: the output the reporter has on screen is resolved, and the
 * statement reaches the person it is about. Nothing expires here — a link
 * reading is the last thing known about that link, and whether it is still
 * somebody's is presence's answer (`Viewer.linkReading`).
 *
 * It lived in the session manager, which is a description of an OUTPUT, and the
 * two questions were tangled there: whether this is a measurement of a LINK,
 * and whether this is a statement by a VIEWER. Required to be both, a page that
 * had measured nothing could say nothing — see `Viewer.report`.
 *
 * Given the outputs and the viewer registry as plain values, so nothing here
 * knows how an output is found, what a variant is, or that there is an encoder.
 */

import { activeOutputFor } from "./active-output.js";

/**
 * Take one report from one viewer.
 *
 * @param {object} params
 * @param {{ get: (id: string) => object | undefined }} params.outputs - Every live output, by id.
 * @param {{ join: (session: object, consumerId: string) => import("./Viewer.js").Viewer | null }} params.viewers
 * @param {string} params.sessionId - The session the page addresses, which is
 *   always the picture's: the browser is not told which rung it is on.
 * @param {object} params.report - What they said about themselves.
 * @param {number} [params.now]
 * @returns {boolean} False when the session or its viewer has gone.
 */
export function recordViewerReport({ outputs, viewers, sessionId, report, now = Date.now() }) {
  const named = outputs.get(sessionId);
  const consumerId = typeof report?.consumerId === "string" ? report.consumerId : "";
  // A report that names nobody is a reading of nobody's link.
  if (!named || !consumerId) {
    return false;
  }
  // The stream on screen is the reporter's own: with two viewers on two rungs,
  // one report says nothing about the other's encoder.
  const session = activeOutputFor({ base: named, consumerId, outputs, viewers });
  const viewer = viewers.join(session, consumerId);
  if (!viewer) return false;
  viewer.report(report, now);
  return true;
}
