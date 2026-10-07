import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { EncodeInputs } from "../../services/encode/EncodeInputs.js";
import { MachineBudget } from "../../services/storage/MachineBudget.js";

const output = { id: "output" };

test("input allowance changing before a pending memory refusal is returned is not lost", async () => {
  let finish, calls = 0;
  const inputs = new EncodeInputs({
    resolve: () => ++calls === 1 ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ kind: "result", sources: [source] }),
    readRanges: async () => [Buffer.from("ab")], reviseBudget: async () => {},
    changed: () => {}, failed: (_output, error) => { throw error; }
  });
  inputs.take(output, 0, 0);
  await setImmediate();
  inputs.allow(100);
  finish({ kind: "needs-memory", bytes: 64 });
  await setImmediate();
  assert.equal(calls, 2);
  const admitted = inputs.take(output, 0, 0);
  assert.equal(admitted?.kind, "result");
  admitted.release();
});

for (const duringRead of [false, true]) test(`metadata memory admission wakes encoder input (duringRead=${duringRead})`, async () => {
  let available = false, finish, calls = 0;
  const inputs = new EncodeInputs({
    resolve: async () => {
      calls++;
      if (available) return { kind: "result", sources: [source] };
      if (duringRead) return new Promise(resolve => { finish = resolve; });
      return { kind: "needs-memory", bytes: 64 };
    },
    readRanges: async () => [Buffer.from("ab")], reviseBudget: async () => inputs.allow(100),
    changed: () => {}, failed: (_output, error) => { throw error; }
  });
  inputs.take(output, 0, 0);
  await setImmediate();
  available = true;
  inputs.memoryChanged();
  finish?.({ kind: "needs-memory", bytes: 64 });
  await setImmediate();
  assert.equal(calls, 2);
  const admitted = inputs.take(output, 0, 0);
  assert.equal(admitted?.kind, "result");
  admitted.release();
  assert.equal(inputs.held(), 0);
});

for (const urgent of [true, false]) test(`chosen complete input is admitted before speculative whole-file memory (urgent=${urgent})`, async () => {
  const budget = new MachineBudget({ policy: { kind: "fixed", bytes: 100 } });
  budget.defineResource({ name: "memory", readFree: () => 100 });
  const inputs = new EncodeInputs({ resolve: async () => ({ kind: "result", sources: [source] }),
    urgent: () => urgent,
    readRanges: async () => [Buffer.from("ab")], reviseBudget: () => budget.revise(),
    changed: () => {}, failed: (_output, error) => { throw error; } });
  budget.register({ name: "input", resource: "memory", held: () => inputs.held(),
    wanted: () => inputs.wanted(), required: () => inputs.required(), allow: bytes => inputs.allow(bytes) });
  budget.register({ name: "speculative pieces", resource: "memory", held: () => 0,
    wanted: () => 10_000, allow: () => {} });
  inputs.take(output, 0, 0);
  await setImmediate();
  const admitted = inputs.take(output, 0, 0);
  assert.equal(admitted?.kind, "result");
  assert.equal(inputs.required(), 2);
  admitted.release();
  assert.equal(inputs.required(), 0);
});
const source = { sourceKey: "source", fileIndex: 0, input: { ranges: [[0, 1]], tracks: [{
  track: { type: "video", codecId: "vp8", width: 64, height: 64 },
  packets: [{ pts: 0, duration: 1, keyframe: true, ranges: [[0, 1]] }]
}] } };

test("run admission is synchronous and retries missing bytes only after an availability event", async () => {
  let reads = 0, available = false, changed = 0;
  const inputs = new EncodeInputs({ resolve: async () => ({ kind: "result", sources: [source] }),
    readRanges: async () => { reads++; return available ? [Buffer.from("ab")] : null; },
    reviseBudget: async () => inputs.allow(100), changed: () => changed++, failed: error => { throw error; } });
  assert.equal(inputs.take(output, 0, 0), null);
  await setImmediate();
  assert.equal(reads, 1);
  for (let index = 0; index < 10; index++) assert.equal(inputs.take(output, 0, 0), null);
  assert.equal(reads, 1);
  available = true;
  inputs.bytesChanged();
  await setImmediate();
  assert.equal(changed, 1);
  assert.equal(inputs.held(), 2);
  const admitted = inputs.take(output, 0, 0);
  assert.equal(admitted.kind, "result");
  admitted.release();
  assert.equal(inputs.held(), 0);
});

test("withdrawing an output during a read releases the late result without announcing readiness", async () => {
  let settle, changed = 0;
  const inputs = new EncodeInputs({ resolve: async () => ({ kind: "result", sources: [source] }),
    readRanges: () => new Promise(resolve => { settle = resolve; }), reviseBudget: async () => inputs.allow(100),
    changed: () => changed++, failed: error => { throw error; } });
  inputs.take(output, 0, 0);
  await setImmediate();
  assert.equal(inputs.held(), 2);
  inputs.forget(output);
  settle([Buffer.from("ab")]);
  await setImmediate();
  assert.equal(inputs.held(), 0);
  assert.equal(changed, 0);
});

test("an availability event during an unsuccessful read is not lost", async () => {
  let settle, reads = 0;
  const inputs = new EncodeInputs({ resolve: async () => ({ kind: "result", sources: [source] }),
    readRanges: () => ++reads === 1 ? new Promise(resolve => { settle = resolve; }) : Promise.resolve([Buffer.from("ab")]),
    reviseBudget: async () => inputs.allow(100), changed: () => {}, failed: error => { throw error; } });
  inputs.take(output, 0, 0);
  await setImmediate();
  inputs.bytesChanged();
  settle(null);
  await setImmediate();
  assert.equal(reads, 2);
  inputs.forget(output);
  assert.equal(inputs.held(), 0);
});

test("withdrawing segment demand returns a prepared input immediately", async () => {
  const inputs = new EncodeInputs({ resolve: async () => ({ kind: "result", sources: [source] }),
    readRanges: async () => [Buffer.from("ab")], reviseBudget: async () => inputs.allow(100),
    changed: () => {}, failed: error => { throw error; } });
  inputs.take(output, 5, 5);
  await setImmediate();
  assert.equal(inputs.held(), 2);
  inputs.retain(output, [{ from: 0, to: 4 }]);
  assert.equal(inputs.held(), 0);
});

test("an urgent complete input exceeding measured machine capacity is terminal before reading", async () => {
  let reads = 0, announced;
  const inputs = new EncodeInputs({ resolve: async () => ({ kind: "result", sources: [source] }),
    readRanges: async () => { reads++; return [Buffer.from("ab")]; }, reviseBudget: async () => inputs.allow(1),
    capacity: () => 1, changed: (_output, result) => { announced = result; }, failed: error => { throw error; } });
  inputs.take(output, 0, 0);
  await setImmediate();
  assert.equal(reads, 0);
  assert.equal(announced.reason, "source-input-exceeds-memory-capacity");
  assert.equal(inputs.failureOf(output), announced);
  assert.equal(inputs.wanted(), 0);
});

test("nonurgent memory shortage can become a terminal reason when that segment becomes urgent", async () => {
  let urgent = false;
  const inputs = new EncodeInputs({ resolve: async () => ({ kind: "result", sources: [source] }),
    readRanges: async () => assert.fail("Insufficient memory must prevent reads"), reviseBudget: async () => inputs.allow(1),
    capacity: () => 1, urgent: () => urgent, changed: () => {}, failed: error => { throw error; } });
  inputs.take(output, 0, 0);
  await setImmediate();
  assert.equal(inputs.failureOf(output), null);
  urgent = true;
  inputs.retain(output, [{ from: 0, to: 1 }]);
  await setImmediate();
  assert.equal(inputs.failureOf(output).reason, "source-input-exceeds-memory-capacity");
});
