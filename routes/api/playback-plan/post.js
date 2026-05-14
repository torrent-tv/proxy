function getPayload(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body;
  }
  return {};
}

export async function handleApiPlaybackPlanPost(req, reply, { playbackPlanner }) {
  const payload = getPayload(req.body);
  const sourceKey = typeof payload.sourceKey === "string" ? payload.sourceKey.trim() : "";
  const fileIndex = Number(payload.fileIndex);
  const userAgent = typeof payload.userAgent === "string" ? payload.userAgent : "";

  if (!sourceKey || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return reply.code(400).send({ error: "sourceKey and valid fileIndex are required." });
  }

  try {
    const plan = await playbackPlanner.getPlan({ sourceKey, fileIndex, userAgent });
    return reply.send(plan);
  } catch (error) {
    if (error instanceof Error && error.code === "SOURCE_NOT_FOUND") {
      return reply.code(404).send({ error: error.message });
    }
    if (error instanceof Error && error.code === "FILE_NOT_FOUND") {
      return reply.code(404).send({ error: error.message });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: `Failed to prepare playback plan: ${message}` });
  }
}
