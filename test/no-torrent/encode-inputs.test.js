import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { EncodeInputs } from "../../services/encode/EncodeInputs.js";
import { MachineBudget } from "../../services/storage/MachineBudget.js";
import { matroskaIdOf } from "./support/codec-lookup.js";

const output = { id: "output" };

test("container reads carry the output demand into source metadata", async () => {
  let readPriority;
  const inputs = new EncodeInputs({ matroskaIdOf,
    resolve: async (_output, _from, _to, _timing, _isCurrent, _signal, priority) => {
      readPriority = priority;
      return { kind: "needs-bytes", ranges: [[0, 9]] };
    },
    rankAt: () => ({ rank: 95, topRank: 100, urgent: false, deadlineAt: 17_000 }),
    readRanges: async () => null, reviseBudget: async () => {}, changed: () => {}, failed: (_output, error) => { throw error; }
  });
  inputs.take(output, 4, 8, 4);
  await setImmediate();
  assert.deepEqual({ rank: readPriority.rank, topRank: readPriority.topRank, urgent: readPriority.urgent,
    deadlineAt: readPriority.deadlineAt, serves: readPriority.serves },
  { rank: 95, topRank: 100, urgent: false, deadlineAt: 17_000, serves: 4 });
  assert.match(readPriority.requestId, /^encode:/);
  inputs.forget(output);
});

test("input allowance changing before a pending memory refusal is returned is not lost", async () => {
  let finish, calls = 0;
  const inputs = new EncodeInputs({ matroskaIdOf,
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
  const inputs = new EncodeInputs({ matroskaIdOf,
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
  const inputs = new EncodeInputs({ matroskaIdOf, resolve: async () => ({ kind: "result", sources: [source] }),
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
  const inputs = new EncodeInputs({ matroskaIdOf, resolve: async () => ({ kind: "result", sources: [source] }),
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
  const inputs = new EncodeInputs({ matroskaIdOf, resolve: async () => ({ kind: "result", sources: [source] }),
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

test("withdrawing a pending input aborts its resolver", async () => {
  let signal, finished;
  const inputs = new EncodeInputs({ matroskaIdOf,
    resolve: (_output, _from, _to, _timing, _isCurrent, requestSignal) => {
      signal = requestSignal;
      return new Promise(resolve => { finished = resolve; });
    },
    readRanges: async () => [Buffer.from("ab")], reviseBudget: async () => {},
    changed: () => {}, failed: (_output, error) => { throw error; }
  });
  inputs.take(output, 0, 0);
  await setImmediate();
  assert.equal(signal.aborted, false);
  inputs.retain(output, []);
  assert.equal(signal.aborted, true);
  finished({ kind: "terminal", reason: "request-obsolete" });
  await setImmediate();
});

test("an availability event during an unsuccessful read is not lost", async () => {
  let settle, reads = 0;
  const inputs = new EncodeInputs({ matroskaIdOf, resolve: async () => ({ kind: "result", sources: [source] }),
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
  const inputs = new EncodeInputs({ matroskaIdOf, resolve: async () => ({ kind: "result", sources: [source] }),
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
  const inputs = new EncodeInputs({ matroskaIdOf, resolve: async () => ({ kind: "result", sources: [source] }),
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
  const inputs = new EncodeInputs({ matroskaIdOf, resolve: async () => ({ kind: "result", sources: [source] }),
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

test("an input's state names the piece it is prepared for and that piece's rank, not its own first piece", async () => {
  const lines = [];
  const asked = [];
  const inputs = new EncodeInputs({ matroskaIdOf,
    resolve: async () => ({ kind: "needs-bytes" }),
    readRanges: async () => null, reviseBudget: async () => {},
    rankAt: (_output, index) => { asked.push(index); return { rank: 2, topRank: 3 }; },
    log: line => lines.push(line),
    changed: () => {}, failed: (_output, error) => { throw error; }
  });
  // Read from the keyframe before: the input starts at #4 for the run at #5.
  inputs.take(output, 4, 9, 5);
  await setImmediate();
  assert.deepEqual(asked, [5]);
  assert.match(lines.at(-1), /encode input #4\.\.#9 of output: needs-bytes \(held 0 of 0 allowed; for #5, rank 2 of 3\)/);
});

test("input preparation logs one P8 span across missing-byte retries", async () => {
  const events = [];
  const tracedOutput = { ...output, file: { sourceKey: "source" }, spec: { carries: "picture" } };
  let calls = 0;
  const inputs = new EncodeInputs({ matroskaIdOf,
    resolve: async () => ++calls === 1 ? { kind: "needs-bytes" } : { kind: "result", sources: [source] },
    readRanges: async () => [Buffer.from("ab")],
    reviseBudget: async () => inputs.allow(100),
    changed: () => {}, failed: (_output, error) => { throw error; },
    observeWait: (sourceKey, event, fields) => events.push({ sourceKey, event, ...fields })
  });
  inputs.take(tracedOutput, 0, 0);
  await setImmediate();
  assert.ok(events.some(event => event.process === "P8.v" && event.phase === "waiting" && event.reason === "needs-bytes"));
  inputs.bytesChanged();
  await setImmediate();
  const admitted = inputs.take(tracedOutput, 0, 0);
  assert.equal(admitted?.kind, "result");
  const span = events.filter(event => event.process === "P8.v");
  assert.equal(span[0].phase, "begin");
  assert.equal(span.at(-1).phase, "end");
  assert.equal(span.filter(event => event.phase === "begin").length, 1);
  admitted.release();
});

// AN INPUT HOLDS THE PIECE IT IS TAKEN FOR (torrent-tv/meta#341). An original
// file whose segment k is the ten bytes at 10k, and whose header and index are
// ten bytes at 5000 that every stretch needs once. Nothing measured, so a
// stretch is the least that makes the piece it serves.
const STRETCH_HEADER = [5000, 5009];
const stretchOf = (from, to) => ({ kind: "result", sources: [{ sourceKey: "film", fileIndex: 0, timeShiftSeconds: 0,
  input: { original: true, from, fileLength: 6000, ranges: [[from * 10, to * 10 + 9], STRETCH_HEADER],
    selections: [{ track: { type: "video" }, index: 0 }] } }] });
const picture = { outputKey: "picture" };

/** EncodeInputs over that file; `resolveStretch` answers each interval it is asked to state. */
function originalInputs({ resolveStretch = stretchOf } = {}) {
  const lines = [], announced = [], resolved = [];
  const inputs = new EncodeInputs({ matroskaIdOf,
    resolve: async (_output, from, to) => { resolved.push([from, to]); return resolveStretch(from, to); },
    heldRanges: async () => [[0, 4999], STRETCH_HEADER],
    readRanges: async (_source, ranges) => ranges.map(([start, end]) => Buffer.alloc(end - start + 1)),
    reviseBudget: async () => inputs.allow(100_000),
    changed: (_output, result) => announced.push(result), failed: (_output, error) => { throw error; },
    log: line => lines.push(line)
  });
  return { inputs, lines, announced, resolved };
}

const turns = async (count = 8) => { for (let turn = 0; turn < count; turn++) await setImmediate(); };

/** The field case: the input keyed at #187 is ready with #187..#187, prepared for #187. */
async function heldForThePieceBefore(inputs) {
  assert.equal(inputs.take(picture, 187, 263, 187), null, "preparation is never synchronous");
  await turns();
}

test("a stretch held for the piece before is not handed out for the next piece", { todo: "AC-1" }, async () => {
  const { inputs } = originalInputs();
  await heldForThePieceBefore(inputs);
  const taken = inputs.take(picture, 187, 263, 188);
  assert.equal(taken, null, `handed out #${taken?.from}..#${taken?.to} for #188`);
  inputs.forget(picture);
});

test("a held stretch that misses the piece is released", { todo: "AC-1" }, async () => {
  const { inputs, announced } = originalInputs();
  await heldForThePieceBefore(inputs);
  const held = announced.find(result => result.kind === "result");
  assert.deepEqual([held.from, held.to], [187, 187]);
  let released = 0;
  const release = held.release.bind(held);
  held.release = () => { released += 1; release(); };
  inputs.take(picture, 187, 263, 188);
  assert.equal(released, 1);
  inputs.forget(picture);
});

test("a held stretch that misses the piece is prepared again at once and then reaches it", { todo: "AC-1" }, async () => {
  const { inputs } = originalInputs();
  await heldForThePieceBefore(inputs);
  const first = inputs.take(picture, 187, 263, 188);
  first?.release();
  // No bytes arrive and no memory changes: the take itself prepares it again.
  await turns();
  const ready = inputs.take(picture, 187, 263, 188);
  assert.ok(ready?.kind === "result" && ready.from === 187 && ready.to >= 188,
    `the ready stretch is ${ready ? `#${ready.from}..#${ready.to}` : "none"}, not one from #187 reaching #188`);
  ready.release();
});

test("a held stretch that misses the piece says so once", { todo: "AC-1" }, async () => {
  const { inputs, lines } = originalInputs();
  await heldForThePieceBefore(inputs);
  inputs.take(picture, 187, 263, 188)?.release();
  inputs.take(picture, 187, 263, 188)?.release();
  await turns();
  const said = lines.filter(line => line === "encode input #187..#263 of picture: the held stretch #187..#187 " +
    "does not reach #188, the piece it is now taken for; prepared again");
  assert.equal(said.length, 1);
  inputs.forget(picture);
});

test("a held stretch that ends at the piece it is taken for is handed out without another preparation", async () => {
  const { inputs, announced, resolved } = originalInputs();
  assert.equal(inputs.take(picture, 187, 263, 188), null);
  await turns();
  const asked = resolved.length;
  const taken = inputs.take(picture, 187, 263, 188);
  assert.equal(taken, announced.find(result => result.kind === "result"));
  assert.deepEqual([taken.from, taken.to], [187, 188]);
  assert.equal(resolved.length, asked, "nothing was prepared again");
  taken.release();
});

/** A file whose stretch from #187 through #188 cannot be stated until the bytes of #188 arrive. */
function waitingForThePiece() {
  const state = { arrived: false };
  const made = originalInputs({ resolveStretch: (from, to) => to >= 188 && !state.arrived
    ? { kind: "needs-bytes", sourceKey: "film", fileIndex: 0, ranges: [[1880, 1889]] } : stretchOf(from, to) });
  return { ...made, state };
}

test("a stretch is not answered as the piece before while the stretch through its piece cannot be stated", { todo: "AC-2" }, async () => {
  const { inputs, announced } = waitingForThePiece();
  assert.equal(inputs.take(picture, 187, 263, 188), null);
  await turns();
  const short = announced.filter(result => result.kind === "result" && result.to < 188);
  assert.deepEqual(short.map(result => `#${result.from}..#${result.to}`), []);
  inputs.forget(picture);
});

test("a stretch whose piece cannot be stated yet waits as its resolution answered", { todo: "AC-2" }, async () => {
  const { inputs, lines } = waitingForThePiece();
  inputs.take(picture, 187, 263, 188);
  await turns();
  const waits = lines.filter(line => /^encode input #187\.\.#263 of picture: needs-bytes /.test(line));
  assert.equal(waits.length, 1, `its lines were:\n${lines.join("\n")}`);
  inputs.forget(picture);
});

test("bytes the resolution waited for prepare the stretch through its piece", { todo: "AC-2" }, async () => {
  const { inputs, state } = waitingForThePiece();
  inputs.take(picture, 187, 263, 188);
  await turns();
  state.arrived = true;
  inputs.bytesChanged({ sourceKey: "film", ranges: [{ fileIndex: 0, start: 1880, end: 1889 }] });
  await turns();
  const ready = inputs.take(picture, 187, 263, 188);
  assert.ok(ready?.kind === "result" && ready.from === 187 && ready.to >= 188,
    `the ready stretch is ${ready ? `#${ready.from}..#${ready.to}` : "none"}, not one from #187 reaching #188`);
  ready.release();
});

test("a terminal resolution of the stretch through its piece is the request's answer", { todo: "AC-2" }, async () => {
  const { inputs } = originalInputs({ resolveStretch: (from, to) => to >= 188
    ? { kind: "terminal", reason: "damaged-track", message: "the piece cannot be read" } : stretchOf(from, to) });
  inputs.take(picture, 187, 263, 188);
  await turns();
  assert.equal(inputs.failureOf(picture)?.reason, "damaged-track");
  inputs.forget(picture);
});
