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
