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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { SegmentStore } from "../services/encode/SegmentStore.js";
import { Timeline } from "../services/output/Timeline.js";
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
    // Where the file is cut, which every live session holds.
    timeline: new Timeline({ boundaries: [0, 4, 8], cutGrid: "keyframe" }),
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

  // Two runs writing into the ONE directory this output has. They are kept
  // apart by the stretches they were given, not by a directory each, so neither
  // can reach the other's numbers and there is nothing to separate.
  writeFileSync(path.join(dirPath, "segment-00000.mp4"), Buffer.alloc(32, 1));
  writeFileSync(path.join(dirPath, "segment-00100.mp4"), Buffer.alloc(32, 2));

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

test("a session leaving does not take the segments with it", async (t) => {
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
  await manager.disposeSession(viewerTwo.id);

  // Both sessions are gone and the material is still here. That is the whole
  // decoupling: a session ending says nothing about whether anybody will ask
  // for these segments again — the viewer who left may come back, and a viewer
  // who never had a session here may open the same film in a minute.
  assert.notEqual(store.pathOf(OUTPUT_KEY, 0), null);
});

test("what nobody has read for long enough goes, and time is the only judge", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "shared-segments-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = 1_000_000;
  const store = new SegmentStore({ root, now: () => clock });

  const dirPath = store.directoryFor(OUTPUT_KEY);
  store.useFormat(OUTPUT_KEY, fmp4Format);
  writeFileSync(path.join(dirPath, "segment-00000.mp4"), Buffer.alloc(32, 1));

  clock += 60_000;
  assert.deepEqual(
    store.enforce({ idleMs: 3_600_000, maxBytes: 1e9 }),
    { droppedIdle: 0, droppedForRoom: 0, bytes: 32 }
  );

  clock += 7_200_000;
  const swept = store.enforce({ idleMs: 3_600_000, maxBytes: 1e9 });
  assert.equal(swept.droppedIdle, 1);
  assert.equal(store.pathOf(OUTPUT_KEY, 0), null);
});

test("over the allowance, what was read longest ago goes first", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "shared-segments-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = 1_000_000;
  const store = new SegmentStore({ root, now: () => clock });

  const older = OUTPUT_KEY;
  const newer = `${OUTPUT_KEY}:second`;
  for (const key of [older, newer]) {
    const dir = store.directoryFor(key);
    store.useFormat(key, fmp4Format);
    writeFileSync(path.join(dir, "segment-00000.mp4"), Buffer.alloc(1000, 1));
    clock += 1000;
  }
  // Reading the newer one again is what puts the older one at the front of the
  // queue: the judge is the last REQUEST, not when the file was written.
  clock += 1000;
  store.pathOf(newer, 0);

  const swept = store.enforce({ idleMs: 3_600_000, maxBytes: 1500 });
  assert.equal(swept.droppedForRoom, 1);
  assert.equal(store.pathOf(older, 0), null);
  assert.notEqual(store.pathOf(newer, 0), null);
});
