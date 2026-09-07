/**
 * @file What the plan believes exists is what the disk holds — with a real
 * store, a real directory, and no ffmpeg.
 *
 * The failure these are written against, field 2026-09-07, twice in one evening
 * on `Star.Trek.Strange.New.Worlds.S04E03`:
 *
 * > `encode: … ready=482 zones=[p100:#0..#0 …] runs=[#0..#0@0.0x] waiting=nobody`
 * > `encode-run stopped #0..#0 …, reached #-1 (0 segment(s)) after 2778ms,`
 * > `signal SIGTERM: the film is no worse off without it`
 * > `encode: … ready=482 … runs=[] waiting=nobody`
 *
 * The map claimed every one of the film's 482 segments while the directory held
 * nothing a header could be lifted out of, so every arrangement scored perfect,
 * the only encoder was taken away as unnecessary and none was placed again. The
 * viewer's browser asked for the init segment, was never answered, and gave up.
 *
 * Readiness had been accumulating for the life of the process: the map was told
 * what existed and never told what had stopped existing — the word for that
 * existed and was called from no line of the product. So these check the one
 * property that makes the whole class of failure impossible: what the map says
 * is ready is what the store can prove right now, and nothing older.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EncodeRun } from "../services/encode/EncodeRun.js";
import { SegmentStore } from "../services/encode/SegmentStore.js";
import { SoftwareEncoder } from "../services/encode/SoftwareEncoder.js";
import { EncodeOrchestrator } from "../services/orchestrators/EncodeOrchestrator.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

const PICTURE = "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy";
const SEGMENTS = 482;

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 1;
  }

  kill(signal) {
    this.emit("exit", null, signal);
  }
}

/**
 * A store on a real directory, and an orchestrator that owns it.
 *
 * @returns {{ made: EncodeOrchestrator, store: SegmentStore, dir: string,
 *   root: string, lines: string[] }}
 */
function orchestratorWithAStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), "coverage-disk-"));
  const lines = [];
  const logger = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const store = new SegmentStore({ root, logger });
  store.useFormat(PICTURE, fmp4Format);
  const dir = store.directoryFor(PICTURE);
  /** @type {EncodeOrchestrator} */
  let made;
  made = new EncodeOrchestrator({
    maxRunsFor: () => 1,
    segmentSeconds: 6,
    killCostSec: 0,
    firstByteWaitSec: 0.12,
    refetchSecPerFilmSecond: () => 0.25,
    startingSpeedFor: () => 2,
    segmentStore: store,
    now: () => 1000,
    logger,
    makeRun: ({ address, from, to }) => new EncodeRun({
      address,
      encoder: new SoftwareEncoder(),
      from,
      to,
      buildArgs: () => ["-i", "in", "out"],
      spawn: () => new FakeProcess(),
      logger,
      now: () => 1000,
      onEnded: (ended) => made.noteEnded(ended)
    })
  });
  made.setSegmentCount(PICTURE, SEGMENTS);
  return { made, store, dir, root, lines };
}

/** A viewer stopped at the beginning, which is what a fresh session states. */
function aViewerAtTheStart(made) {
  made.notePriorityMap(PICTURE, [
    { from: 0, to: 0, priority: 100, withinSeconds: 0 },
    { from: 1, to: SEGMENTS - 1, priority: 91, withinSeconds: 6 }
  ]);
}

/**
 * Every segment of the film, written and reported closed — what the store looked
 * like while the film was being watched.
 */
function theWholeFilmIsOnDisk(store, dir) {
  for (let index = 0; index < SEGMENTS; index += 1) {
    writeFileSync(path.join(dir, fmp4Format.segmentFileName(index)), Buffer.alloc(16));
    store.markClosed(PICTURE, index);
  }
}

test("a film that is entirely made needs no encoder", (t) => {
  const { made, store, dir, root } = orchestratorWithAStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  theWholeFilmIsOnDisk(store, dir);
  aViewerAtTheStart(made);
  made.reconcile();

  // The other half of the property, and the reason the failure looked
  // reasonable: when the film really is all there, taking the encoder away IS
  // right, and the viewer is served from the disk.
  assert.equal(made.runsOn(PICTURE).length, 0, "nothing left to make");
});

test("segments the store has lost stop being ready, and an encoder is placed again", (t) => {
  const { made, store, dir, root } = orchestratorWithAStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  theWholeFilmIsOnDisk(store, dir);
  aViewerAtTheStart(made);
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 0);

  // THE FIELD FAILURE. The output's directory goes — dropped for room, or by the
  // idle rule, or because a killed process left it and the sweep cleared it. The
  // map used to keep all 482 numbers and the plan went on believing the film was
  // made, for the life of the process.
  store.drop(PICTURE, "the test is taking its files away");
  store.useFormat(PICTURE, fmp4Format);
  store.directoryFor(PICTURE);

  made.reconcile();
  const runs = made.runsOn(PICTURE);
  assert.equal(runs.length, 1, "the film is unmade again, so somebody makes it");
  assert.equal(runs[0].from, 0, "beginning where the viewer is stopped");
});

test("a piece discarded with the run that had it open is not ready either", (t) => {
  const { made, store, dir, root } = orchestratorWithAStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  theWholeFilmIsOnDisk(store, dir);
  aViewerAtTheStart(made);
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 0);

  // A run stopped the instant after opening #0 leaves a file of no bytes under a
  // name that reads as a segment; the store throws it away. Field 2026-09-07,
  // 20:13:13 and 20:13:57 — printed twice while the map went on saying 482.
  rmSync(path.join(dir, fmp4Format.segmentFileName(0)), { force: true });

  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 1, "one number missing is one encoder");
  assert.equal(made.runsOn(PICTURE)[0].from, 0);
});

test("nobody making what somebody waits for is said out loud", (t) => {
  const { made, root, lines } = orchestratorWithAStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // A HOST THAT CANNOT BUILD AN ENCODER. Whatever the reason — and there are
  // several — the state it leaves is the one that cost two sessions on
  // 2026-09-07: somebody is waiting, nothing is being made, and every line
  // above reads as a healthy proxy. It ran for 41 seconds in the field with no
  // word about it on either side, and ended at the browser's own timeout with a
  // message naming no cause.
  made.makeRun = () => null;
  aViewerAtTheStart(made);
  made.reconcile();

  assert.equal(made.runsOn(PICTURE).length, 0);
  const said = lines.find((line) => line.includes("NO ENCODER IS MAKING IT"));
  assert.ok(said, "the state has a line of its own");
  assert.ok(said.includes("#0"), "which number is wanted");
  assert.ok(said.includes(PICTURE), "of which output, whole — not cut to sixty characters");
  assert.ok(/files=\d+/.test(said), "and what the disk holds, beside what is proven");
});
