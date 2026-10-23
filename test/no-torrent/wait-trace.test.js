import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceWaitTrace } from "../../utils/wait-trace.js";
import { tracePieceStorePut } from "../../services/torrent/worker/trace-piece-store-put.js";
import { beginSwarmLifecycleTrace, noteSwarmDiscovery, noteSwarmMetadata, noteSwarmPeer } from "../../services/torrent/worker/trace-swarm-lifecycle.js";

test("source observations expire and do not claim a request caused shared work", () => {
  let now = 0;
  const events = [];
  const trace = new SourceWaitTrace({ now: () => now, emit: value => events.push(value) });
  trace.remember("source", { wait: "wait", attempt: 2, operation: "b10" });
  now = 100;
  trace.source("source", "container-read", { queuedMs: 30, readMs: 70 });
  assert.equal(events[0].operation, null);
  assert.equal(events[0].at, 100);
  assert.equal(events[0].wait, "wait");
  trace.process("source", "P2", "begin", { at: 110, requestId: "read-1" });
  trace.process("source", "P2", "end", { at: 200, startedAt: 110, endedAt: 200, requestId: "read-1" });
  assert.deepEqual(events.slice(1).map(event => [event.process, event.phase, event.at]), [
    ["P2", "begin", 110], ["P2", "end", 200]
  ]);
  now = 30 * 60_000 + 1;
  trace.source("source", "container-read");
  assert.equal(events.length, 3);
});

test("untraced requests produce no events; traced finish is recorded once", async () => {
  let now = 10;
  const hooks = {};
  const events = [];
  const listeners = {};
  const trace = new SourceWaitTrace({ now: () => now, emit: value => events.push(value) });
  trace.install({ addHook: (name, fn) => { hooks[name] = fn; } });
  const reply = { statusCode: 200, raw: { once: (name, fn) => { listeners[name] = fn; }, writableFinished: true } };
  await hooks.onRequest({ headers: {} }, reply);
  assert.equal(events.length, 0);
  const req = { method: "POST", url: "/api/playback-plan", headers: { "x-ttv-wait-trace": "a",
    "x-ttv-wait-attempt": "1", "x-ttv-wait-operation": "b1", "x-ttv-wait-process": "A12" },
  body: { sourceKey: "source" } };
  await hooks.onRequest(req, reply);
  await hooks.preHandler(req);
  now = 100;
  await hooks.onSend(req, reply, "bytes");
  listeners.finish();
  listeners.close();
  assert.equal(events.filter(event => event.event === "http-end").length, 1);
  assert.equal(events.at(-1).duration, 90);
  assert.equal(events.at(-1).operation, "b1");
  assert.equal(events.find(event => event.event === "http-start").process, "P3");
  assert.equal(events.find(event => event.event === "http-end").phase, "end");
  const progressRequest = { method: "GET", url: "/api/transcode-sessions/session-1/progress?consumer=viewer",
    headers: { "x-ttv-wait-trace": "a", "x-ttv-wait-attempt": "1", "x-ttv-wait-operation": "b2",
      "x-ttv-wait-process": "S2.1" } };
  await hooks.onRequest(progressRequest, reply);
  assert.equal(events.filter(event => event.event === "http-start").at(-1).process, "P14");
});

test("W9 records the exact piece-store write duration and preserves callback results", () => {
  let now = 20;
  const events = [];
  const originalResult = { accepted: true };
  const store = { put(index, bytes, callback) {
    assert.equal(index, 7);
    assert.equal(bytes.byteLength, 12);
    this.complete = callback;
    return originalResult;
  } };
  const trace = (process, phase, fields) => events.push({ process, phase, ...fields });
  assert.equal(tracePieceStorePut(store, trace, () => now), true);
  const callbackResults = [];
  assert.equal(store.put(7, new Uint8Array(12), error => callbackResults.push(error)), originalResult);
  now = 24.5;
  store.complete(null);
  assert.deepEqual(callbackResults, [null]);
  assert.deepEqual(events.map(event => [event.process, event.phase, event.piece, event.durationMs]), [
    ["W9", "begin", 7, undefined], ["W9", "end", 7, 4.5]
  ]);
});

test("W9 can attach after the store appears, remains single-wrapped, and records failures", () => {
  let now = 5;
  const events = [];
  const trace = (process, phase, fields) => events.push({ process, phase, ...fields });
  const late = {};
  assert.equal(tracePieceStorePut(late, trace, () => now), false);
  late.put = function (_index, _bytes, callback) { this.complete = callback; };
  assert.equal(tracePieceStorePut(late, trace, () => now), true);
  assert.equal(tracePieceStorePut(late, trace, () => now), false);
  late.put(3, new Uint8Array(4), () => {});
  now = 8;
  late.complete(new Error("disk write failed"));
  assert.deepEqual(events.map(event => [event.phase, event.durationMs, event.outcome]), [
    ["begin", undefined, undefined], ["end", 3, "error"]
  ]);
});

test("W3 and W4 measure first-peer and magnet-metadata waits on the worker clock", () => {
  let now = 10;
  const events = [];
  const timing = { addedAtMonotonic: 5, firstPeerAtMonotonic: null, peerWaitStartedAt: null, metadataWaitStartedAt: null };
  const trace = (process, phase, fields) => events.push({ process, phase, ...fields });
  beginSwarmLifecycleTrace(timing, trace, false, () => now);
  noteSwarmDiscovery(timing, trace, now);
  now = 30;
  noteSwarmPeer(timing, trace, false, () => now);
  now = 47;
  noteSwarmMetadata(timing, trace, 4, () => now);
  assert.deepEqual(events.map(event => [event.process, event.phase, event.durationMs]), [
    ["W3", "begin", undefined], ["W3", "end", 20], ["W4", "begin", undefined], ["W4", "end", 17]
  ]);
});
