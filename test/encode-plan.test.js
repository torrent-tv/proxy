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
import { contentionPenalty, penaltiesFrom } from "../services/encode/contention.js";

// WHAT A SECOND ENCODER COSTS THE FIRST — measured, never a formula.
//
// Addon host, 2026-09-03: 854x480 through libx264 `ultrafast` ran at 7.12x with
// the machine to itself, and at 4.20x and 4.16x when two ran at once. The
// penalty is read off that reading by the SAME two functions production uses,
// so nothing here invents a shape: beyond what was measured the reading is held
// rather than extrapolated.
const MEASURED_PENALTIES = penaltiesFrom(7.12, [{ others: 1, speed: 4.18 }]);
const penaltyFor = (others) => contentionPenalty(others, MEASURED_PENALTIES).penalty;

// What a start and a stop cost, measured on the same host: a spawn with its
// input open is 0.12 s there.
const RUN_COSTS = { killCostSec: 0, firstByteWaitSec: 0.12 };


/** A host that can afford two encoders, four-second segments, a cheap restart. */
// A host that has measured itself: the start and the death from its own runs,
// and what the swarm charges to fetch a second of film again. All four terms
// have to be present for the drive-or-move comparison to mean anything, and a
// host missing any of them keeps its encoders instead — which is its own check
// below rather than the shape every other check is written against.
const HOST = {
  // Measured on the addon host: a second encoder beside the first costs about
  // half its speed. Without it an extra process is free and the score always
  // wants more of them.
  contentionPenaltyFor: penaltyFor,
  // What the startup benchmark says this host encodes at, in realtimes. It is
  // measured before any viewer exists, so the plan always has a speed.
  speedX: 2,
  maxRuns: 2,
  segmentSeconds: 4,
  killCostSec: 0.5,
  firstByteWaitSec: 1,
  refetchSecPerFilmSecond: 0.25
};

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

test("two viewers a couple of numbers apart are never given the same stretch twice", () => {
  // Found by the orchestrator's own checks. Under the old design the second
  // viewer was given an encoder of their own while the run already there had
  // nowhere left to go — two processes side by side for one stretch of film.
  //
  // The model answers it by arithmetic instead of by a rule: the number the
  // second viewer stands on is due now and the encoder behind them needs six
  // seconds, so it IS late; a new one delivers it in two, so placing one is
  // worth it; and the one behind is then bounded to the two numbers it can still
  // make and retires. One encoder, and the second viewer waits four seconds
  // less. What must never happen — two of them running the same stretch — does
  // not.
  const coverage = new CoverageMap({ segmentCount: 1000 });
  const runA = run({ from: 100, to: 999, head: 100 });
  coverage.claim(runA, 100, 999);
  const actions = planEncoders({
    coverage,
    windows: [{ from: 100, to: 130 }, { from: 102, to: 132 }],
    runs: [runA],
    ...HOST
  });
  const spans = actions
    .filter((action) => action.type !== "stop")
    .map((action) => [action.from, action.to])
    .sort((left, right) => left[0] - right[0]);
  for (let index = 0; index < spans.length - 1; index += 1) {
    assert.ok(spans[index][1] < spans[index + 1][0],
      `#${spans[index][0]}..#${spans[index][1]} overlaps #${spans[index + 1][0]}`);
  }
  assert.ok(spans.some(([from, to]) => from <= 102 && (to < from || to >= 102)),
    "somebody is making what the second viewer needs");
  // How MANY is the score's answer and not a rule: with these two standing two
  // numbers apart, a second process makes the one in front wait 1.4 s longer and
  // the one behind 2.5 s less, so the pair is better off. What is fixed is that
  // they never share a stretch, which the loop above asserts.
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

test("a run that has caught up with made material is not killed for it", () => {
  // It has arrived at film somebody else made. Killing it was the old answer and
  // it is never the right one: the work is either taken past the made stretch or
  // left to drive through, and which of those depends on the score, but the
  // encoder goes on existing either way.
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
  assert.equal(actions.some((action) => action.type === "stop"), false, "not killed");
  assert.ok(
    actions.some((action) => (action.type === "keep" || action.type === "move") && action.run === runA),
    "it is still one of the encoders on this output"
  );
  // And nothing is arranged so that two of them make the same piece.
  const spans = actions
    .filter((action) => action.type !== "stop")
    .map((action) => [action.from, action.to < action.from ? Number.POSITIVE_INFINITY : action.to])
    .sort((left, right) => left[0] - right[0]);
  for (let index = 0; index < spans.length - 1; index += 1) {
    assert.ok(spans[index][1] < spans[index + 1][0], "the stretches do not overlap");
  }
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
    // From where the run stands, so the only question asked is the covered piece
    // under it. Beginning at #0 would also be asking who makes #0..#9.
    windows: [{ from: 10, to: 90 }],
    runs: [runA],
    ...HOST
  });
  assert.equal(actions.some((action) => action.type === "move"), false);
  assert.ok(actions.some((action) => action.type === "keep" && action.run === runA));
});

test("a run standing on film nobody has made is never taken away", () => {
  // The field failure this guards: 684 starts in 482 seconds on 2026-09-05,
  // because a run was moved whenever anything ahead of it had been made.
  //
  // Moving is priced rather than forbidden — a run standing ON made film may
  // well be worth restarting one number along, and the two checks above measure
  // both sides of that. What can never be worth it is moving a run that has
  // nothing made under it or ahead of it: there is no work to skip, so the move
  // buys nothing and costs a start.
  const coverage = new CoverageMap({ segmentCount: 100 });
  const runA = run({ head: 10, speedX: 2 });
  coverage.claim(runA, 0, 100);
  const actions = planEncoders({
    coverage,
    windows: [{ from: 10, to: 90 }],
    runs: [runA],
    ...HOST
  });
  assert.equal(actions.some((action) => action.type === "move"), false);
  assert.ok(actions.some((action) => action.type === "keep" && action.run === runA));
});

test("a long stretch of made film is skipped, and the swarm's price is in the reckoning", () => {
  // Driving through costs this encoder's time AND the swarm the same bytes a
  // second time. Twenty made pieces of 4 s at 1x is 80 s of encoding plus 20 s
  // of fetching, against a move priced at 0.12 + 0.5 + 3 seconds — so it skips.
  //
  // There is no separate comparison to read here: both are seconds, both are in
  // the one score, and the arrangement with the smaller total is the one taken.
  const coverage = new CoverageMap({ segmentCount: 200 });
  const runA = run({ head: 10, speedX: 1 });
  coverage.claim(runA, 0, 200);
  for (let at = 10; at < 30; at += 1) {
    coverage.markReady(at);
  }
  const actions = planEncoders({
    coverage,
    // The viewer is PAST the made stretch, so the only question is this encoder:
    // drive through twenty pieces that exist, or skip them. With a viewer at #0
    // as well, something has to cross that stretch whatever happens, and then
    // moving buys nothing — which the score says too, and is why the window
    // starts where the viewer actually is.
    windows: [{ from: 30, to: 190 }],
    runs: [runA],
    ...HOST,
    // One encoder, so the question is only about THIS one: drive through the
    // twenty pieces that exist, or skip them. With room for a second, the
    // machine simply buys one and the question never arises.
    maxRuns: 1,
    killCostSec: 0.5,
    firstByteWaitSec: 3,
    refetchSecPerFilmSecond: 0.25
  });
  const move = actions.find((action) => action.type === "move");
  assert.ok(move, "it is taken past the made film rather than left to make it again");
  assert.equal(move.from, 30, "to the first thing nobody has");
});

test("a short covered stretch is driven through rather than paid a restart for", () => {
  // One covered segment at 1x is 4 s of encoding plus 1 s of refetch, against a
  // move priced at 0.12 + 0.5 + 30 seconds on a host where the first bytes are
  // slow to come. The comparison, not a rule, decides it.
  const coverage = new CoverageMap({ segmentCount: 200 });
  const runA = run({ head: 10, speedX: 1 });
  coverage.claim(runA, 0, 200);
  coverage.markReady(10);
  const actions = planEncoders({
    coverage,
    // From where the run stands, so the only question is the covered piece under
    // it. A window starting at #0 would also be asking who makes #0..#9.
    windows: [{ from: 10, to: 190 }],
    runs: [runA],
    ...HOST,
    killCostSec: 0.5,
    firstByteWaitSec: 30,
    refetchSecPerFilmSecond: 0.25
  });
  assert.equal(actions.some((action) => action.type === "move"), false);
  assert.ok(actions.some((action) => action.type === "keep" && action.run === runA));
});

test("a run with nothing left ahead of it does not go on making nothing", () => {
  // Everything from #10 to the end exists. The encoder standing at #10 has
  // nothing to do there; whether it is stopped or taken back to the film before
  // #0 that nobody has made is the score's answer, and both are right answers.
  // What must not happen is that it stays where it is, producing nothing.
  const coverage = new CoverageMap({ segmentCount: 100 });
  const runA = run({ head: 10 });
  coverage.claim(runA, 0, 100);
  for (let index = 10; index < 100; index += 1) {
    coverage.markReady(index);
  }
  const actions = planEncoders({
    coverage,
    windows: [{ from: 0, to: 90 }],
    runs: [runA],
    ...HOST
  });
  const kept = actions.find((action) => action.type === "keep" && action.run === runA);
  assert.equal(kept, undefined, "it is not left standing on film that already exists");
  const madeAgain = actions.filter((action) => action.type !== "stop");
  for (const action of madeAgain) {
    assert.ok(action.from < 10, "and whatever is made is film nobody has");
  }
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

test("the one machine goes to whoever is due soonest, not to the smallest number", () => {
  // Urgency is a TIME in this model, so the test states one. The far zone is
  // lower in number and needed sooner; the order must come from the time.
  const coverage = new CoverageMap({ segmentCount: 1000 });
  const actions = planEncoders({
    coverage,
    windows: [
      { from: 0, to: 100, priority: 1, withinSeconds: 600 },
      { from: 500, to: 530, priority: 3, withinSeconds: 0 }
    ],
    // A run whose speed has been measured: how long an encoder takes to reach a
    // number is the whole comparison, and with nothing measured the model has no
    // ground to prefer one place over another and places once.
    runs: [run({ from: 900, to: 999, head: 900 })],
    ...HOST,
    maxRuns: 2
  });
  const started = actions.filter((action) => action.type === "start").map((action) => action.from);

  assert.deepEqual(started, [500], "the one machine goes where somebody is stopped");
});

test("two viewers far apart are both served, by however many encoders serve them soonest", () => {
  // Two encoders, or one that goes to whichever of them is worse off: the answer
  // is what a second process costs this machine, which is measured, and the
  // score works it out. What must hold is that neither of them is simply left.
  const coverage = new CoverageMap({ segmentCount: 1000 });
  const actions = planEncoders({
    coverage,
    windows: [
      { from: 0, to: 30, withinSeconds: 0 },
      { from: 800, to: 830, withinSeconds: 0 }
    ],
    runs: [run({ from: 900, to: 999, head: 900 })],
    ...HOST,
    maxRuns: 3
  });
  const spans = actions
    .filter((action) => action.type !== "stop")
    .map((action) => [action.from, action.to < action.from ? Number.POSITIVE_INFINITY : action.to]);
  assert.ok(spans.some(([from, to]) => from <= 0 && to >= 0), "the one at the beginning is served");
  for (let index = 0; index < spans.length - 1; index += 1) {
    const sorted = [...spans].sort((left, right) => left[0] - right[0]);
    assert.ok(sorted[index][1] < sorted[index + 1][0], "and no two encoders share a number");
  }
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
  // A head at #510 means #500..#509 are already made — that is what a head is.
  // Left unsaid, the map believes a viewer is waiting on ten pieces nobody has,
  // and moving the encoder back to make them is then the right answer.
  for (let index = 500; index < 510; index += 1) {
    coverage.markReady(index);
  }
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
  coverage.setReady([40, 41]);
  assert.equal(firstUnmetWant(coverage, [{ from: 40, to: 70 }]), 42);
  coverage.setReady([40, 41, 42, 43, 44]);
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
    ...RUN_COSTS
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

test("spare budget IS spent on the rest of the film, once nobody is waiting", () => {
  // The user's own correction: film nobody is waiting for still has value,
  // because a viewer seeking back into a part that exists starts playing at
  // once. So what the machine has spare goes to finishing the file.
  //
  // "Once nobody is waiting" is not a condition written anywhere — it falls out
  // of the score. A second process costs the first the measured share of the
  // machine, so while somebody is stopped on a piece, adding one delays that
  // piece and the first term refuses it. Here the near film is already made,
  // nothing is late in either arrangement, and the two that finish the rest
  // sooner win.
  const coverage = new CoverageMap({ segmentCount: 400 });
  for (let index = 0; index <= 9; index += 1) {
    coverage.markReady(index);
  }
  const actions = planEncoders({
    coverage,
    windows: [
      { from: 0, to: 9, priority: 32, withinSeconds: 0 },
      { from: 10, to: 399, priority: 20, withinSeconds: 40 }
    ],
    runs: [],
    ...HOST,
    maxRuns: 4
  });
  const started = actions.filter((action) => action.type === "start");

  assert.ok(started.length > 1, "the machine does not stand idle while film is unmade");
  const spans = started
    .map((action) => [action.from, action.to])
    .sort((left, right) => left[0] - right[0]);
  for (let index = 0; index < spans.length - 1; index += 1) {
    assert.ok(spans[index][1] < spans[index + 1][0], "and no two of them share a number");
  }
});


test("two encoders never share a segment number", () => {
  // The whole of what went wrong in the field: two encoders writing one name.
  const coverage = new CoverageMap({ segmentCount: 400 });
  const actions = planEncoders({
    coverage,
    windows: [{ from: 0, to: 399, priority: 32 }],
    runs: [],
    ...HOST,
    maxRuns: 4
  });
  const spans = actions
    .filter((action) => action.type === "start")
    .map((action) => ({ from: action.from, to: action.to }))
    .sort((left, right) => left.from - right.from);

  for (let index = 0; index < spans.length - 1; index += 1) {
    assert.ok(
      spans[index].to < spans[index + 1].from,
      `#${spans[index].from}..#${spans[index].to} overlaps #${spans[index + 1].from}`
    );
  }
});
