/**
 * Determine the best playback mode (direct stream or HLS transcode) for a
 * torrent file and return the corresponding plan.
 *
 * POST /api/playback-plan
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ playbackPlanner: ReturnType<import("../../../services/playback-planner.js").createPlaybackPlanner> }} deps
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

export async function handleApiPlaybackPlanPost(req, reply, { playbackPlanner, sourceRegistry, torrentPool, ffmpegBin, localBaseUrl }) {
  const payload = getPayload(req.body);
  const sourceKey = typeof payload.sourceKey === "string" ? payload.sourceKey.trim() : "";
  const fileIndex = Number(payload.fileIndex);
  const userAgent = typeof payload.userAgent === "string" ? payload.userAgent : "";

  if (!sourceKey || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return reply.code(400).send({ error: "sourceKey and valid fileIndex are required." });
  }

  // Interface delegates to PlaybackController (orchestrator + domain). Keeps route thin.
  const { PlaybackController } = await import("../../../services/controllers/PlaybackController.js");
  const controller = new PlaybackController({ torrentPool, sourceRegistry, ffmpegBin, localBaseUrl, playbackPlanner });
  try {
    const plan = await controller.getPlan({ sourceKey, fileIndex, userAgent, maxWaitMs: 8_000 });
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
