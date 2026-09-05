/**
 * @file How many encoders there should be, and where.
 *
 * Every case here is one the code used to get wrong for a reason recorded in
 * `research/encoder-layer-2026-09-04.md`: a run placed at a viewer's position
 * rather than at the first thing missing, a run with no end, and nothing that
 * stops a run which has caught up with material already made.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CoverageMap } from "../services/encode/CoverageMap.js";
import { endOfRun } from "../services/encode/EncodeRun.js";
import { firstUnmetWant, planEncoders } from "../services/encode/EncodePlan.js";

/** A host that can afford two encoders, four-second segments, a cheap restart. */
const HOST = { maxRuns: 2, segmentSeconds: 4, restartCostSec: 0.12 };

/**
 * @param {Partial<import("../services/encode/EncodePlan.js").LiveRun>} run
 * @returns {import("../services/encode/EncodePlan.js").LiveRun}
 */
function run(run_) {
  // A run has no name: the plan hands back the run itself, so a test compares
  // the thing rather than a token standing for it.
  return { from: 0, to: 100, head: 0, speedX: 2, ...run_ };
}

test("a viewer waiting on nothing made starts one encoder, at what they are waiting for", () => {
  // It starts where the viewer is stopped and runs to the end of the film,
  // because nothing else is in the way. The window says where to start and
  // whether to start; it does not say where to stop — a window travels forward
  // as the viewer plays, and a run bounded by one has to be replaced every few
  // seconds.
  const coverage = new CoverageMap({ segmentCount: 100 });
  const actions = planEncoders({
    coverage,
    windows: [{ from: 40, to: 70 }],
    runs: [],
    ...HOST
  });
  assert.deepEqual(
    actions.map((action) => ({ type: action.type, from: action.from, to: action.to })),
    [{ type: "start", from: 40, to: 99 }]
  );
});

test("a viewer whose cushion reaches past a running encoder starts nothing", () => {
  // Found by the orchestrator's own checks: with the end taken from the window,
  // a second viewer two segments further on was given an encoder of their own
  // to make those two, while the run already there had nowhere left to go.
  const coverage = new CoverageMap({ segmentCount: 1000 });
  const runA = run({ from: 100, to: 999, head: 100 });
  coverage.claim(runA, 100, 999);
  const actions = planEncoders({
    coverage,
    windows: [{ from: 100, to: 130 }, { from: 102, to: 132 }],
    runs: [runA],
    ...HOST
  });
  assert.equal(actions.some((action) => action.type === "start"), false);
});

test("a viewer whose whole window is already made starts nothing", () => {
  // The case that used to restart an encoder to make a second copy of material
  // sitting on the disk.
  const coverage = new CoverageMap({ segmentCount: 100 });
  for (let index = 40; index <= 70; index += 1) {
    coverage.markReady(index);
  }
  const actions = planEncoders({ coverage, windows: [{ from: 40, to: 70 }], runs: [], ...HOST });
  assert.deepEqual(actions, []);
});

test("a run is given an end at the edge of what is free", () => {
  // Handed the rest of the film it would drive straight into another run's
  // ground; handed the free stretch it stops where the covered material starts.
  const coverage = new CoverageMap({ segmentCount: 100 });
  const runB = run({ from: 50, to: 80 });
  coverage.claim(runB, 50, 80);
  const actions = planEncoders({ coverage, windows: [{ from: 40, to: 90 }], runs: [], ...HOST });
  assert.equal(actions.length, 1);
  assert.deepEqual({ from: actions[0].from, to: actions[0].to }, { from: 40, to: 49 });
});

test("a run that has caught up with made material is moved forward, not killed", () => {
  const coverage = new CoverageMap({ segmentCount: 100 });
  const runA = run({ head: 10, from: 0, to: 100 });
  coverage.claim(runA, 0, 100);
  for (let index = 10; index <= 30; index += 1) {
    coverage.markReady(index);
  }
  const actions = planEncoders({
    coverage,
    windows: [{ from: 0, to: 90 }],
    runs: [runA],
    ...HOST
  });
  const move = actions.find((action) => action.type === "move");
  assert.ok(move, "it should have been moved");
  assert.equal(move.run, runA);
  assert.equal(move.from, 31, "to the first thing nobody has");
  assert.equal(actions.some((action) => action.type === "stop"), false, "and not stopped");
});

test("a covered stretch shorter than a restart is driven through instead", () => {
  // The comparison is of two measured quantities: the covered stretch divided
  // by this run's own speed, against what a restart costs. One segment at 50x
  // is 0.08 s of encoding against 0.12 s to move.
  const coverage = new CoverageMap({ segmentCount: 100 });
  const runA = run({ head: 10, speedX: 50 });
  coverage.claim(runA, 0, 100);
  coverage.markReady(10);
  const actions = planEncoders({
    coverage,
    windows: [{ from: 0, to: 90 }],
    runs: [runA],
    ...HOST
  });
  assert.equal(actions.some((action) => action.type === "move"), false);
  assert.ok(actions.some((action) => action.type === "keep" && action.run === runA));
});

test("a run whose speed nothing has measured is moved rather than left driving through", () => {
  // Not a default: driving through is work that is certainly wasted, and the
  // restart is a known and small cost. What cannot be done is the comparison.
  const coverage = new CoverageMap({ segmentCount: 100 });
  const runA = run({ head: 10, speedX: 0 });
  coverage.claim(runA, 0, 100);
  coverage.markReady(10);
  const actions = planEncoders({
    coverage,
    windows: [{ from: 0, to: 90 }],
    runs: [runA],
    ...HOST
  });
  const move = actions.find((action) => action.type === "move");
  assert.ok(move);
  assert.match(move.because, /speed is not measured/);
});

test("a run with nothing left to make ahead of it is stopped", () => {
  const coverage = new CoverageMap({ segmentCount: 100 });
  const runA = run({ head: 10 });
  coverage.claim(runA, 0, 100);
  for (let index = 10; index <= 90; index += 1) {
    coverage.markReady(index);
  }
  const actions = planEncoders({
    coverage,
    windows: [{ from: 0, to: 90 }],
    runs: [runA],
    ...HOST
  });
  assert.deepEqual(
    actions.map((action) => action.type),
    ["stop"]
  );
});

test("every encoder stops when nobody is watching the output", () => {
  // A look-ahead cannot answer this: it asks how far AHEAD of a viewer a run
  // is, and there is no viewer.
  const coverage = new CoverageMap({ segmentCount: 100 });
  const runA = run();
  const runB = run();
  const actions = planEncoders({
    coverage,
    windows: [],
    runs: [runA, runB],
    ...HOST
  });
  assert.deepEqual(
    actions.map((action) => [action.type, action.run]),
    [["stop", runA], ["stop", runB]]
  );
});

test("a run standing outside every window keeps working: the file is encoded whole", () => {
  // The rule, stated by the user 2026-09-05: while a file is being encoded it
  // is encoded whole, and a viewer decides the ORDER, not whether a run may
  // live. Stopping a run for standing outside a window is what produced the
  // field oscillation of that day — placed by one rule, killed by another,
  // 350-700ms per cycle, nothing ever produced.
  const coverage = new CoverageMap({ segmentCount: 1000 });
  const runA = run({ from: 500, to: 600, head: 520 });
  coverage.claim(runA, 500, 600);
  const actions = planEncoders({
    coverage,
    windows: [{ from: 0, to: 40 }],
    runs: [runA],
    ...HOST
  });
  assert.ok(
    !actions.some((action) => action.type === "stop" && action.run === runA),
    "it is making film that will be wanted, and nothing else is making it"
  );
});

test("the same plan run twice on an unchanged state gives the same answer", () => {
  // What the oscillation actually was: two passes over one state disagreeing
  // with each other. Nothing about the state changes between them here.
  const coverage = new CoverageMap({ segmentCount: 1000 });
  const runA = run({ from: 500, to: 600, head: 520 });
  coverage.claim(runA, 500, 600);
  const input = { coverage, windows: [{ from: 0, to: 40 }], runs: [runA], ...HOST };

  const first = planEncoders(input).map((action) => action.type);
  const second = planEncoders(input).map((action) => action.type);

  assert.deepEqual(first, second);
  assert.ok(!first.includes("stop"), "and neither pass kills what the other would start");
});

test("a viewer's most urgent zone is filled before a less urgent one", () => {
  const coverage = new CoverageMap({ segmentCount: 1000 });
  const actions = planEncoders({
    coverage,
    // The far zone is lower in number and lower in priority: the order must
    // come from the priority, not from the number.
    windows: [
      { from: 0, to: 100, priority: 1 },
      { from: 500, to: 530, priority: 3 }
    ],
    runs: [],
    ...HOST,
    maxRuns: 1
  });
  const started = actions.filter((action) => action.type === "start").map((action) => action.from);

  assert.deepEqual(started, [500], "the one machine goes where somebody is stopped");
});

test("two viewers far apart get an encoder each, when the machine can hold two", () => {
  const coverage = new CoverageMap({ segmentCount: 1000 });
  const actions = planEncoders({
    coverage,
    windows: [{ from: 0, to: 30 }, { from: 800, to: 830 }],
    runs: [],
    ...HOST
  });
  const started = actions.filter((action) => action.type === "start").map((action) => action.from);
  assert.deepEqual(started, [0, 800]);
});

test("a machine that can hold one gives it to the viewer who is stopped soonest", () => {
  // The bound is the host's own budget, the same arithmetic that decides the
  // quality offer. Measured on the addon host 2026-09-03: at 1080p one encode
  // saturates the machine and two land on realtime.
  const coverage = new CoverageMap({ segmentCount: 1000 });
  const actions = planEncoders({
    coverage,
    windows: [{ from: 800, to: 830 }, { from: 0, to: 30 }],
    runs: [],
    ...HOST,
    maxRuns: 1
  });
  const started = actions.filter((action) => action.type === "start").map((action) => action.from);
  assert.deepEqual(started, [0]);
});

test("a viewer joining behind a running encoder gets their own, not a dragged one", () => {
  // This is what the whole layer is for. The run in front is untouched; the
  // viewer behind is not made to wait for it to be pulled back.
  const coverage = new CoverageMap({ segmentCount: 1000 });
  const runA = run({ from: 500, to: 600, head: 510 });
  coverage.claim(runA, 500, 600);
  const actions = planEncoders({
    coverage,
    windows: [{ from: 500, to: 530 }, { from: 100, to: 130 }],
    runs: [runA],
    ...HOST
  });
  assert.ok(actions.some((action) => action.type === "keep" && action.run === runA));
  assert.equal(actions.some((action) => action.type === "move"), false);
  const started = actions.filter((action) => action.type === "start");
  assert.equal(started.length, 1);
  assert.equal(started[0].from, 100);
});

test("the lowest thing a viewer is waiting for is reported, so a stalled plan is visible", () => {
  const coverage = new CoverageMap({ segmentCount: 100 });
  coverage.markReady(40);
  coverage.markReady(41);
  assert.equal(firstUnmetWant(coverage, [{ from: 40, to: 70 }]), 42);
  coverage.markReadyAll([42, 43, 44]);
  assert.equal(firstUnmetWant(coverage, [{ from: 40, to: 44 }]), null);
});

test("a run with no end is making what the viewers ahead of it are waiting for", () => {
  // Field, 2026-09-05: an encoder was started and killed every five seconds,
  // each producing 0-2 segments, for as long as anybody watched. A run given no
  // end carries `to = -1`, and two places read that as a number instead of as
  // "no end": the overlap test called its work unwanted, and the claim it made
  // in the coverage map was one segment long, so the plan saw the rest of the
  // film as free and started another encoder there.
  const coverage = new CoverageMap({ segmentCount: 570 });
  const run = { from: 0, to: -1, head: 3, speedX: 8, isAlive: true };
  coverage.claim(run, run.from, endOfRun(run));

  const actions = planEncoders({
    coverage,
    live: [run],
    wanted: [{ from: 0, to: 30 }],
    maxRuns: 2,
    segmentSeconds: 4,
    restartCostSec: 0.12
  });

  assert.deepEqual(
    actions.filter((action) => action.type === "stop"),
    [],
    "nothing is stopped: it is making exactly what is wanted"
  );
  assert.deepEqual(
    actions.filter((action) => action.type === "start"),
    [],
    "and nothing new is started over ground it already holds"
  );
});
