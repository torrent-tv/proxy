/**
 * @file WebRTC data channel request handler (proxy side).
 *
 * When a browser opens a data channel to this proxy, this handler wires up
 * message handlers that implement an HTTP-over-DataChannel protocol:
 * each incoming `request` message triggers a local `fetch` to the Fastify
 * server, and the response is streamed back as base64-encoded chunks.
 *
 * ## Wire protocol
 *
 * Browser → Proxy
 * ```
 * { type: "request",  requestId, method, path, query, headers, body }
 * { type: "ping",     id }
 * ```
 *
 * Proxy → Browser
 * ```
 * { type: "response-start", requestId, status, headers }
 * { type: "response-chunk", requestId, data: string (base64), done: boolean }
 * { type: "response-error", requestId, error: string }
 * { type: "pong",           id }
 * ```
 *
 * The protocol mirrors the tunnel relay protocol so both transports share
 * the same mental model and the same browser-side `WebRtcProxy` implementation.
 */

/** @import { DataChannel } from 'node-datachannel' */

/**
 * Configuration for the data channel handler.
 *
 * @typedef {Object} DataChannelHandlerOptions
 * @property {number} proxyPort
 *   Local port the proxy's Fastify HTTP server is listening on.
 *   Incoming requests are forwarded to `http://127.0.0.1:{proxyPort}`.
 * @property {(message: string) => void} [onLog]
 *   Optional log sink.
 */

/**
 * An incoming request message received over the data channel.
 *
 * @typedef {Object} DataChannelRequest
 * @property {string}  requestId
 * @property {string}  method    - HTTP method (GET, POST, …).
 * @property {string}  path      - Request path (e.g. "/api/sources").
 * @property {string}  query     - Raw query string without the leading "?".
 * @property {Record<string, string>} headers - Headers to forward.
 * @property {string | null} body - Request body string, or null.
 */

/**
 * The object returned by {@link createDataChannelHandler}.
 *
 * @typedef {Object} DataChannelHandler
 * @property {(sessionId: string, channel: DataChannel) => void} handleChannel
 *   Wire message handlers onto a freshly opened data channel.
 */

/**
 * Create a handler for incoming WebRTC data channels.
 *
 * @param {DataChannelHandlerOptions} options
 * @returns {DataChannelHandler}
 */
export function createDataChannelHandler({ proxyPort, onLog }) {
  /**
   * @param {string} message
   * @returns {void}
   */
  function log(message) {
    if (typeof onLog === "function") {
      onLog(message);
    }
  }

  /**
   * Wire up the `onMessage`, `onClosed`, and `onError` handlers for a channel.
   *
   * @param {string}      sessionId
   * @param {DataChannel} channel
   * @returns {void}
   */
  function handleChannel(sessionId, channel) {
    log(`[dc] Session ${sessionId.slice(0, 8)}: channel open`);

    channel.onMessage((raw) => {
      /** @type {DataChannelRequest | { type: "ping", id: string }} */
      let message;
      try {
        message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        return;
      }

      if (message.type === "request") {
        void handleRequest(channel, message).catch((error) => {
          log(`[dc] Session ${sessionId.slice(0, 8)}: request error: ${error?.message ?? error}`);
        });
        return;
      }

      if (message.type === "ping") {
        send(channel, { type: "pong", id: message.id });
      }
    });

    channel.onClosed(() => {
      log(`[dc] Session ${sessionId.slice(0, 8)}: channel closed`);
    });

    channel.onError((err) => {
      log(`[dc] Session ${sessionId.slice(0, 8)}: channel error: ${err}`);
    });
  }

  /**
   * Fetch a resource from the local proxy HTTP server and stream the response
   * back to the browser over the data channel.
   *
   * The `Host` header is rewritten to `127.0.0.1:{proxyPort}` so that Fastify
   * routes the request correctly regardless of what the browser sent.
   *
   * @param {DataChannel}        channel
   * @param {DataChannelRequest} req
   * @returns {Promise<void>}
   */
  async function handleRequest(channel, req) {
    const { requestId, method, path, query, headers: forwardedHeaders, body } = req;

    // Reject paths that are not absolute, contain traversal sequences, or
    // do not start with a known proxy route prefix.  All valid browser-side
    // requests use /api/*, /stream, /transcode/*, /health, or /healthz.
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.includes("..") ||
      !PATH_ALLOWLIST_RE.test(path)
    ) {
      send(channel, { type: "response-error", requestId, error: "Invalid request path." });
      return;
    }

    // Reject unreasonably large JSON bodies (legitimate API calls are small).
    const MAX_BODY_BYTES = 64 * 1024; // 64 KB
    if (body != null && typeof body === "string" && body.length > MAX_BODY_BYTES) {
      send(channel, { type: "response-error", requestId, error: "Request body too large." });
      return;
    }

    const targetUrl = `http://127.0.0.1:${proxyPort}${path}${query ? `?${query}` : ""}`;
    const requestHeaders = { ...(forwardedHeaders ?? {}), host: `127.0.0.1:${proxyPort}` };

    let response;
    try {
      response = await fetch(targetUrl, {
        method,
        headers: requestHeaders,
        body: body != null ? body : undefined,
        redirect: "manual"
      });
    } catch (fetchError) {
      send(channel, { type: "response-error", requestId, error: fetchError?.message ?? String(fetchError) });
      return;
    }

    /** @type {Record<string, string>} */
    const responseHeaders = {};
    for (const [name, value] of response.headers.entries()) {
      responseHeaders[name] = value;
    }

    send(channel, { type: "response-start", requestId, status: response.status, headers: responseHeaders });

    if (!response.body) {
      send(channel, { type: "response-chunk", requestId, data: "", done: true });
      return;
    }

    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          send(channel, { type: "response-chunk", requestId, data: "", done: true });
          break;
        }
        send(channel, {
          type: "response-chunk",
          requestId,
          data: Buffer.from(value).toString("base64"),
          done: false
        });
      }
    } catch {
      send(channel, { type: "response-chunk", requestId, data: "", done: true });
    }
  }

  /**
   * Serialise `message` to JSON and send it over the data channel.
   * Errors are silently swallowed — the channel may have closed between
   * the open check and the actual send.
   *
   * @param {DataChannel} channel
   * @param {object}      message
   * @returns {void}
   */
  function send(channel, message) {
    try {
      channel.sendMessage(JSON.stringify(message));
    } catch {
      // Channel closed between check and send — safe to ignore.
    }
  }

  return { handleChannel };
}

/**
 * Allowed path prefixes for data-channel requests.
 * Only the known proxy API and streaming routes are accepted.
 */
const PATH_ALLOWLIST_RE = /^(?:\/api\/|\/stream(?:$|\?)|\/?transcode\/|\/health(?:z)?(?:$|\?))/;
