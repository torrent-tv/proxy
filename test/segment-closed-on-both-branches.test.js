/**
 * @file A piece is closed by one of two writers, and both must say so.
 *
 * The `segment` muxer writes under a working name and reports the closure on a
 * channel of its own, which reaches `SegmentStore.publish`. The `hls` muxer
 * writes through a temporary name of its own (`+temp_file`) and reports
 * nothing: the file simply appears under the name it is served as. That branch
 * is taken by every re-encoded output cut on the even grid — an ordinary
 * quality step — and for it a wait could only end on its deadline, so a segment
 * lying finished on disk was answered 503 after the whole hold.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SegmentStore } from "../services/storage/segment-store/SegmentStore.js";
import { fmp4Format } from "../services/encode/segment-formats/fmp4.js";

const KEY = "torrent:abc:fmt=fmp4:grid=uniform@0:video-only:v=libx264/854x480";

/** A deadline is the backstop of these waits, never what they measure. */
const BACKSTOP_MS = 10_000;

/**
 * @returns {{ store: SegmentStore, root: string }}
 */
function storeInATempRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "segment-closed-"));
  const store = new SegmentStore({ root, logger: { info: () => {}, warn: () => {} } });
  store.useFormat(KEY, fmp4Format);
  return { store, root };
}

test("a piece that simply appears ends the wait that began before it", async (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => {
    store.dropAll("the test is over");
    rmSync(root, { recursive: true, force: true });
  });

  const dir = store.directoryFor(KEY);
  // The wait begins on a segment nobody has written yet — the cold case, and
  // the only one the deadline used to decide.
  const waited = store.waitFor(KEY, 7, BACKSTOP_MS);

  // What the `hls` muxer does: a temporary name of its own, renamed into place
  // when the piece is whole. Nothing is told; the directory simply moves.
  const temp = path.join(dir, "segment-00007.mp4.tmp");
  writeFileSync(temp, Buffer.alloc(64));
  renameSync(temp, path.join(dir, fmp4Format.segmentFileName(7)));

  assert.equal(await waited, true, "the piece was on disk and the wait did not end");
  assert.ok(store.pathOf(KEY, 7), "and the store must be able to hand it over");
});

test("clearing up after a run is not its pieces arriving", async (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => {
    store.dropAll("the test is over");
    rmSync(root, { recursive: true, force: true });
  });

  const dir = store.directoryFor(KEY);
  const unfinished = path.join(dir, fmp4Format.makingFileNameTemplate("3").replace("%05d", "00009"));
  writeFileSync(unfinished, Buffer.alloc(64));

  let ended = false;
  // 200 ms is a grace before asserting that something did NOT happen, which can
  // only ever pass too easily — never a measurement.
  const waited = store.waitFor(KEY, 9, 200).then((value) => {
    ended = value;
    return value;
  });
  rmSync(unfinished, { force: true });

  assert.equal(await waited, false, "a directory that moved because a file went holds nothing new");
  assert.equal(ended, false);
});

test("the writer that does report a closure is unaffected", async (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => {
    store.dropAll("the test is over");
    rmSync(root, { recursive: true, force: true });
  });

  const dir = store.directoryFor(KEY);
  const making = fmp4Format.makingFileNameTemplate("4").replace("%05d", "00004");
  writeFileSync(path.join(dir, making), Buffer.alloc(64));

  const waited = store.waitFor(KEY, 4, BACKSTOP_MS);
  assert.equal(store.publish(KEY, making, fmp4Format), fmp4Format.segmentFileName(4));
  assert.equal(await waited, true);
});

test("a directory removed from outside and made again is watched again", async (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => {
    store.dropAll("the test is over");
    rmSync(root, { recursive: true, force: true });
  });

  // Removed by something other than the store, so its watch was not stopped
  // first. The watch held on that path watches a directory that is gone.
  rmSync(store.directoryFor(KEY), { recursive: true, force: true });
  const dir = store.directoryFor(KEY);
  const waited = store.waitFor(KEY, 3, BACKSTOP_MS);

  writeFileSync(path.join(dir, fmp4Format.segmentFileName(3)), Buffer.alloc(64));

  assert.equal(await waited, true, "the piece arrived in the new directory and the wait did not end");
});
