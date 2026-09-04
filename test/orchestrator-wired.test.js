/**
 * @file The plan is what decides the encoders, and it is asked of real sessions.
 *
 * Three rules written into the session manager become one here: where a run
 * belongs, when it has been overtaken, and how many the machine affords. The
 * point of wiring rather than duplicating is that the arithmetic has sixteen
 * checks of its own and no ffmpeg behind it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SourceFile } from "../services/source/SourceFile.js";
import { Timeline } from "../services/output/Timeline.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { SegmentStore } from "../services/encode/SegmentStore.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";
import { viewerOf } from "../services/viewer/Viewer.js";

const KEY = "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy";

function managerWithAnOutput() {
  const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-wired-"));
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

function sessionOn({ id, dirPath, runState = "PRODUCING", encodeStartIndex = 0, runEndIndex = -1, speed = 0 }) {
  return {
    id,
    outputKey: KEY,
    dirPath,
    // Where this file is cut, held by the file. A fixture that stated it
    // on the session was describing what production no longer does.
    timeline: new Timeline({
      boundaries: Array.from({ length: 1001 }, (_, index) => index * 4),
      cutGrid: "uniform"
    }),
    state: "ready",
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" }),
    segmentFormat: fmp4Format,
    segmentCount: 1000,
    runState,
    encodeStartIndex,
    runEndIndex,
    recentSpeed: speed > 0 ? { speed } : null,
    consumers: new Set(),
    viewers: new Map(),
    ffmpeg: null,
    lastAccessedAt: Date.now()
  };
}

test("a session is handed to the plan as the run it is", (t) => {
  const { manager, root, dirPath } = managerWithAnOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const session = sessionOn({ id: "one", dirPath, encodeStartIndex: 10, runEndIndex: 40 });
  manager.sessionsById.set(session.id, session);
  viewerOf(session, "watching").head = { segment: 12, seconds: 48, at: Date.now() };

  manager.runQualityBudgetOnce;
  manager.planEncodersNow();

  const runs = manager.encodeOrchestrator.runsOn(KEY);
  assert.equal(runs.length, 1, "the session the browser already has is a run like any other");
  assert.equal(runs[0].id, "one");
  assert.equal(runs[0].from, 10);
  assert.equal(runs[0].to, 40);
});

test("what a viewer waits for reaches the plan without their name", (t) => {
  const { manager, root, dirPath } = managerWithAnOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const session = sessionOn({ id: "one", dirPath, encodeStartIndex: 0, runEndIndex: -1 });
  manager.sessionsById.set(session.id, session);
  viewerOf(session, "someone").head = { segment: 5, seconds: 20, at: Date.now() };

  manager.planEncodersNow();

  const wanted = manager.encodeOrchestrator.demand.windowsOn(KEY);
  assert.equal(wanted.length, 1);
  assert.equal(wanted[0].from, 5, "where they are");
  assert.ok(wanted[0].to > 5, "and the cushion in front of them");
});

test("a viewer who has gone quiet stops being waited for", (t) => {
  const { manager, root, dirPath } = managerWithAnOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const session = sessionOn({ id: "one", dirPath });
  manager.sessionsById.set(session.id, session);
  viewerOf(session, "gone").head = { segment: 5, seconds: 20, at: Date.now() - 10 * 60 * 1000 };

  manager.planEncodersNow();

  assert.equal(manager.encodeOrchestrator.demand.windowsOn(KEY).length, 0);
});

test("how many encoders the machine affords is measured, not chosen", (t) => {
  const { manager, root, dirPath } = managerWithAnOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Nothing measured yet: one is what it has.
  const cold = sessionOn({ id: "cold", dirPath });
  manager.sessionsById.set(cold.id, cold);
  assert.equal(manager.maxRunsForOutput(KEY), 1);

  // Fast, but what a second job costs on THIS machine has not been measured,
  // and an unmeasured penalty of 1 is not a statement that it is free.
  cold.recentSpeed = { speed: 7.12 };
  assert.equal(manager.maxRunsForOutput(KEY), 1, "no measurement, no second encoder");

  // Measured on the addon host 2026-09-03: at 854x480 one run made 7.12x and
  // two made 4.20x and 4.16x, a penalty of 1.70x, and both stayed far above
  // realtime.
  manager.contentionPenalties = new Map([[1, 1.7]]);
  assert.ok(manager.maxRunsForOutput(KEY) > 1, "measured, and a second fits");

  // The same host at 1920x1080: one made 1.96x, two made 0.99x and 0.98x.
  manager.contentionPenalties = new Map([[1, 1.98]]);
  cold.recentSpeed = { speed: 1.96 };
  assert.equal(manager.maxRunsForOutput(KEY), 1, "the machine is full at one");
});

test("segments already made are known to the plan, whoever made them", (t) => {
  const { manager, store, root, dirPath } = managerWithAnOutput();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const index of [0, 1, 2, 3]) {
    writeFileSync(path.join(dirPath, fmp4Format.segmentFileName(index)), Buffer.alloc(16, 1));
  }
  const session = sessionOn({ id: "one", dirPath });
  manager.sessionsById.set(session.id, session);

  manager.planEncodersNow();

  const coverage = manager.encodeOrchestrator.coverageOf(KEY);
  assert.equal(coverage.isReady(0), true);
  assert.equal(coverage.isReady(2), true);
  assert.equal(coverage.isReady(3), false, "the highest has no successor to prove it closed");
  void store;
});
