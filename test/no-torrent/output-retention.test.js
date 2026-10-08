import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { SegmentStore } from "../../services/storage/segment-store/SegmentStore.js";
import { OutputRetention } from "../../services/encode/output/OutputRetention.js";
import { OutputCatalog } from "../../services/encode/output/OutputCatalog.js";
import { OutputLifecycle } from "../../services/server/OutputLifecycle.js";
import { Viewers } from "../../services/viewer/Viewers.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { IDLE_KEEP_MS } from "../../services/storage/keep.js";

function setup(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "output-retention-"));
  const clock = { at: 1000 };
  const store = new SegmentStore({ root, now: () => clock.at });
  const outputs = new OutputCatalog({ now: () => clock.at });
  const writing = new Set();
  const retention = new OutputRetention();
  let lifecycle;
  const viewers = new Viewers({ onChange: () => lifecycle?.observeUse() });
  const host = {
    now: () => clock.at, retention, outputs, viewers, segmentStore: store,
    sessionTtlMs: 30 * 60 * 1000,
    outputNeeded: (key, now) => store.isReading(key) || viewers.assignmentsHold({ outputKey: key }, now) ||
      outputs.outputsOn(key).some(output => viewers.stillNeeded(output, now)),
    outputWriting: key => writing.has(key),
    outputReading: key => store.isReading(key) || viewers.responsesHold(key),
    viewerSegmentsOn: () => [],
    invalidateWaits() {},
    outputTimes: { logIndexAccuracy() {} },
    encodeRuns: { liveRunsOf: () => [], forgetEncodingOfGone() {} },
    timelines: { forgetUnused() {} },
    sourceFiles: { forgetUnused() {}, get() {} },
    keyframeTables: { forgetUnused() {} },
    machineBudget: { revise: async () => {}, segmentBytes: () => Number.MAX_SAFE_INTEGER },
    returns: { describe: () => null }
  };
  lifecycle = new OutputLifecycle(host);
  const output = { id: "aaaaaaaaaaaaaaaa", outputKey: "retained-picture" };
  outputs.set(output.id, output);
  const dir = store.directoryFor(output.outputKey, fmp4Format);
  writeFileSync(path.join(dir, "segment-00000.mp4"), Buffer.from("complete segment"));
  t.after(() => {
    store.dropAll("the check is over");
    rmSync(root, { recursive: true, force: true });
  });
  return { clock, store, outputs, viewers, lifecycle, output, dir, writing, host };
}

test("a paused viewer keeps the session and material without segment reads", async t => {
  const { clock, store, viewers, lifecycle, output, outputs } = setup(t);
  const viewer = viewers.of(output, "paused");
  viewer.pausedAt = clock.at;
  clock.at += IDLE_KEEP_MS * 2;
  // Progress polling used to keep only the catalog alive, not its material.
  outputs.touch(output);
  await lifecycle.cleanupExpired();
  assert.equal(outputs.has(output.id), true);
  assert.deepEqual(store.provenNumbers(output.outputKey), [0]);
});

test("the keeping period starts at confirmed departure, not the last read", async t => {
  const { clock, store, viewers, lifecycle, output, outputs } = setup(t);
  viewers.of(output, "viewer");
  clock.at += IDLE_KEEP_MS * 2;
  viewers.leaves(output, "viewer");
  lifecycle.keepWithinRoom();
  assert.deepEqual(store.provenNumbers(output.outputKey), [0], "old reads do not expire a new departure");
  clock.at += IDLE_KEEP_MS - 1;
  lifecycle.keepWithinRoom();
  assert.equal(store.addresses().length, 1);
  clock.at += 1;
  await lifecycle.cleanupExpired();
  assert.equal(outputs.has(output.id), false, "unused session metadata expires as well");
  assert.deepEqual(store.addresses(), []);
});

test("a return cancels expiry, and the next departure starts a full period", t => {
  const { clock, store, viewers, lifecycle, output } = setup(t);
  viewers.of(output, "viewer");
  viewers.leaves(output, "viewer");
  clock.at += IDLE_KEEP_MS - 1;
  viewers.of(output, "viewer");
  viewers.leaves(output, "viewer");
  clock.at += 2;
  lifecycle.keepWithinRoom();
  assert.equal(store.addresses().length, 1, "the previous expiry was cancelled");
  clock.at += IDLE_KEEP_MS;
  lifecycle.keepWithinRoom();
  assert.equal(store.addresses().length, 0);
});

test("writes and physical reads protect material after expiry", t => {
  const { clock, store, lifecycle, output, writing, host } = setup(t);
  lifecycle.observeUse();
  clock.at += IDLE_KEEP_MS;
  writing.add(output.outputKey);
  lifecycle.keepWithinRoom();
  assert.equal(store.addresses().length, 1);
  writing.clear();
  const release = store.holdRead(output.outputKey);
  lifecycle.keepWithinRoom();
  assert.equal(store.drop(output.outputKey, "unsafe concurrent removal"), false);
  host.machineBudget.segmentBytes = () => 1;
  lifecycle.keepWithinRoom();
  assert.equal(store.remove(output.outputKey, 0, "unsafe eviction"), 0);
  assert.deepEqual(store.provenNumbers(output.outputKey), [0]);
  release();
  release();
  host.machineBudget.segmentBytes = () => Number.MAX_SAFE_INTEGER;
  lifecycle.keepWithinRoom();
  assert.equal(store.addresses().length, 1, "the read ended before absence was confirmed again");
  clock.at += IDLE_KEEP_MS;
  lifecycle.keepWithinRoom();
  assert.equal(store.addresses().length, 0);
});

test("a response holds an output independently of its viewer relation", t => {
  const { clock, store, viewers, lifecycle, output } = setup(t);
  const viewer = viewers.of(output, "viewer");
  const token = viewer.assignments.accept(output.outputKey);
  // The same connection moved to another output; the old response still runs.
  viewers.of({ id: "bbbbbbbbbbbbbbbb", outputKey: "elsewhere" }, "viewer");
  viewers.leaves(output, "viewer");
  clock.at += IDLE_KEEP_MS * 2;
  lifecycle.keepWithinRoom();
  assert.equal(store.addresses().length, 1);
  viewer.assignments.release(token);
  lifecycle.keepWithinRoom();
  clock.at += IDLE_KEEP_MS;
  lifecycle.keepWithinRoom();
  assert.equal(store.addresses().length, 0);
});

test("a surviving output publishes visible and servable segments after cleanup", t => {
  const { store, output, outputs, dir } = setup(t);
  assert.equal(store.drop(output.outputKey, "previous material expired"), true);
  assert.equal(outputs.get(output.id), output, "the same output parameters survive");
  // Recreate using the old caller signature, then publish with the format:
  // publication must not depend on a previous registration at opening time.
  store.directoryFor(output.outputKey);
  const bytes = Buffer.from("new complete segment");
  writeFileSync(path.join(dir, "making-reopened-00000.mp4"), bytes);
  assert.equal(store.publish(output.outputKey, "making-reopened-00000.mp4", fmp4Format), "segment-00000.mp4");
  assert.deepEqual(store.provenNumbers(output.outputKey), [0]);
  assert.deepEqual(readFileSync(store.pathOfName(output.outputKey, "segment-00000.mp4")), bytes);
});

test("a physical read refusal preserves registration and does not claim freed bytes", t => {
  const { store, output, dir } = setup(t);
  const release = store.holdRead(output.outputKey);
  const before = store.stats().bytes;
  assert.equal(store.drop(output.outputKey, "still read"), false);
  assert.equal(store.remove(output.outputKey, 0, "still read"), 0);
  assert.equal(store.stats().bytes, before);
  assert.equal(existsSync(dir), true);
  release();
});

test("filesystem deletion errors keep the format and do not claim freed bytes", t => {
  const { store, output, dir } = setup(t);
  const before = store.stats().bytes;
  const original = fs.rmSync;
  const mocked = t.mock.method(fs, "rmSync", (target, options) => {
    if (target === dir || target === path.join(dir, "segment-00000.mp4")) {
      throw Object.assign(new Error("the file is still in use"), { code: "EBUSY" });
    }
    return original(target, options);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(store.drop(output.outputKey, "filesystem refusal"), false);
    assert.equal(store.remove(output.outputKey, 0, "filesystem refusal"), 0);
    assert.deepEqual(store.provenNumbers(output.outputKey), [0]);
    assert.equal(store.stats().bytes, before);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
