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
 * { type: "response-start", requestId, status, headers }   (JSON string)
 * { type: "response-error", requestId, error: string }     (JSON string)
 * { type: "pong",           id }                            (JSON string)
 * ```
 *
 * Response bodies are sent as BINARY data-channel messages (not JSON), to
 * avoid the ~33% base64 overhead and the JSON encode/decode cost. Each binary
 * frame is laid out as:
 * ```
 * byte 0          flags     (bit 0: done)
 * byte 1          idLen     (length of the requestId in bytes)
 * bytes 2..2+N    requestId (ASCII)
 * bytes 2+N..     payload   (raw body bytes; empty on the final done frame)
 * ```
 * Control messages stay JSON strings so the browser can distinguish them from
 * body frames by message type (string vs ArrayBuffer).
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

    const queryInfo = query ? `?${query}` : "";
    const bodyInfo = body != null && typeof body === "string" && body.length > 0 ? ` body=${body.length} bytes` : "";
    log(`[dc] ${method} ${path}${queryInfo}${bodyInfo}`);

    const targetUrl = `http://127.0.0.1:${proxyPort}${path}${query ? `?${query}` : ""}`;
    const requestHeaders = { ...(forwardedHeaders ?? {}), host: `127.0.0.1:${proxyPort}` };

    let response;
    // [net-debug] TEMPORARY: time spent in the local fetch (waiting for the
    // route to return a response — e.g. long-polling until an HLS segment is
    // finalized by ffmpeg) vs. the body transfer over the data channel.
    const fetchStartedAt = Date.now();
    try {
      response = await fetch(targetUrl, {
        method,
        headers: requestHeaders,
        body: body != null ? body : undefined,
        redirect: "manual"
      });
    } catch (fetchError) {
      log(`[dc] ${method} ${path}${queryInfo} → error: ${fetchError?.message ?? String(fetchError)}`);
      send(channel, { type: "response-error", requestId, error: fetchError?.message ?? String(fetchError) });
      return;
    }

    if (response.status !== 200 && response.status !== 206) {
      log(`[dc] ${method} ${path}${queryInfo} → ${response.status}`);
    }

    /** @type {Record<string, string>} */
    const responseHeaders = {};
    for (const [name, value] of response.headers.entries()) {
      responseHeaders[name] = value;
    }

    send(channel, { type: "response-start", requestId, status: response.status, headers: responseHeaders });

    if (!response.body) {
      sendChunk(channel, requestId, null, true);
      return;
    }

    try {
      const reader = response.body.getReader();
      // [net-debug] TEMPORARY: measure transfer size/time and channel buffering.
      // fetchMs = time waiting for the route (incl. ffmpeg segment finalization).
      // ttfbMs  = time from body-read start to the first chunk with data (loopback).
      // sendMs  = total body read+send duration over the data channel.
      const fetchMs = Date.now() - fetchStartedAt;
      const sendStartedAt = Date.now();
      let firstByteMs = -1;
      let chunks = 0;
      let totalBytes = 0;
      let maxBuffered = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          sendChunk(channel, requestId, null, true);
          const elapsedMs = Date.now() - sendStartedAt;
          let bufferedNow = 0;
          try { bufferedNow = typeof channel.bufferedAmount === "function" ? channel.bufferedAmount() : 0; } catch { /* ignore */ }
          log(
            `[net-debug] sent ${path}${queryInfo} bytes=${totalBytes} fetchMs=${fetchMs} ` +
              `ttfbMs=${firstByteMs} sendMs=${elapsedMs} chunks=${chunks} ` +
              `maxBuffered=${maxBuffered} bufferedAtEnd=${bufferedNow}`
          );
          break;
        }
        if (firstByteMs < 0) firstByteMs = Date.now() - sendStartedAt;
        chunks += 1;
        totalBytes += value.length;
        try {
          const b = typeof channel.bufferedAmount === "function" ? channel.bufferedAmount() : 0;
          if (b > maxBuffered) maxBuffered = b;
        } catch { /* ignore */ }
        sendChunk(channel, requestId, value, false);
        // Backpressure: do not keep queuing chunks once the channel's outgoing
        // buffer is large — wait for it to drain. Prevents the SCTP send buffer
        // from ballooning, which stalls throughput.
        await waitForBufferDrain(channel);
      }
    } catch {
      sendChunk(channel, requestId, null, true);
    }
  }

  /**
   * Send a response body frame as a BINARY data-channel message.
   * Layout: [flags(1)][idLen(1)][requestId(ASCII)][payload].
   *
   * @param {DataChannel}            channel
   * @param {string}                 requestId
   * @param {Uint8Array | null}      bytes - Body bytes, or null/empty for the done frame.
   * @param {boolean}                done
   * @returns {void}
   */
  function sendChunk(channel, requestId, bytes, done) {
    try {
      const idBuf = Buffer.from(requestId, "ascii");
      const header = Buffer.allocUnsafe(2 + idBuf.length);
      header[0] = done ? 1 : 0;
      header[1] = idBuf.length;
      idBuf.copy(header, 2);
      const frame =
        bytes && bytes.length > 0 ? Buffer.concat([header, Buffer.from(bytes)]) : header;
      channel.sendMessageBinary(frame);
    } catch {
      // Channel closed between check and send — safe to ignore.
    }
  }

  /**
   * Resolve once the channel's outgoing buffer has drained below the low-water
   * mark. No-op (resolves immediately) when the buffer is already small or the
   * channel does not expose buffer APIs. A timeout fallback guards against a
   * missed low-water event so the send loop can never deadlock.
   *
   * @param {DataChannel} channel
   * @returns {Promise<void>}
   */
  function waitForBufferDrain(channel) {
    return new Promise((resolve) => {
      try {
        if (typeof channel.bufferedAmount !== "function" || channel.bufferedAmount() <= DC_BUFFER_HIGH_WATER) {
          resolve();
          return;
        }
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        channel.setBufferedAmountLowThreshold(DC_BUFFER_LOW_WATER);
        channel.onBufferedAmountLow(done);
        // Guard against a race where the buffer drained between the check above
        // and registering the callback (the low-water event would never fire).
        if (channel.bufferedAmount() <= DC_BUFFER_LOW_WATER) {
          done();
          return;
        }
        setTimeout(done, DC_BUFFER_DRAIN_TIMEOUT_MS);
      } catch {
        resolve();
      }
    });
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

/** Pause sending body chunks once the channel buffer exceeds this many bytes. */
const DC_BUFFER_HIGH_WATER = 8 * 1024 * 1024;
/** Resume sending once the channel buffer drains to this many bytes. */
const DC_BUFFER_LOW_WATER = 1 * 1024 * 1024;
/** Safety fallback so the send loop cannot deadlock on a missed drain event. */
const DC_BUFFER_DRAIN_TIMEOUT_MS = 5000;
