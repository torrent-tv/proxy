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
import { performance } from "node:perf_hooks";
import { eventLoopDelay, resetEventLoopDelay } from "../utils/perf.js";

/**
 * Build one body frame: `[flags(1)][idLen(1)][requestId][payload]`.
 *
 * One allocation and one copy. The previous version made two of each — a copy
 * of the chunk into a `Buffer`, then a `concat` that copied it again into the
 * frame — which measured 75.9 ms per 13 MB segment on the field host against
 * 40.0 ms this way, and allocated ~600 extra buffers over a segment's 208
 * chunks. One copy is the floor: chunks arrive from a web stream that allocates
 * them itself, so there is no buffer of ours to read them into.
 *
 * @param {Buffer} idBytes - The request id, already encoded.
 * @param {Uint8Array | null} bytes - Payload, or nothing for the done frame.
 * @param {boolean} done
 * @returns {Buffer}
 */
export function encodeFrame(idBytes, bytes, done) {
  const payloadLength = bytes?.length ?? 0;
  const frame = Buffer.allocUnsafe(2 + idBytes.length + payloadLength);
  frame[0] = done ? 1 : 0;
  frame[1] = idBytes.length;
  idBytes.copy(frame, 2);
  if (payloadLength > 0) {
    frame.set(bytes, 2 + idBytes.length);
  }
  return frame;
}

export function createDataChannelHandler({ proxyPort, onLog }) {
  /** Request id → its ASCII bytes; see {@link requestIdBytes}. */
  const requestIdCache = new Map();

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
    const tag = sessionId.slice(0, 8);
    log(`[dc] Session ${tag}: channel open`);

    // Partial chunked-request bodies in flight on THIS channel, keyed by
    // requestId. Each entry buffers frames until the done frame, then runs the
    // assembled request through the same path as a single-message request.
    /** @type {Map<string, { meta: object, chunks: Buffer[], receivedBytes: number, bodyBytes: number, timer: ReturnType<typeof setTimeout> }>} */
    const partials = new Map();

    const dropPartial = (requestId) => {
      const entry = partials.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        partials.delete(requestId);
      }
    };

    /**
     * Begin assembling a chunked request. Validates the path and size up front
     * so an invalid or oversized request never buffers a body.
     *
     * @param {any} message - The `request-start` control message.
     */
    const startPartialRequest = (message) => {
      const { requestId, method, path, query, headers, bodyBytes } = message ?? {};
      if (typeof requestId !== "string" || requestId.length === 0) {
        return;
      }
      if (!isValidRequestPath(path)) {
        send(channel, { type: "response-error", requestId, error: "Invalid request path." });
        return;
      }
      if (!Number.isInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > PROXY_MAX_REQUEST_BODY_BYTES) {
        send(channel, { type: "response-error", requestId, error: "Request body too large." });
        return;
      }
      dropPartial(requestId); // replace any stale entry with the same id
      const timer = setTimeout(() => {
        const entry = partials.get(requestId);
        partials.delete(requestId);
        log(`[dc] Session ${tag}: dropped stale partial request ${requestId.slice(0, 8)} (${entry?.receivedBytes ?? 0}B)`);
      }, PARTIAL_REQUEST_TTL_MS);
      partials.set(requestId, {
        meta: { requestId, method, path, query, headers },
        chunks: [],
        receivedBytes: 0,
        bodyBytes,
        timer
      });
    };

    /**
     * Handle a binary body frame for a chunked request.
     * Layout: [flags(1)][idLen(1)][requestId(ASCII)][payload].
     *
     * @param {Buffer} buf
     */
    const handleBodyFrame = (buf) => {
      if (buf.length < 2) {
        return;
      }
      const flags = buf[0];
      const idLen = buf[1];
      if (buf.length < 2 + idLen) {
        return;
      }
      const requestId = buf.toString("ascii", 2, 2 + idLen);
      const entry = partials.get(requestId);
      if (!entry) {
        return; // stale / already-dropped / aborted
      }
      if (flags & 2) {
        // Aborted by the browser — drop silently, no reply.
        dropPartial(requestId);
        return;
      }
      if (buf.length > 2 + idLen) {
        const payload = buf.subarray(2 + idLen);
        entry.chunks.push(Buffer.from(payload));
        entry.receivedBytes += payload.length;
      }
      if (entry.receivedBytes > entry.bodyBytes || entry.receivedBytes > PROXY_MAX_REQUEST_BODY_BYTES) {
        dropPartial(requestId);
        send(channel, { type: "response-error", requestId, error: "Request body size mismatch." });
        return;
      }
      if (flags & 1) {
        // Done frame — assemble and execute.
        dropPartial(requestId);
        if (entry.receivedBytes !== entry.bodyBytes) {
          send(channel, { type: "response-error", requestId, error: "Request body size mismatch." });
          return;
        }
        const body = Buffer.concat(entry.chunks).toString("utf8");
        void handleRequest(channel, { ...entry.meta, body }, true).catch((error) => {
          log(`[dc] Session ${tag}: request error: ${error?.message ?? error}`);
        });
      }
    };

    channel.onMessage((raw) => {
      // Binary messages are chunked-request body frames; the proxy otherwise
      // only ever receives JSON strings, so the type discriminates cleanly.
      if (typeof raw !== "string") {
        handleBodyFrame(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
        return;
      }

      /** @type {DataChannelRequest | { type: string, id?: string }} */
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      if (message.type === "request") {
        void handleRequest(channel, message).catch((error) => {
          log(`[dc] Session ${tag}: request error: ${error?.message ?? error}`);
        });
        return;
      }

      if (message.type === "request-start") {
        startPartialRequest(message);
        return;
      }

      if (message.type === "ping") {
        send(channel, { type: "pong", id: message.id });
      }
    });

    channel.onClosed(() => {
      for (const entry of partials.values()) {
        clearTimeout(entry.timer);
      }
      partials.clear();
      log(`[dc] Session ${tag}: channel closed`);
    });

    channel.onError((err) => {
      log(`[dc] Session ${tag}: channel error: ${err}`);
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
  async function handleRequest(channel, req, viaChunks = false) {
    const { requestId, method, path, query, headers: forwardedHeaders, body } = req;

    // Reject paths that are not absolute, contain traversal sequences, or
    // do not start with a known proxy route prefix.  All valid browser-side
    // requests use /api/*, /stream, /transcode/*, /health, or /healthz.
    if (!isValidRequestPath(path)) {
      send(channel, { type: "response-error", requestId, error: "Invalid request path." });
      return;
    }

    const queryInfo = query ? `?${query}` : "";
    const bodyInfo =
      body != null && typeof body === "string" && body.length > 0
        ? ` body=${body.length} bytes${viaChunks ? " (chunked)" : ""}`
        : "";
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
      // Attribute the transfer to the step that actually consumes the time.
      // Without this split a slow transfer is indistinguishable between "the
      // source is slow", "the channel is slow" and "the event loop is blocked",
      // which is exactly the argument a field seek left unresolved.
      let readMs = 0;
      let sendMs2 = 0;
      let drainMs = 0;
      resetEventLoopDelay();
      while (true) {
        const readStartedAt = performance.now();
        const { done, value } = await reader.read();
        readMs += performance.now() - readStartedAt;
        if (done) {
          sendChunk(channel, requestId, null, true);
          const elapsedMs = Date.now() - sendStartedAt;
          let bufferedNow = 0;
          try { bufferedNow = typeof channel.bufferedAmount === "function" ? channel.bufferedAmount() : 0; } catch { /* ignore */ }
          const loop = eventLoopDelay();
          const mbps = elapsedMs > 0 ? (totalBytes * 8) / (elapsedMs * 1000) : 0;
          log(
            `[net-debug] sent ${path}${queryInfo} bytes=${totalBytes} fetchMs=${fetchMs} ` +
              `ttfbMs=${firstByteMs} sendMs=${elapsedMs} chunks=${chunks} ` +
              `maxBuffered=${maxBuffered} bufferedAtEnd=${bufferedNow} ` +
              // Where the time went: reading the body from the local route,
              // handing chunks to the channel, or waiting for its queue. Plus
              // the event-loop delay over the same window — a large max here
              // means the transfer was blocked by synchronous work, not by the
              // network, and the three figures above will all look inflated.
              `readMs=${readMs.toFixed(0)} chanMs=${sendMs2.toFixed(0)} drainMs=${drainMs.toFixed(0)} ` +
              `loopMean=${loop.meanMs.toFixed(1)} loopP99=${loop.p99Ms.toFixed(1)} loopMax=${loop.maxMs.toFixed(1)} ` +
              `rate=${mbps.toFixed(1)}Mbps`
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
        const sendStepAt = performance.now();
        sendChunk(channel, requestId, value, false);
        sendMs2 += performance.now() - sendStepAt;
        // Backpressure: do not keep queuing chunks once the channel's outgoing
        // buffer is large — wait for it to drain. Prevents the SCTP send buffer
        // from ballooning, which stalls throughput.
        const drainStepAt = performance.now();
        await waitForBufferDrain(channel);
        drainMs += performance.now() - drainStepAt;
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
  /**
   * The request id as bytes, prepared once per request rather than per chunk.
   *
   * A segment is a couple of hundred chunks, and each one was re-encoding the
   * same 32-character string. The map is bounded because request ids are
   * short-lived and unbounded in number — dropping the whole cache when it
   * grows costs one re-encode per live request and cannot leak.
   *
   * @param {string} requestId
   * @returns {Buffer}
   */
  function requestIdBytes(requestId) {
    let bytes = requestIdCache.get(requestId);
    if (!bytes) {
      if (requestIdCache.size > 64) {
        requestIdCache.clear();
      }
      bytes = Buffer.from(requestId, "ascii");
      requestIdCache.set(requestId, bytes);
    }
    return bytes;
  }

  function sendChunk(channel, requestId, bytes, done) {
    try {
      channel.sendMessageBinary(encodeFrame(requestIdBytes(requestId), bytes, done));
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

/**
 * True when `path` is an absolute, traversal-free path on a known proxy route.
 * Shared by the single-message and chunked request entry points.
 *
 * @param {unknown} path
 * @returns {boolean}
 */
function isValidRequestPath(path) {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.includes("..") &&
    PATH_ALLOWLIST_RE.test(path)
  );
}

/** Max assembled size of a chunked request body (guards proxy memory). */
const PROXY_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
/** Drop an incomplete chunked body if no further frame arrives within this window. */
const PARTIAL_REQUEST_TTL_MS = 60_000;

/** Pause sending body chunks once the channel buffer exceeds this many bytes. */
const DC_BUFFER_HIGH_WATER = 8 * 1024 * 1024;
/** Resume sending once the channel buffer drains to this many bytes. */
const DC_BUFFER_LOW_WATER = 1 * 1024 * 1024;
/** Safety fallback so the send loop cannot deadlock on a missed drain event. */
const DC_BUFFER_DRAIN_TIMEOUT_MS = 5000;
