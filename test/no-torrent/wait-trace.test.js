import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceWaitTrace } from "../../utils/wait-trace.js";

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
  now = 60_001;
  trace.source("source", "container-read");
  assert.equal(events.length, 1);
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
    "x-ttv-wait-attempt": "1", "x-ttv-wait-operation": "b1" }, body: { sourceKey: "source" } };
  await hooks.onRequest(req, reply);
  await hooks.preHandler(req);
  now = 100;
  await hooks.onSend(req, reply, "bytes");
  listeners.finish();
  listeners.close();
  assert.equal(events.filter(event => event.event === "http-end").length, 1);
  assert.equal(events.at(-1).duration, 90);
  assert.equal(events.at(-1).operation, "b1");
});
