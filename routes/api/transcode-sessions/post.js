function getPayload(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body;
  }
  return {};
}

export async function handleApiTranscodeSessionsPost(req, reply, { hlsSessionManager }) {
  const payload = getPayload(req.body);
  const sourceKey = typeof payload.sourceKey === "string" ? payload.sourceKey.trim() : "";
  const fileIndex = Number(payload.fileIndex);
  const transcodeVideo = payload.transcodeVideo === true;
  const transcodeAudio = payload.transcodeAudio === true;
  const consumerId = typeof payload.consumerId === "string" ? payload.consumerId.trim() : "";
  const fileName = typeof payload.fileName === "string" ? payload.fileName.trim() : "";
  const targetWidth = Number(payload.targetWidth);
  const targetHeight = Number(payload.targetHeight);

  if (!sourceKey || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return reply.code(400).send({ error: "sourceKey and valid fileIndex are required." });
  }

  try {
    const session = await hlsSessionManager.createOrGetSession({
      sourceKey,
      fileIndex,
      transcodeVideo,
      transcodeAudio,
      consumerId,
      fileName,
      targetWidth: Number.isInteger(targetWidth) && targetWidth > 0 ? targetWidth : 0,
      targetHeight: Number.isInteger(targetHeight) && targetHeight > 0 ? targetHeight : 0
    });
    return reply.send({
      sessionId: session.id,
      playlistPath: `/transcode/${session.id}/index.m3u8`
    });
  } catch (error) {
    if (error instanceof Error && error.code === "TRANSCODE_DISABLED") {
      return reply.code(409).send({ error: error.message });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: `Failed to prepare transcode session: ${message}` });
  }
}
