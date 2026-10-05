/**
 * Determine the best playback mode (direct stream or HLS transcode) for a
 * torrent file and return the corresponding plan.
 *
 * POST /api/playback-plan
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ playbackPlanner: ReturnType<import("../../../services/media/playback-planner.js").createPlaybackPlanner> }} deps
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

export async function handleApiPlaybackPlanPost(req, reply, { playbackPlanner, sourceRegistry, torrentPool, ffmpegBin, localBaseUrl, viewers }) {
  const payload = getPayload(req.body);
  const sourceKey = typeof payload.sourceKey === "string" ? payload.sourceKey.trim() : "";
  const fileIndex = Number(payload.fileIndex);
  const userAgent = typeof payload.userAgent === "string" ? payload.userAgent : "";

  if (!sourceKey || !Number.isSafeInteger(fileIndex) || fileIndex < 0) {
    return reply.code(400).send({ error: "sourceKey and valid fileIndex are required." });
  }
  const consumerId = typeof payload.consumerId === "string" ? payload.consumerId.trim() : "";
  const selection = {};
  if (typeof payload.positionSeconds === "number" && Number.isFinite(payload.positionSeconds) && payload.positionSeconds >= 0) selection.positionSeconds = payload.positionSeconds;
  if (typeof payload.wantsToPlay === "boolean") selection.wantsToPlay = payload.wantsToPlay;
  if (consumerId) viewers?.selectsFile(consumerId, sourceKey, fileIndex, Date.now(), selection);

  // Interface delegates to PlaybackController (orchestrator + domain). Keeps route thin.
  const { PlaybackController } = await import("../../../services/server/controllers/PlaybackController.js");
  const controller = new PlaybackController({ torrentPool, sourceRegistry, ffmpegBin, localBaseUrl, playbackPlanner });
  const cancellation = new AbortController();
  const aborted = () => cancellation.abort();
  const closed = () => { if (!reply.raw?.writableEnded) aborted(); };
  req.raw?.once?.("aborted", aborted);
  reply.raw?.once?.("close", closed);
  if (req.raw?.aborted) aborted();
  try {
    const params = { sourceKey, fileIndex, userAgent };
    const plan = payload.waitForReady === true
      ? await controller.getReadyPlan(params, { signal: cancellation.signal }) : await controller.getPlan(params);
    return reply.send(plan);
  } catch (error) {
    if (cancellation.signal.aborted) return;
    if (error instanceof Error && error.code === "SOURCE_NOT_FOUND") {
      return reply.code(404).send({ error: error.message });
    }
    if (error instanceof Error && error.code === "FILE_NOT_FOUND") {
      return reply.code(404).send({ error: error.message });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: `Failed to prepare playback plan: ${message}`, code: error?.code, canRetry: error?.canRetry !== false });
  } finally {
    req.raw?.removeListener?.("aborted", aborted);
    reply.raw?.removeListener?.("close", closed);
  }
}
