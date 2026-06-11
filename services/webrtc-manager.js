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

const ICE_SERVERS = ["stun:stun.l.google.com:19302"];

/**
 * Return true when the ICE candidate string describes a `typ host` candidate
 * with a private (RFC 1918 / ULA / loopback) IP address.
 *
 * Browsers enforce Private Network Access (PNA) and show a permission dialog
 * when a page served from a public origin (e.g. webauth.courses) attempts a
 * WebRTC connection to a private-network address.  Filtering these candidates
 * out before forwarding them to the browser lets the connection proceed via the
 * server-reflexive (srflx) candidate — the proxy's public IP as seen by STUN —
 * which does not trigger PNA.
 *
 * Edge case: if no srflx candidate is available (STUN unreachable, symmetric
 * NAT that maps differently per destination, etc.) all host candidates are
 * suppressed and the connection will fail.  We accept this trade-off; STUN is
 * a hard dependency of the WebRTC path in any case.
 *
 * @param {string} candidate - Raw candidate attribute string from node-datachannel.
 * @returns {boolean}
 */
function isPrivateHostCandidate(candidate) {
  // Only care about "typ host" — srflx and relay are already public/relay.
  if (!candidate.includes("typ host")) {
    return false;
  }
  // RFC 1918 IPv4 private ranges.
  if (/\b(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(candidate)) {
    return true;
  }
  // Docker / typical private subnets not covered above (100.64–127 are special).
  if (/\b127\./.test(candidate)) {
    return true;
  }
  // IPv6 loopback.
  if (/\s::1\s/.test(candidate)) {
    return true;
  }
  // IPv6 Unique Local Addresses (ULA): fc00::/7 — starts with fc or fd.
  if (/\s(?:fc|fd)[0-9a-f]{2}:/i.test(candidate)) {
    return true;
  }
  return false;
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
 * @property {number} [udpPort]
 *   When set, every PeerConnection is pinned to this single UDP port and ICE
 *   UDP multiplexing is enabled, so all sessions share one port that can be
 *   statically UPnP-mapped (makes the WebRTC path reachable behind NAT). When
 *   omitted, node-datachannel uses an ephemeral UDP port (previous behaviour).
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
 */

/**
 * Create the proxy-side WebRTC connection manager.
 *
 * @param {WebRtcManagerOptions} options
 * @returns {WebRtcManager}
 */
export function createWebRtcManager({ sendSignal, onDataChannel, onLog, udpPort }) {
  /** @type {Map<string, import("node-datachannel").PeerConnection>} */
  const peers = new Map();

  // Base PeerConnection config shared by every session. When a UDP port is
  // configured, pin all sessions to it and enable ICE UDP mux so they share the
  // single (UPnP-mapped) port; otherwise fall back to an ephemeral UDP port.
  const pcConfig = { iceServers: ICE_SERVERS };
  if (Number.isInteger(udpPort) && udpPort > 0 && udpPort <= 65535) {
    pcConfig.enableIceUdpMux = true;
    pcConfig.portRangeBegin = udpPort;
    pcConfig.portRangeEnd = udpPort;
  }

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
      const isPrivate = isPrivateHostCandidate(candidate);
      // Log the full candidate (addr:port typ …) so we can confirm WebRTC is
      // pinned to the mapped UDP port and diagnose which paths are offered.
      log(
        `[webrtc] Session ${sessionId.slice(0, 8)}: sending ${isPrivate ? "private" : "public"} candidate: ${candidate.replace(/^a=/, "")}`
      );
      sendSignal(sessionId, { type: "candidate", candidate, mid });
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
      const pc = getOrCreatePeer(sessionId);
      pc.setRemoteDescription(signal.sdp, "offer");
      // `onLocalDescription` fires automatically with the SDP answer.
      return;
    }

    if (signal.type === "candidate") {
      const pc = peers.get(sessionId);
      if (!pc) {
        return;
      }
      if (typeof signal.candidate === "string" && typeof signal.mid === "string") {
        pc.addRemoteCandidate(signal.candidate, signal.mid);
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

  return { handleSignal, closeSession };
}
