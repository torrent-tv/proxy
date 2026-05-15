/**
 * Release a consumer from a transcode session.
 * When the last consumer is released the session is disposed automatically.
 *
 * POST /api/transcode-sessions/:sessionId/release
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ hlsSessionManager: import("../../../../services/hls-session-manager.js").HlsSessionManager }} deps
 * @returns {Promise<void>}
 */

/**
 * Extract a plain object from the request body, guarding against
 * non-object payloads (arrays, primitives, null).
 *
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function getPayload(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body;
  }
  return {};
}

export async function handleApiTranscodeSessionReleasePost(req, reply, { hlsSessionManager }) {
  const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
  const payload = getPayload(req.body);
  const consumerId = typeof payload.consumerId === "string" ? payload.consumerId.trim() : "";
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (!sessionId || !consumerId) {
    return reply.code(400).send({ error: "sessionId and consumerId are required." });
  }

  const released = await hlsSessionManager.releaseSessionConsumer(sessionId, consumerId, reason);
  if (!released) {
    return reply.code(404).send({ error: "Transcode session was not found." });
  }
  return reply.send({ ok: true });
}
