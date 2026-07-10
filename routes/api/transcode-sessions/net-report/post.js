/**
 * Accept a viewer link report for a transcode session (adaptive bitrate).
 * The browser measures its own data-channel throughput per segment fetch and
 * posts a rolling median + its buffered seconds; the session manager's budget
 * loop uses the latest report as the link-deficit downshift trigger.
 *
 * POST /api/transcode-sessions/:sessionId/net-report
 * Body: { linkMbps: number, bufferedAheadSec: number }
 *
 * Best-effort telemetry: invalid body → 400, unknown session → 404, ok → 204.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ hlsSessionManager: import("../../../../services/hls-session-manager.js").HlsSessionManager }} deps
 * @returns {Promise<void>}
 */
export async function handleApiTranscodeSessionNetReportPost(req, reply, { hlsSessionManager }) {
  const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const linkMbps = Number(body.linkMbps);
  const bufferedAheadSec = Number(body.bufferedAheadSec);
  if (!sessionId || !Number.isFinite(linkMbps) || linkMbps <= 0 || !Number.isFinite(bufferedAheadSec) || bufferedAheadSec < 0) {
    return reply.code(400).send({ error: "linkMbps (>0) and bufferedAheadSec (>=0) are required." });
  }

  const recorded = hlsSessionManager.recordNetReport(sessionId, { linkMbps, bufferedAheadSec });
  if (!recorded) {
    return reply.code(404).send({ error: "Transcode session was not found." });
  }
  return reply.code(204).send();
}
