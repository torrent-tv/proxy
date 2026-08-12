import { logger } from "../../../utils/logger.js";

/**
 * How long a request for a not-yet-produced file is held before answering with
 * a retryable 503.
 *
 * MEASUREMENT MODE (2026-08-02): deliberately far above any plausible player
 * deadline, so OUR limit never fires first. Whatever ends the wait is then the
 * player's own behaviour — which is exactly what we need to observe. The
 * `[hold]` log line at the call site records, per request, whether the segment
 * arrived, whether we gave up, or whether the CLIENT aborted, and after how
 * long.
 *
 * The previous value (2 s) was chosen to dodge a reported iOS AVPlayer ~3.5 s
 * response-header deadline. That deadline never appears in our own logs (no
 * -12889 across six hours of production logs), and every reference project
 * holds rather than refusing: Jellyfin and hls-vod-too hold unbounded,
 * hls-media-server holds 10 s. The early refusal is what made the player probe
 * scattered positions, which then steered the encoder off target. Choose the
 * final value from what this measurement shows, not from a number read
 * elsewhere.
 */
const SEGMENT_WAIT_MS = 60_000;

/**
 * Serve HLS playlist and segment files from an active transcode session.
 *
 * Briefly waits for the requested file to appear, then answers with a
 * retryable 503 rather than holding the connection, so clients — in
 * particular iOS's native HLS player — never hit their own response
 * deadline while a segment is still being produced.
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
  return serveSessionFile(req, reply, { hlsSessionManager, sessionId, fileName });
}

/**
 * Serve one playlist or segment from a named session.
 *
 * Split from the route above because the variant route
 * (`/transcode/:sessionId/v/:height/:fileName`) serves the same files from
 * another session of the same family, and must hold, log and answer them
 * identically — a switch of quality must not go through a different code path
 * from the stream it switches away from.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ hlsSessionManager: import("../../../services/hls-session-manager.js").HlsSessionManager, sessionId: string, fileName: string }} params
 * @returns {Promise<void>}
 */
export async function serveSessionFile(req, reply, { hlsSessionManager, sessionId, fileName }) {
  // Hold the request only briefly, then answer "retry" instead of waiting for
  // the segment. iOS's native HLS player (AVPlayer) enforces a hard ~3.5 s
  // deadline on RESPONSE HEADERS and raises -12889 ("No response for media
  // file") when it passes — it then cancels in-flight requests, probes
  // neighbouring positions and can restart the stream from the beginning. That
  // is exactly the post-seek "player thrashing" seen in the field, because a
  // seek restarts ffmpeg and the first segment then takes far longer than 3.5 s
  // to appear. Holding the connection for 30 s (as this did) guaranteed the
  // timeout on every seek. A short hold keeps the fast path intact (a ready or
  // nearly-ready segment is still served on the first request) while a slow one
  // gets a prompt retryable answer, which resets the player's own deadline.
  // hls.js is unaffected: it consumes the 503 through its retry policy, whose
  // budget the client widens to match (see hls-player.js fragLoadPolicy).
  // Instrumented wait. `clientAborted` flips when the player drops the
  // connection while we are still holding it — the single most informative
  // signal about its real patience, and observable only from this side.
  const holdStartedAt = Date.now();
  let clientAborted = false;
  const onClientAbort = () => { clientAborted = true; };
  req.raw.on("close", onClientAbort);

  const result = await waitForSessionFile(hlsSessionManager, sessionId, fileName, SEGMENT_WAIT_MS);

  req.raw.off("close", onClientAbort);
  const heldMs = Date.now() - holdStartedAt;
  if (result.isPlaylist !== true) {
    const outcome = clientAborted
      ? "client-aborted"
      : result.kind === "ok" ? "served" : result.kind;
    logger.info(`[hold] ${fileName} ${outcome} after ${heldMs}ms`);
  }

  if (result.kind === "not-found") {
    return reply.code(404).send({ error: "Transcode session file was not found." });
  }
  if (result.kind === "superseded") {
    // The viewer moved while this was being held. Answer at once so the player
    // can ask for where it is now; `Retry-After: 0` because there is nothing to
    // wait for — this segment is simply no longer the one being watched.
    reply.header("Retry-After", "0");
    return reply.code(503).send({ error: "Superseded by a seek." });
  }
  if (result.kind === "warming-up") {
    // The segment is still being produced (e.g. just after a seek-restart).
    // Return a retryable 503 — never 202, which hls.js cannot consume as a
    // media segment — so the player retries the fetch shortly.
    reply.header("Retry-After", "1");
    // `Retry-After` tells the player to re-request THIS segment after a short
    // pause. Without it a bare 503 reads as "nothing here", and the player goes
    // looking elsewhere: because our synthetic VOD playlist lists every segment
    // of the file, it believes they all exist and SCANS them (field log: one
    // user seek produced probes at #617, #717, #732…). That scan is what used
    // to steer the encoder off the real target. Whether iOS's native player
    // honours the hint is not guaranteed — its behaviour is closed — but this
    // is the standard, correct way to say "wait, don't look elsewhere", and
    // hls.js already retries the same fragment regardless.
    reply.header("Retry-After", "1");
    return reply.code(503).send({ error: "Transcode segment is still being produced." });
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
export async function waitForSessionFile(hlsSessionManager, sessionId, fileName, timeoutMs) {
  const startedAt = Date.now();
  // One sequence number for THIS request, reused by every poll below, so the
  // session can tell a newly-arrived request apart from an old one polling
  // again — see HlsSessionManager#ensureEncodingFor for the encoder ping-pong
  // this prevents when one seek-bar scrub fires several segment requests.
  const requestSeq = hlsSessionManager.nextRequestSeq(sessionId);
  // The viewer's position when this request was made. A seek makes every held
  // request stale — it asks for a segment nobody is going to watch — and hls.js
  // keeps only ONE fragment load outstanding, so holding on blocks the request
  // the player actually needs now. Measured: 57 s of a 58 s backward seek was
  // this wait, and the segment the viewer wanted took 15 ms once it was asked
  // for.
  const seekEpoch = hlsSessionManager.seekEpoch(sessionId);
  while (Date.now() - startedAt < timeoutMs) {
    const result = await hlsSessionManager.getFileStream(sessionId, fileName, { requestSeq });
    if (result.kind !== "warming-up") {
      return result;
    }
    if (hlsSessionManager.seekEpoch(sessionId) !== seekEpoch) {
      return { kind: "superseded" };
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
