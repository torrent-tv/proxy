/**
 * @file GET /transcode/:sessionId/v/:height/:fileName — one file of a quality
 * variant.
 *
 * A variant is another encode of the same file at another height, and it is an
 * ordinary session underneath. It lives under the base session's path, one
 * directory level down, so every relative name inside its playlist — its
 * segments and its `#EXT-X-MAP` init — resolves to that variant with nothing in
 * the playlist itself having to change.
 *
 * The variant is created on the first request for it, which is what keeps a
 * weak host running one encoder: the player's own bitrate adaptation is off, so
 * no variant is ever asked for unless the viewer picked it.
 */

import { serveSessionFile } from "../session-file/get.js";

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ hlsSessionManager: import("../../../services/hls-session-manager.js").HlsSessionManager }} deps
 * @returns {Promise<void>}
 */
export async function handleTranscodeVariantFileGet(req, reply, { hlsSessionManager }) {
  const baseSessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
  const height = Number(req.params.height);
  const fileName = typeof req.params.fileName === "string" ? req.params.fileName : "";

  const resolved = await hlsSessionManager.resolveVariantFile(baseSessionId, height, fileName);
  if (resolved.error) {
    // Preparing the variant failed — a probe, a keyframe index, an input that
    // is not there yet. Retryable, like every other not-ready answer on this
    // path: a 500 for a level playlist is fatal to hls.js, which would end the
    // stream over something the next attempt may well get past.
    reply.header("Retry-After", "1");
    return reply.code(503).send({ error: `Could not prepare the quality variant: ${resolved.error}` });
  }
  if (!resolved.sessionId) {
    return reply.code(404).send({ error: "No such quality variant for this transcode session." });
  }

  return serveSessionFile(req, reply, {
    hlsSessionManager,
    sessionId: resolved.sessionId,
    fileName
  });
}
