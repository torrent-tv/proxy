/**
 * @file GET /transcode/:sessionId/v/:height/warm?position=<seconds> — prepare a
 * quality rung before the player is told to switch to it.
 *
 * A rung is an encoder that does not exist until someone asks for it, so a
 * switch made first and waited for second shows the viewer a spinner for as
 * long as the first segment takes to produce — 15 988 ms, measured 2026-08-11
 * on a rung producing at 1.2x. Asking first and switching second moves that
 * wait to where it cannot be seen: the rung on screen goes on playing, and it
 * keeps its own encoder until the player actually moves.
 *
 * Answers when the segment at that position is ready, so the caller can switch
 * knowing there is something to fetch.
 */

import { replyOutputUnavailable } from "../../../services/server/http-responses.js";
import { waitForSessionFile } from "../../../services/server/transcode-session-files.js";
import { OUTPUT_UNAVAILABLE } from "../../../services/encode/output/index.js";

/** How long to hold the warm-up request before telling the caller to retry. */
const WARM_WAIT_MS = 30_000;

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ renditions: object, serving: object, viewerRequests: object }} deps
 * @returns {Promise<void>}
 */
export async function handleTranscodeVariantWarmGet(req, reply, { renditions, serving, viewerRequests }) {
  const baseSessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
  const height = Number(req.params.height);
  const positionSeconds = Number(req.query?.position);

  if (!Number.isInteger(height) || height <= 0 || !Number.isFinite(positionSeconds) || positionSeconds < 0) {
    return reply.code(400).send({ error: "A height and a non-negative position are required." });
  }
  // Whose warm-up this is. It was not passed at all, so every warm-up was
  // written onto a nameless viewer instead of the person who asked for it.
  const consumerId = typeof req.query?.consumer === "string" ? req.query.consumer : "";
  if (!consumerId) {
    return reply.code(400).send({ error: "A consumer is required." });
  }

  let prepared;
  try {
    prepared = await renditions.prepareVariant(baseSessionId, height, positionSeconds, consumerId);
  } catch (error) {
    if (error?.code === OUTPUT_UNAVAILABLE) {
      // Nothing at that height suits this viewer's link. Said at once and not
      // as "retry": the page tells the viewer and keeps what is playing.
      return replyOutputUnavailable(reply, error.details);
    }
    const message = error instanceof Error ? error.message : String(error);
    reply.header("Retry-After", "1");
    return reply.code(503).send({ error: `Could not prepare the quality variant: ${message}` });
  }
  if (!prepared) {
    return reply.code(404).send({ error: "No such quality variant for this transcode session." });
  }

  const result = await waitForSessionFile(
    serving,
    prepared.sessionId,
    prepared.fileName,
    { holdMs: WARM_WAIT_MS }
  );
  if (result.kind === "file") {
    // The bytes are not sent — the player fetches them itself the moment it
    // switches, and by then they are on disk — but the handle opened to reach
    // them is ours to close. Some formats answer with a real file descriptor
    // rather than bytes already in memory, and one left behind per quality pick
    // walks a long-running proxy to EMFILE, where every read fails, segments
    // included.
    result.stream?.destroy?.();
    return reply.code(204).send();
  }
  if (result.kind === "failed") {
    return reply.code(500).send({ error: result.message });
  }
  // Still being produced. The caller may switch anyway — it will simply wait
  // where it would have waited before — or ask again.
  reply.header("Retry-After", "1");
  return reply.code(503).send({ error: "The quality variant is still warming up." });
}
