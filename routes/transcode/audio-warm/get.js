/**
 * @file GET /transcode/:sessionId/a/:track/warm?position=<seconds>[&transcode=0|1]
 * — prepare an audio track before the player is told to change to it.
 *
 * `transcode` is the page's statement about THIS track: `1` when its browser
 * cannot play the track's codec as it stands, `0` when it can. The proxy then
 * decides how the track is produced by the same rule as when a file is opened
 * — a track nothing states a rate for is re-encoded even for a browser that
 * would play it. Left out, the page is taken to need what it needs for the
 * track it is on.
 *
 * The picture keeps playing while a quality rung is warmed (`variant-warm`),
 * and a track change deserves the same: the player discards the audio it holds
 * the moment it switches and cannot show a frame until the new track covers the
 * playhead, so switching first and producing second shows the track's cold
 * start as a spinner over a stopped picture (measured 2026-08-15).
 *
 * Answers 204 when the segment at that position is ready, so the caller can
 * switch into bytes that already exist; 503 while it is still being made.
 */

import { waitForSessionFile } from "../../../services/server/transcode-session-files.js";

/** How long to hold the request before telling the caller to retry. */
const WARM_WAIT_MS = 12_000;

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ renditions: object, serving: object, viewerRequests: object }} deps
 */
export async function handleTranscodeAudioWarmGet(req, reply, { renditions, serving, viewerRequests }) {
  const baseSessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
  const trackIndex = Number(req.params.track);
  const positionSeconds = Number(req.query?.position);

  if (
    !Number.isInteger(trackIndex) ||
    trackIndex < 0 ||
    !Number.isFinite(positionSeconds) ||
    positionSeconds < 0
  ) {
    return reply.code(400).send({ error: "A track index and a non-negative position are required." });
  }

  // Whose track change this is. Another viewer of the same picture may be
  // listening to something else, and preparing a track must not be read as
  // everybody moving to it.
  const consumerId = typeof req.query?.consumer === "string" ? req.query.consumer : "";
  if (!consumerId) {
    return reply.code(400).send({ error: "A consumer is required." });
  }

  const statedNeed = req.query?.transcode;
  const browserPlays = statedNeed === "0" ? true : statedNeed === "1" ? false : null;

  let prepared;
  try {
    prepared = await renditions.prepareAudioTrack(
      baseSessionId,
      trackIndex,
      positionSeconds,
      consumerId,
      browserPlays
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply.header("Retry-After", "1");
    return reply.code(503).send({ error: `Could not prepare the audio track: ${message}` });
  }
  if (!prepared) {
    return reply.code(404).send({ error: "No such audio track for this transcode session." });
  }

  const result = await waitForSessionFile(
    serving,
    prepared.sessionId,
    prepared.fileName,
    { holdMs: WARM_WAIT_MS }
  );
  if (result.kind === "file") {
    // The bytes are the player's to fetch; the handle opened to reach them is
    // ours to close, or a long-running proxy walks to EMFILE one track change
    // at a time.
    result.stream?.destroy?.();
    return reply.code(204).send();
  }
  if (result.kind === "failed") {
    return reply.code(500).send({ error: result.message });
  }
  // Still being produced. The caller may switch anyway — it will wait where it
  // would have waited before — or ask again.
  //
  // `warming: true` says the track and how it is produced ARE recorded for this
  // viewer — `prepareAudioTrack` records them before the wait — which the
  // status alone cannot say: the 503 above is a preparation that recorded
  // nothing. A page restating its soundtrack after a reconnect needs to know
  // which of the two it got.
  reply.header("Retry-After", "1");
  return reply.code(503).send({ error: "The audio track is still warming up.", warming: true });
}
