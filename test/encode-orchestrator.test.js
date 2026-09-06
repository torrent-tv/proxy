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
/**
 * What is wanted of the picture, as ONE map.
 *
 * The encoding receives a map per output, already merged and with nobody's name
 * on it; these tests state the same thing, so what a viewer's zone becomes is
 * the priority layer's business and not asserted here.
 *
 * @param {EncodeOrchestrator} made
 * @param {{ from: number, to: number, priority?: number, withinSeconds?: number }[]} zones
 */
function wants(made, zones) {
  made.notePriorityMap(PICTURE, zones.map((zone) => ({
    from: zone.from,
    to: zone.to,
    priority: zone.priority ?? 1,
    withinSeconds: zone.withinSeconds ?? 0
  })));
}

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
  // A run built the way the session builds the FIRST one of an output: outside
  // the plan, and with no end, because the free stretch reaches the last
  // segment of the film and `-1` is how that is written everywhere here.
  const buildRun = ({ address = PICTURE, from = 0, to = -1 } = {}) => {
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
    processes.set(run, process_);
    return run;
  };
  return { made, lines, processes, buildRun };
}

test("a viewer waiting gets an encoder at what they are waiting for", () => {
  const { made } = orchestrator();
  wants(made, [{ from: 100, to: 130 }]);
  made.reconcile();
  const runs = made.runsOn(PICTURE);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].from, 100, "where the viewer is stopped");
  assert.equal(runs[0].to, 999, "and on to the end of the film, nothing being in the way");
});

test("an encoder already working covers what it will reach in time", () => {
  // THE MODEL, not a case: a segment is late when it arrives after it is needed,
  // and an encoder placed at `a` delivers `a + j` at `(j + 1) / r`. So the
  // question asked of a working encoder is the same one asked of a new one —
  // when would it get here — and the answer decides whether a second process is
  // wanted at all.
  const { made, buildRun } = orchestrator();
  const first = buildRun({ from: 0, to: -1 });
  first.start("a viewer needs it");
  first.noteSpeed(8);
  made.adopt(PICTURE, first);
  made.noteProduced(PICTURE, 0);
  made.noteProduced(PICTURE, 1);
  assert.equal(first.head, 2, "where it stands");

  const coverage = made.coverageOf(PICTURE);
  assert.equal(coverage.stateOf(15), "making", "it holds the road it was given");
  assert.equal(coverage.stateOf(500), "making", "all of it, to the end of the film");

  // Wanted fourteen segments ahead of it, and not needed for a hundred seconds.
  // At 8x on four-second segments it makes two a second, so it arrives in about
  // seven — in time, and no second process is bought.
  wants(made, [{ from: 15, to: 45, withinSeconds: 100 }]);
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 1, "one encoder, because one is enough");
  assert.equal(made.runsOn(PICTURE)[0], first);
});

test("somebody stopped where no encoder can arrive in time gets one of their own", () => {
  // The same arithmetic, the other way. Needed NOW, and the encoder that holds
  // the road is 197 segments behind it: at 1x on four-second segments that is
  // 788 seconds. Field 2026-09-06 is the case this describes.
  const { made, buildRun } = orchestrator();
  const first = buildRun({ from: 0, to: -1 });
  first.start("a viewer needs it");
  first.noteSpeed(1);
  made.adopt(PICTURE, first);
  made.noteProduced(PICTURE, 0);
  made.noteProduced(PICTURE, 1);
  made.noteProduced(PICTURE, 2);

  wants(made, [{ from: 200, to: 230, withinSeconds: 0 }]);
  made.reconcile();

  const runs = made.runsOn(PICTURE);
  assert.equal(runs.length, 2, "the one waiting got an encoder");
  assert.ok(runs.some((run) => run.from === 200), "placed exactly where it is needed");
  // The one in front keeps working from where it stood, with an end at the new
  // encoder's start. It is a fresh process because where a run stops is fixed
  // when its own process starts: one given no end carries no `-to` and would
  // open the contested file however the plan bounds it afterwards. So the
  // viewer in front pays a restart in place, which is a cost this layer prices,
  // rather than the two of them writing one name.
  const ahead = runs.find((run) => run.from === 3);
  assert.ok(ahead, "the work in front continues from where it stood");
  assert.equal(ahead.to, 199, "and now ends where the other one begins");
});

test("two encoders on one output never share a segment number", () => {
  // Non-overlap is not a rule here, it is a consequence: placements partition
  // the line, because past its neighbour's start an encoder would only make
  // what that neighbour makes sooner.
  const { made, buildRun } = orchestrator();
  const first = buildRun({ from: 0, to: -1 });
  first.start("a viewer needs it");
  first.noteSpeed(1);
  made.adopt(PICTURE, first);
  made.noteProduced(PICTURE, 0);
  wants(made, [{ from: 200, to: 230, withinSeconds: 0 }]);
  made.reconcile();
  const spans = made.runsOn(PICTURE)
    .map((run) => [run.from, run.to < run.from ? Number.POSITIVE_INFINITY : run.to])
    .sort((left, right) => left[0] - right[0]);
  for (let index = 0; index < spans.length - 1; index += 1) {
    assert.ok(spans[index][1] < spans[index + 1][0],
      `#${spans[index][0]}..#${spans[index][1]} must end before #${spans[index + 1][0]}`);
  }
});

test("a second viewer at the same place starts nothing more", () => {
  // One encode serves everyone standing in front of it, which is the whole
  // reason the decision is made from a union and not per viewer.
  const { made } = orchestrator();
  wants(made, [{ from: 100, to: 130 }]);
  made.reconcile();
  wants(made, [{ from: 102, to: 132 }]);
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 1);
});

test("a second viewer far behind gets an encoder of their own", () => {
  // Nobody is dragged: the run in front keeps its stretch and goes on making it.
  const { made } = orchestrator();
  wants(made, [{ from: 500, to: 530 }]);
  made.reconcile();
  wants(made, [{ from: 100, to: 130 }]);
  made.reconcile();
  const spans = made.runsOn(PICTURE).map((run) => [run.from, run.to]);
  assert.equal(spans.length, 2);
  assert.ok(spans.some(([from]) => from === 500), "the one in front is untouched");
  assert.ok(spans.some(([from]) => from === 100), "the one behind got its own");
});

test("a machine that can afford one encoder does not start a second", () => {
  const { made } = orchestrator({ maxRuns: 1 });
  wants(made, [{ from: 100, to: 130 }]);
  made.reconcile();
  wants(made, [{ from: 500, to: 530 }]);
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 1);
});

test("a viewer asking for what is already made starts nothing", () => {
  const { made } = orchestrator();
  made.noteAlreadyMade(PICTURE, [100, 101, 102, 103, 104]);
  wants(made, [{ from: 100, to: 104 }]);
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 0);
});

test("segments left by a previous life of this process are used, not remade", () => {
  // The startup sweep tells the map what survived; from there it is material
  // like any other, whoever made it and whatever became of them.
  const { made } = orchestrator();
  made.noteAlreadyMade(PICTURE, [100, 101, 102]);
  wants(made, [{ from: 100, to: 110 }]);
  made.reconcile();
  const runs = made.runsOn(PICTURE);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].from, 103, "it starts at the first thing missing");
});

test("a viewer who leaves takes the encoder with them", () => {
  const { made } = orchestrator();
  wants(made, [{ from: 100, to: 130 }]);
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 1);
  // Nobody left watching. An EMPTY map is how that is said: there is no name to
  // release, because no viewer's name ever reaches this layer.
  wants(made, []);
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 0);
  assert.equal(made.endings()[ENCODE_EXIT.STOPPED], 1);
});

test("a run that meets material made elsewhere is moved past it", () => {
  const { made } = orchestrator();
  wants(made, [{ from: 100, to: 200 }]);
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
  wants(made, [{ from: 100, to: 130 }]);
  made.reconcile();
  const run = made.runsOn(PICTURE)[0];
  processes.get(run).emit("exit", 255, null);
  wants(made, []);
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
  wants(made, [{ from: 100, to: 130 }]);
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

test("the swarm limits the encoders, whatever the processor allows", () => {
  // Every encoder reads the same torrent, so together they cannot consume
  // faster than it is delivered. At 0.25 seconds of swarm time per second of
  // film, one encoder running at 8x takes twice everything there is — so a
  // machine whose processor would allow two gets one.
  const { made, lines } = orchestrator({ maxRuns: 2 });
  wants(made, [{ from: 100, to: 130 }]);
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(8);
  wants(made, [{ from: 500, to: 530 }]);
  made.reconcile();

  assert.equal(made.runsOn(PICTURE).length, 1);
  assert.ok(
    lines.some((line) => line.includes("what the swarm delivers")),
    "and the line says which limit decided it"
  );
});
