import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { OriginalInputStore } from "../../services/encode/OriginalInputStore.js";
import { admitOriginalInput } from "../../services/encode/OriginalInput.js";
import { EncodeInputs } from "../../services/encode/EncodeInputs.js";
import { handleEncodeInputGet } from "../../routes/encode-input/get.js";

const source = (ranges, commonRanges = [[0, 9]], sourceKey = "generated") => ({ sourceKey, fileIndex: 0,
  input: { original: true, fileLength: 2000, ranges, commonRanges, selections: [] } });
const content = Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 251));
const reader = async (_source, ranges) => ranges.map(([start, end]) => Buffer.from(content.subarray(start, end + 1)));
async function admit(store, candidate, readRanges = reader) {
  const storage = store.acquire([candidate], 10000, { readRanges });
  return admitOriginalInput({ sources: [candidate], storage });
}

test("overlapping live inputs own each byte once and retain exact full input sizes", async () => {
  const store = new OriginalInputStore();
  const first = await admit(store, source([[0, 9], [100, 199]]));
  await first.whole;
  const next = await admit(store, source([[0, 9], [150, 249]]));
  await next.whole;
  assert.equal(first.bytes, 110);
  assert.equal(next.bytes, 110, "disk cache still receives the entire input");
  assert.equal(store.bytes, 160);
  assert.equal(next.copiedBytes, 50);
  assert.equal(next.sharedBytes, 60);
  assert.equal(next.heldUntil(0, 150), 200, "packet learning bounds its portion by a stored part");
  assert.deepEqual(next.read(0, 150, 249).bytes, content.subarray(150, 250), "audio learning can read across part boundaries");
  assert.equal(next.read(0, 90, 110), null, "sharing does not admit a gap");
  first.release();
  assert.equal(store.bytes, 160, "a referenced subrange keeps its complete allocation charged");
  next.release();
  assert.equal(store.bytes, 0);
});

test("packet learning retains the admitted copy after FFmpeg exits", async () => {
  const store = new OriginalInputStore();
  const input = await admit(store, source([[0, 199]], []));
  await input.whole;
  const releaseLearning = input.retain();
  const closed = input.release();
  assert.equal(store.bytes, 200);
  assert.deepEqual(input.read(0, 100, 149).bytes, content.subarray(100, 150));
  releaseLearning();
  releaseLearning();
  await closed;
  assert.equal(store.bytes, 0);
  assert.equal(input.read(0, 100, 149), null);
});

test("pending copies are joined and a withdrawn creator does not invalidate another input", async () => {
  const store = new OriginalInputStore();
  let finish, reads = 0;
  const readRanges = async (s, ranges) => {
    reads++;
    await new Promise(resolve => { finish = resolve; });
    return reader(s, ranges);
  };
  const aSource = source([[100, 199]], []);
  const a = store.acquire([aSource], 100, { readRanges });
  const copyA = a.copy(aSource, aSource.input.ranges);
  await setImmediate();
  const b = store.acquire([aSource], 0, { readRanges });
  const copyB = b.copy(aSource, aSource.input.ranges);
  a.release();
  assert.equal(store.bytes, 100);
  finish();
  assert.equal(await copyA, false);
  assert.equal(await copyB, true);
  assert.equal(reads, 1);
  assert.deepEqual(b.slices(aSource, 100, 199).buffers[0], content.subarray(100, 200));
  b.release();
  assert.equal(store.bytes, 0);
});

test("equal offsets of different sources are never shared", async () => {
  const store = new OriginalInputStore();
  const first = await admit(store, source([[0, 9]], [], "first"));
  const next = await admit(store, source([[0, 9]], [], "other"));
  await Promise.all([first.whole, next.whole]);
  assert.equal(store.bytes, 20);
  assert.equal(next.copiedBytes, 10);
  assert.equal(next.sharedBytes, 0);
  await Promise.all([first.release(), next.release()]);
  assert.equal(store.bytes, 0);
});

test("a common prefix survives a seek without retaining the merged media allocation", async () => {
  const store = new OriginalInputStore();
  const output = {};
  const candidate = source([[0, 199]]);
  store.retain(output, [candidate]);
  const input = await admit(store, candidate);
  await input.whole;
  input.release();
  assert.equal(store.bytes, 10);
  assert.equal(store.required, 0);
  const next = await admit(store, source([[0, 9], [500, 599]]));
  await next.whole;
  assert.equal(next.sharedBytes, 10);
  assert.equal(next.copiedBytes, 100);
  next.release();
  store.trim(0);
  assert.equal(store.bytes, 0);
  store.forget(output);
});

test("an unfinished HTTP answer retains all its parts after both runs release", async () => {
  const store = new OriginalInputStore();
  const first = await admit(store, source([[100, 199]], []));
  await first.whole;
  const next = await admit(store, source([[150, 249]], []));
  await next.whole;
  const answer = next.read(0, 150, 249, true);
  assert.equal(answer.size, 100);
  assert.deepEqual(Buffer.concat(answer.chunks), content.subarray(150, 250));
  first.release();
  next.release();
  assert.equal(store.bytes, 150);
  assert.equal(store.required, 150);
  store.trim(0);
  assert.equal(store.bytes, 150);
  answer.release();
  answer.release();
  assert.equal(store.bytes, 0);
});

test("a response closed during its deferred copy releases the subsequently acquired HTTP reference", async () => {
  const store = new OriginalInputStore();
  let finish;
  const input = await admit(store, source([[0, 9], [100, 199]], []), async (s, ranges) => {
    if (ranges.some(([start]) => start === 100)) await new Promise(resolve => { finish = resolve; });
    return reader(s, ranges);
  });
  const raw = new EventEmitter();
  raw.destroyed = false;
  const reply = { raw, code() { return this; }, header() { return this; }, send() { throw new Error("Closed response must not be sent."); } };
  const pending = handleEncodeInputGet({ raw: { socket: { remoteAddress: "127.0.0.1" } }, method: "GET",
    params: { token: "1", fileIndex: "0" }, headers: { range: "bytes=100-" } }, reply, { inputOf: () => input });
  await setImmediate();
  raw.destroyed = true;
  raw.emit("close");
  finish();
  assert.equal(await pending, reply);
  await input.release();
  assert.equal(store.bytes, 0);
});

test("missing and malformed reads release reservations and can be retried", async () => {
  const store = new OriginalInputStore();
  const candidate = source([[100, 199]], []);
  assert.equal((await admit(store, candidate, async () => null)).kind, "needs-bytes");
  assert.equal(store.bytes, 0);
  await assert.rejects(admit(store, candidate, async () => [Buffer.alloc(1)]), /incomplete/);
  assert.equal(store.bytes, 0);
  const input = await admit(store, candidate);
  assert.equal(await input.whole, true);
  input.release();
  assert.equal(store.bytes, 0);
});

test("budget admission and copy-rate learning distinguish shared memory from full input bytes", async () => {
  let clock = 0;
  const output = { outputKey: "picture" };
  const inputs = new EncodeInputs({
    resolve: async (_output, from, to) => ({ kind: "result", sources: [source([[0, 9], [100 + from * 10, 119 + to * 10]])] }),
    heldRanges: async () => [[0, 1999]],
    readRanges: async (s, ranges) => { const buffers = await reader(s, ranges); clock += buffers.reduce((sum, b) => sum + b.length, 0); return buffers; },
    now: () => clock, openOf: () => ({ seconds: 0.01, measured: true }), capacity: () => 1000,
    reviseBudget: async () => inputs.allow(inputs.required()), changed: () => {}, failed: (_output, error) => { throw error; }
  });
  const first = await inputs.acquire(output, 0, 0);
  await first.whole;
  first.release();
  assert.equal(inputs.held(), 10);
  assert.equal(inputs.required(), 0);
  const next = await inputs.acquire(output, 1, 1);
  assert.ok(next);
  await next.whole;
  assert.equal(next.bytes, 30);
  assert.equal(next.copiedBytes, 20);
  assert.equal(next.sharedBytes, 10);
  assert.equal(inputs.stretchTerms().copyBytesPerMs, 1, "ready bytes must not inflate the learned copy rate");
  next.release();
  inputs.forget(output);
  assert.equal(inputs.held(), 0);
});
