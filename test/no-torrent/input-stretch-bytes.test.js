import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { EncodeInputs } from "../../services/encode/EncodeInputs.js";

// A named stretch size replaces copy rate times open and nothing else: memory,
// downloaded bytes and the plan's bound still end a stretch (torrent-tv/meta#182).

const output = { outputKey: "picture" };

// Piece i is bytes [i*10, i*10+9]; every input also holds [1000, 1009].
function prepare({ stretchBytes, allowance = 10_000, presentEnd = 999 } = {}) {
  const lines = [];
  const inputs = new EncodeInputs({
    resolve: async (_output, from, to) => ({ kind: "result", sources: [{ sourceKey: "generated", fileIndex: 0,
      input: { original: true, fileLength: 2000, ranges: [[from * 10, to * 10 + 9], [1000, 1009]], selections: [] } }] }),
    heldRanges: async () => [[0, presentEnd], [1000, 1009]],
    readRanges: async (_source, ranges) => ranges.map(([from, to]) => Buffer.alloc(to - from + 1)),
    reviseBudget: async () => inputs.allow(allowance),
    capacity: () => 20_000, log: line => lines.push(line), stretchBytes,
    changed: () => {}, failed: (_output, error) => { throw error; }
  });
  return { inputs, selection: () => lines.filter(line => line.startsWith("encode input selection of picture: "))
    .map(line => JSON.parse(line.slice(line.indexOf(": ") + 2))).at(-1) };
}

async function take(inputs, from, to) {
  assert.equal(inputs.take(output, from, to), null);
  for (let turn = 0; turn < 8; turn++) await setImmediate();
  const input = inputs.take(output, from, to);
  assert.equal(input?.kind, "result");
  await input.whole;
  return input;
}

test("a named stretch size is the target with no copy rate or open measured", async () => {
  const state = prepare({ stretchBytes: 100 });
  assert.deepEqual(state.inputs.stretchFor(output), { bytes: 100, openMeasured: true });
  assert.equal(state.inputs.targetInputBytes(output), 100);
  const input = await take(state.inputs, 0, 50);
  assert.equal(input.to, 8);
  assert.equal(input.bytes, 100);
  const selection = state.selection();
  assert.equal(selection.targetBytes, 100);
  assert.equal(selection.targetFixed, true);
  assert.equal(selection.chosenEnd, 8);
  input.release();
});

test("a named stretch size is still cut by the memory allowance", async () => {
  const state = prepare({ stretchBytes: 100, allowance: 50 });
  const input = await take(state.inputs, 0, 50);
  assert.equal(input.to, 3);
  assert.equal(input.bytes, 50);
  input.release();
  assert.equal(state.inputs.held(), 0);
});

test("a named stretch size is still cut by bytes not downloaded and by the plan's bound", async () => {
  const missing = prepare({ stretchBytes: 100, presentEnd: 39 });
  const short = await take(missing.inputs, 0, 50);
  assert.equal(short.to, 3);
  short.release();
  const bounded = prepare({ stretchBytes: 100 });
  const planned = await take(bounded.inputs, 0, 2);
  assert.equal(planned.to, 2);
  planned.release();
});

test("no named size keeps the measured rule", () => {
  for (const stretchBytes of [undefined, null, 0, -5, 1.5]) {
    assert.equal(prepare({ stretchBytes }).inputs.stretchFor(output), null);
  }
});
