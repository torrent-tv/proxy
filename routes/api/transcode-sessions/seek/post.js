/**
 * @file POST /api/transcode-sessions/:sessionId/seek — the viewer's seek target.
 *
 * The browser reports WHERE THE VIEWER ACTUALLY SEEKED, explicitly, the moment
 * the scrub ends. This is the only authoritative source of that intent: the
 * position lives in the browser (`video.currentTime`) and nowhere else.
 *
 * Why this route exists at all: our synthetic VOD playlist advertises every
 * segment of the file, but segments only exist once ffmpeg has produced them.
 * A player is entitled by the HLS contract to fetch any advertised segment and
 * get it immediately, so when one 503s it legitimately probes elsewhere —
 * field log 2026-08-02 shows a correct target burst (#973..#985, the real seek)
 * followed by scattered probing across the whole file (#125, #173, #251, #326,
 * #478...). Inferring the target from that request stream made the encoder
 * restart at #519 — a probe, not the seek — and the viewer waited ten seconds
 * for a segment nobody wanted. Segment requests are data fetches, not commands;
 * the seek target now arrives here instead of being guessed from them.
 *
 * Mirrors how Jellyfin/Plex handle server-side seeking (an explicit start
 * position from the client), rather than heuristics over request patterns.
 */

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ hlsSessionManager: import("../../../../services/hls-session-manager.js").HlsSessionManager }} deps
 * @returns {Promise<void>}
 */
export async function handleApiTranscodeSessionSeekPost(req, reply, { hlsSessionManager }) {
  const sessionId = req.params?.sessionId;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const positionSeconds = Number(body.positionSeconds);

  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
    reply.code(400);
    return reply.send({ error: "positionSeconds must be a non-negative number." });
  }

  // Who moved. A session can be shared, and the seeking viewer's own position
  // has to move with them or their next request is judged against where they
  // were before the jump.
  const consumerId = typeof body.consumerId === "string" ? body.consumerId.trim() : "";
  const applied = hlsSessionManager.requestSeek(sessionId, positionSeconds, consumerId);
  if (!applied) {
    // Unknown or disposed session — nothing to steer. Not an error worth
    // surfacing to the viewer: the seek will be handled by whatever session
    // replaces it.
    reply.code(404);
    return reply.send({ error: "No such transcode session." });
  }

  reply.code(204);
  return reply.send();
}
