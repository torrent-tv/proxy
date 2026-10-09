import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createDataChannelHandler } from "../../services/transport/data-channel-handler.js";

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

/**
 * A global setTimeout whose time moves only when the check moves it. When the
 * check ends, every handle it gave out goes on real timers.
 *
 * undici keeps its request timeouts on one clock per module: the first of them
 * calls the global setTimeout, and every later one refreshes that handle
 * (undici lib/util/timers.js, refreshTimeout). A handle from node:test's mocked
 * timers does nothing on refresh(), so they move that clock one step only.
 */
function manualClock(t) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let real = false;
  const armed = new Set();
  class Handle {
    constructor(callback, delay, args) {
      Object.assign(this, { callback, delay, args, timer: null });
      this.refresh();
    }

    refresh() {
      realClearTimeout(this.timer);
      if (real) {
        this.timer = realSetTimeout(this.callback, this.delay, ...this.args).unref();
      } else {
        this.due = now + this.delay;
        armed.add(this);
      }
      return this;
    }

    unref() {
      return this;
    }
  }
  t.mock.method(globalThis, "setTimeout", (callback, delay = 0, ...args) => new Handle(callback, delay, args));
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    if (!(timer instanceof Handle)) return realClearTimeout(timer);
    armed.delete(timer);
    realClearTimeout(timer.timer);
  });
  // undici keeps this handle as its clock for the rest of the process.
  t.after(() => {
    real = true;
    for (const handle of armed) handle.refresh();
    armed.clear();
  });
  const earliest = () => [...armed].reduce((first, handle) => (!first || handle.due < first.due ? handle : first), null);
  return {
    armed: () => armed.size,
    advance(ms) {
      const until = now + ms;
      for (let next = earliest(); next && next.due <= until; next = earliest()) {
        armed.delete(next);
        now = next.due;
        next.callback(...next.args);
      }
      now = until;
    }
  };
}

// First in this file: once any request has put undici's clock on a real timer,
// no check in this process can move it.
test("a response held past undici's default five-minute timeouts still reaches the browser", async (t) => {
  // undici's default for both the headers and the body wait. Its clock moves in
  // half-second steps and a timeout starts counting on the step after it is
  // armed, so two seconds more passes either default.
  const pastDefault = 300_000 + 2_000;
  const clock = manualClock(t);
  let arrived;
  const held = new Promise((resolve) => { arrived = resolve; });
  // A synthetic HTTP route only; no proxy or torrent client is started.
  const server = createServer((_request, response) => arrived(response));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const channel = new FakeDataChannel("proxy");
  const handler = createDataChannelHandler({ proxyPort: server.address().port });
  handler.handleChannel("held-peer", channel);
  t.after(async () => {
    channel.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const events = [];
  let recheck = () => {};
  const record = (event) => { events.push(event); recheck(); };
  channel.sendMessage = message => record(JSON.parse(message));
  channel.sendMessageBinary = frame =>
    record(frame[0] === 1 ? { type: "done" } : { type: "body", bytes: Buffer.from(frame.subarray(2 + frame[1])) });
  // The first message of one of `types`, once the channel has carried it.
  const first = (...types) => new Promise((resolve) => {
    recheck = () => {
      const event = events.find(candidate => types.includes(candidate.type));
      if (event) resolve(event);
    };
    recheck();
  });

  channel.message(JSON.stringify({ type: "request", requestId: "held", method: "GET", path: "/stream" }));
  const response = await held;
  assert.ok(clock.armed() > 0, "undici's clock is on this check's setTimeout");

  clock.advance(pastDefault);
  response.writeHead(200, { "content-type": "video/mp4" });
  response.write("first-");
  const started = await first("response-start", "response-error");
  assert.equal(started.type, "response-start", `the headers wait ended the request: ${started.error}`);

  clock.advance(pastDefault);
  response.end("rest");
  const ended = await first("done", "response-error");
  assert.equal(ended.type, "done", `the body wait ended the request: ${ended.error}`);
  const body = Buffer.concat(events.filter(event => event.type === "body").map(event => event.bytes));
  assert.equal(body.toString(), "first-rest");
});

test("the loopback dispatcher forwards a real HTTP response through the channel", async (t) => {
  // A synthetic HTTP response only; no proxy or torrent client is started.
  const server = createServer((_request, response) => response.end("held-media"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const channel = new FakeDataChannel("proxy");
  const handler = createDataChannelHandler({ proxyPort: server.address().port });
  handler.handleChannel("loopback-peer", channel);
  t.after(async () => {
    channel.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const chunks = [];
  let finish, failed;
  const completed = new Promise((resolve, reject) => { finish = resolve; failed = reject; });
  const send = channel.sendMessage.bind(channel);
  channel.sendMessage = message => {
    send(message);
    const parsed = JSON.parse(message);
    if (parsed.type === "response-error") failed(new Error(parsed.error));
  };
  channel.sendMessageBinary = frame => {
    if (frame[0] === 1) finish();
    else chunks.push(frame.subarray(2 + frame[1]));
  };
  channel.message(JSON.stringify({ type: "request", requestId: "loopback", method: "GET", path: "/healthz" }));
  await completed;
  assert.equal(JSON.parse(channel.messages.find(message => JSON.parse(message).type === "response-start")).status, 200);
  assert.equal(Buffer.concat(chunks).toString(), "held-media");
});

test("cancellation releases a response stalled on a full outgoing channel", async (t) => {
  let cancelled;
  let reachedQueue;
  const released = new Promise((resolve) => { cancelled = resolve; });
  const queued = new Promise((resolve) => { reachedQueue = resolve; });
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled(); }
  })));
  const handler = createDataChannelHandler({ proxyPort: 9090 });
  const channel = new FakeDataChannel("proxy");
  channel.sendMessageBinary = () => {};
  channel.bufferedAmount = () => { reachedQueue(); return 16 * 1024 * 1024; };
  handler.handleChannel("queue-peer", channel);
  t.after(() => channel.close());
  channel.message(JSON.stringify({ type: "request", requestId: "queued", method: "GET", path: "/healthz" }));
  await queued;
  channel.message(JSON.stringify({ type: "request-cancel", requestId: "queued" }));
  await released;
  assert.equal(channel.messages.some((message) => JSON.parse(message).type === "response-error"), false);
});

test("cancelling a browser request aborts its local HTTP wait", async (t) => {
  let receivedSignal;
  let requestEnded;
  const ended = new Promise((resolve) => { requestEnded = resolve; });
  t.mock.method(globalThis, "fetch", (_url, options) => {
    receivedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(new DOMException("Cancelled", "AbortError"));
        requestEnded();
      }, { once: true });
    });
  });
  const handler = createDataChannelHandler({ proxyPort: 9090 });
  const channel = new FakeDataChannel("proxy");
  handler.handleChannel("cancel-peer", channel);
  t.after(() => channel.close());
  channel.message(JSON.stringify({ type: "request", requestId: "cancel-me", method: "GET", path: "/healthz" }));
  assert.equal(receivedSignal.aborted, false);
  channel.message(JSON.stringify({ type: "request-cancel", requestId: "cancel-me" }));
  await ended;
  assert.equal(receivedSignal.aborted, true);
});

test("a different channel cannot cancel another connection's request", (t) => {
  let receivedSignal;
  t.mock.method(globalThis, "fetch", (_url, options) => {
    receivedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Closed", "AbortError")), { once: true });
    });
  });
  const handler = createDataChannelHandler({ proxyPort: 9090 });
  const channel = new FakeDataChannel("proxy");
  const other = new FakeDataChannel("proxy");
  handler.handleChannel("one-peer", channel);
  handler.handleChannel("other-peer", other);
  t.after(() => { channel.close(); other.close(); });
  channel.message(JSON.stringify({ type: "request", requestId: "same-id", method: "GET", path: "/healthz" }));
  other.message(JSON.stringify({ type: "request-cancel", requestId: "same-id" }));
  assert.equal(receivedSignal.aborted, false);
  channel.close();
  assert.equal(receivedSignal.aborted, true);
});

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
