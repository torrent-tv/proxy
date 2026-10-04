import test from "node:test";
import assert from "node:assert/strict";
import { createDataChannelHandler } from "../services/transport/data-channel-handler.js";

class FakeDataChannel {
  constructor(label) {
    this.label = label;
    this.messages = [];
    this.closed = null;
  }

  getLabel() {
    return this.label;
  }

  onMessage(callback) {
    this.message = callback;
  }

  onClosed(callback) {
    this.closed = callback;
  }

  onError() {}

  sendMessage(message) {
    this.messages.push(message);
  }

  close() {
    this.closed?.();
  }
}

test("a viewer remains present until every data channel on the connection closes", () => {
  const gone = [];
  const handler = createDataChannelHandler({
    proxyPort: 9090,
    getTransportSnapshot: () => ({ bytesSent: 0, bytesReceived: 0 }),
    onViewerGone: (consumerId, reason) => gone.push({ consumerId, reason })
  });
  const media = new FakeDataChannel("proxy");
  const control = new FakeDataChannel("proxy-control");
  const probe = new FakeDataChannel("proxy-fast");

  handler.handleChannel("peer-session", media);
  handler.handleChannel("peer-session", control);
  handler.handleChannel("peer-session", probe);
  control.message(JSON.stringify({ type: "viewer", consumerId: "viewer-1" }));

  control.close();
  assert.deepEqual(gone, [], "closing the control channel alone does not release the viewer");

  media.close();
  assert.deepEqual(gone, [], "the viewer remains while the probe channel is still open");

  probe.close();
  assert.deepEqual(gone, [
    { consumerId: "viewer-1", reason: "the connection closed" }
  ]);
});

test("a closing connection does not release a viewer already named on its replacement", () => {
  const gone = [];
  const handler = createDataChannelHandler({
    proxyPort: 9090,
    getTransportSnapshot: () => ({ bytesSent: 0, bytesReceived: 0 }),
    onViewerGone: (consumerId, reason) => gone.push({ consumerId, reason })
  });
  const oldControl = new FakeDataChannel("proxy-control");
  const oldMedia = new FakeDataChannel("proxy");
  const newControl = new FakeDataChannel("proxy-control");
  const newMedia = new FakeDataChannel("proxy");

  handler.handleChannel("old-peer", oldControl);
  handler.handleChannel("old-peer", oldMedia);
  oldControl.message(JSON.stringify({ type: "viewer", consumerId: "viewer-1" }));
  handler.handleChannel("new-peer", newControl);
  handler.handleChannel("new-peer", newMedia);
  newControl.message(JSON.stringify({ type: "viewer", consumerId: "viewer-1" }));

  oldControl.close();
  oldMedia.close();
  assert.deepEqual(gone, [], "the old connection no longer owns the viewer");

  newControl.close();
  assert.deepEqual(gone, [], "the replacement still has its media channel");
  newMedia.close();
  assert.deepEqual(gone, [
    { consumerId: "viewer-1", reason: "the connection closed" }
  ]);
});

/**
 * A page on an old connection that raises a trial connection beside it, the
 * way it does when the old one stops delivering.
 */
function trialBeside(gone) {
  const handler = createDataChannelHandler({
    proxyPort: 9090,
    getTransportSnapshot: () => ({ bytesSent: 0, bytesReceived: 0 }),
    viewersWantingCues: () => ["viewer-1"],
    onViewerGone: (consumerId, reason) => gone.push({ consumerId, reason })
  });
  const old = { control: new FakeDataChannel("proxy-control"), media: new FakeDataChannel("proxy") };
  const trial = { control: new FakeDataChannel("proxy-control"), media: new FakeDataChannel("proxy") };
  handler.handleChannel("old-peer", old.control);
  handler.handleChannel("old-peer", old.media);
  old.control.message(JSON.stringify({ type: "viewer", consumerId: "viewer-1" }));
  handler.handleChannel("trial-peer", trial.control);
  handler.handleChannel("trial-peer", trial.media);
  trial.control.message(JSON.stringify({ type: "viewer", consumerId: "viewer-1" }));
  const cuesOn = (channel) => channel.messages.filter((message) => message.includes("subtitle-cues")).length;
  const push = () =>
    handler.publishSubtitleCues({
      sourceKey: "torrent:abc",
      fileIndex: 0,
      trackIndex: 0,
      cues: [{ start: 1, end: 2, text: "line" }],
      language: "en",
      detectedLanguage: null,
      cursor: 1
    });
  return { old, trial, cuesOn, push };
}

test("closing a trial connection keeps the viewer and their cues on the old one", () => {
  // The old connection delivered again before the trial was adopted, so the
  // page closes the trial. The viewer never left.
  const gone = [];
  const { old, trial, cuesOn, push } = trialBeside(gone);
  trial.control.close();
  trial.media.close();
  assert.deepEqual(gone, [], "the viewer is still on the old connection");
  push();
  assert.equal(cuesOn(old.control), 1, "cues reach the channel the viewer named themselves on");
  old.control.close();
  old.media.close();
  assert.deepEqual(gone, [{ consumerId: "viewer-1", reason: "the connection closed" }]);
});

test("after a trial connection is adopted, cues go to it and the old one's close releases nobody", () => {
  const gone = [];
  const { old, trial, cuesOn, push } = trialBeside(gone);
  push();
  assert.equal(cuesOn(trial.control), 1, "the newest connection carrying the viewer is used");
  assert.equal(cuesOn(old.control), 0);
  old.control.close();
  old.media.close();
  assert.deepEqual(gone, []);
  push();
  assert.equal(cuesOn(trial.control), 2);
});

test("a viewer whose newest channel closed is reached on the older connection", () => {
  const gone = [];
  const { old, trial, cuesOn, push } = trialBeside(gone);
  trial.control.close();
  push();
  assert.equal(cuesOn(old.control), 1);
  assert.deepEqual(gone, [], "the trial connection still has its media channel");
});

test("a connection the transport no longer knows is not probed any more, though no channel said it closed", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  let alive = true;
  const handler = createDataChannelHandler({
    proxyPort: 9090,
    getTransportSnapshot: () => (alive ? { bytesSent: 0, bytesReceived: 0 } : null),
    onViewerGone: () => {}
  });
  const channels = ["proxy", "proxy-control", "proxy-fast"].map((label) => new FakeDataChannel(label));
  for (const channel of channels) {
    handler.handleChannel("trial-peer", channel);
  }
  const probes = () =>
    channels.reduce((sum, channel) => sum + channel.messages.filter((message) => message.includes('"probe"')).length, 0);
  t.mock.timers.tick(2_000);
  assert.ok(probes() > 0, "an open connection is probed");

  // Field 2026-10-04: the peer connection closed 70 ms after its channels
  // opened, and none of them reported `onClosed`.
  alive = false;
  const advance = (ms) => {
    // Second by second: the watcher compares the clock between its own ticks,
    // and one long jump lands every tick on the same instant.
    for (let elapsed = 0; elapsed < ms; elapsed += 1_000) t.mock.timers.tick(1_000);
  };
  advance(30_000);
  const afterGone = probes();
  advance(30_000);
  assert.equal(probes(), afterGone, "nothing is sent on a connection that is gone");
});
