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

import {
  consumerOf,
  refusedAsStale,
  replyAssignmentLost,
  replyOutputUnavailable,
  serveSessionFile,
  statedGenerationOf
} from "../session-file/get.js";

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ renditions: object, serving: object, viewerRequests: object }} deps
 * @returns {Promise<void>}
 */
export async function handleTranscodeVariantFileGet(req, reply, { renditions, serving, viewerRequests }) {
  const baseSessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
  const height = Number(req.params.height);
  const fileName = typeof req.params.fileName === "string" ? req.params.fileName : "";

  // Which viewer is asking. Two viewers of one picture can be on two rungs, and
  // a segment request is what says which rung a viewer is watching — read as
  // the session's own, one of them would take the other off their step.
  const consumerId = consumerOf(req);
  // Before resolving: resolving can make a step and registers this viewer on
  // it, which a request for a viewing they have already left must not do.
  if (refusedAsStale(req, reply, viewerRequests, fileName)) {
    return reply;
  }
  const resolved = await renditions.resolveVariantFile(
    baseSessionId,
    height,
    fileName,
    consumerId,
    // Which viewing this request was made in: a repeat within it is answered
    // by whatever answered it the first time.
    statedGenerationOf(req)
  );
  if (resolved.unavailable) {
    return replyOutputUnavailable(reply, resolved.unavailable);
  }
  if (resolved.lost) {
    return replyAssignmentLost(reply, resolved.lost);
  }
  if (resolved.recover) {
    // The very piece that was given, from what its gone output left in the
    // store — held for as long as it is being sent, like any other answer.
    const stored = await serving.storedPieceOf(resolved.recover.key, resolved.recover.likeId, fileName);
    if (!stored) {
      return replyAssignmentLost(reply, { reason: "the stored piece went while it was being fetched" });
    }
    const release = viewerRequests.holdResponseForKey(resolved.recover.key, consumerId);
    reply.raw?.once?.("finish", release);
    reply.raw?.once?.("close", release);
    reply.raw?.once?.("error", release);
    if (!reply.raw || reply.raw.destroyed || reply.raw.writableEnded) {
      release();
    }
    reply.header("Cache-Control", "public, max-age=60");
    reply.header("Content-Type", stored.contentType);
    return reply.send(stored.stream);
  }
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
    serving,
    viewerRequests,
    sessionId: resolved.sessionId,
    fileName
  });
}
