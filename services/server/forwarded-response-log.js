/**
 * @file The log of a forwarded transcode-session response (the registry's
 * request, followed from its arrival to its last byte).
 *
 * Moved out of `server.js` verbatim (torrent-tv/meta#280). It imports nothing:
 * the logger and the clock are passed in.
 */

/**
 * Registers, on `app`, the hooks that write the `[forecast-http]` and
 * `[http-response]` lines of a `POST /api/transcode-sessions` carrying
 * `x-ttv-forwarded-request-id`. Any other request logs nothing.
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {{ log: (line: string) => void, warn: (line: string) => void, now?: () => number }} ports
 */
export function installForwardedResponseLog(app, { log, warn, now = () => performance.now() }) {
  const forwardedSessionResponseStarts = new WeakMap();
  const logStage = (stage, req) => {
    const startedAt = forwardedSessionResponseStarts.get(req);
    const requestId = req.headers["x-ttv-forwarded-request-id"];
    if (startedAt === undefined || typeof requestId !== "string") return;
    const at = now();
    log(`[forecast-http] stage=${stage} requestId=${requestId} atMs=${at.toFixed(3)} ` +
      `elapsedMs=${(at - startedAt).toFixed(3)}`);
  };
  app.addHook("onRequest", async (req, reply) => {
    const requestId = req.headers["x-ttv-forwarded-request-id"];
    if (typeof requestId !== "string" || req.method !== "POST" || req.url !== "/api/transcode-sessions") return;
    const startedAt = now();
    forwardedSessionResponseStarts.set(req, startedAt);
    logStage("onRequest", req);
    reply.raw.once("finish", () => {
      logStage("finish", req);
      log(`[http-response] requestId=${requestId} method=${req.method} url=${req.url} ` +
        `responseMs=${(now() - startedAt).toFixed(1)} status=${reply.statusCode} ` +
        `contentLength=${reply.raw.getHeader("content-length") ?? "unknown"}`);
    });
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) {
        logStage("close", req);
        warn(`[http-response] requestId=${requestId} method=${req.method} url=${req.url} ` +
          `closedMs=${(now() - startedAt).toFixed(1)} status=${reply.statusCode}`);
      }
    });
  });
  app.addHook("preSerialization", async (req, _reply, payload) => {
    logStage("preSerialization", req);
    return payload;
  });
  app.addHook("onSend", async (req, _reply, payload) => {
    logStage("onSend", req);
    return payload;
  });
}
