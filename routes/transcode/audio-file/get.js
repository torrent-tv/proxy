/**
 * @file GET /transcode/:sessionId/a/:trackIndex/:fileName — one file of an audio
 * rendition.
 *
 * A rendition is one audio track of the file, encoded once and shared by every
 * quality rung, published in the master playlist as `#EXT-X-MEDIA`. It is an
 * ordinary session underneath, living one directory level below the base
 * session so every relative name inside its playlist resolves to it unchanged —
 * the same arrangement quality variants use.
 *
 * Unlike a variant, a rendition is fetched ALONGSIDE the picture rather than
 * instead of it: both encoders run, one for the rung and one for the audio.
 */

import { serveSessionFile } from "../session-file/get.js";

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ hlsSessionManager: import("../../../services/hls-session-manager.js").HlsSessionManager }} deps
 * @returns {Promise<void>}
 */
export async function handleTranscodeAudioFileGet(req, reply, { hlsSessionManager }) {
  const baseSessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
  const trackIndex = Number(req.params.trackIndex);
  const fileName = typeof req.params.fileName === "string" ? req.params.fileName : "";

  // Which viewer is asking. One picture serves everyone watching it, and the
  // soundtrack each of them chose is their own: without this, a segment request
  // from one viewer would be read as everybody moving to that track, and the
  // other viewer's encoder would be stopped once per segment.
  const consumerId = typeof req.query?.consumer === "string" ? req.query.consumer : "";
  const resolved = await hlsSessionManager.resolveAudioRenditionFile(
    baseSessionId,
    trackIndex,
    fileName,
    consumerId
  );
  if (resolved.error) {
    // Retryable, like every other not-ready answer on this path: a 500 for a
    // rendition playlist would end the stream over something the next attempt
    // may well get past.
    reply.header("Retry-After", "1");
    return reply.code(503).send({ error: `Could not prepare the audio rendition: ${resolved.error}` });
  }
  if (!resolved.sessionId) {
    return reply.code(404).send({ error: "No such audio rendition for this transcode session." });
  }

  return serveSessionFile(req, reply, {
    hlsSessionManager,
    sessionId: resolved.sessionId,
    fileName
  });
}
