/**
 * @file Outbound WebSocket tunnel from the proxy to the registry server.
 *
 * The proxy establishes one persistent connection on startup.
 * The server sends relay requests through it; the proxy fetches them
 * locally (against 127.0.0.1) and streams responses back chunk-by-chunk.
 */

/**
 * @typedef {Object} TunnelClientOptions
 * @property {string} serverUrl   - Base URL of the registry server (http/https).
 * @property {string} proxyId     - Stable ID used to identify this proxy on the server.
 * @property {string} token       - Auth token sent as a header during the WS handshake.
 * @property {number} proxyPort   - Local port the proxy HTTP server is listening on.
 * @property {(message: string) => void} [onLog] - Optional log callback.
 */

/**
 * @typedef {Object} TunnelRelayRequest
 * @property {string} requestId - Unique ID assigned by the server for this relay round-trip.
 * @property {string} method    - HTTP method to use when calling the local proxy.
 * @property {string} path      - Request path (e.g. "/health").
 * @property {string} query     - Query string without the leading "?".
 * @property {Record<string, string>} headers - Headers forwarded from the browser.
 * @property {string | null} body - Serialised JSON body, or null for GET.
 */

const RECONNECT_DELAY_MS = 5_000;

/**
 * Create and manage the outbound WebSocket tunnel to the registry server.
 *
 * @param {TunnelClientOptions} options
 * @returns {{ connect: () => void, disconnect: () => void }}
 */
export function createTunnelClient({ serverUrl, proxyId, token, proxyPort, onLog }) {
  const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws/proxy-tunnel";

  /** @type {WebSocket | null} */
  let socket = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnectTimer = null;
  let stopped = false;

  /**
   * Emit a log message via the provided callback.
   *
   * @param {string} message
   * @returns {void}
   */
  function log(message) {
    if (typeof onLog === "function") {
      onLog(message);
    }
  }

  /**
   * Open a new WebSocket connection to the server.
   * Automatically reconnects on close unless {@link disconnect} was called.
   *
   * @returns {void}
   */
  function connect() {
    if (stopped) {
      return;
    }
    log(`Connecting tunnel to ${wsUrl}`);

    socket = new WebSocket(wsUrl, {
      headers: {
        "x-proxy-id": proxyId,
        "x-proxy-token": token
      }
    });

    socket.addEventListener("open", () => {
      log("Tunnel connected.");
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "request") {
        void handleRelayRequest(message).catch((error) => {
          log(`Tunnel relay error: ${error?.message ?? error}`);
        });
      }
    });

    socket.addEventListener("close", (event) => {
      log(`Tunnel disconnected (code=${event.code}). Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
      socket = null;
      if (!stopped) {
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    });

    socket.addEventListener("error", (event) => {
      log(`Tunnel WebSocket error: ${event.message ?? "unknown"}`);
    });
  }

  /**
   * Execute a relay request sent by the server: fetch the resource
   * from the local proxy and stream the response back chunk-by-chunk.
   *
   * @param {TunnelRelayRequest} relayRequest
   * @returns {Promise<void>}
   */
  async function handleRelayRequest(relayRequest) {
    const { requestId, method, path, query, headers: forwardedHeaders, body } = relayRequest;
    const targetUrl = `http://127.0.0.1:${proxyPort}${path}` + (query ? `?${query}` : "");
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
      sendError(requestId, fetchError?.message ?? String(fetchError));
      return;
    }

    const responseHeaders = {};
    for (const [headerName, headerValue] of response.headers.entries()) {
      responseHeaders[headerName] = headerValue;
    }

    send({
      type: "response-start",
      requestId,
      status: response.status,
      headers: responseHeaders
    });

    if (!response.body) {
      send({ type: "response-chunk", requestId, data: "", done: true });
      return;
    }

    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          send({ type: "response-chunk", requestId, data: "", done: true });
          break;
        }
        send({
          type: "response-chunk",
          requestId,
          data: Buffer.from(value).toString("base64"),
          done: false
        });
      }
    } catch {
      send({ type: "response-chunk", requestId, data: "", done: true });
    }
  }

  /**
   * Send a JSON message through the WebSocket if it is open.
   *
   * @param {object} message
   * @returns {void}
   */
  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  /**
   * Send a `response-error` message back to the server for the given request.
   *
   * @param {string} requestId
   * @param {string} errorMessage
   * @returns {void}
   */
  function sendError(requestId, errorMessage) {
    send({ type: "response-error", requestId, error: errorMessage });
  }

  return {
    /**
     * Start the tunnel, connecting immediately and reconnecting on drop.
     *
     * @returns {void}
     */
    connect() {
      stopped = false;
      connect();
    },

    /**
     * Stop the tunnel and close the current connection without reconnecting.
     *
     * @returns {void}
     */
    disconnect() {
      stopped = true;
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        socket.close(1000, "shutdown");
        socket = null;
      }
    }
  };
}
