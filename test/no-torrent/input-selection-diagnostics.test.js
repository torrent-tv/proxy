import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { EncodeInputs } from "../../services/encode/EncodeInputs.js";

const output = { outputKey: "picture" };

function prepare({ allowance = 10_000, presentEnd = 999 } = {}) {
  const resolutions = [], reads = [], lines = [];
  let clock = 0, heldReads = 0, open = null;
  const inputs = new EncodeInputs({
    resolve: async (_output, from, to) => {
      resolutions.push([from, to]);
      return { kind: "result", sources: [{ sourceKey: "generated", fileIndex: 0,
        input: { original: true, fileLength: 2000, ranges: [[from * 10, to * 10 + 9], [1000, 1009]], selections: [] } }] };
    },
    heldRanges: async () => { heldReads++; return [[0, presentEnd], [1000, 1009]]; },
    readRanges: async (_source, ranges) => {
      reads.push(ranges);
      return ranges.map(([from, to]) => { clock += to - from + 1; return Buffer.alloc(to - from + 1); });
    },
    openOf: () => open,
    reviseBudget: async () => inputs.allow(allowance),
    capacity: () => 20_000, now: () => clock, log: line => lines.push(line),
    changed: () => {}, failed: (_output, error) => { throw error; }
  });
  return { inputs, resolutions, reads, heldReads: () => heldReads,
    measured: () => { open = { seconds: 0.1, measured: true }; },
    selections: () => lines.filter(line => line.startsWith("encode input selection of picture: "))
      .map(line => JSON.parse(line.slice(line.indexOf(": ") + 2))) };
}

async function take(inputs, from, to) {
  assert.equal(inputs.take(output, from, to), null);
  for (let turn = 0; turn < 8; turn++) await setImmediate();
  const input = inputs.take(output, from, to);
  assert.equal(input?.kind, "result");
  await input.whole;
  return input;
}

test("selection reports unknown cold sizing without resolving another interval", async () => {
  const state = prepare();
  const input = await take(state.inputs, 0, 50);
  const [selection] = state.selections();
  assert.equal(selection.targetBytes, null);
  assert.equal(selection.copyBytesPerMs, null);
  assert.equal(selection.openSeconds, null);
  assert.equal(selection.inputBytes, input.bytes);
  assert.deepEqual(selection.probes, []);
  assert.deepEqual(state.resolutions, [[0, 0]]);
  assert.equal(state.reads.length, 2);
  assert.equal(state.heldReads(), 1);
  input.release();
});

test("selection separates target and memory narrowing without additional reads", async () => {
  const state = prepare({ allowance: 50 });
  (await take(state.inputs, 0, 0)).release();
  state.measured();
  state.resolutions.length = 0;
  const readsBefore = state.reads.length, heldBefore = state.heldReads();
  const input = await take(state.inputs, 1, 50);
  const selection = state.selections().at(-1);
  assert.deepEqual(state.inputs.stretchFor(output), { bytes: 100, openMeasured: true });
  assert.equal(selection.targetBytes, 100);
  assert.equal(selection.copyBytesPerMs, 1);
  assert.equal(selection.openSeconds, 0.1);
  assert.equal(selection.minimumBytes, 20);
  assert.equal(selection.targetEnd, 9);
  assert.equal(selection.chosenEnd, 4);
  assert.equal(selection.inputBytes, 50);
  assert.equal(input.bytes, 50, "total input/cache-disk bytes keep their meaning");
  assert.deepEqual(selection.reservations, [{ bytes: 50, allowed: 50, held: 0, capacity: 20_000, room: 50, end: 4, admitted: true }]);
  assert.deepEqual(state.resolutions, [[1, 1], [1, 2], [1, 4], [1, 8], [1, 16], [1, 12], [1, 10], [1, 9], [1, 6], [1, 5]]);
  assert.equal(state.reads.length - readsBefore, 2);
  assert.equal(state.heldReads() - heldBefore, 1);
  assert.ok(selection.probes.some(probe => probe.limitBytes === 100 && probe.result === "size"));
  assert.ok(selection.probes.some(probe => probe.limitBytes === 50 && probe.result === "size"));
  input.release();
  assert.equal(state.inputs.held(), 0);
});

test("selection records missing bytes from the existing availability check", async () => {
  const state = prepare({ presentEnd: 39 });
  (await take(state.inputs, 0, 0)).release();
  state.measured();
  state.resolutions.length = 0;
  const readsBefore = state.reads.length, heldBefore = state.heldReads();
  const input = await take(state.inputs, 1, 50);
  const selection = state.selections().at(-1);
  assert.equal(selection.targetBytes, 100);
  assert.equal(selection.targetEnd, 3);
  assert.equal(selection.chosenEnd, 3);
  assert.deepEqual(selection.probes.map(probe => probe.result), ["fits", "missing-bytes", "fits"]);
  assert.deepEqual(state.resolutions, [[1, 1], [1, 2], [1, 4], [1, 3]]);
  assert.equal(state.reads.length - readsBefore, 2);
  assert.equal(state.heldReads() - heldBefore, 1);
  input.release();
});
