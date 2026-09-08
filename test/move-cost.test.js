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

test("nothing measured is a plain zero, and the floor is derived where the arithmetic is", () => {
  const costs = new RunCosts();

  const { firstByteWaitSec, killCostSec } = costs.seconds();
  assert.equal(firstByteWaitSec, 0, "no reading is said as none, not as a guess");
  assert.equal(killCostSec, 0);
  // There was an `Infinity` here — the cost of a move, made unaffordable until
  // something had been measured, on the reasoning that an unmeasured price must
  // not license an irreversible act. It was an exception in a model that needs
  // none: a first piece cannot appear faster than it takes to ENCODE one, and
  // how fast this host encodes is measured before any viewer exists, so the
  // floor belongs where the arithmetic is.
  assert.equal("moveCostSec" in costs.seconds(), false, "no such figure any more");
});

test("a run killed before producing anything is a lower bound on the first output", () => {
  const costs = new RunCosts();

  // Exactly what a thrash supplies: a run that lived 800 ms and finished
  // nothing. It says the first output takes AT LEAST that long, which is a fact
  // and the only reading a thrash can give — every run in one is killed before
  // it produces.
  costs.note({ livedMs: 800, dyingMs: 40 });

  const { firstByteWaitSec, killCostSec } = costs.seconds();
  assert.ok(Math.abs(firstByteWaitSec - 0.8) < 0.001, `got ${firstByteWaitSec}`);
  assert.ok(Math.abs(killCostSec - 0.04) < 0.001, `got ${killCostSec}`);
});

test("a run that produced something is measured by its first output, not its life", () => {
  const costs = new RunCosts();

  costs.note({ livedMs: 60_000, firstOutputMs: 1260, dyingMs: 100 });

  const { firstByteWaitSec } = costs.seconds();
  assert.ok(Math.abs(firstByteWaitSec - 1.26) < 0.001, `got ${firstByteWaitSec}`);
});

/**
 * The map's real shape: one segment at the viewer, doubling zones ahead down to
 * p91, and everything behind them at p1 with no deadline. Written out because a
 * fixture of two zones is not this, and the difference decides the answer: with
 * nothing stated past the viewer's own zone, a run one segment behind it is
 * compared on that zone alone and loses by a tenth of a second.
 *
 * @param {number} head - The segment the viewer is on.
 * @param {number} count
 * @returns {object[]}
 */
function mapAt(head, count) {
  const zones = [];
  if (head > 0) {
    zones.push({ from: 0, to: head - 1, priority: 1, withinSeconds: null, behind: true });
  }
  let from = head;
  let width = 1;
  let rank = 100;
  while (from < count && rank > 90) {
    const to = Math.min(count - 1, from + width - 1);
    zones.push({ from, to, priority: rank, withinSeconds: (from - head) * 4.2, behind: false });
    from = to + 1;
    width *= 2;
    rank -= 1;
  }
  if (from < count) {
    zones.push({ from, to: count - 1, priority: 90, withinSeconds: (from - head) * 4.2, behind: false });
  }
  return zones;
}

test("an encoder is left alone while the viewer is still at or before it", () => {
  // Every slide of the viewer's zone used to make standing one number behind it
  // score worse than standing in it — by ten milliseconds, which is nothing but
  // the double charge for a piece already being made. What holds now is the
  // narrower and true statement: while the viewer's own zone still contains the
  // encoder's position, it is left alone. A viewer BEFORE it is a different
  // case entirely and correctly moves it back — encoders only go forward, so
  // one standing past a viewer never reaches them.
  //
  // Once the viewer has PASSED it, moving forward is correct and happens once: a
  // run that has produced nothing in 0.8 s of a 1.26 s warm-up owes 0.46 s
  // before its piece exists, while a fresh one at the viewer's own number owes
  // 0.32 s of spawn and then the piece — so the viewer is served sooner, and the
  // number left behind is in nobody's zone.
  const coverage = new CoverageMap();
  coverage.setSegmentCount(482);
  const run = { from: 58, to: -1, head: 58, speedX: 4.45, isAlive: true, startedAt: 1_000_000 };
  coverage.claim(run, 58, -1);

  for (const viewerAt of [58]) {
    const actions = planEncoders({
      coverage,
      windows: mapAt(viewerAt, 482),
      runs: [run],
      maxRuns: 3,
      segmentSeconds: 4.2,
      speedX: 4.45,
      killCostSec: 0.04,
      // Measured on the addon host: a run started at 15:50:15.521 and its first
      // piece existed at 15:50:16.785.
      firstByteWaitSec: 1.26,
      refetchSecPerFilmSecond: 0,
      // 1.98 at 1920x1080, measured: a second encoder takes very nearly all of
      // the first's speed.
      contentionPenaltyFor: (others) => (others <= 0 ? 1 : 1.98 ** others),
      now: 1_000_000 + 800
    });

    assert.deepEqual(
      actions.filter((one) => one.type === "move"),
      [],
      `the viewer at #${viewerAt} does not cost the encoder its place`
    );
  }

  // And once they are past it, exactly one move — not one per slide.
  const past = [59, 60, 61].map((viewerAt) => planEncoders({
    coverage,
    windows: mapAt(viewerAt, 482),
    runs: [run],
    maxRuns: 3,
    segmentSeconds: 4.2,
    speedX: 4.45,
    killCostSec: 0.04,
    firstByteWaitSec: 1.26,
    refetchSecPerFilmSecond: 0,
    contentionPenaltyFor: (others) => (others <= 0 ? 1 : 1.98 ** others),
    now: 1_000_000 + 800
  }).filter((one) => one.type === "move"));

  assert.deepEqual(
    past.map((moves) => moves.length),
    [1, 1, 1],
    "one move to where the viewer now is, whichever number that is"
  );
  assert.deepEqual(
    past.map((moves) => moves[0].from),
    [59, 60, 61],
    "and it goes to the viewer's own number, not one past it"
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
    firstByteWaitSec: 1.26,
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
