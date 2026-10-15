/**
 * @file A response body is handed to the library only while the library holds
 * nothing of the channel that usrsctp has not taken.
 *
 * libdatachannel keeps one queue for every channel of a connection, so what a
 * response leaves in it is waited behind by every control answer after it. On
 * Home Assistant probes on all three channels stood 2.8-5.1 s behind while
 * copied 1080p pieces crossed (r46, torrent-tv/meta#178). The channels here are
 * fakes: no peer connection, no proxy and no torrent is started.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createDataChannelHandler } from "../../services/transport/data-channel-handler.js";

/** A channel whose library queue the check fills and empties by hand. */
class QueueingChannel {
  constructor(label) {
    this.label = label;
    this.queued = 0;
    this.frames = [];
    this.messages = [];
    this.threshold = null;
    this.low = null;
    this.closed = null;
    this.onFrame = () => {};
  }

  getLabel() { return this.label; }
  onMessage(callback) { this.message = callback; }
  onClosed(callback) { this.closed = callback; }
  onError() {}
  bufferedAmount() { return this.queued; }
  setBufferedAmountLowThreshold(value) { this.threshold = value; }
  onBufferedAmountLow(callback) { this.low = callback; }
  sendMessage(message) { this.messages.push(JSON.parse(message)); }

  sendMessageBinary(frame) {
    this.frames.push(frame);
    // Everything handed over stays in the library until the check drains it.
    if (frame[0] !== 1) this.queued += frame.length;
    this.onFrame();
  }

  /** usrsctp takes everything; the library says its queue is at the threshold. */
  drain() {
    this.queued = 0;
    this.low?.();
  }

  close() { this.closed?.(); }
}

const bodyOf = (...chunks) => new Response(new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
    controller.close();
  }
}));

/** Resolves once `count` frames have been handed to the channel. */
function framesHanded(channel, count) {
  return new Promise((resolve) => {
    const check = () => { if (channel.frames.length >= count) resolve(); };
    channel.onFrame = check;
    check();
  });
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("the next frame waits until the library has handed every earlier one to usrsctp", async (t) => {
  t.mock.method(globalThis, "fetch", async () => bodyOf(1000, 1000, 1000));
  const handler = createDataChannelHandler({ proxyPort: 9090 });
  const channel = new QueueingChannel("proxy");
  handler.handleChannel("queue-peer", channel);
  t.after(() => channel.close());

  channel.message(JSON.stringify({ type: "request", requestId: "piece", method: "GET", path: "/healthz" }));
  await framesHanded(channel, 1);
  await settle();
  assert.equal(channel.threshold, 0, "the library is asked to say when its queue is empty");
  assert.equal(channel.frames.length, 1, "nothing more while the first frame is still in the library");

  channel.drain();
  await framesHanded(channel, 2);
  await settle();
  assert.equal(channel.frames.length, 2, "one frame per emptying");

  channel.drain();
  await framesHanded(channel, 3);
  channel.drain();
  await framesHanded(channel, 4);
  assert.equal(channel.frames.at(-1)[0], 1, "and the response ends");
});

test("one emptying wakes every response waiting on the channel", async (t) => {
  t.mock.method(globalThis, "fetch", async () => bodyOf(500, 500));
  const handler = createDataChannelHandler({ proxyPort: 9090 });
  const channel = new QueueingChannel("proxy");
  handler.handleChannel("two-peer", channel);
  t.after(() => channel.close());

  channel.message(JSON.stringify({ type: "request", requestId: "video", method: "GET", path: "/healthz" }));
  channel.message(JSON.stringify({ type: "request", requestId: "audio", method: "GET", path: "/healthz" }));
  await framesHanded(channel, 2);
  await settle();
  assert.equal(channel.frames.length, 2, "each response handed its first frame and waits");

  channel.drain();
  await framesHanded(channel, 4);
  await settle();
  assert.equal(channel.frames.length, 4, "both resumed on the one event");
});

test("a request cancelled while its frames wait is released without the queue emptying", async (t) => {
  let cancelled;
  const released = new Promise((resolve) => { cancelled = resolve; });
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024)); controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled(); }
  })));
  const handler = createDataChannelHandler({ proxyPort: 9090 });
  const channel = new QueueingChannel("proxy");
  handler.handleChannel("cancel-peer", channel);
  t.after(() => channel.close());

  channel.message(JSON.stringify({ type: "request", requestId: "old", method: "GET", path: "/healthz" }));
  await framesHanded(channel, 1);
  channel.message(JSON.stringify({ type: "request-cancel", requestId: "old" }));
  await released;
  assert.equal(channel.frames.length, 1, "nothing further of the cancelled response");
});
