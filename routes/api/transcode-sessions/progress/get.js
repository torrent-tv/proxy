/**
 * Return the current encoding progress for an active HLS transcode session.
 *
 * GET /api/transcode-sessions/:sessionId/progress
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ viewerRequests: object }} deps
 * @returns {Promise<void>}
 */
export async function handleApiTranscodeSessionsProgressGet(req, reply, { viewerRequests }) {
  const requestReceivedAtProxyMs = performance.now();
  const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
  if (!sessionId) {
    return reply.code(400).send({ error: "sessionId is required." });
  }

  // Whose progress. One picture serves everyone watching it, and after a
  // quality change the stream on screen is another session — a different one
  // for each viewer who changed.
  const consumerId = typeof req.query?.consumer === "string" ? req.query.consumer : "";
  const progress = await viewerRequests.getSessionProgress(sessionId, consumerId);
  if (!progress) {
    return reply.code(404).send({ error: "Transcode session was not found." });
  }

  const responsePreparedAtProxyMs = performance.now();
  progress.snapshotTransport = {
    requestReceivedAtProxyMs,
    snapshotAtProxyMs: progress.playbackReadiness?.snapshotAtProxyMs ?? null,
    responsePreparedAtProxyMs
  };
  return reply.send(progress);
}
