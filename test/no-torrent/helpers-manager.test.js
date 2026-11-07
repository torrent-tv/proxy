/**
 * @file `helpers/manager.js`: `managerWithOwnStore`, the one way a check builds a serving manager
 * (torrent-tv/meta#309).
 *
 * Sixteen files built a manager on the default store root, which every test PROCESS shares and
 * `disposeAll` removes. The isolation check below is what keeps that flake from coming back: it
 * states the property the migration exists for, so the files that moved onto the helper do not
 * each have to prove it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EncodeRuns } from "../../services/encode/EncodeRuns.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { SegmentStore } from "../../services/storage/segment-store/SegmentStore.js";
import { managerWithOwnStore } from "./helpers/manager.js";

const KEY = "isolation:fmt=fmp4:grid=uniform:video-only:v=0/copy";

/** One finished segment on disk under `key`, in the manager's own store. */
function writeSegment(manager, key, index = 0) {
  manager.segmentStore.useFormat(key, fmp4Format);
  const file = path.join(manager.segmentStore.directoryFor(key), fmp4Format.segmentFileName(index));
  writeFileSync(file, Buffer.alloc(64, 0x5a));
  return file;
}

test("two managers get distinct roots, neither of them the shared default one", (t) => {
  const one = managerWithOwnStore();
  const two = managerWithOwnStore();
  t.after(() => { one.cleanup(); two.cleanup(); });

  assert.notEqual(one.root, two.root);
  assert.equal(one.store.root, one.root, "the manager's store lives at the root the helper reports");
  assert.equal(two.store.root, two.root);
  assert.equal(one.manager.segmentStore, one.store);
  const shared = path.join(os.tmpdir(), "torrent-tv-hls");
  assert.notEqual(one.root, shared);
  assert.notEqual(two.root, shared);
});

test("disposeAll on one manager does not remove the segments of another", async (t) => {
  const one = managerWithOwnStore();
  const two = managerWithOwnStore();
  t.after(() => { one.cleanup(); two.cleanup(); });
  const mine = writeSegment(one.manager, KEY);
  const theirs = writeSegment(two.manager, KEY);
  assert.ok(existsSync(mine) && existsSync(theirs));

  await one.manager.lifecycle.disposeAll();

  assert.equal(existsSync(mine), false, "disposeAll removes what the manager it was called on had written");
  assert.ok(existsSync(theirs), "and nothing of the other manager's");
});

test("cleanup removes the root and may be called twice", (t) => {
  const own = managerWithOwnStore();
  writeSegment(own.manager, KEY);
  own.cleanup();
  assert.equal(existsSync(own.root), false);
  assert.doesNotThrow(() => own.cleanup());
  t.after(() => own.cleanup());
});

test("a store given in the options wins over the one the helper makes", (t) => {
  const given = managerWithOwnStore();
  const store = new SegmentStore({ root: given.root });
  const own = managerWithOwnStore({ segmentStore: store });
  t.after(() => { given.cleanup(); own.cleanup(); });
  assert.equal(own.store, store);
  assert.equal(own.manager.segmentStore, store);
});

test("a manager is not planless unless it is asked to be", (t) => {
  const { manager, cleanup } = managerWithOwnStore();
  t.after(cleanup);
  const now = t.mock.method(EncodeRuns.prototype, "planEncodersNow", () => {});
  t.mock.method(EncodeRuns.prototype, "planEncodersSoon", () => {});
  assert.equal(Object.hasOwn(manager.encodeRuns, "planEncodersNow"), false, "the production method is not shadowed");
  manager.encodeRuns.planEncodersNow();
  assert.equal(now.mock.callCount(), 1);
  const explicit = managerWithOwnStore({ planless: false });
  t.after(explicit.cleanup);
  assert.equal(Object.hasOwn(explicit.manager.encodeRuns, "planEncodersNow"), false, "planless: false is the default");
});

test("a planless manager makes no plan calls, now or soon, and returns nothing", (t) => {
  const { manager, cleanup } = managerWithOwnStore({ planless: true });
  t.after(cleanup);
  const now = t.mock.method(EncodeRuns.prototype, "planEncodersNow", () => {});
  const soon = t.mock.method(EncodeRuns.prototype, "planEncodersSoon", () => {});

  assert.equal(manager.encodeRuns.planEncodersNow(), undefined);
  assert.equal(manager.encodeRuns.planEncodersSoon(), undefined);
  assert.equal(now.mock.callCount(), 0, "planEncodersNow reached the production plan");
  assert.equal(soon.mock.callCount(), 0, "planEncodersSoon reached the production plan");
});

test("planless leaves the rest of the manager as it was: own store, and other options still reach it", (t) => {
  const { manager, store, root, cleanup } = managerWithOwnStore({ planless: true });
  t.after(cleanup);
  assert.equal(manager.segmentStore, store);
  assert.equal(store.root, root);
  assert.equal(typeof manager.lifecycle.disposeAll, "function");
  assert.ok(manager.outputs && manager.viewers && manager.encodeRuns);
});
