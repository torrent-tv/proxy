import assert from "node:assert/strict";
import test from "node:test";
import { IndexMemory } from "../../services/storage/IndexMemory.js";
import { PacketRecords } from "../../services/media/container/PacketRecords.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";
import { divideAllowance } from "../../services/storage/allowance.js";
import { MachineBudget } from "../../services/storage/MachineBudget.js";
import { ContainerOrchestrator } from "../../services/media/ContainerOrchestrator.js";
import { MediaReadRequests } from "../../services/media/MediaReadRequests.js";
import { RetainedBytes } from "../../services/media/container/RetainedBytes.js";
import { RetainedReads } from "../../services/media/container/RetainedReads.js";

test("retained declaration ranges share reads and reserve memory before each range", async () => {
  const memory = new IndexMemory({ reviseBudget() {}, changed() {} });
  const ranges = new RetainedReads(memory.forFile("source", 0));
  let reads = 0;
  const read = (start, end) => { reads++; return Buffer.alloc(end - start + 1); };
  await assert.rejects(ranges.read(10, 19, read), IndexMemoryUnavailable);
  assert.equal(reads, 0);
  memory.allow(10);
  const [first, second] = await Promise.all([ranges.read(10, 19, read), ranges.read(10, 19, read)]);
  assert.equal(first, second);
  assert.equal(first.buffer.byteLength, first.length);
  assert.equal(reads, 1);
  await assert.rejects(ranges.read(20, 29, read), IndexMemoryUnavailable);
  assert.equal(memory.held(), 10);
  memory.allow(20);
  await assert.rejects(ranges.read(20, 29, () => null), /incomplete/);
  assert.equal(memory.held(), 10);
  await ranges.read(20, 29, read);
  assert.equal(memory.held(), 20);
  assert.equal(memory.packetBytes(), 0);
  memory.forget("source");
  assert.equal(memory.held(), 0);
  await assert.rejects(ranges.read(10, 19, read), /forgotten/);
});

test("source retirement releases in-flight declaration ranges exactly once", async () => {
  const memory = new IndexMemory({ reviseBudget() {}, changed() {} });
  memory.allow(10);
  const ranges = new RetainedReads(memory.forFile("source", 0));
  let finish;
  const pending = ranges.read(0, 9, () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  memory.forget("source");
  finish(Buffer.alloc(10));
  await assert.rejects(pending, /forgotten/);
  assert.equal(memory.held(), 0);
});

test("retained metadata bytes reserve before reading and release on absence or source retirement", async () => {
  const memory = new IndexMemory({ reviseBudget() {}, changed() {} });
  const allocation = new RetainedBytes(memory.forFile("source", 0));
  let reads = 0;
  const read = () => { reads++; return Buffer.alloc(32); };
  await assert.rejects(allocation.read(32, read), IndexMemoryUnavailable);
  assert.equal(reads, 0);
  memory.allow(32);
  await assert.rejects(allocation.read(32, () => { throw new Error("Missing bytes"); }), /Missing bytes/);
  assert.equal(memory.held(), 0);
  await allocation.read(32, read);
  assert.equal(memory.held(), 32);
  assert.equal(memory.packetBytes(), 0);
  memory.forget("source");
  assert.equal(memory.held(), 0);
  await assert.rejects(allocation.read(32, read), /no longer available/);
});

test("retiring a source during its metadata read cannot retain its result or release memory twice", async () => {
  const memory = new IndexMemory({ reviseBudget() {}, changed() {} });
  memory.allow(32);
  const allocation = new RetainedBytes(memory.forFile("source", 0));
  let complete;
  const pending = allocation.read(32, () => new Promise(resolve => { complete = resolve; }));
  memory.forget("source");
  complete(Buffer.alloc(32));
  await assert.rejects(pending, /forgotten/);
  assert.equal(memory.held(), 0);
});

test("a pending media read resumes through the shared budget after held encode input is released", async () => {
  const reader = new ContainerOrchestrator();
  const budget = new MachineBudget({ policy: { kind: "fixed", bytes: 131072 } });
  budget.defineResource({ name: "memory", readFree: async () => 1024 * 1024 });
  const requests = new MediaReadRequests({ read: params => reader.inspect(params, "packets") });
  const memory = new IndexMemory({ reviseBudget: () => { void budget.revise(); }, changed: () => requests.memoryChanged() });
  budget.register({ name: "indexes", resource: "memory", held: () => memory.held(), wanted: () => memory.wanted(),
    required: () => memory.required(), allow: bytes => memory.allow(bytes) });
  let inputHeld = 131072;
  budget.register({ name: "encode input", resource: "memory", held: () => inputHeld, wanted: () => inputHeld,
    required: () => inputHeld, allow() {} });
  const records = new PacketRecords(memory.forFile("source", 0));
  reader.cache.set("source:0", { readPacketIndex: async () => {
    if (!records.length) records.push({ pts: 0, duration: 1, ranges: [[0, 0]] });
    return records;
  } });
  let complete;
  const completed = new Promise(resolve => { complete = resolve; });
  const params = { sourceKey: "source", fileIndex: 0,
    onReadStart: () => requests.memoryRevision(),
    onReadResult: (statement, result, revision) => {
      requests.record(params, statement, result, 0, revision);
      if (result.kind === "result") complete(result);
    } };
  assert.equal((await reader.inspect(params, "packets")).kind, "needs-memory");
  await budget.revise();
  assert.equal(memory.held(), 0, "an index cannot take bytes still held by an encoder");
  inputHeld = 0;
  await budget.revise();
  assert.equal((await completed).value.length, 1);
  assert.equal(memory.held(), 131072);
  requests.forget("source");
  memory.forget("source");
  assert.equal(memory.held(), 0);
});

test("index ownership reserves actual blocks and failed reconstruction retains its measured need", async () => {
  let revisions = 0, changes = 0;
  const memory = new IndexMemory({ reviseBudget: () => { revisions++; }, changed: () => { changes++; } });
  const records = new PacketRecords(memory.forFile("source", 0));
  const packet = { pts: 0, duration: 1, ranges: [[0, 0]] };
  assert.throws(() => records.push(packet), IndexMemoryUnavailable);
  assert.equal(memory.held(), 0);
  assert.equal(memory.wanted(), 131072);
  await Promise.resolve();
  assert.equal(revisions, 1);
  memory.allow(131072);
  for (let index = 0; index < Math.floor(65536 / 72); index++) records.push(packet);
  assert.equal(memory.held(), records.allocatedBytes);
  assert.throws(() => records.push(packet), IndexMemoryUnavailable);
  assert.equal(memory.wanted(), 196608);
  records.dispose();
  assert.equal(memory.held(), 0);
  assert.equal(memory.wanted(), 196608);
  memory.forget("source");
  assert.equal(memory.wanted(), 0);
  assert.ok(changes > 0);
  assert.throws(() => records.push(packet), /released/);
});

test("an indivisible index allocation cannot be starved by a large piece-cache request", () => {
  const shares = divideAllowance([131072, 2 ** 40], 2 ** 30, [131072, 0]);
  assert.equal(shares[0], 131072);
  assert.equal(shares.reduce((sum, value) => sum + value, 0), 2 ** 30);
  assert.deepEqual(divideAllowance([100, 100], 100, [100, 100]), [50, 50]);
  assert.deepEqual(divideAllowance([100, 100], 300, [100, 0]), [100, 100]);
});
