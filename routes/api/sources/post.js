function getPayload(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body;
  }
  return {};
}

export async function handleApiSourcesPost(req, reply, { sourceRegistry }) {
  const payload = getPayload(req.body);
  const sourceType = typeof payload.sourceType === "string" ? payload.sourceType : "";
  const source = typeof payload.source === "string" ? payload.source : "";
  if (!sourceType || !source) {
    return reply.code(400).send({ error: "sourceType and source are required." });
  }

  const sourceKey = sourceRegistry.upsert(sourceType, source);
  return reply.send({ sourceKey });
}
