/**
 * Accept the player's report that a delivered fragment sits far from the edge
 * of what it has buffered.
 *
 * This is the earliest statement that exists of a stream coming apart, and
 * until now it lived only in the browser's console. Measured 2026-08-21 on
 * `JUFD665.mp4`: four of these across half a minute, each naming a gap of
 * ~33.5 s, while the buffer stood still at 4571.1 s — and then hls.js gave up
 * and jumped the viewer 16.8 s forward. The proxy is the only side that can say
 * what the gap MEANS, because only it knows which boundary the segment it
 * produced actually holds, and whether that is the one its number claims.
 *
 * POST /api/transcode-sessions/:sessionId/fragment-far
 * Body: { sn: number, track?: string, fragStartSec: number, bufferEndSec: number, currentTimeSec: number }
 *
 * `track` is hls.js's own name for the stream the fragment belongs to ("main"
 * or "audio"). It matters because picture and sound are produced by two
 * different sessions positioned by two different runs — which is how they come
 * apart in the first place — so a report answered against the wrong one is a
 * confident statement about a stream nobody asked about.
 *
 * Diagnostic only — it changes nothing about the encode. Invalid body → 400,
 * unknown session → 404, ok → 204.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ hlsSessionManager: import("../../../../services/hls-session-manager.js").HlsSessionManager }} deps
 * @returns {Promise<void>}
 */
export async function handleApiTranscodeSessionFragmentFarPost(req, reply, { hlsSessionManager }) {
  const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const sn = Number(body.sn);
  const track = typeof body.track === "string" ? body.track : "";
  const fragStartSec = Number(body.fragStartSec);
  const bufferEndSec = Number(body.bufferEndSec);
  const currentTimeSec = Number(body.currentTimeSec);
  if (
    !sessionId ||
    !Number.isInteger(sn) ||
    sn < 0 ||
    !Number.isFinite(fragStartSec) ||
    !Number.isFinite(bufferEndSec) ||
    !Number.isFinite(currentTimeSec)
  ) {
    return reply.code(400).send({ error: "sn (integer >=0), fragStartSec, bufferEndSec and currentTimeSec are required." });
  }

  const recorded = hlsSessionManager.recordFragmentFar(sessionId, {
    sn,
    track,
    fragStartSec,
    bufferEndSec,
    currentTimeSec
  });
  if (!recorded) {
    return reply.code(404).send({ error: "Transcode session was not found." });
  }
  return reply.code(204).send();
}
