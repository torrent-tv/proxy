/**
 * @file WebRTC connection manager for the proxy (Node.js side).
 *
 * Maintains one `PeerConnection` per browser session, keyed by `sessionId`.
 * Receives SDP offers and ICE candidates through the signalling tunnel
 * and responds with SDP answers and its own candidates through the same channel.
 *
 * Data channels for actual streaming are handed off to `data-channel-handler.js`
 * via the `onDataChannel` callback — this module only owns the signalling phase.
 */

import nodeDataChannel from "node-datachannel";

/** @import { WebRtcSignal } from './tunnel-client.js' */

// Two STUN servers from different operators, both with IPv6 (AAAA) records, so
// the proxy gathers a server-reflexive candidate over BOTH v4 and (when the
// host has global v6) v6 — enabling a direct IPv6 path on v6-native networks.
const ICE_SERVERS = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];

// Symmetric-NAT port prediction window. For each real srflx candidate we offer
// this many extra candidates at ports base + delta*k (k = 1..N), because the
// number of NAT mappings the router allocates between STUN gathering and the
// browser connectivity check is unknown — a small window covers the likely
// values without bloating the SDP.
const PORT_PREDICTION_WINDOW = 16;

/**
 * Build predicted srflx ICE candidates for a symmetric NAT.
 *
 * A symmetric NAT assigns a different external port per destination, so the
 * STUN-learned srflx port is not the port the NAT will use toward the browser.
 * Given the per-destination port `delta` measured at startup, we offer ports
 * `base + delta*k` (k = 1..window) so the browser also probes them; if one
 * matches the mapping the NAT creates for the proxy→browser path, ICE connects.
 * This is the practical, signalling-only form of the birthday-paradox trick —
 * it works for sequential/predictable symmetric NATs, not fully random ones.
 *
 * Each predicted candidate gets a unique foundation so ICE treats it as a
 * distinct candidate. Returns [] for non-srflx, IPv6, missing/zero delta, or a
 * candidate string we cannot parse.
 *
 * @param {string} candidate - Raw candidate string (with or without `a=`).
 * @param {number} delta - Per-destination external-port delta (from NAT classification).
 * @param {number} [windowSize]
 * @returns {Array<{ candidate: string, port: number }>}
 */
function buildPredictedSrflxCandidates(candidate, delta, windowSize = PORT_PREDICTION_WINDOW) {
  if (!Number.isInteger(delta) || delta === 0) {
    return [];
  }
  const raw = candidate.replace(/^a=/, "");
  if (!/ typ srflx /.test(raw)) {
    return [];
  }
  // candidate:<foundation> <component> <proto> <priority> <ip> <port> typ srflx ...
  const parts = raw.split(" ");
  if (parts.length < 8 || !parts[0].startsWith("candidate:")) {
    return [];
  }
  const ip = parts[4];
  if (typeof ip !== "string" || ip.includes(":")) {
    // IPv6 has no NAT — port prediction is meaningless.
    return [];
  }
  const basePort = Number(parts[5]);
  if (!Number.isInteger(basePort)) {
    return [];
  }

  const out = [];
  const seen = new Set([basePort]);
  for (let k = 1; k <= windowSize; k++) {
    const port = basePort + delta * k;
    if (port < 1 || port > 65535 || seen.has(port)) {
      continue;
    }
    seen.add(port);
    const p = parts.slice();
    p[0] = `candidate:pp${k}`;
    p[5] = String(port);
    out.push({ candidate: p.join(" "), port });
  }
  return out;
}

/**
 * Classify an ICE candidate by its address family and scope, for diagnostics.
 *
 * Returns one of: `v4-private`, `v4-public`, `v6-global`, `v6-ula`,
 * `v6-linklocal`, `v6-loopback`, or `unknown`. This is logged for every
 * candidate so the field log shows whether a **global IPv6** path is being
 * offered (IPv6 has no NAT — if both sides have a global v6 address the
 * connection can go direct, which matters for v6-native mobile networks).
 *
 * Note on PNA: a `v4-private` host candidate triggers the browser's Private
 * Network Access permission prompt; the connection otherwise proceeds via the
 * public srflx candidate. We forward all candidates regardless (the browser
 * decides) — this only labels them.
 *
 * @param {string} candidate - Raw candidate attribute string (with or without `a=`).
 * @returns {"v4-private"|"v4-public"|"v6-global"|"v6-ula"|"v6-linklocal"|"v6-loopback"|"unknown"}
 */
function candidateAddrKind(candidate) {
  const parts = candidate.replace(/^a=/, "").split(" ");
  const ip = parts.length > 4 ? parts[4] : "";
  if (!ip) {
    return "unknown";
  }
  if (!ip.includes(":")) {
    // IPv4: RFC 1918 / loopback / link-local are private.
    if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) {
      return "v4-private";
    }
    return "v4-public";
  }
  const low = ip.toLowerCase();
  if (low === "::1") {
    return "v6-loopback";
  }
  if (low.startsWith("fe80")) {
    return "v6-linklocal";
  }
  if (/^f[cd][0-9a-f]{2}:/.test(low)) {
    // Unique Local Address (fc00::/7).
    return "v6-ula";
  }
  return "v6-global";
}

/**
 * Configuration for the WebRTC manager.
 *
 * @typedef {Object} WebRtcManagerOptions
 * @property {(sessionId: string, signal: WebRtcSignal) => void} sendSignal
 *   Send a WebRTC signal (answer or ICE candidate) back to the browser via
 *   the tunnel.  Typically wired to `tunnelClient.sendSignal`.
 * @property {(sessionId: string, channel: import("node-datachannel").DataChannel) => void} onDataChannel
 *   Called when the browser opens a data channel.  Receives the raw
 *   `node-datachannel` `DataChannel` object; hand it to `createDataChannelHandler`.
 * @property {(message: string) => void} [onLog]
 *   Optional log sink.
 * @property {() => ({ klass: string, portDelta: number|null } | null)} [getNatInfo]
 *   Returns the latest NAT classification (or null if not yet known). When it
 *   reports a symmetric NAT with a known port delta, each srflx candidate is
 *   accompanied by predicted-port candidates (see {@link buildPredictedSrflxCandidates}).
 * @property {number} [udpPort]
 *   When set, all WebRTC sessions are multiplexed onto this single UDP port so
 *   it can be statically UPnP-mapped (one mapping, one reachable port). A
 *   persistent {@link import("node-datachannel").IceUdpMuxListener} is created
 *   once at startup and owns the shared socket; every PeerConnection enables
 *   `enableIceUdpMux` on the same port and demuxes over it by ICE ufrag.
 *
 *   The persistent listener is the crucial part: per-PeerConnection
 *   `enableIceUdpMux` WITHOUT it ties the shared socket to a connection's
 *   lifetime, so a freshly-opened session fails to bind the port while a
 *   just-closed one still holds it → "Failed to gather local ICE candidates"
 *   (which crashed the proxy). The listener keeps the socket alive across
 *   sessions; verified with sequential + concurrent connections on one port.
 *   When omitted, node-datachannel uses an ephemeral UDP port.
 */

/**
 * The object returned by {@link createWebRtcManager}.
 *
 * @typedef {Object} WebRtcManager
 * @property {(sessionId: string, signal: WebRtcSignal) => void} handleSignal
 *   Dispatch an incoming signal (offer / ICE candidate) from the browser to
 *   the matching peer connection, creating it if necessary.
 * @property {(sessionId: string) => void} closeSession
 *   Tear down and remove a peer connection by session ID.
 * @property {() => void} dispose
 *   Close all peer connections and stop the shared UDP mux listener. Call on
 *   proxy shutdown so the listener's socket is released.
 */

/**
 * Create the proxy-side WebRTC connection manager.
 *
 * @param {WebRtcManagerOptions} options
 * @returns {WebRtcManager}
 */
export function createWebRtcManager({ sendSignal, onDataChannel, onLog, udpPort, getNatInfo }) {
  /** @type {Map<string, import("node-datachannel").PeerConnection>} */
  const peers = new Map();

  /**
   * @param {string} message
   * @returns {void}
   */
  function log(message) {
    if (typeof onLog === "function") {
      onLog(message);
    }
  }

  // Base PeerConnection config shared by every session.
  const pcConfig = { iceServers: ICE_SERVERS };

  // Single-port UDP mux: create ONE persistent listener that owns the shared
  // UDP socket for the proxy's whole lifetime, then have every PeerConnection
  // mux over it (enableIceUdpMux + the same fixed port). The listener must
  // outlive individual sessions — without it the socket is bound/freed per
  // connection and a repeat session fails to gather ICE candidates.
  /** @type {import("node-datachannel").IceUdpMuxListener | null} */
  let udpMuxListener = null;
  if (Number.isInteger(udpPort) && udpPort > 0 && udpPort <= 65535) {
    try {
      udpMuxListener = new nodeDataChannel.IceUdpMuxListener(udpPort);
      // STUN that doesn't match an existing session (our PeerConnections are
      // created from the SDP offer before the browser's STUN arrives, so normal
      // traffic is "handled"). Stray/unhandled requests are simply dropped.
      udpMuxListener.onUnhandledStunRequest(() => {});
      pcConfig.enableIceUdpMux = true;
      pcConfig.portRangeBegin = udpPort;
      pcConfig.portRangeEnd = udpPort;
      log(`[webrtc] UDP mux listener bound on port ${udpPort}; all sessions share it`);
    } catch (error) {
      // Could not bind the mux port — fall back to ephemeral UDP ports (no
      // single-port reachability, but the proxy still works on LAN / via STUN).
      const message = error instanceof Error ? error.message : String(error);
      log(`[webrtc] UDP mux listener failed on port ${udpPort} (${message}); using ephemeral ports`);
      udpMuxListener = null;
    }
  }

  /**
   * Retrieve an existing peer connection or create a new one for the session.
   *
   * A new `PeerConnection` is configured with the shared ICE server list and
   * wired up to forward local descriptions and candidates back to the browser.
   *
   * @param {string} sessionId
   * @returns {import("node-datachannel").PeerConnection}
   */
  function getOrCreatePeer(sessionId) {
    const existing = peers.get(sessionId);
    if (existing) {
      return existing;
    }

    const pc = new nodeDataChannel.PeerConnection(`proxy-${sessionId.slice(0, 8)}`, pcConfig);

    // Forward all ICE candidates to the browser through the tunnel.
    //
    // All candidates — both private (RFC 1918) and public (srflx) — are sent
    // immediately. The browser will attempt all paths in parallel and use
    // whichever connects first. Private candidates trigger Chrome's Private
    // Network Access (PNA) permission dialog once; after the user allows it
    // the connection proceeds via the local LAN path.
    pc.onLocalCandidate((candidate, mid) => {
      const kind = candidateAddrKind(candidate);
      // Log the full candidate (addr:port typ …) with its address kind so we
      // can confirm WebRTC is pinned to the mapped UDP port, see whether a
      // global IPv6 path is offered, and diagnose which routes are available.
      log(
        `[webrtc] Session ${sessionId.slice(0, 8)}: sending ${kind} candidate: ${candidate.replace(/^a=/, "")}`
      );
      sendSignal(sessionId, { type: "candidate", candidate, mid });

      // Symmetric-NAT port prediction: offer extra srflx candidates at the
      // predicted external ports so the browser probes them too. No-op unless
      // the NAT is symmetric with a known delta and this is an IPv4 srflx
      // candidate. Best-effort — never let it break candidate forwarding.
      try {
        const nat = typeof getNatInfo === "function" ? getNatInfo() : null;
        if (nat && nat.klass === "symmetric") {
          const predicted = buildPredictedSrflxCandidates(candidate, nat.portDelta);
          if (predicted.length > 0) {
            log(
              `[webrtc] Session ${sessionId.slice(0, 8)}: symmetric NAT (delta=${nat.portDelta}) — injecting ${predicted.length} predicted srflx candidates: ${predicted.map((p) => p.port).join(",")}`
            );
            for (const p of predicted) {
              sendSignal(sessionId, { type: "candidate", candidate: p.candidate, mid });
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[webrtc] Session ${sessionId.slice(0, 8)}: port-prediction inject failed: ${message}`);
      }
    });

    pc.onGatheringStateChange((state) => {
      log(`[webrtc] Session ${sessionId.slice(0, 8)}: gathering → ${state}`);
    });

    // Forward our SDP answer to the browser through the tunnel.
    pc.onLocalDescription((sdp, type) => {
      log(`[webrtc] Session ${sessionId.slice(0, 8)}: sending ${type}`);
      sendSignal(sessionId, { type, sdp });
    });

    pc.onStateChange((state) => {
      log(`[webrtc] Session ${sessionId.slice(0, 8)}: state → ${state}`);
      // On connect, log which candidate pair actually won — this is the single
      // most useful line for "did the open-port/WebRTC path work, and over
      // which route (LAN / public srflx v4 / v6)".
      if (state === "connected") {
        try {
          const pair = pc.getSelectedCandidatePair();
          if (pair) {
            const fmt = (c) => `${c.type} ${c.address}:${c.port}/${c.transportType}`;
            log(
              `[webrtc] Session ${sessionId.slice(0, 8)}: selected pair local=[${fmt(pair.local)}] remote=[${fmt(pair.remote)}]`
            );
          }
        } catch {
          // Diagnostics only — never let a logging call affect the connection.
        }
      }
      // "disconnected" is a transient state — ICE may recover on its own.
      // Only tear down on terminal states: "failed" and "closed".
      if (state === "failed" || state === "closed") {
        closeSession(sessionId);
      }
    });

    // Granular ICE-level transitions (checking → connected/failed) — finer than
    // the peer state above; pinpoints where a failing connection stalls.
    pc.onIceStateChange((state) => {
      log(`[webrtc] Session ${sessionId.slice(0, 8)}: ICE → ${state}`);
    });

    // Browser creates the data channel — we receive it here.
    pc.onDataChannel((channel) => {
      log(`[webrtc] Session ${sessionId.slice(0, 8)}: data channel "${channel.getLabel()}" opened`);
      onDataChannel(sessionId, channel);
    });

    peers.set(sessionId, pc);
    return pc;
  }

  /**
   * Dispatch an incoming WebRTC signal from the browser.
   *
   * - `offer`: creates (or reuses) the peer connection and sets the remote
   *   description; the library fires `onLocalDescription` automatically with
   *   the SDP answer.
   * - `candidate`: adds the ICE candidate to the existing peer connection.
   *
   * @param {string} sessionId
   * @param {WebRtcSignal} signal
   * @returns {void}
   */
  function handleSignal(sessionId, signal) {
    if (!signal || typeof signal.type !== "string") {
      return;
    }

    if (signal.type === "offer") {
      if (typeof signal.sdp !== "string") {
        return;
      }
      log(`[webrtc] Session ${sessionId.slice(0, 8)}: received offer`);
      // node-datachannel can throw SYNCHRONOUSLY here (e.g. "Failed to gather
      // local ICE candidates" when the pinned UDP port cannot be bound). A
      // single bad session must never crash the whole proxy — that would drop
      // every other viewer and the tunnel. Contain it: fail this session only.
      try {
        const pc = getOrCreatePeer(sessionId);
        pc.setRemoteDescription(signal.sdp, "offer");
        // `onLocalDescription` fires automatically with the SDP answer.
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[webrtc] Session ${sessionId.slice(0, 8)}: failed to handle offer: ${message}`);
        closeSession(sessionId);
      }
      return;
    }

    if (signal.type === "candidate") {
      const pc = peers.get(sessionId);
      if (!pc) {
        return;
      }
      if (typeof signal.candidate === "string" && typeof signal.mid === "string") {
        try {
          pc.addRemoteCandidate(signal.candidate, signal.mid);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`[webrtc] Session ${sessionId.slice(0, 8)}: failed to add candidate: ${message}`);
        }
      }
    }
  }

  /**
   * Close and remove the peer connection for a session.
   * Called automatically when the connection enters a terminal state.
   *
   * @param {string} sessionId
   * @returns {void}
   */
  function closeSession(sessionId) {
    const pc = peers.get(sessionId);
    if (pc) {
      try { pc.close(); } catch { /* ignore */ }
      peers.delete(sessionId);
      log(`[webrtc] Session ${sessionId.slice(0, 8)}: closed`);
    }
  }

  /**
   * Close all peer connections and stop the shared UDP mux listener.
   *
   * @returns {void}
   */
  function dispose() {
    for (const sessionId of [...peers.keys()]) {
      closeSession(sessionId);
    }
    if (udpMuxListener) {
      try { udpMuxListener.stop(); } catch { /* ignore */ }
      udpMuxListener = null;
    }
  }

  return { handleSignal, closeSession, dispose };
}
