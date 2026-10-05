import test from "node:test";
import assert from "node:assert/strict";
import { ContainerOrchestrator } from "../../services/media/ContainerOrchestrator.js";
import { BytesUnavailable } from "../../services/media/container/unavailable.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";
import { MediaReadRequests } from "../../services/media/MediaReadRequests.js";

const params = { sourceKey: "source", fileIndex: 0, requestId: "request", fileSize: 100 };

test("a completed statement callback can read another statement from the same file", async () => {
  const reader = new ContainerOrchestrator();
  reader.containerFor = async () => ({ readTracks: async () => [], readMediaInfo: async () => ({ durationSeconds: 7 }) });
  let media;
  const result = await reader.inspect({ ...params, onReadResult: async () => {
    media = await reader.inspect(params, "media-info");
  } }, "tracks");
  assert.equal(result.kind, "result");
  assert.equal(media.value.durationSeconds, 7);
});

test("index memory shortage remains pending and never establishes missing keyframes", async () => {
  const reader = new ContainerOrchestrator();
  reader.containerFor = async () => ({ readKeyframeIndex: () => { throw new IndexMemoryUnavailable(65536); } });
  assert.deepEqual(await reader.inspect(params, "keyframes"), { kind: "needs-memory", bytes: 65536, requestId: "request" });
  await assert.rejects(reader.getKeyframeIndex(params), IndexMemoryUnavailable);
});

test("resource changes retry only statements waiting for that resource", async () => {
  const read = [];
  const pending = new MediaReadRequests({ read: async (_, statement) => { read.push(statement); } });
  pending.record(params, "packets", { kind: "needs-memory", bytes: 65536 });
  pending.record(params, "tracks", { kind: "needs-ranges", ranges: [[0, 15]] });
  pending.bytesChanged("source", 0);
  await Promise.resolve();
  assert.deepEqual(read, ["tracks"]);
  pending.memoryChanged();
  await Promise.resolve();
  assert.deepEqual(read, ["tracks", "packets"]);
  pending.forget("source");
  pending.memoryChanged();
  await Promise.resolve();
  assert.equal(read.length, 2);
});

test("memory becoming available during a read cannot leave its pending statement asleep", async () => {
  let reads = 0;
  const pending = new MediaReadRequests({ read: async () => { reads++; } });
  const revision = pending.memoryRevision();
  pending.memoryChanged();
  pending.record(params, "packets", { kind: "needs-memory", bytes: 65536 }, 0, revision);
  await Promise.resolve();
  assert.equal(reads, 1);
});

test("a resource change during a read does not retry a different unchanged resource", async () => {
  for (const initial of ["needs-memory", "needs-ranges"]) {
    let reads = 0;
    const notifications = [];
    const next = initial === "needs-memory" ? "needs-ranges" : "needs-memory";
    const pending = new MediaReadRequests({ read: async () => {
      reads++;
      const bytes = pending.revision("source", 0), memory = pending.memoryRevision();
      if (initial === "needs-memory") pending.memoryChanged();
      else pending.bytesChanged("source", 0);
      pending.record(params, "packets", { kind: next }, bytes, memory);
    } });
    pending.subscribe("source", 0, result => notifications.push(result.kind));
    pending.record(params, "packets", { kind: initial });
    if (initial === "needs-memory") pending.memoryChanged();
    else pending.bytesChanged("source", 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1, "the next read waits for the resource it actually lacks");
    if (initial === "needs-memory") assert.deepEqual(notifications, [], "memory retries cannot wake an unrelated source wait");
    pending.forget("source");
  }
});

test("packet-storage accounting counts one shared container and releases forgotten sources", () => {
  const reader = new ContainerOrchestrator();
  const container = { packetIndexBytes: () => 65536 };
  reader.cache.set("source:0", container);
  reader.cache.set("source:1", container);
  reader.cache.set("other:0", { packetIndexBytes: () => 131072 });
  assert.equal(reader.packetIndexBytes(), 196608);
  reader.forget("source");
  assert.equal(reader.packetIndexBytes(), 131072);
});

test("forgetting media cancels queued statements and a late track table cannot restore facts", async () => {
  const reader = new ContainerOrchestrator();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  reader.containerFor = async () => ({ readTracks: async () => { entered(); return pending; },
    readMediaInfo: () => assert.fail("a withdrawn queued statement must not read") });
  const first = reader.inspect(params, "tracks");
  const second = reader.inspect(params, "media-info");
  await started;
  reader.forget("source", 0);
  release([{ type: "video" }]);
  assert.equal((await first).reason, "request-obsolete");
  assert.equal((await second).reason, "request-obsolete");
  assert.equal(reader.tracks.size, 0);
});

test("a withdrawn format discovery cannot replace or clear a newer discovery", async () => {
  const reader = new ContainerOrchestrator();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const first = reader.containerFor({ ...params, readRange: async () => { entered(); return held; } });
  await started;
  reader.forget("source", 0);
  const current = await reader.containerFor({ ...params, readRange: async () => Buffer.alloc(16) });
  release(Buffer.alloc(16));
  await assert.rejects(first, /withdrawn/);
  assert.equal(reader.known("source", 0), current);
});

test("concurrent statements on one source serialize progressive parser state", async () => {
  const reader = new ContainerOrchestrator();
  let active = 0, maximum = 0;
  const read = async value => {
    active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return value;
  };
  reader.containerFor = async () => ({ readTracks: () => read([]), readMediaInfo: () => read({ durationSeconds: 2 }) });
  const results = await Promise.all([reader.inspect(params, "tracks"), reader.inspect(params, "media-info")]);
  assert.equal(maximum, 1);
  assert.ok(results.every(result => result.kind === "result"));
});

test("consumer callback failures are not classified as damaged source media", async () => {
  const reader = new ContainerOrchestrator();
  reader.containerFor = async () => ({ readTracks: async () => [] });
  await assert.rejects(reader.inspect({ ...params, onReadResult: () => { throw new Error("Publication failed."); } }), /Publication failed/);
  assert.equal((await reader.inspect(params)).kind, "result");
});

test("container discovery publishes missing-byte demand and callback errors remain external", async () => {
  const reader = new ContainerOrchestrator();
  reader.containerFor = async () => { throw new BytesUnavailable(0, 15, 0); };
  const results = [];
  assert.equal(await reader.getContainer({ ...params, onReadResult: (statement, result) => results.push({ statement, result }) }), null);
  assert.equal(results[0].statement, "container");
  assert.deepEqual(results[0].result.ranges, [[0, 15]]);
  await assert.rejects(reader.getContainer({ ...params, onNeedsRanges: () => { throw new Error("Demand publication failed."); } }), /Demand publication failed/);
});

test("missing metadata names its required bytes and remains readable on the next pass", async () => {
  const reader = new ContainerOrchestrator();
  let available = false;
  reader.containerFor = async () => ({ readTracks: async () => {
    if (!available) throw new BytesUnavailable(30, 49, 0);
    return [{ type: "video" }];
  } });
  let needed;
  const before = await reader.inspect({ ...params, onNeedsRanges: result => { needed = result; } });
  assert.deepEqual(before, { kind: "needs-ranges", ranges: [[30, 49]], requestId: "request" });
  assert.equal(needed, before);
  assert.equal(reader.tracks.size, 0);
  available = true;
  const after = await reader.inspect(params);
  assert.equal(after.kind, "result");
  assert.equal(after.value, reader.tracks.get("source:0"));
});

test("an empty proven track table differs from absent bytes", async () => {
  const reader = new ContainerOrchestrator();
  reader.containerFor = async () => ({ readTracks: async () => [] });
  assert.deepEqual((await reader.inspect(params)).value, []);
  assert.equal(reader.tracks.size, 1);
});

test("an unreadable format and failed parsing carry terminal reasons", async () => {
  const reader = new ContainerOrchestrator();
  reader.containerFor = async () => null;
  assert.equal((await reader.inspect(params)).reason, "format-not-supported");
  reader.containerFor = async () => ({ readTracks: async () => { throw new Error("Invalid track header."); } });
  const result = await reader.inspect(params);
  assert.equal(result.kind, "terminal");
  assert.equal(result.message, "Invalid track header.");
});
