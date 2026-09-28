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
