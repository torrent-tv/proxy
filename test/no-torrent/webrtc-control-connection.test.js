import test from "node:test";
import assert from "node:assert/strict";
import { createWebRtcManager } from "../../services/transport/webrtc-manager.js";

// No native peer or network is created. Only the signalling dispatch is real.
function setup() {
  const peers = [];
  const signals = [];
  const channels = [];
  class Peer {
    constructor() { peers.push(this); this.closed = 0; this.candidates = []; }
    onLocalCandidate(callback) { this.candidate = callback; }
    onLocalDescription(callback) { this.description = callback; }
    onStateChange(callback) { this.changeState = callback; }
    onDataChannel(callback) { this.channel = callback; }
    onGatheringStateChange() {}
    onIceStateChange() {}
    setRemoteDescription(sdp) { this.remote = sdp; this.description("answer", "answer"); }
    addRemoteCandidate(candidate) { this.candidates.push(candidate); }
    close() { this.closed++; this.changeState("closed"); }
    bytesSent() { return peers.indexOf(this) + 1; }
    bytesReceived() { return 0; }
    rtt() { return 0; }
    state() { return "connected"; }
    iceState() { return "connected"; }
    getSelectedCandidatePair() { return null; }
  }
  const manager = createWebRtcManager({
    rtc: { PeerConnection: Peer },
    sendSignal: (sessionId, signal) => signals.push({ sessionId, ...signal }),
    onDataChannel: (peerId, channel) => channels.push({ peerId, channel })
  });
  return { manager, peers, signals, channels };
}

test("media and control use independent peers and tagged signalling", t => {
  const { manager, peers, signals, channels } = setup();
  t.after(() => manager.dispose());
  manager.handleSignal("session", { type: "offer", sdp: "media" });
  manager.handleSignal("session", { type: "offer", sdp: "control", connectionId: "control-1" });
  assert.equal(peers.length, 2);
  assert.equal(signals[0].separateControl, true);
  assert.equal(signals[1].connectionId, "control-1");
  manager.handleSignal("session", { type: "candidate", candidate: "media-candidate", mid: "0" });
  manager.handleSignal("session", { type: "candidate", candidate: "control-candidate", mid: "0", connectionId: "control-1" });
  assert.deepEqual(peers.map(peer => peer.candidates), [["media-candidate"], ["control-candidate"]]);
  peers[1].candidate("local-control", "0");
  assert.equal(signals.at(-1).connectionId, "control-1");
  const channel = { getLabel: () => "proxy-control" };
  peers[1].channel(channel);
  assert.deepEqual(channels, [{ peerId: "session/control-1", channel }]);
  assert.equal(manager.getTransportSnapshot("session").bytesSent, 1);
  assert.equal(manager.getTransportSnapshot("session/control-1").bytesSent, 2);
});

test("replacing control closes only its old generation and ignores late candidates", t => {
  const { manager, peers } = setup();
  t.after(() => manager.dispose());
  manager.handleSignal("session", { type: "offer", sdp: "media" });
  manager.handleSignal("session", { type: "offer", sdp: "control", connectionId: "old" });
  manager.handleSignal("session", { type: "offer", sdp: "control", connectionId: "new" });
  assert.deepEqual(peers.map(peer => peer.closed), [0, 1, 0]);
  manager.handleSignal("session", { type: "candidate", candidate: "late", mid: "0", connectionId: "old" });
  peers[1].changeState("failed");
  assert.ok(manager.getTransportSnapshot("session/new"));
  assert.deepEqual(peers[2].candidates, []);
  manager.closeSession("session");
  assert.deepEqual(peers.map(peer => peer.closed), [1, 1, 1]);
});

test("a control peer cannot carry a media channel or exist without its media session", t => {
  const { manager, peers } = setup();
  t.after(() => manager.dispose());
  manager.handleSignal("session", { type: "offer", sdp: "control", connectionId: "orphan" });
  assert.equal(peers.length, 0);
  manager.handleSignal("session", { type: "offer", sdp: "media" });
  manager.handleSignal("session", { type: "offer", sdp: "control", connectionId: "control" });
  let closed = false;
  peers[1].channel({ getLabel: () => "proxy", close: () => { closed = true; } });
  assert.equal(closed, true);
});
