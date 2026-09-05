/**
 * @file Encoders managed to suit whoever is watching, with no viewer reaching
 * the decision.
 *
 * Runs are built by the test, so nothing here spawns ffmpeg. What is exercised
 * is the whole path a request takes: a viewer states a window, a plan is made
 * from the union, runs are started, moved and stopped, and every ending is
 * counted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EncodeRun } from "../services/encode/EncodeRun.js";
import { ENCODE_EXIT } from "../services/encode/encode-exit.js";
import { SoftwareEncoder } from "../services/encode/SoftwareEncoder.js";
import { EncodeOrchestrator } from "../services/orchestrators/EncodeOrchestrator.js";

const PICTURE = "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 1;
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    // A real ffmpeg dies a moment later; the test wants the bookkeeping to
    // happen where it can be seen, so the exit is immediate and synchronous.
    this.emit("exit", null, signal);
  }
}

/**
 * @param {{ maxRuns?: number }} [options]
 */
function orchestrator({ maxRuns = 2 } = {}) {
  const lines = [];
  const processes = new Map();
  /** @type {EncodeOrchestrator} */
  let made;
  made = new EncodeOrchestrator({
    maxRunsFor: () => maxRuns,
    segmentSeconds: 4,
    restartCostSec: 0.12,
    // A host that has measured what the swarm charges to fetch a second of film
    // again. Without it the drive-or-move comparison has only one side and the
    // plan keeps the encoder rather than paying an unknown price — which is its
    // own check in `encode-plan.test.js` rather than the shape every check here
    // is written against.
    refetchSecPerFilmSecond: () => 0.25,
    now: () => 1000,
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    makeRun: ({ address, from, to }) => {
      const process_ = new FakeProcess();
      const run = new EncodeRun({
        address,
        encoder: new SoftwareEncoder(),
        from,
        to,
        buildArgs: () => ["-i", "in", "out"],
        spawn: () => process_,
        logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
        now: () => 1000,
        onEnded: (ended) => made.noteEnded(ended)
      });
      // Filed under the run itself: a run has no name, so a test that has to
      // reach its process asks with the run in hand.
      processes.set(run, process_);
      return run;
    }
  });
  made.setSegmentCount(PICTURE, 1000);
  return { made, lines, processes };
}

test("a viewer waiting gets an encoder at what they are waiting for", () => {
  const { made } = orchestrator();
  made.want({ claimant: "one", address: PICTURE, from: 100, to: 130 });
  made.reconcile();
  const runs = made.runsOn(PICTURE);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].from, 100, "where the viewer is stopped");
  assert.equal(runs[0].to, 999, "and on to the end of the film, nothing being in the way");
});

test("a second viewer at the same place starts nothing more", () => {
  // One encode serves everyone standing in front of it, which is the whole
  // reason the decision is made from a union and not per viewer.
  const { made } = orchestrator();
  made.want({ claimant: "one", address: PICTURE, from: 100, to: 130 });
  made.reconcile();
  made.want({ claimant: "two", address: PICTURE, from: 102, to: 132 });
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 1);
});

test("a second viewer far behind gets an encoder of their own", () => {
  // Nobody is dragged: the run in front keeps its stretch and goes on making it.
  const { made } = orchestrator();
  made.want({ claimant: "one", address: PICTURE, from: 500, to: 530 });
  made.reconcile();
  made.want({ claimant: "two", address: PICTURE, from: 100, to: 130 });
  made.reconcile();
  const spans = made.runsOn(PICTURE).map((run) => [run.from, run.to]);
  assert.equal(spans.length, 2);
  assert.ok(spans.some(([from]) => from === 500), "the one in front is untouched");
  assert.ok(spans.some(([from]) => from === 100), "the one behind got its own");
});

test("a machine that can afford one encoder does not start a second", () => {
  const { made } = orchestrator({ maxRuns: 1 });
  made.want({ claimant: "one", address: PICTURE, from: 100, to: 130 });
  made.reconcile();
  made.want({ claimant: "two", address: PICTURE, from: 500, to: 530 });
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 1);
});

test("a viewer asking for what is already made starts nothing", () => {
  const { made } = orchestrator();
  made.noteAlreadyMade(PICTURE, [100, 101, 102, 103, 104]);
  made.want({ claimant: "one", address: PICTURE, from: 100, to: 104 });
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 0);
});

test("segments left by a previous life of this process are used, not remade", () => {
  // The startup sweep tells the map what survived; from there it is material
  // like any other, whoever made it and whatever became of them.
  const { made } = orchestrator();
  made.noteAlreadyMade(PICTURE, [100, 101, 102]);
  made.want({ claimant: "one", address: PICTURE, from: 100, to: 110 });
  made.reconcile();
  const runs = made.runsOn(PICTURE);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].from, 103, "it starts at the first thing missing");
});

test("a viewer who leaves takes the encoder with them", () => {
  const { made } = orchestrator();
  made.want({ claimant: "one", address: PICTURE, from: 100, to: 130 });
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 1);
  made.release("one");
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 0);
  assert.equal(made.endings()[ENCODE_EXIT.STOPPED], 1);
});

test("a run that meets material made elsewhere is moved past it", () => {
  const { made } = orchestrator();
  made.want({ claimant: "one", address: PICTURE, from: 100, to: 200 });
  made.reconcile();
  const first = made.runsOn(PICTURE)[0];
  // It has made a few, and meanwhile 105..150 arrived from somewhere else.
  made.noteProduced(PICTURE, 100);
  made.noteProduced(PICTURE, 101);
  for (let index = 102; index <= 150; index += 1) {
    made.coverageOf(PICTURE).markReady(index);
  }
  first.noteSpeed(1);
  made.reconcile();
  const runs = made.runsOn(PICTURE);
  assert.equal(runs.length, 1, "one encoder, moved rather than joined by another");
  assert.equal(runs[0].from, 151);
  assert.notEqual(runs[0], first, "a move is this one ending and another beginning");
});

test("every ending is counted, and our own kill is not counted as normal", () => {
  const { made, processes } = orchestrator();
  made.want({ claimant: "one", address: PICTURE, from: 100, to: 130 });
  made.reconcile();
  const run = made.runsOn(PICTURE)[0];
  processes.get(run).emit("exit", 255, null);
  made.release("one");
  made.reconcile();
  const tally = made.endings();
  assert.equal(tally[ENCODE_EXIT.FAILED], 1);
  assert.equal(tally[ENCODE_EXIT.COMPLETE], 0);
});

test("the line says whether anybody is still waiting", () => {
  // A proxy with encoders running and a viewer stopped at a segment nobody is
  // making is the failure this layer removes; it has to be readable, not
  // inferred.
  const { made } = orchestrator();
  made.want({ claimant: "one", address: PICTURE, from: 100, to: 130 });
  made.reconcile();
  assert.match(made.describe(), /waiting=#100/);
  for (let index = 100; index <= 130; index += 1) {
    made.noteProduced(PICTURE, index);
  }
  assert.match(made.describe(), /waiting=nobody/);
});

test("nothing wanted anywhere is said plainly", () => {
  const { made } = orchestrator();
  assert.match(made.describe(), /nothing wanted/);
});

test("a run adopted with no end holds what it has made, not the rest of the film", () => {
  // A session's own encoder is handed to the plan rather than built by it, and
  // it carries `to = -1` — no end, which means the film's length is not known.
  // Claiming the film from there would leave a viewer further in with no
  // encoder at all: they would wait for this run to encode its way to them,
  // which on a long film is an hour. What it holds is what it has produced,
  // which is a fact rather than a distance nobody measured.
  const { made } = orchestrator({ maxRuns: 2 });
  const adopted = {
    from: 0,
    to: -1,
    head: 3,
    isAlive: true,
    isStopping: false,
    // Slow enough that the swarm is not what limits the count here: at 0.25
    // seconds of swarm time per second of film, one encoder at 1x takes a
    // quarter of what is delivered and four may run. The swarm's own limit has
    // its own check below.
    speedX: 1,
    stop() {
      this.isAlive = false;
    }
  };
  made.adopt(PICTURE, adopted);

  made.want({ claimant: "far", address: PICTURE, from: 200, to: 230 });
  made.reconcile();

  const runs = made.runsOn(PICTURE);
  assert.equal(runs.length, 2, "the viewer further in got an encoder of their own");
  assert.ok(adopted.isAlive, "and the adopted run was not stopped to make room");
  assert.equal(runs.some((run) => run.from === 200), true, "started where that viewer is waiting");
});

test("the swarm limits the encoders, whatever the processor allows", () => {
  // Every encoder reads the same torrent, so together they cannot consume
  // faster than it is delivered. At 0.25 seconds of swarm time per second of
  // film, one encoder running at 8x takes twice everything there is — so a
  // machine whose processor would allow two gets one.
  const { made, lines } = orchestrator({ maxRuns: 2 });
  made.want({ claimant: "one", address: PICTURE, from: 100, to: 130 });
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(8);
  made.want({ claimant: "two", address: PICTURE, from: 500, to: 530 });
  made.reconcile();

  assert.equal(made.runsOn(PICTURE).length, 1);
  assert.ok(
    lines.some((line) => line.includes("what the swarm delivers")),
    "and the line says which limit decided it"
  );
});
