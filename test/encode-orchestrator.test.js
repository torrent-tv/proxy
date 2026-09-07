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
import { penaltiesFrom } from "../services/encode/contention.js";

// WHAT A SECOND ENCODER COSTS THE FIRST — measured, never a formula.
//
// Addon host, 2026-09-03: 854x480 through libx264 `ultrafast` ran at 7.12x with
// the machine to itself, and at 4.20x and 4.16x when two ran at once. The
// penalty is read off that reading by the SAME two functions production uses,
// so nothing here invents a shape: beyond what was measured the reading is held
// rather than extrapolated.
const MEASURED_PENALTIES = penaltiesFrom(7.12, [{ others: 1, speed: 4.18 }]);

// What a start and a stop cost, measured on the same host: a spawn with its
// input open is 0.12 s there.
const RUN_COSTS = { killCostSec: 0, firstByteWaitSec: 0.12 };


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

/**
 * How many encoders are working the stretch a given number falls in.
 *
 * The count that matters for a viewer is not how many exist — what the machine
 * has spare goes to finishing the file, which is what makes a seek back into a
 * made part start at once — but how many are crowded onto one place.
 *
 * @param {EncodeOrchestrator} made
 * @param {number} segment
 */
function onTheStretchOf(made, segment) {
  return made.runsOn(PICTURE).filter((run) => {
    const to = run.to < run.from ? Number.POSITIVE_INFINITY : run.to;
    return run.from <= segment && segment <= to;
  }).length;
}

function orchestrator({ maxRuns = 2 } = {}) {
  const lines = [];
  const processes = new Map();
  /** @type {EncodeOrchestrator} */
  let made;
  made = new EncodeOrchestrator({
    maxRunsFor: () => maxRuns,
    segmentSeconds: 4,
    ...RUN_COSTS,
    // A host that has measured what the swarm charges to fetch a second of film
    // again. Without it the drive-or-move comparison has only one side and the
    // plan keeps the encoder rather than paying an unknown price — which is its
    // own check in `encode-plan.test.js` rather than the shape every check here
    // is written against.
    refetchSecPerFilmSecond: () => 0.25,
    // What this host was measured to encode at before any run reported —
    // the startup benchmark, which exists before a viewer does.
    startingSpeedFor: () => 2,
    // What a second encoder costs the first, measured on the addon host
    // 2026-09-03: 1.70x beside one other at 480p, 1.98x at 1080p. Sharing one
    // machine is close to proportional, so this is the measured shape. Without
    // it every extra process is free and the score always wants more of them —
    // and fewer encoders can genuinely finish sooner.
    contentionPenalties: MEASURED_PENALTIES,
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
  assert.equal(onTheStretchOf(made, 100), 1, "one encoder where the viewer is stopped");
  assert.ok(runs.some((run) => run.from === 100), "and it begins exactly there");
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

test("somebody stopped where no encoder can arrive in time is served, and the score says how", () => {
  // The encoder that exists is 197 pieces behind them and would take 788 seconds
  // to arrive. What serves them soonest is the question, and on a machine where
  // a second encoder costs the first half its speed the answer is to bring this
  // one — two of them, each at half, deliver the piece later than one at full.
  //
  // Nobody is watching where it stood, so nothing is lost by moving it. That the
  // film there goes unmade is the third of the three counts, and the first —
  // seconds anybody spends looking at a spinner — outranks it.
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

  assert.equal(made.coverageOf(PICTURE).stateOf(200), "making",
    "somebody is making what the viewer is waiting for");
  assert.equal(onTheStretchOf(made, 200), 1, "and one encoder is on it, not a crowd");
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
  assert.equal(onTheStretchOf(made, 102), 1, "the same encoder serves them both");
});

test("a second viewer far behind is served, at whatever the score says is soonest", () => {
  // They may get an encoder of their own, or the one in front may come back to
  // them — which is better depends on what a second process costs this machine,
  // and that is measured. What must hold is that somebody is making what they
  // are waiting for.
  const { made } = orchestrator();
  wants(made, [{ from: 500, to: 530, withinSeconds: 0 }]);
  made.reconcile();
  for (const run of made.runsOn(PICTURE)) {
    run.noteSpeed(2);
  }
  wants(made, [
    { from: 500, to: 530, withinSeconds: 0 },
    { from: 100, to: 130, withinSeconds: 0 }
  ]);
  made.reconcile();

  assert.equal(made.coverageOf(PICTURE).stateOf(100), "making", "the one behind is served");
  assert.ok(made.runsOn(PICTURE).length <= 2, "and never more than the machine holds");
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
  assert.ok(runs.some((run) => run.from === 103), "it starts at the first thing missing");
  assert.equal(onTheStretchOf(made, 103), 1, "and one encoder is enough for it");
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
