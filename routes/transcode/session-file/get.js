/**
 * Serve HLS playlist and segment files from an active transcode session.
 *
 * Polls until the requested file appears (up to 15 s) so that HLS clients
 * do not receive a 404 during the ffmpeg warmup phase.
 *
 * GET /transcode/:sessionId/:fileName
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ hlsSessionManager: import("../../../services/hls-session-manager.js").HlsSessionManager }} deps
 * @returns {Promise<void>}
 */
export async function handleTranscodeSessionFileGet(req, reply, { hlsSessionManager }) {
  const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
  const fileName = typeof req.params.fileName === "string" ? req.params.fileName : "";
  const result = await waitForSessionFile(hlsSessionManager, sessionId, fileName, 15_000);

  if (result.kind === "not-found") {
    return reply.code(404).send({ error: "Transcode session file was not found." });
  }
  if (result.kind === "warming-up") {
    reply.header("Retry-After", "2");
    return reply.code(202).send({ status: "warming-up" });
  }
  if (result.kind === "failed") {
    return reply.code(500).send({ error: result.message });
  }

  if (result.isPlaylist) {
    reply.header("Cache-Control", "no-store");
  } else {
    reply.header("Cache-Control", "public, max-age=60");
  }
  reply.header("Content-Type", result.contentType);
  return reply.send(result.stream);
}

/**
 * Poll `hlsSessionManager.getFileStream()` until the file is available,
 * the session fails, or the timeout elapses.
 *
 * @param {import("../../../services/hls-session-manager.js").HlsSessionManager} hlsSessionManager
 * @param {string} sessionId
 * @param {string} fileName
 * @param {number} timeoutMs
 * @returns {Promise<Awaited<ReturnType<import("../../../services/hls-session-manager.js").HlsSessionManager["getFileStream"]>>>}
 */
async function waitForSessionFile(hlsSessionManager, sessionId, fileName, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await hlsSessionManager.getFileStream(sessionId, fileName);
    if (result.kind !== "warming-up") {
      return result;
    }
    await delay(300);
  }
  return { kind: "warming-up" };
}

/**
 * Resolve after a given number of milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
