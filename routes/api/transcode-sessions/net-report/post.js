import { recordViewerReport } from "../../../../services/viewer/report-intake.js";

/**
 * Accept a viewer link report for a transcode session (adaptive bitrate).
 * The browser measures its own data-channel throughput per segment fetch and
 * posts a rolling median + its buffered seconds; the session manager's budget
 * loop uses the latest report as the link-deficit downshift trigger.
 *
 * POST /api/transcode-sessions/:sessionId/net-report
 * Body: { consumerId: string, bufferedAheadSec: number, linkMbps?: number,
 *         positionSeconds?: number, playingHeight?: number, appendEpoch?: string,
 *         appendEpochStartedAt?: number, appendSnapshotAt?: number,
 *         appendService?: object, fragmentService?: object, … }
 *
 * `consumerId` and `positionSeconds` say WHO is reporting and WHERE they are.
 * A copied picture is one session shared by every viewer of it, so without them
 * the proxy could only act on whichever viewer reported last. The viewer is
 * required; the position is not.
 *
 * Best-effort telemetry: invalid body → 400, unknown session → 404, ok → 204.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ outputs: { get: (id: string) => object | undefined }, viewers: object, renditions: { viewerPlays: Function, noteViewerReported: Function }, quality: { noteViewerReported: Function }, planSoon?: () => void, segmentAt?: (output: object, seconds: number) => number | null }} deps -
 *   The live outputs, the registry of viewers, and the rungs of a picture. The
 *   VIEWER component takes the statement; which rung a stated height is, is the
 *   encoding component's. This route's whole job is turning a request into
 *   those calls and their answer into a status code.
 * @returns {Promise<void>}
 */
export async function handleApiTranscodeSessionNetReportPost(req, reply,
  { outputs, viewers, renditions, quality, planSoon = () => {}, segmentAt = () => null }) {
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
  const linkSampleMbps = Number(body.linkSampleMbps);
  const linkSampleAt = Number(body.linkSampleAt);
  const bufferedAheadSec = Number(body.bufferedAheadSec);
  const bufferLimitSeconds = Number(body.bufferLimitSeconds);
  if (!sessionId || !Number.isFinite(bufferedAheadSec) || bufferedAheadSec < 0) {
    return reply.code(400).send({ error: "bufferedAheadSec (>=0) is required." });
  }

  // WHO is reporting is required: a viewer always has a name, and a reading of
  // a link that belongs to nobody cannot be kept anywhere. The position is not
  // required — a report without one is still a truthful reading of that link.
  const consumerId = typeof body.consumerId === "string" ? body.consumerId.trim() : "";
  if (!consumerId) {
    return reply.code(400).send({ error: "consumerId is required." });
  }
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
  // Whether the size on screen was picked by hand or is the automatic choice.
  // A size picked by hand is served exactly; the automatic choice may be served
  // by an output of the same quality or better that is already made.
  const qualityMode = body.qualityMode === "auto" || body.qualityMode === "manual" ? body.qualityMode : undefined;
  const positionSeconds = Number(body.positionSeconds);
  // Which of this viewer's viewings the page made the report in; a page one
  // release behind does not say (`Viewer.isOfAnEarlierViewing`).
  const stated = Number(body.generation);
  const generation = Number.isInteger(stated) ? stated : undefined;
  // The picture as the viewer sees it, in physical pixels: the upper bound of
  // the height of a re-encoded output made for them (roadmap item 98). Sent the
  // moment it changes; a page that does not say leaves the size as it was.
  const visiblePicture = body.visiblePicture && typeof body.visiblePicture === "object"
    ? { width: Number(body.visiblePicture.width), height: Number(body.visiblePicture.height) }
    : undefined;
  // WHICH RUNG THE PLAYER IS PLAYING, stated by the page the moment it
  // switched. Stated before the report is recorded, because the report belongs
  // to the rung on screen. A page that does not say leaves the rung as it was.
  const playingHeight = Number(body.playingHeight);
  if (Number.isInteger(playingHeight) && playingHeight > 0) {
    // Where they stood when they said it, unless they have seeked since.
    const placed = Number.isFinite(positionSeconds) && positionSeconds >= 0 &&
      !viewers.get?.(consumerId)?.isOfAnEarlierViewing(generation);
    renditions.viewerPlays(sessionId, consumerId, playingHeight, placed ? positionSeconds : undefined);
  }
  // Where they stood and whether they were playing or waiting, before this
  // report: what the encoders are planned from (`movedForThePlan`).
  const before = viewers.get?.(consumerId);
  const was = before ? { seconds: before.position?.seconds ?? null, playing: before.playing, waiting: before.waiting } : null;
  const recorded = recordViewerReport({
    outputs,
    viewers,
    sessionId,
    report: {
      linkMbps: Number.isFinite(linkMbps) && linkMbps > 0 ? linkMbps : undefined,
      linkSampleMbps: Number.isFinite(linkSampleMbps) && linkSampleMbps > 0 ? linkSampleMbps : undefined,
      linkSampleAt: Number.isFinite(linkSampleAt) && linkSampleAt > 0 ? linkSampleAt : undefined,
      appendSessionId: sessionId,
      appendEpoch: typeof body.appendEpoch === "string" ? body.appendEpoch : undefined,
      appendEpochStartedAt: Number.isFinite(body.appendEpochStartedAt) && body.appendEpochStartedAt > 0
        ? body.appendEpochStartedAt : undefined,
      appendSnapshotAt: Number.isFinite(body.appendSnapshotAt) && body.appendSnapshotAt > 0
        ? body.appendSnapshotAt : undefined,
      appendService: body.appendService && typeof body.appendService === "object" ? body.appendService : undefined,
      fragmentService: body.fragmentService && typeof body.fragmentService === "object" ? body.fragmentService : undefined,
      bufferedAheadSec,
      bufferedRanges: body.bufferedRanges,
      timestampOffsets: body.bufferedRanges?.timestampOffsets,
      bufferLimitSeconds:
        Number.isFinite(bufferLimitSeconds) && bufferLimitSeconds > 0 ? bufferLimitSeconds : undefined,
      consumerId,
      playing,
      waiting,
      onScreen,
      inPictureInPicture,
      qualityMode,
      visiblePicture,
      positionSeconds:
        Number.isFinite(positionSeconds) && positionSeconds >= 0 ? positionSeconds : undefined,
      generation
    }
  });
  if (!recorded) {
    return reply.code(404).send({ error: "Transcode session was not found." });
  }
  // A VIEWER WHO MOVED INTO ANOTHER PIECE, or started or stopped playing or
  // waiting, changed the maps the encoders are placed from; the plan is taken
  // again now. Recorded and not re-planned, a soundtrack the viewer was
  // stopped for waited 59 s behind a picture that had long left the urgent
  // band, because only the end of that picture's run planned again (Home
  // Assistant 2026-10-12, torrent-tv/meta#178).
  const after = viewers.get?.(consumerId);
  if (after && movedForThePlan(was, after, outputs.get(sessionId), segmentAt)) planSoon();
  // After the statement is recorded, so what is judged is what they just said:
  // a move of theirs to another limit may no longer be wanted.
  renditions.noteViewerReported(sessionId, consumerId);
  // And the quality budget judges this viewer now, on what they just said —
  // their buffer's trend, their link, the picture they see — rather than at
  // the next tick of a timer.
  void quality.noteViewerReported(sessionId, consumerId);
  return reply.code(204).send();
}

/**
 * Whether a report changed what the encoders are planned from: the piece the
 * viewer stands in, or whether they play or wait.
 *
 * @param {{ seconds: number | null, playing: boolean, waiting: boolean } | null} was
 * @param {{ position?: { seconds: number } | null, playing: boolean, waiting: boolean }} now
 * @param {object | undefined} output
 * @param {(output: object, seconds: number) => number | null} segmentAt
 * @returns {boolean}
 */
export function movedForThePlan(was, now, output, segmentAt) {
  if (!was) return true;
  if (was.playing !== now.playing || was.waiting !== now.waiting) return true;
  const seconds = now.position?.seconds;
  if (!Number.isFinite(seconds)) return false;
  if (!Number.isFinite(was.seconds)) return true;
  if (!output) return false;
  return segmentAt(output, was.seconds) !== segmentAt(output, seconds);
}
