import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MediaReadRequests } from "../../services/media/MediaReadRequests.js";
import { handleApiTranscodeSessionsPost } from "../../routes/api/transcode-sessions/post.js";

function preparation() {
  const reads = new MediaReadRequests({ read: async () => {} });
  const req = { body: { sourceKey: "source", fileIndex: 0, consumerId: "viewer" } };
  let sent = null, calls = 0, available = false;
  const reply = { raw: new EventEmitter(), code() { return this; }, send(body) { sent = body; return this; } };
  const deps = { subscribeSource: (...args) => reads.subscribe(...args),
    viewerRequests: { createOrGetSession: async ({ signal }) => {
      signal.throwIfAborted();
      calls++;
      if (!available) { const error = new Error("Missing keyframe bytes"); error.code = "MEDIA_BYTES_UNAVAILABLE"; throw error; }
      return { id: "output" };
    } },
    renditions: { buildMasterPlaylist: () => null, declaredTracks: () => [], soundtrackOf: () => null },
    quality: { offeredHeights: () => [] }, lookaheadSeconds: 4 };
  return { req, reply, deps, reads, get sent() { return sent; }, get calls() { return calls; }, ready() { available = true; } };
}

test("output allocation retries on source readiness without changing copy parameters", async () => {
  const state = preparation();
  const waiting = handleApiTranscodeSessionsPost(state.req, state.reply, state.deps);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.sent, null);
  assert.equal(state.calls, 1);
  state.ready();
  state.reads.bytesChanged("source", 0);
  await waiting;
  assert.equal(state.calls, 2);
  assert.equal(state.sent.sessionId, "output");
  assert.equal(state.reply.raw.listenerCount("close"), 0);
});

test("cancelled allocation stops observing subsequent source readiness", async () => {
  const state = preparation();
  const waiting = handleApiTranscodeSessionsPost(state.req, state.reply, state.deps);
  await new Promise(resolve => setImmediate(resolve));
  state.reply.raw.emit("close");
  await waiting;
  state.ready();
  state.reads.bytesChanged("source", 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.calls, 1);
  assert.equal(state.sent, null);
  assert.equal(state.reply.raw.listenerCount("close"), 0);
});

test("a forgotten source settles an open allocation instead of leaving its response pending", async () => {
  const state = preparation();
  let status;
  state.reply.code = value => { status = value; return state.reply; };
  const waiting = handleApiTranscodeSessionsPost(state.req, state.reply, state.deps);
  await new Promise(resolve => setImmediate(resolve));
  state.reads.forget("source");
  await waiting;
  assert.equal(status, 410);
  assert.equal(state.sent.terminal, true);
  assert.equal(state.sent.retryable, false);
  assert.equal(state.reply.raw.listenerCount("close"), 0);
});
