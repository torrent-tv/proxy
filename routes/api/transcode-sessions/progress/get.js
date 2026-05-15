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

  const progress = hlsSessionManager.getSessionProgress(sessionId);
  if (!progress) {
    return reply.code(404).send({ error: "Transcode session was not found." });
  }

  return reply.send(progress);
}
