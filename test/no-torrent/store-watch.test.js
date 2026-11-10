/**
 * @file The wait of helpers/store-watch.js ends when the store's own listener
 * has heard the probe writes, and fails with its own message when it never does.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SegmentStore } from "../../services/storage/segment-store/SegmentStore.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { untilWatchIsLive } from "./helpers/store-watch.js";

const KEY = "store-watch:fmt=fmp4:grid=uniform@0:video-only:v=libx264/854x480";
const OTHER_KEY = "store-watch-other:fmt=fmp4:grid=uniform@0:video-only:v=libx264/854x480";

/**
 * @param {import("node:test").TestContext} t
 * @returns {{ store: SegmentStore, root: string }}
 */
function aStore(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "store-watch-"));
  const store = new SegmentStore({ root, logger: { info: () => {}, warn: () => {} } });
  store.useFormat(KEY, fmp4Format);
  store.useFormat(OTHER_KEY, fmp4Format);
  t.after(() => {
    store.dropAll("the test is over");
    rmSync(root, { recursive: true, force: true });
  });
  return { store, root };
}

test("the wait ends on the directory the store watches and removes its probe file", { timeout: 30_000 }, async (t) => {
  const { store } = aStore(t);
  const dir = store.directoryFor(KEY);

  await untilWatchIsLive(store, KEY, dir);

  assert.equal(existsSync(path.join(dir, ".watch-probe")), false);
});

test("the wait fails with its own message on a directory the store does not watch", { timeout: 30_000 }, async (t) => {
  const { store } = aStore(t);
  store.directoryFor(KEY);
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "store-watch-elsewhere-"));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));

  await assert.rejects(
    untilWatchIsLive(store, KEY, elsewhere, { limitMs: 600 }),
    /the store heard nothing from .* for 600 ms/
  );
  assert.equal(existsSync(path.join(elsewhere, ".watch-probe")), false);
});

test("the wait fails with its own message when the listener is on another output's directory", { timeout: 30_000 }, async (t) => {
  const { store } = aStore(t);
  store.directoryFor(KEY);
  const otherDir = store.directoryFor(OTHER_KEY);

  await assert.rejects(
    untilWatchIsLive(store, KEY, otherDir, { limitMs: 600 }),
    /the store heard nothing from .* for 600 ms/
  );
});
