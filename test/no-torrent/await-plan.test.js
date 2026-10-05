import assert from "node:assert/strict";
import test from "node:test";
import { waitForPlan } from "../../services/media/await-plan.js";

function events() {
  let listener;
  let removed = 0;
  return {
    subscribe(callback) { listener = callback; return () => { listener = null; removed++; }; },
    emit(value) { listener?.(value); },
    get subscribed() { return Boolean(listener); },
    get removed() { return removed; }
  };
}

test("plan preparation subscribes before reading and removes the subscription after readiness", async () => {
  const source = events();
  const plan = { mode: "hls" };
  assert.equal(await waitForPlan({ subscribe: source.subscribe, read: async () => {
    assert.equal(source.subscribed, true);
    return plan;
  } }), plan);
  assert.equal(source.removed, 1);
});

test("an event during an unfinished read causes another read without losing the change", async () => {
  const source = events();
  let finishRead;
  let reads = 0;
  const pending = waitForPlan({ subscribe: source.subscribe, read: () => {
    if (++reads === 1) return new Promise(resolve => { finishRead = resolve; });
    return { mode: "direct" };
  } });
  source.emit({ kind: "result" });
  finishRead({ pending: true });
  assert.equal((await pending).mode, "direct");
  assert.equal(reads, 2);
  assert.equal(source.removed, 1);
});

test("pending preparation waits for a source event and cancellation releases it immediately", async () => {
  const source = events();
  const controller = new AbortController();
  let reads = 0;
  const pending = waitForPlan({ subscribe: source.subscribe, signal: controller.signal,
    read: async () => { reads++; return { pending: true }; } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reads, 1);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(source.removed, 1);
  source.emit({ kind: "result" });
  assert.equal(reads, 1);
});

test("a terminal read rejects preparation and removes its subscription", async () => {
  const source = events();
  const error = new Error("Unsupported track");
  await assert.rejects(waitForPlan({ subscribe: source.subscribe, read: async () => { throw error; } }), error);
  assert.equal(source.removed, 1);
});

test("withdrawal during subscription cancels before any read", async () => {
  let removed = 0;
  let reads = 0;
  await assert.rejects(waitForPlan({ subscribe: listener => {
    listener({ kind: "cancelled" });
    return () => { removed++; };
  }, read: async () => { reads++; return {}; } }), { name: "AbortError" });
  assert.equal(reads, 0);
  assert.equal(removed, 1);
});
