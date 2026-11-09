/**
 * @file What the data channel forwards to the proxy's own HTTP server, and what
 * the browser is told when it does not (torrent-tv/meta#281).
 *
 * A request from the browser becomes a call to 127.0.0.1, where some routes
 * trust the caller. Paths outside the browser's route set and bodies over the
 * cap never reach the local server; the browser gets a `response-error`. An
 * answer that breaks off half-way is reported as an error, never as complete:
 * a done frame would make a cut-off segment look whole.
 *
 * The channel is a fake and the local server a stand-in on 127.0.0.1 at a free
 * port; no peer connection, no proxy route and no torrent is started.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createDataChannelHandler } from "../../services/transport/data-channel-handler.js";
import { cutOffAfter, startLoopbackServer } from "./helpers/loopback-server.js";
import { settle, until } from "./helpers/wait.js";

const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/** A data channel whose library queue is always empty. */
class FakeChannel {
  constructor(label) {
    this.label = label;
    /** @type {any[]} JSON control messages sent to the browser */
    this.messages = [];
    /** @type {Buffer[]} binary body frames sent to the browser */
    this.frames = [];
    this.message = () => {};
    this.closed = null;
  }

  getLabel() { return this.label; }
  onMessage(callback) { this.message = callback; }
  onClosed(callback) { this.closed = callback; }
  onError() {}
  bufferedAmount() { return 0; }
  setBufferedAmountLowThreshold() {}
  onBufferedAmountLow() {}
  sendMessage(message) { this.messages.push(JSON.parse(message)); }
  sendMessageBinary(frame) { this.frames.push(Buffer.from(frame)); }
  close() { this.closed?.(); }

  /** Control messages about one request. */
  about(requestId) { return this.messages.filter((message) => message.requestId === requestId); }

  /** Body frames for one request: `{ done, payload }`. */
  framesOf(requestId) {
    return this.frames
      .filter((frame) => frame.toString("ascii", 2, 2 + frame[1]) === requestId)
      .map((frame) => ({ done: (frame[0] & 1) === 1, payload: frame.subarray(2 + frame[1]) }));
  }
}

/** A handler forwarding to `server`, with one open channel. */
function openChannel(t, server) {
  const handler = createDataChannelHandler({ proxyPort: server.port, onLog: () => {} });
  const channel = new FakeChannel("proxy");
  handler.handleChannel("loopback-peer", channel);
  t.after(() => channel.close());
  return channel;
}

/** True once the browser has been told how `requestId` ended. */
function ended(channel, requestId) {
  return () =>
    channel.about(requestId).some((message) => message.type === "response-error") ||
    channel.framesOf(requestId).some((frame) => frame.done);
}

test("a data-channel request for /encode-input/1/0 is answered with an error and never reaches the local server", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());
  const channel = openChannel(t, server);

  channel.message(JSON.stringify({ type: "request", requestId: "enc", method: "GET", path: "/encode-input/1/0" }));
  await until(ended(channel, "enc"), "the answer to /encode-input/1/0");
  await settle(5);

  assert.deepEqual(channel.about("enc"), [{ type: "response-error", requestId: "enc", error: "Invalid request path." }]);
  assert.equal(server.connections(), 0);
});

test("a data-channel request for /media with a query is answered with an error and never reaches the local server", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());
  const channel = openChannel(t, server);

  channel.message(JSON.stringify({ type: "request", requestId: "med", method: "GET", path: "/media?url=x" }));
  await until(ended(channel, "med"), "the answer to /media");
  await settle(5);

  assert.deepEqual(channel.about("med"), [{ type: "response-error", requestId: "med", error: "Invalid request path." }]);
  assert.equal(server.connections(), 0);
});

test("a single-message body one byte over the cap is answered with an error and never reaches the local server", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());
  const channel = openChannel(t, server);

  channel.message(JSON.stringify({
    type: "request",
    requestId: "big",
    method: "POST",
    path: "/api/x",
    headers: { "content-type": "text/plain" },
    body: "a".repeat(MAX_REQUEST_BODY_BYTES + 1)
  }));
  await until(
    () => channel.about("big").some((message) => message.type === "response-error" || message.type === "response-start"),
    "the answer to the oversized body"
  );
  await settle(5);

  assert.deepEqual(channel.about("big"), [{ type: "response-error", requestId: "big", error: "Request body too large." }]);
  assert.equal(server.connections(), 0);
});

test("an answer whose body breaks off half-way ends in an error frame and no done frame", async (t) => {
  const server = await startLoopbackServer(cutOffAfter(1000, 5000));
  t.after(() => server.close());
  const channel = openChannel(t, server);

  channel.message(JSON.stringify({ type: "request", requestId: "cut", method: "GET", path: "/stream" }));
  await until(ended(channel, "cut"), "the end of the cut-off answer");
  await settle(5);

  const control = channel.about("cut");
  assert.equal(control[0].type, "response-start");
  assert.equal(control[0].status, 200);
  assert.equal(control.filter((message) => message.type === "response-error").length, 1);
  const frames = channel.framesOf("cut");
  assert.equal(frames.some((frame) => frame.done), false, "a done frame was sent for a cut-off body");
  assert.equal(frames.reduce((sum, frame) => sum + frame.payload.length, 0), 1000);
});

test("an allowed data-channel request reaches the local server with its host and request id, and completes", async (t) => {
  const server = await startLoopbackServer((_request, res) => res.end("ok"));
  t.after(() => server.close());
  const channel = openChannel(t, server);

  channel.message(JSON.stringify({
    type: "request",
    requestId: "ok-1",
    method: "GET",
    path: "/api/sources",
    query: "a=1",
    headers: { host: "viewer.example.test" }
  }));
  await until(ended(channel, "ok-1"), "the answer to /api/sources");

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, "/api/sources?a=1");
  assert.equal(server.requests[0].headers.host, `127.0.0.1:${server.port}`);
  assert.equal(server.requests[0].headers["x-ttv-forwarded-request-id"], "ok-1");
  assert.equal(channel.about("ok-1").some((message) => message.type === "response-error"), false);
  const frames = channel.framesOf("ok-1");
  assert.equal(frames.at(-1).done, true);
  assert.equal(Buffer.concat(frames.map((frame) => frame.payload)).toString("utf8"), "ok");
});
