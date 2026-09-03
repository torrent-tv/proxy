/**
 * Return the current encoding progress for an active HLS transcode session.
 *
 * GET /api/transcode-sessions/:sessionId/progress
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ hlsSessionManager: import("../../../../services/hls-session-manager.js").HlsSessionManager }} deps
 * @returns {Promise<void>}
 */
export async function handleApiTranscodeSessionsProgressGet(req, reply, { hlsSessionManager }) {
  const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
  if (!sessionId) {
    return reply.code(400).send({ error: "sessionId is required." });
  }

  // Whose progress. One picture serves everyone watching it, and after a
  // quality change the stream on screen is another session — a different one
  // for each viewer who changed.
  const consumerId = typeof req.query?.consumer === "string" ? req.query.consumer : "";
  const progress = await hlsSessionManager.getSessionProgress(sessionId, consumerId);
  if (!progress) {
    return reply.code(404).send({ error: "Transcode session was not found." });
  }

  return reply.send(progress);
}
