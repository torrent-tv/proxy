/**
 * @file A viewer's statement about itself, taken in.
 *
 * The VIEWER layer's own entry point, and the whole of what happens when a page
 * says where it is: the statement reaches the person it is about, and readings
 * that have gone stale stop deciding for the people still here.
 *
 * It lived in the session manager, which is a description of an OUTPUT, and the
 * two questions were tangled there: whether this is a measurement of a LINK,
 * and whether this is a statement by a VIEWER. Required to be both, a page that
 * had measured nothing could say nothing — see `Viewer.report`.
 *
 * Given the session and the registry as plain arguments, so nothing here knows
 * how a session is found, what a variant is, or that there is an encoder.
 */

import { viewersOf } from "./Viewer.js";

/**
 * Take one report.
 *
 * @param {object} params
 * @param {{ of: (session: object, consumerId: string) => import("./Viewer.js").Viewer }} params.viewers
 * @param {object} params.session - The output this viewer has on screen.
 * @param {string} params.consumerId - Who is reporting; empty when the page
 *   does not name itself, and then every such page shares one viewer, which is
 *   exactly what one unnamed browser is.
 * @param {object} params.report - What they said about themselves.
 * @param {number} params.now
 * @param {number} params.linkFreshMs - How long a link reading describes the
 *   link it was measured on.
 * @returns {true}
 */
export function takeViewerReport({ viewers, session, consumerId, report, now, linkFreshMs }) {
  viewers.of(session, consumerId).report(report, now);
  forgetStaleLinkReadings({ session, now, linkFreshMs });
  return true;
}

/**
 * Drop link readings older than the time they describe.
 *
 * ONLY THE READING EXPIRES. Whether the person is still watching is a different
 * question with its own answer — their connection — and a viewer who has simply
 * stopped reporting is not thereby gone. Answering both from this one place is
 * what stopped a soundtrack's encoder on 2026-09-05, seconds after it started
 * and before it had made the `init.mp4` the picture could not be played
 * without.
 *
 * @param {object} params
 * @param {object} params.session
 * @param {number} params.now
 * @param {number} params.linkFreshMs
 * @returns {void}
 */
export function forgetStaleLinkReadings({ session, now, linkFreshMs }) {
  for (const viewer of viewersOf(session).values()) {
    const reading = viewer.netReport;
    if (reading !== null && now - reading.at > linkFreshMs) {
      viewer.netReport = null;
    }
  }
}
