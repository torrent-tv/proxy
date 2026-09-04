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
import { SourceFile } from "../services/source/SourceFile.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { SegmentStore } from "../services/encode/SegmentStore.js";
import { Timeline } from "../services/output/Timeline.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";
import { viewerOf } from "../services/viewer/Viewer.js";

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
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" }),
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

test("a run without an end does not claim the whole film away from a later viewer", (t) => {
  const { manager, root, dirPath } = managerWithAnEmptyOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // The first viewer's run, at the beginning, with no end — which is every run
  // whose output was empty when it started.
  const first = sessionOn({
    id: "first",
    dirPath,
    segmentCount: 1000,
    runState: "PRODUCING",
    encodeStartIndex: 0,
    runEndIndex: -1
  });
  manager.sessionsById.set(first.id, first);
  const second = sessionOn({ id: "second", dirPath, segmentCount: 1000 });

  // A second viewer opens the same film in the middle. Counting the first run's
  // claim as the whole film would leave them with no encoder at all, waiting for
  // it to encode its way there — an hour on a long film. It only claims as far
  // as it will actually get, which is its head plus the look-ahead.
  const planned = manager.planRunInterval(second, 500);
  assert.notEqual(planned, null);
  assert.equal(planned.from, 500);
});

test("a run stops when it reaches a stretch another run was given", async (t) => {
  const { manager, root, dirPath } = managerWithAnEmptyOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const stopped = [];
  const ahead = sessionOn({
    id: "ahead",
    dirPath,
    runState: "PRODUCING",
    encodeStartIndex: 500,
    runEndIndex: 600
  });
  manager.sessionsById.set(ahead.id, ahead);
  const behind = sessionOn({
    id: "behind",
    dirPath,
    runState: "PRODUCING",
    encodeStartIndex: 0,
    runEndIndex: -1
  });
  manager.sessionsById.set(behind.id, behind);

  // Its own end was set from the gaps of the moment it began, and the viewer who
  // opened the film further on was not in that picture. Walking into their
  // stretch means writing names they are writing.
  assert.equal(manager.runMakingSegment(behind, 550), "ahead");
  assert.equal(manager.runMakingSegment(behind, 499), null);
  assert.equal(
    manager.runMakingSegment(ahead, 550),
    null,
    "a run without an end owns only as far as it has got, not the rest of the film"
  );
  void stopped;
});

test("a seek backwards does not drag the picture away from a viewer watching ahead", (t) => {
  const { manager, root, dirPath } = managerWithAnEmptyOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const asked = [];
  manager.createOrGetSession = async (params) => {
    asked.push(params.startPositionSeconds);
    return null;
  };

  const shared = sessionOn({
    id: "shared",
    dirPath,
    segmentCount: 1000,
    runState: "PRODUCING",
    encodeStartIndex: 200,
    runEndIndex: -1
  });
  shared.sourceKey = "torrent:abc";
  shared.fileIndex = 0;
  shared.timeline = new Timeline({ boundaries: Array.from({ length: 1001 }, (_, index) => index * 4), cutGrid: "uniform" });
  shared.acquireSource = null;
  shared.progress = { processedSeconds: 900, startPositionSeconds: 800 };
  manager.sessionsById.set(shared.id, shared);

  // One viewer is at segment 250 and being served. The other jumps back an hour.
  viewerOf(shared, "ahead").head = { segment: 250, seconds: 1000, at: Date.now() };
  viewerOf(shared, "back").head = { segment: 250, seconds: 1000, at: Date.now() };

  const startedAt = shared.encodeStartIndex;
  manager.requestSeek("shared", 40, "back");

  assert.equal(
    shared.encodeStartIndex,
    startedAt,
    "the run serving the viewer in front is left exactly where it was"
  );
  assert.deepEqual(asked, [40], "and the one who jumped is given a run of their own, there");
});

test("a seek backwards with nobody else watching still moves the run", (t) => {
  const { manager, root, dirPath } = managerWithAnEmptyOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  let created = 0;
  manager.createOrGetSession = async () => {
    created += 1;
    return null;
  };

  const alone = sessionOn({
    id: "alone",
    dirPath,
    segmentCount: 1000,
    runState: "PRODUCING",
    encodeStartIndex: 200,
    runEndIndex: -1
  });
  alone.timeline = new Timeline({ boundaries: Array.from({ length: 1001 }, (_, index) => index * 4), cutGrid: "uniform" });
  alone.progress = { processedSeconds: 900, startPositionSeconds: 800 };
  manager.sessionsById.set(alone.id, alone);
  viewerOf(alone, "only").head = { segment: 250, seconds: 1000, at: Date.now() };

  manager.requestSeek("alone", 40, "only");

  // Nobody is left behind, so a second run would be an encoder for one viewer
  // who is not there any more.
  assert.equal(created, 0);
  assert.equal(alone.seekTarget !== undefined, true, "the run itself is repositioned, as before");
});
