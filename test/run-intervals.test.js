/**
 * @file A run is given a stretch nobody else holds, and stops at the end of it.
 *
 * This is what removes the per-run directories. Runs used to be kept apart by a
 * directory each, because two of them writing one segment name at the same time
 * produce a file belonging to neither — which was also the only reason a restart
 * ever had to wait for its predecessor to die. Intervals remove that by
 * construction, so one flat directory per output is correct.
 *
 * The other half is the argument that states the end, and WHICH argument it is
 * belongs to the branch — measured, not reasoned:
 * `research/encoder-layer-2026-09-04.md` §11.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { SegmentStore } from "../services/encode/SegmentStore.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

const KEY = "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy";

/**
 * @returns {{ manager: HlsSessionManager, store: SegmentStore, root: string, dirPath: string }}
 */
function managerWithAnEmptyOutput() {
  const root = mkdtempSync(path.join(os.tmpdir(), "run-intervals-"));
  const store = new SegmentStore({ root });
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090,
    segmentStore: store
  });
  const dirPath = store.directoryFor(KEY);
  store.useFormat(KEY, fmp4Format);
  return { manager, store, root, dirPath };
}

/**
 * @param {object} params
 * @returns {object}
 */
function sessionOn({ id, dirPath, segmentCount = 100, runState = null, encodeStartIndex = 0, runEndIndex = -1 }) {
  return {
    id,
    outputKey: KEY,
    dirPath,
    state: "ready",
    fileName: "video.mkv",
    segmentFormat: fmp4Format,
    segmentCount,
    runState,
    encodeStartIndex,
    runEndIndex,
    consumers: new Set(),
    lastAccessedAt: Date.now()
  };
}

/**
 * @param {string} dirPath
 * @param {number[]} indexes
 */
function alreadyMade(dirPath, indexes) {
  for (const index of indexes) {
    writeFileSync(path.join(dirPath, fmp4Format.segmentFileName(index)), Buffer.alloc(16, 1));
  }
}

test("with nothing made, a run gets everything from where it was asked", (t) => {
  const { manager, root, dirPath } = managerWithAnEmptyOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const session = sessionOn({ id: "s", dirPath });
  // -1 for the end means "to the end of the film", which is what every run had
  // before ends existed — and the only case where that is still right.
  assert.deepEqual(manager.planRunInterval(session, 0), { from: 0, to: -1 });
});

test("a run stops before material that is already made", (t) => {
  const { manager, root, dirPath } = managerWithAnEmptyOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 10..20 on the disk. Only 10..19 are PROVEN — the highest has no successor,
  // so nothing shows whether it was closed or was being written when its run
  // died.
  alreadyMade(dirPath, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  const session = sessionOn({ id: "s", dirPath });

  assert.deepEqual(manager.planRunInterval(session, 0), { from: 0, to: 9 });
});

test("a run asked to start inside made material is moved forward to the gap", (t) => {
  const { manager, root, dirPath } = managerWithAnEmptyOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  alreadyMade(dirPath, [10, 11, 12, 13, 14, 15]);
  const session = sessionOn({ id: "s", dirPath });

  // Asked for 11, which is made, and so is everything to 14. The first thing
  // worth encoding is 15 — unproven, because 16 does not exist.
  assert.deepEqual(manager.planRunInterval(session, 11), { from: 15, to: -1 });
});

test("a run stops before a stretch another live run was given", (t) => {
  const { manager, root, dirPath } = managerWithAnEmptyOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const other = sessionOn({
    id: "other",
    dirPath,
    runState: "PRODUCING",
    encodeStartIndex: 40,
    runEndIndex: 60
  });
  manager.sessionsById.set(other.id, other);
  const session = sessionOn({ id: "s", dirPath });

  // Two viewers of one film, one already encoding 40..60. The second run takes
  // what is free in front of it and stops where the other one begins, so
  // neither ever writes a name the other wants.
  assert.deepEqual(manager.planRunInterval(session, 0), { from: 0, to: 39 });
  assert.deepEqual(manager.planRunInterval(session, 45), { from: 61, to: -1 });
});

test("a run that has died holds nothing back", (t) => {
  const { manager, root, dirPath } = managerWithAnEmptyOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // The same stretch, but the process cannot be signalled — it has ended. What
  // it did not finish is free again, without anything having to release it.
  const dead = sessionOn({
    id: "dead",
    dirPath,
    runState: "ENDED_FAILED",
    encodeStartIndex: 40,
    runEndIndex: 60
  });
  manager.sessionsById.set(dead.id, dead);
  const session = sessionOn({ id: "s", dirPath });

  assert.deepEqual(manager.planRunInterval(session, 0), { from: 0, to: -1 });
});

test("nothing left to make is answered with nothing, not with a run", (t) => {
  const { manager, root, dirPath } = managerWithAnEmptyOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const session = sessionOn({ id: "s", dirPath, segmentCount: 5 });
  alreadyMade(dirPath, [0, 1, 2, 3, 4]);
  const other = sessionOn({
    id: "other",
    dirPath,
    segmentCount: 5,
    runState: "PRODUCING",
    encodeStartIndex: 4,
    runEndIndex: 4
  });
  manager.sessionsById.set(other.id, other);

  // Starting an encoder here would only repeat somebody else's work, which is
  // what three ffmpeg processes making one identical picture cost on a CM4.
  assert.equal(manager.planRunInterval(session, 0), null);
});

test("a session with no address keeps the old shape: start here, no end", (t) => {
  const { manager, root, dirPath } = managerWithAnEmptyOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const session = sessionOn({ id: "s", dirPath });
  session.outputKey = "";

  assert.deepEqual(manager.planRunInterval(session, 7), { from: 7, to: -1 });
});
