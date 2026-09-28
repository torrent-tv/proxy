import {
  consumerOf,
  refusedAsStale,
  serveSessionFile,
  statedGenerationOf
} from "../../../services/server/transcode-session-files.js";

/**
 * How long a request for a file not yet produced is held: AS LONG AS THE
 * REQUESTER SAYS IT WILL WAIT, and no longer than it stays.
 *
 * The patience is the requester's. It used to be a figure of this route's own,
 * 60 s, beside the page's own 60 s — two chosen numbers that happened to agree,
 * so the "retry" this route sent at its deadline reached a page that had given
 * up at the same instant. The page now states how long it will hold the answer
 * open (`X-Hold-Ms`, its own deadline less the round trip it has measured), and
 * this route answers by then. A requester that states nothing is held until it
 * closes the connection, which every HTTP client does when it stops waiting.
 */

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
 * @param {{ serving: object, viewerRequests: object }} deps
 * @returns {Promise<void>}
 */
export async function handleTranscodeSessionFileGet(req, reply, { serving, viewerRequests }) {
  const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
  const fileName = typeof req.params.fileName === "string" ? req.params.fileName : "";
  if (refusedAsStale(req, reply, viewerRequests, fileName)) {
    return reply;
  }
  // This route names its output outright, so the answer is recorded rather
  // than chosen — under the height the output is named after, which is where
  // the step route answers with the picture itself.
  viewerRequests.noteAnsweredDirectly(
    sessionId,
    consumerOf(req),
    statedGenerationOf(req),
    fileName
  );
  return serveSessionFile(req, reply, { serving, viewerRequests, sessionId, fileName });
}
