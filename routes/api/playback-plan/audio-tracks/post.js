/**
 * Refresh metadata for audio tracks whose sidecar headers were unavailable
 * when the playback plan was built.
 *
 * POST /api/playback-plan/audio-tracks
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ playbackPlanner: object }} deps
 */
export async function handleApiPlaybackPlanAudioTracksPost(req, reply, { playbackPlanner }) {
  const payload = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const sourceKey = typeof payload.sourceKey === "string" ? payload.sourceKey.trim() : "";
  const fileIndex = Number(payload.fileIndex);
  if (!sourceKey || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return reply.code(400).send({ error: "sourceKey and valid fileIndex are required." });
  }
  try {
    const { PlaybackController } = await import("../../../../services/server/controllers/PlaybackController.js");
    const controller = new PlaybackController({ playbackPlanner });
    return reply.send(await controller.refreshAudioTracks({ sourceKey, fileIndex }));
  } catch (error) {
    if (error instanceof Error && error.code === "SOURCE_NOT_FOUND") {
      return reply.code(404).send({ error: error.message });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: `Failed to refresh audio track metadata: ${message}` });
  }
}
