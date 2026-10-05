import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SegmentStore } from "../../services/storage/segment-store/SegmentStore.js";

const KEY = "wait-state";
const format = {
  segmentFileName: (index) => `segment-${index}.mp4`,
  isSegmentFileName: (name) => /^segment-\d+\.mp4$/.test(name),
  segmentIndexFromName: (name) => Number(name.match(/\d+/)?.[0] ?? -1)
};

function prepare(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "segment-wait-state-"));
  const store = new SegmentStore({ root });
  store.useFormat(KEY, format);
  const dir = store.directoryFor(KEY);
  t.after(() => {
    store.dropAll("test complete");
    rmSync(root, { recursive: true, force: true });
  });
  return { store, dir };
}

test("availability is inspected only after the waiter subscribes", async (t) => {
  const { store } = prepare(t);
  store.pathOf = () => {
    assert.equal(store.waitingFor(KEY), 1);
    return "ready";
  };
  assert.equal(await store.waitFor(KEY, 0, Infinity), true);
  assert.equal(store.waitingFor(KEY), 0);
});

test("an announcement without available bytes leaves the wait pending", async (t) => {
  const { store, dir } = prepare(t);
  const waited = store.waitFor(KEY, 0, Infinity);
  store.announce(KEY, 0);
  assert.equal(store.waitingFor(KEY), 1);
  writeFileSync(path.join(dir, format.segmentFileName(0)), Buffer.from("complete"));
  store.forget(KEY);
  store.announce(KEY, 0);
  assert.equal(await waited, true);
  assert.equal(store.waitingFor(KEY), 0);
});

test("dropping an output releases a wait with no deadline", async (t) => {
  const { store } = prepare(t);
  const waited = store.waitFor(KEY, 0, Infinity);
  assert.equal(store.waitingFor(KEY), 1);
  store.drop(KEY, "output disposed");
  assert.equal(await waited, false);
  assert.equal(store.waitingFor(KEY), 0);
});

test("caller cancellation removes its waiter", async (t) => {
  const { store } = prepare(t);
  let cancel;
  const cancelled = new Promise((resolve) => { cancel = resolve; });
  const waited = store.waitFor(KEY, 0, Infinity, cancelled);
  cancel();
  assert.equal(await waited, false);
  assert.equal(store.waitingFor(KEY), 0);
});
