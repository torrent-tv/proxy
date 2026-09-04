/**
 * @file Two sessions of one output write into one place, and each serves what
 * the other has made.
 *
 * This is what the whole address change is for. Measured 2026-09-03: two
 * viewers of one copied file got two sessions with byte-identical output —
 * `segment-00000.mp4` of 4141899 bytes, twice — and neither could see the
 * other's work, because the directory was named after the session's own random
 * id (`research/two-viewers-one-file-2026-09-03.md`).
 *
 * The start position is deliberately NOT part of the address: segment 42 covers
 * the same span whoever began where, so two viewers who opened the same film at
 * different places produce interchangeable segments and must share them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { SegmentStore } from "../services/encode/SegmentStore.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

const OUTPUT_KEY = "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy";

/**
 * @returns {{ manager: HlsSessionManager, store: SegmentStore, root: string }}
 */
function managerOverATempStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), "shared-segments-"));
  const store = new SegmentStore({ root });
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090,
    segmentStore: store
  });
  return { manager, store, root };
}

/**
 * A session shaped like a live one, sharing an output with any other built
 * from the same key.
 *
 * @param {{ id: string, dirPath: string, outputKey: string }} params
 * @returns {object}
 */
function sessionOn({ id, dirPath, outputKey }) {
  return {
    id,
    outputKey,
    dirPath,
    state: "ready",
    fileName: "video.mkv",
    segmentFormat: fmp4Format,
    consumers: new Set(),
    lastAccessedAt: Date.now()
  };
}

test("a second session of the same output is given the same directory", (t) => {
  const { store, root } = managerOverATempStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Two viewers who opened one film ten minutes apart. Their sessions differ —
  // the start position is still what keeps their encoders apart — but what they
  // produce is the same material.
  assert.equal(store.pathFor(OUTPUT_KEY), store.pathFor(OUTPUT_KEY));
});

test("each session serves the segments the other one's encoder made", (t) => {
  const { manager, store, root } = managerOverATempStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dirPath = store.directoryFor(OUTPUT_KEY);
  store.useFormat(OUTPUT_KEY, fmp4Format);

  // One run of each session, numbered from the OUTPUT rather than from the
  // session, which is what stops them both claiming `run-1`.
  const first = store.nextRunSerial(OUTPUT_KEY);
  const second = store.nextRunSerial(OUTPUT_KEY);
  assert.equal(first, 1);
  assert.equal(second, 2, "the number is the output's, so the second run is not another run-1");

  const runOne = path.join(dirPath, `run-${first}`);
  const runTwo = path.join(dirPath, `run-${second}`);
  mkdirSync(runOne, { recursive: true });
  mkdirSync(runTwo, { recursive: true });
  writeFileSync(path.join(runOne, "segment-00000.mp4"), Buffer.alloc(32, 1));
  writeFileSync(path.join(runTwo, "segment-00100.mp4"), Buffer.alloc(32, 2));

  const viewerOne = sessionOn({ id: "s-one", dirPath, outputKey: OUTPUT_KEY });
  const viewerTwo = sessionOn({ id: "s-two", dirPath, outputKey: OUTPUT_KEY });
  manager.sessionsById.set(viewerOne.id, viewerOne);
  manager.sessionsById.set(viewerTwo.id, viewerTwo);

  const sorted = (numbers) => [...numbers].sort((left, right) => left - right);
  const heldByOne = sorted(manager.producedSegmentNumbers(viewerOne));
  const heldByTwo = sorted(manager.producedSegmentNumbers(viewerTwo));

  assert.deepEqual(heldByOne, [0, 100]);
  assert.deepEqual(heldByTwo, [0, 100], "neither viewer's session is the owner of either run");
});

test("the last session to leave takes the directory with it, and no earlier one does", async (t) => {
  const { manager, store, root } = managerOverATempStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dirPath = store.directoryFor(OUTPUT_KEY);
  store.useFormat(OUTPUT_KEY, fmp4Format);
  writeFileSync(path.join(dirPath, "segment-00000.mp4"), Buffer.alloc(32, 1));

  const viewerOne = sessionOn({ id: "s-one", dirPath, outputKey: OUTPUT_KEY });
  const viewerTwo = sessionOn({ id: "s-two", dirPath, outputKey: OUTPUT_KEY });
  manager.sessionsById.set(viewerOne.id, viewerOne);
  manager.sessionsById.set(viewerTwo.id, viewerTwo);

  await manager.disposeSession(viewerOne.id);
  assert.notEqual(
    store.pathOf(OUTPUT_KEY, 0),
    null,
    "one viewer leaving must not take away material the other is playing"
  );

  await manager.disposeSession(viewerTwo.id);
  assert.equal(store.pathOf(OUTPUT_KEY, 0), null);
});
