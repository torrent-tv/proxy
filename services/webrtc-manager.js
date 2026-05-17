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
export function createWebRtcManager({ sendSignal, onDataChannel, onLog }) {
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

    const pc = new nodeDataChannel.PeerConnection(`proxy-${sessionId.slice(0, 8)}`, {
      iceServers: ICE_SERVERS
    });

    // Forward our ICE candidates to the browser through the tunnel.
    pc.onLocalCandidate((candidate, mid) => {
      sendSignal(sessionId, { type: "candidate", candidate, mid });
    });

    // Forward our SDP answer to the browser through the tunnel.
    pc.onLocalDescription((sdp, type) => {
      log(`[webrtc] Session ${sessionId.slice(0, 8)}: sending ${type}`);
      sendSignal(sessionId, { type, sdp });
    });

    pc.onStateChange((state) => {
      log(`[webrtc] Session ${sessionId.slice(0, 8)}: state → ${state}`);
      if (state === "disconnected" || state === "failed" || state === "closed") {
        closeSession(sessionId);
      }
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
