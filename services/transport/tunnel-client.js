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
 *
 * A server being replaced by a release asks its proxies to move
 * (`server-moving`). The proxy then opens a second connection, which reaches the
 * new server, and keeps the old one until the old server closes it. While both
 * are open each reply goes over the connection its request arrived on: a
 * browser that signalled through the old server is answered there, because the
 * new one does not know that browser.
 */

import { WebSocket } from "ws";


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
 * @property {string}  [name]
 *   Display name, sent with every connection so that whichever server instance
 *   the connection reaches knows it without a separate registration request.
 * @property {string}  [baseUrl]
 *   Advertised direct URL, sent with every connection for the same reason.
 * @property {(sessionId: string, signal: WebRtcSignal) => void} [onSignal]
 *   Called when the server forwards a WebRTC signal (SDP offer or ICE candidate)
 *   from a browser to this proxy.  `sessionId` scopes the signal to a P2P session.
 * @property {() => void} [onConnect]
 *   Called each time the WebSocket connection becomes open (including reconnects).
 *   Use to re-register the proxy so the server's in-memory store stays consistent
 *   after server restarts.
 * @property {(mediaInfo: object) => { copy: number[], transcode: number[] } | null} [onCanServeRequest]
 *   Called when the server asks whether this host could sustain a file it has
 *   been DESCRIBED — height, rate, bitrate, codec — rather than one it holds.
 *   Answered from this host's startup benchmarks alone: no torrent is added, no
 *   bytes are fetched and ffmpeg is not run, so it costs milliseconds and can
 *   be asked of every proxy in the pool at once.
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
  name = "",
  baseUrl = "",
  onSignal,
  onConnect,
  onCanServeRequest,
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
   * Every connection that is open now. Usually one; two while a renewal or a
   * move to a new server is under way.
   *
   * @type {Set<WebSocket>}
   */
  const openConnections = new Set();
  /**
   * The connection each browser session signalled through. The proxy's answer
   * and its ICE candidates go back the same way, because only the server
   * instance that holds that browser's signalling socket can deliver them.
   *
   * @type {Map<string, WebSocket>}
   */
  const signalRoutes = new Map();

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
        // Who this proxy is, on the connection itself: a separate registration
        // request may reach a different server instance during a release.
        "x-proxy-name": encodeURIComponent(name),
        "x-proxy-base-url": baseUrl,
        // This proxy answers on the connection a request arrived on and opens a
        // new connection when the server says `server-moving`, so the server
        // may wait for it to arrive at the new instance.
        "x-proxy-follows-moves": "1",
        "user-agent": "torrent-tv-proxy/1.0"
      }
    });
    /** @type {ReturnType<typeof setInterval> | null} */
    let keepaliveTimer = null;
    socket = connection;

    connection.addEventListener("open", () => {
      openConnections.add(connection);
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

      // The server is being replaced. A new connection reaches its successor;
      // this one stays open until the old server has finished with the
      // browsers it is still signalling for, and then it closes it.
      if (message.type === "server-moving") {
        if (connection === socket && !stopped) {
          log("Tunnel: the server is being replaced; connecting to its successor before this connection closes.");
          connect();
        }
        return;
      }

      if (message.type === "request") {
        void handleRelayRequest(message, connection).catch((error) => {
          log(`Tunnel relay error: ${error?.message ?? error}`);
        });
        return;
      }

      // WebRTC signalling: server forwards a signal from a browser session.
      if (message.type === "signal") {
        if (typeof message.sessionId === "string" && message.signal && typeof onSignal === "function") {
          signalRoutes.set(message.sessionId, connection);
          onSignal(message.sessionId, message.signal);
        }
        return;
      }

      // The server's answer to this proxy's keepalive, echoed at once on the
      // same connection: the server measures the tunnel round trip from it on
      // its own clock, and chooses proxies partly by that.
      if (message.type === "rtt-probe") {
        send({ type: "rtt-echo", sentAt: message.sentAt }, connection);
        return;
      }

      // Could this host serve a file it is only told ABOUT? Asked when the
      // proxy a viewer landed on has refused the file, so the browser can be
      // sent somewhere that will work instead of being shown an error. The
      // description travels because the refusing proxy has already probed the
      // file: the expensive half is done once, and every other proxy answers
      // by arithmetic.
      if (message.type === "can-serve-request") {
        let offer = null;
        try {
          offer = typeof onCanServeRequest === "function"
            ? onCanServeRequest(message.mediaInfo ?? {})
            : null;
        } catch {
          // silent-ok: an unanswerable question is answered "no", which is what
          // a null offer means to the caller.
        }
        send({ type: "can-serve-response", requestId: message.requestId, offer }, connection);
        return;
      }
    });

    connection.addEventListener("close", (event) => {
      if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      openConnections.delete(connection);
      for (const [sessionId, route] of signalRoutes) {
        if (route === connection) {
          signalRoutes.delete(sessionId);
        }
      }
      // A connection this one replaced. The server closes it as soon as the
      // replacement registers, which is the whole point of renewing early —
      // there is nothing to report and nothing to reconnect, because the tunnel
      // never went down.
      if (socket !== connection) {
        log(`Tunnel handed over (code=${event.code}); the replacement is already carrying it.`);
        return;
      }
      // The newest connection ended while an older one is still open: a move
      // whose new connection did not get through. The older one goes on
      // carrying the tunnel until its server closes it, and the move is tried
      // again meanwhile.
      const survivor = [...openConnections].at(-1);
      if (survivor) {
        socket = survivor;
        log(`Tunnel connection ended (code=${event.code}) while the previous one is still open; it carries the tunnel, and a new connection is tried in ${RECONNECT_DELAY_MS}ms.`);
        scheduleReconnect();
        return;
      }
      log(`Tunnel disconnected (code=${event.code}). Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
      socket = null;
      if (renewalTimer !== null) {
        clearTimeout(renewalTimer);
        renewalTimer = null;
      }
      scheduleReconnect();
    });

    connection.addEventListener("error", (event) => {
      log(`Tunnel WebSocket error: ${event.message ?? "unknown"}`);
    });
  }

  /**
   * Connect again after a fixed back-off, unless a reconnect is already due.
   *
   * @returns {void}
   */
  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  /**
   * Fetch a resource from the local Fastify server and stream the response
   * back to the registry server chunk-by-chunk over the WebSocket.
   *
   * @param {TunnelRelayRequest} relayRequest
   * @param {WebSocket} over - The connection the request arrived on, which
   *   the response goes back over.
   * @returns {Promise<void>}
   */
  async function handleRelayRequest(relayRequest, over) {
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
      sendError(requestId, fetchError?.message ?? String(fetchError), over);
      return;
    }

    /** @type {Record<string, string>} */
    const responseHeaders = {};
    for (const [headerName, headerValue] of response.headers.entries()) {
      responseHeaders[headerName] = headerValue;
    }

    send({ type: "response-start", requestId, status: response.status, headers: responseHeaders }, over);

    if (!response.body) {
      send({ type: "response-chunk", requestId, data: "", done: true }, over);
      return;
    }

    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          send({ type: "response-chunk", requestId, data: "", done: true }, over);
          break;
        }
        send({
          type: "response-chunk",
          requestId,
          data: Buffer.from(value).toString("base64"),
          done: false
        }, over);
      }
    } catch {
      send({ type: "response-chunk", requestId, data: "", done: true }, over);
    }
  }

  /**
   * Serialise a message to JSON and send it through the WebSocket if open.
   *
   * @param {object} message
   * @param {WebSocket | null} [over]
   * @returns {void}
   */
  function send(message, over = null) {
    // What the proxy says on its own goes over the LIVE connection. `over` is
    // for what belongs to a particular socket rather than to the tunnel: its
    // own keepalive, and every reply, which goes back over the connection its
    // request arrived on — during a move that is the old server, the only one
    // still waiting for it.
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
   * @param {WebSocket} over - The connection the request arrived on.
   * @returns {void}
   */
  function sendError(requestId, errorMessage, over) {
    send({ type: "response-error", requestId, error: errorMessage }, over);
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
      for (const connection of openConnections) {
        connection.close(1000, "shutdown");
      }
      if (socket) {
        socket.close(1000, "shutdown");
        socket = null;
      }
    },

    /**
     * Tell the server this proxy's state: its load, its room for one more
     * encode and the films it holds (`transport/proxy-state.js`). Over every
     * open connection: during a move between server instances both keep a
     * table of proxies, and each chooses from its own.
     *
     * @param {{ metrics?: object, holds?: object[] }} state
     * @returns {void}
     */
    sendState(state) {
      for (const connection of openConnections) {
        send({ type: "proxy-state", metrics: state?.metrics ?? {}, holds: Array.isArray(state?.holds) ? state.holds : [] }, connection);
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
      // Back over the connection this session signalled through, while it is
      // open; the server instance at the other end holds that browser.
      const route = signalRoutes.get(sessionId);
      send({ type: "signal", sessionId, signal }, route?.readyState === WebSocket.OPEN ? route : null);
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
