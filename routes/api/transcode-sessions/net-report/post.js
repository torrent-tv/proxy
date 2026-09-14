import { recordViewerReport } from "../../../../services/viewer/report-intake.js";

/**
 * Accept a viewer link report for a transcode session (adaptive bitrate).
 * The browser measures its own data-channel throughput per segment fetch and
 * posts a rolling median + its buffered seconds; the session manager's budget
 * loop uses the latest report as the link-deficit downshift trigger.
 *
 * POST /api/transcode-sessions/:sessionId/net-report
 * Body: { linkMbps: number, bufferedAheadSec: number,
 *         consumerId?: string, positionSeconds?: number }
 *
 * `consumerId` and `positionSeconds` say WHO is reporting and WHERE they are.
 * A copied picture is one session shared by every viewer of it, so without them
 * the proxy could only act on whichever viewer reported last. Both are
 * optional: a browser that sends neither is treated exactly as before.
 *
 * Best-effort telemetry: invalid body → 400, unknown session → 404, ok → 204.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ sessions: { get: (id: string) => object | undefined }, viewers: object }} deps -
 *   The live sessions and the registry of viewers. The VIEWER layer takes the
 *   statement from here; this route's whole job is turning a request into that
 *   one call and its answer into a status code.
 * @returns {Promise<void>}
 */
export async function handleApiTranscodeSessionNetReportPost(req, reply, { sessions, viewers }) {
  const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  // WHAT THIS REPORT IS. A statement by one viewer about itself: where the
  // picture is, how much film it holds, whether it is moving, whether it is
  // blocked on us, whether the page is on screen — and, when there has been
  // anything to measure, how fast the link carried it.
  //
  // THE LINK FIGURE IS NOT REQUIRED, and requiring it is the fault of
  // 2026-09-14. A page measures its link from completed transfers, so a page
  // that has not yet been delivered a segment has no figure; at a cold open
  // that is every page. Rejected here with 400, the page's own account of
  // itself never arrived, this proxy filled the silence by assuming the film
  // was running, and a viewer who had not seen a frame was placed 146 seconds
  // into it — the soundtrack's encoder went there, and the segment the browser
  // was actually asking for was ranked last of a hundred and answered 503.
  const linkMbps = Number(body.linkMbps);
  const bufferedAheadSec = Number(body.bufferedAheadSec);
  if (!sessionId || !Number.isFinite(bufferedAheadSec) || bufferedAheadSec < 0) {
    return reply.code(400).send({ error: "bufferedAheadSec (>=0) is required." });
  }

  // Neither is required, and neither can make a report invalid: they are what
  // the proxy uses to tell the viewers of one session apart, and a report
  // without them is still a truthful reading of somebody's link.
  const consumerId = typeof body.consumerId === "string" ? body.consumerId.trim() : "";
  // Whether the picture is moving. Absent from a page that does not say, and
  // then nothing is assumed: a statement about somebody else's machine is
  // theirs to make, and assuming it walked a viewer 146 seconds into a film
  // they had not begun (2026-09-14).
  const playing = typeof body.playing === "boolean" ? body.playing : undefined;
  // Whether this viewer is BLOCKED on material we owe them, which is a
  // different state from having stopped the picture: the first is the most
  // urgent viewer there is, the second consumes nothing and can wait. One
  // boolean could not hold three states and read the first as the second.
  const waiting = typeof body.waiting === "boolean" ? body.waiting : undefined;
  // Whether the page is on screen, and whether the picture was pulled out of
  // it. A hidden tab has its timers throttled, so it asks for nothing and looks
  // exactly like a viewer holding a full cushion; picture-in-picture is the case
  // that makes the distinction necessary, because there the tab is hidden and
  // the viewer is watching. Absent from a page that does not say, and then the
  // viewer is on screen, as every page meant before it could say otherwise.
  const onScreen = typeof body.onScreen === "boolean" ? body.onScreen : undefined;
  const inPictureInPicture =
    typeof body.inPictureInPicture === "boolean" ? body.inPictureInPicture : undefined;
  const positionSeconds = Number(body.positionSeconds);
  const recorded = recordViewerReport({
    sessions,
    viewers,
    sessionId,
    report: {
      linkMbps: Number.isFinite(linkMbps) && linkMbps > 0 ? linkMbps : undefined,
      bufferedAheadSec,
      consumerId,
      playing,
      waiting,
      onScreen,
      inPictureInPicture,
      positionSeconds:
        Number.isFinite(positionSeconds) && positionSeconds >= 0 ? positionSeconds : undefined
    }
  });
  if (!recorded) {
    return reply.code(404).send({ error: "Transcode session was not found." });
  }
  return reply.code(204).send();
}
