/**
 * @file Outbound WebSocket tunnel from the proxy to the registry server.
 *
 * The proxy opens one persistent connection on startup.  Through it the
 * server can:
 *   - relay browser HTTP requests to the proxy's local Fastify server, and
 *   - forward WebRTC signalling messages (offers, ICE candidates) between
 *     the browser and the proxy's WebRTC manager.
 *
 * The tunnel reconnects automatically with a fixed back-off after any
 * unexpected close.
 */

import { WebSocket } from "ws";

/** @import { HealthMetrics } from './health-collector.js' */

/**
 * Configuration for the tunnel client.
 *
 * @typedef {Object} TunnelClientOptions
 * @property {string}  serverUrl
 *   Base URL of the registry server (http or https — converted to ws/wss automatically).
 * @property {string}  proxyId
 *   Stable ID used to identify this proxy on the server.
 * @property {string}  token
 *   Auth token sent as the `x-proxy-id` / `x-proxy-token` headers during the WS handshake.
 * @property {number}  proxyPort
 *   Local port the proxy's Fastify server is listening on.
 * @property {(sessionId: string, signal: WebRtcSignal) => void} [onSignal]
 *   Called when the server forwards a WebRTC signal (SDP offer or ICE candidate)
 *   from a browser to this proxy.  `sessionId` scopes the signal to a P2P session.
 * @property {() => void} [onConnect]
 *   Called each time the WebSocket connection becomes open (including reconnects).
 *   Use to re-register the proxy so the server's in-memory store stays consistent
 *   after server restarts.
 * @property {() => HealthMetrics} [onHealthRequest]
 *   Called when the server sends a `health-request` message.  The return value is
 *   sent back as `health-response` and used by the server to score this proxy.
 * @property {(message: string) => void} [onLog]
 *   Optional structured log sink.
 */

/**
 * A single WebRTC signal message forwarded through the tunnel.
 *
 * @typedef {Object} WebRtcSignal
 * @property {string}  type       - Signal kind: "offer" | "answer" | "candidate".
 * @property {string}  [sdp]      - SDP string (for "offer" and "answer").
 * @property {string}  [candidate] - ICE candidate string (for "candidate").
 * @property {string}  [mid]      - SDP media ID associated with the candidate.
 */

/**
 * A relay request sent by the server — asking the proxy to perform a local
 * HTTP fetch and stream the response back through the tunnel.
 *
 * @typedef {Object} TunnelRelayRequest
 * @property {string} requestId - Unique ID that ties request → response chunks.
 * @property {string} method    - HTTP method (GET, POST, etc.).
 * @property {string} path      - Request path on the local proxy (e.g. "/health").
 * @property {string} query     - Raw query string without the leading "?".
 * @property {Record<string, string>} headers - Headers forwarded from the browser.
 * @property {string | null} body - Serialised request body, or null.
 */

/**
 * The object returned by {@link createTunnelClient}.
 *
 * @typedef {Object} TunnelClient
 * @property {() => void}   connect      - Open the tunnel; reconnects on drop.
 * @property {() => void}   disconnect   - Close the tunnel; suppresses reconnects.
 * @property {(sessionId: string, signal: WebRtcSignal) => void} sendSignal
 *   Send a WebRTC signal (answer / candidate) back to the browser.
 * @property {(endpoint: { externalIp: string | null, externalPort: number, protocol: string }) => void} sendEndpoint
 *   Report this proxy's UPnP-mapped external endpoint to the server so it can
 *   dial back and verify reachability.
 */

const RECONNECT_DELAY_MS = 5_000;
/** Send a keepalive ping every 30 s to prevent Cloudflare's idle WebSocket timeout (~100 s). */
const KEEPALIVE_INTERVAL_MS = 30_000;
/**
 * Replace the connection before anything upstream ends it for us.
 *
 * Something between this process and the server closes the socket after
 * exactly **100 min 15 s**, whatever is flowing over it. It is not an idle
 * timeout — the keepalive above has been running for months — it is a lifetime
 * cap. Measured across one day of logs (2026-08-20): 01:54:12 → 03:34:27 →
 * ... the same 100:15 apart wherever a restart did not reset the clock, and
 * with `code=1006`, an abrupt close with no closing handshake, which is what an
 * intermediary killing a connection looks like.
 *
 * Reconnecting after the fact costs 5 s during which this proxy does not exist
 * as far as the registry is concerned, and a viewer arriving in that window is
 * told there is no proxy. So the connection is replaced BEFORE the cap, and the
 * replacement is seamless: the new socket registers itself with the server,
 * which atomically supersedes the old one, and only then does the old one
 * close. There is no moment with nothing registered.
 *
 * Ninety minutes leaves ten minutes of margin against a cap that has been
 * exact, and makes the replacement a quiet event rather than a race.
 */
const CONNECTION_LIFETIME_MS = 90 * 60_000;

/**
 * Create and manage the outbound WebSocket tunnel to the registry server.
 *
 * @param {TunnelClientOptions} options
 * @returns {TunnelClient}
 */
export function createTunnelClient({
  serverUrl,
  proxyId,
  token,
  proxyPort,
  onSignal,
  onConnect,
  onHealthRequest,
  onLog,
  connectionLifetimeMs = CONNECTION_LIFETIME_MS
}) {
  const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws/proxy-tunnel";

  /** @type {WebSocket | null} */
  let socket = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnectTimer = null;
  /**
   * The renewal that will replace the live connection before the upstream cap
   * ends it. Owned by the connection it belongs to, and cancelled with it.
   *
   * @type {ReturnType<typeof setTimeout> | null}
   */
  let renewalTimer = null;
  let stopped = false;

  /**
   * Write a message to the log sink if one was provided.
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
   * Automatically schedules a reconnect after any unintentional close.
   *
   * @returns {void}
   */
  function connect() {
    if (stopped) {
      return;
    }
    log(`Connecting tunnel to ${wsUrl}`);

    // The connection being opened, held separately from `socket` so that a
    // socket which has been SUPERSEDED can still recognise itself. During a
    // renewal two exist for a moment, and the old one's close must not be
    // mistaken for the tunnel going down.
    const connection = new WebSocket(wsUrl, {
      headers: {
        "x-proxy-id": proxyId,
        "x-proxy-token": token,
        "user-agent": "torrent-tv-proxy/1.0"
      }
    });
    /** @type {ReturnType<typeof setInterval> | null} */
    let keepaliveTimer = null;
    socket = connection;

    connection.addEventListener("open", () => {
      log("Tunnel connected.");
      // Start keepalive pings to prevent Cloudflare's idle WebSocket timeout.
      keepaliveTimer = setInterval(() => {
        if (connection.readyState === WebSocket.OPEN) {
          send({ type: "ping" }, connection);
        }
      }, KEEPALIVE_INTERVAL_MS);
      // And replace this connection before the upstream lifetime cap does.
      if (renewalTimer !== null) {
        clearTimeout(renewalTimer);
      }
      renewalTimer = setTimeout(() => {
        if (stopped || socket !== connection) {
          return;
        }
        log("Tunnel renewing before the upstream lifetime cap; the replacement takes over first.");
        connect();
      }, connectionLifetimeMs);
      if (typeof onConnect === "function") {
        onConnect();
      }
    });

    connection.addEventListener("message", (event) => {
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
        return;
      }

      // WebRTC signalling: server forwards a signal from a browser session.
      if (message.type === "signal") {
        if (typeof message.sessionId === "string" && message.signal && typeof onSignal === "function") {
          onSignal(message.sessionId, message.signal);
        }
        return;
      }

      // Health check: server requests current metrics for proxy scoring.
      if (message.type === "health-request") {
        const metrics = typeof onHealthRequest === "function" ? onHealthRequest() : {};
        send({ type: "health-response", requestId: message.requestId, metrics });
        return;
      }
    });

    connection.addEventListener("close", (event) => {
      if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      // A connection this one replaced. The server closes it as soon as the
      // replacement registers, which is the whole point of renewing early —
      // there is nothing to report and nothing to reconnect, because the tunnel
      // never went down.
      if (socket !== connection) {
        log(`Tunnel handed over (code=${event.code}); the replacement is already carrying it.`);
        return;
      }
      log(`Tunnel disconnected (code=${event.code}). Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
      socket = null;
      if (renewalTimer !== null) {
        clearTimeout(renewalTimer);
        renewalTimer = null;
      }
      if (!stopped) {
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    });

    connection.addEventListener("error", (event) => {
      log(`Tunnel WebSocket error: ${event.message ?? "unknown"}`);
    });
  }

  /**
   * Fetch a resource from the local Fastify server and stream the response
   * back to the registry server chunk-by-chunk over the WebSocket.
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

    /** @type {Record<string, string>} */
    const responseHeaders = {};
    for (const [headerName, headerValue] of response.headers.entries()) {
      responseHeaders[headerName] = headerValue;
    }

    send({ type: "response-start", requestId, status: response.status, headers: responseHeaders });

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
   * Serialise a message to JSON and send it through the WebSocket if open.
   *
   * @param {object} message
   * @returns {void}
   */
  function send(message, over = null) {
    // Everything the proxy has to say goes over the LIVE connection. `over` is
    // for the one thing that belongs to a particular socket rather than to the
    // tunnel — its own keepalive — which must not be sent over a replacement
    // that has already taken over.
    const target = over ?? socket;
    if (target && target.readyState === WebSocket.OPEN) {
      target.send(JSON.stringify(message));
    }
  }

  /**
   * Send a `response-error` frame for a given relay request.
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
     * Start the tunnel.  Connects immediately and auto-reconnects on drop.
     *
     * @returns {void}
     */
    connect() {
      stopped = false;
      connect();
    },

    /**
     * Tear down the tunnel.  Closes the current connection and prevents
     * any future reconnect attempts.
     *
     * @returns {void}
     */
    disconnect() {
      stopped = true;
      if (renewalTimer !== null) {
        clearTimeout(renewalTimer);
        renewalTimer = null;
      }
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        socket.close(1000, "shutdown");
        socket = null;
      }
    },

    /**
     * Forward a WebRTC signal (SDP answer or ICE candidate) from this proxy
     * to the browser via the server tunnel.
     *
     * @param {string} sessionId   - Scopes the signal to a single P2P session.
     * @param {WebRtcSignal} signal
     * @returns {void}
     */
    sendSignal(sessionId, signal) {
      send({ type: "signal", sessionId, signal });
    },

    /**
     * Report this proxy's UPnP-mapped external endpoint to the server.
     * No-op if the tunnel is not currently open (the caller re-sends on
     * connect / reconnect).
     *
     * @param {{ externalIp: string | null, externalPort: number, protocol: string }} endpoint
     * @returns {void}
     */
    sendEndpoint(endpoint) {
      send({ type: "proxy-endpoint", endpoint });
    }
  };
}
