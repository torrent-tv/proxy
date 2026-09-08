/**
 * @file What moving a running encoder costs, and what the plan does while
 * nobody has measured it.
 *
 * Field 2026-09-08: 39 moves in one session, 24 of them between three adjacent
 * numbers — #58 to #59, #59 to #58, #58 to #60, #60 to #58, six times each,
 * about 0.8 s apart — while the viewer's picture stood still for 116.7 s in
 * three interruptions, the worst of them 91.8 s. The zone the viewer's own
 * position defines slides forward one number at a time, and every slide made
 * standing one number behind it score worse than standing in it.
 *
 * THREE FAULTS IN THE ARITHMETIC, and no threshold anywhere. There was one for
 * a while — "a move must beat staying by at least what moving costs" — and it
 * was a prop under a comparison that was wrong rather than indifferent. It is
 * gone.
 *
 * 1. **A body was charged a whole piece for the one it was already making.**
 *    `arrival = delay + (index - at + 1) / rate` is right for a body that does
 *    not exist yet and wrong for a run 0.8 s into a 0.9 s piece. `delaySec` is
 *    now when the body finishes the piece it STANDS ON, so from #58 reaching #59
 *    costs 0.14 + 0.94 = 1.08 s against 1.88 s for a kill and a cold start — a
 *    decision by eight hundred milliseconds, where the double charge had made it
 *    a coin flip lost by ten.
 * 2. **The piece was priced at the unpenalised rate** while arrivals used the
 *    penalised one, so every extra body looked cheaper than it is and the plan
 *    bought a second encoder where one served. One rate, the one in force.
 * 3. **`withinSeconds: null` was read through `Number()`**, where it is 0, so
 *    the film BEHIND the viewers was due immediately and was the most urgent
 *    material in the file. It bought encoders and it took the run standing in
 *    front of the viewer, because that run was the nearest body to it.
 *
 * And what a move costs is `Infinity` until something has been measured, because
 * a move is irreversible while leaving the encoder alone is always available. A
 * run killed before producing anything is a measurement too — a lower bound on
 * the first output — which is the only reading a thrash can supply.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RunCosts } from "../services/encode/run-costs.js";
import { planEncoders } from "../services/encode/EncodePlan.js";
import { CoverageMap } from "../services/encode/CoverageMap.js";

test("nothing measured means a move is refused, not priced at zero", () => {
  const costs = new RunCosts();

  const { moveCostSec, firstByteWaitSec, killCostSec } = costs.seconds();
  assert.equal(moveCostSec, Number.POSITIVE_INFINITY, "moving is not free while unpriced");
  // Placing one where there is none is the OTHER question, and it has no
  // alternative: the film gets made or it does not.
  assert.equal(firstByteWaitSec, 0, "placing an encoder is not blocked by an unknown price");
  assert.equal(killCostSec, 0);
});

test("a run killed before producing anything is a lower bound on the first output", () => {
  const costs = new RunCosts();

  // Exactly what a thrash supplies: a run that lived 800 ms and finished
  // nothing. It says the first output takes AT LEAST that long, which is a fact.
  costs.note({ livedMs: 800, dyingMs: 40 });

  const { moveCostSec } = costs.seconds();
  assert.ok(Number.isFinite(moveCostSec), "one killed run is enough to stop the blindness");
  assert.ok(Math.abs(moveCostSec - 0.84) < 0.001, `got ${moveCostSec}`);
});

test("a run that produced something is measured by its first output, not its life", () => {
  const costs = new RunCosts();

  costs.note({ livedMs: 60_000, firstOutputMs: 900, dyingMs: 100 });

  const { moveCostSec, firstByteWaitSec } = costs.seconds();
  assert.ok(Math.abs(firstByteWaitSec - 0.9) < 0.001, `got ${firstByteWaitSec}`);
  assert.ok(Math.abs(moveCostSec - 1.0) < 0.001, `got ${moveCostSec}`);
});

test("the zone sliding one number does not move an encoder that is already reaching it", () => {
  // The field shape exactly: a run standing at #58 with the viewer's urgent zone
  // sliding #58..#59 → #59..#60. Driving through one segment costs the encoder a
  // fraction of a second; moving costs a kill and a cold start.
  const coverage = new CoverageMap();
  coverage.setSegmentCount(482);
  const run = { from: 58, to: 481, head: 58, speedX: 4.45, isAlive: true };
  coverage.claim(run, 58, 481);

  const actions = planEncoders({
    coverage,
    windows: [
      { from: 0, to: 57, priority: 1, withinSeconds: null, behind: true },
      { from: 59, to: 60, priority: 100, withinSeconds: 0, behind: false }
    ],
    runs: [run],
    maxRuns: 3,
    segmentSeconds: 4.2,
    speedX: 4.45,
    // Measured on this host: killing takes 40 ms, a fresh encoder's first piece
    // 900 ms. Against that, driving one segment at 4.45x costs 0.94 s — so the
    // two are close, and what settles it is that the move ALSO has to encode
    // the same segment afterwards.
    killCostSec: 0.04,
    firstByteWaitSec: 0.9,
    moveCostSec: 0.94,
    refetchSecPerFilmSecond: 0,
    contentionPenaltyFor: () => 1
  });

  assert.deepEqual(
    actions.filter((one) => one.type === "move"),
    [],
    "a run one number behind the zone is already on its way into it"
  );
});

test("a move that genuinely saves the viewer time still happens", () => {
  // The other half: the viewer jumped fourteen segments ahead, and driving there
  // at 4.45x would take 13 s while a cold start takes 0.94 s. Refusing this
  // would be the opposite fault.
  const coverage = new CoverageMap();
  coverage.setSegmentCount(482);
  const run = { from: 0, to: 481, head: 44, speedX: 4.45, isAlive: true };
  coverage.claim(run, 0, 481);

  const actions = planEncoders({
    coverage,
    windows: [{ from: 58, to: 59, priority: 100, withinSeconds: 0, behind: false }],
    runs: [run],
    maxRuns: 3,
    segmentSeconds: 4.2,
    speedX: 4.45,
    killCostSec: 0.04,
    firstByteWaitSec: 0.9,
    moveCostSec: 0.94,
    refetchSecPerFilmSecond: 0,
    contentionPenaltyFor: () => 1
  });

  // WHERE the encoder ends up, not how it got there: the run at #44 reaches
  // nothing anybody waits for, so the plan may either take it to #58 or stop it
  // and start one there. Both are one process at #58, and which is cheaper is
  // the measured difference between a kill and a cold start.
  const placed = actions
    .filter((one) => one.type === "move" || one.type === "start")
    .map((one) => one.from);
  assert.deepEqual(placed, [58], "fourteen segments of driving is worth a cold start");
});
