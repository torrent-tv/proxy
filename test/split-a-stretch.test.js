/**
 * @file Where a second encoder joins a stretch, and whether it is worth having.
 *
 * Both halves are arithmetic and neither was asked before. The stretch used to
 * be halved, unconditionally:
 *
 *     widestFrom = from + Math.floor(Math.min(room, to - from + 1) / 2)
 *
 * Halving IS the answer when both encoders are fresh and owe the same. It is not
 * when one of them is already partway through a piece, and it never asked the
 * other question at all — whether two encoders under this host's measured
 * contention beat one at full speed.
 *
 * The derivation. A stretch of unmade film runs from `from` to `to`; whoever is
 * already on it stands at `from` and owes `w` before the piece under it exists;
 * a fresh one placed at `x` owes `d` — its start and then a whole piece — and
 * both then work at the rate two encoders leave each other:
 *
 *     the one there closes [from, x-1]:  w + (x - 1 - from) / r   rises with x
 *     the fresh one closes [x, to]:      d + (to - x)     / r     falls with x
 *
 *     x* = (from + to + 1) / 2  +  (d - w) * r / 2
 *
 * The shift is `firstByteWait / (2 * perPiece)` pieces, so it depends on how
 * long a piece takes here: 0.24 of a piece at 4.45x on a 4.2 s grid, but 0.96 at
 * 8.9x and 2.14 at 20x — a whole segment and more on the copy branch, where a
 * piece is short and a start is not. Measuring only the re-encode rate
 * understated it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { planEncoders } from "../services/encode/EncodePlan.js";
import { CoverageMap } from "../services/encode/CoverageMap.js";

const SEGMENT_SECONDS = 4.2;
const LAST = 199;

/**
 * One encoder on a long stretch nobody has made, and room for more.
 *
 * @param {{ speedX: number, penalty: number, head?: number, ageMs?: number,
 *   maxRuns?: number }} params
 * @returns {{ actions: object[], run: object }}
 */
function planFor({ speedX, penalty, head = 0, ageMs = 60_000, maxRuns = 3, runs = null }) {
  const coverage = new CoverageMap({ segmentCount: LAST + 1 });
  const run = { from: 0, to: -1, head, speedX, isAlive: true, startedAt: 1_000_000 };
  const live = runs ?? [run];
  for (const one of live) {
    coverage.claim(one, one.from, one.to);
  }
  return {
    run,
    actions: planEncoders({
      coverage,
      // One zone over the whole film, due now, so nothing but the arithmetic of
      // sharing it decides anything.
      windows: [{ from: 0, to: LAST, priority: 100, withinSeconds: 0, behind: false }],
      runs: live,
      maxRuns,
      segmentSeconds: SEGMENT_SECONDS,
      speedX,
      killCostSec: 0.04,
      firstByteWaitSec: 0.9,
      moveCostSec: 0.94,
      refetchSecPerFilmSecond: 0,
      // Measured on the addon host: 1.70 at 854x480, 1.98 at 1920x1080. Raised
      // to the power of how many others there are, so a third costs again.
      contentionPenaltyFor: (others) => (others <= 0 ? 1 : penalty ** others),
      now: 1_000_000 + ageMs
    })
  };
}

test("one encoder that reaches everything in time is left to do it alone", () => {
  // A zone whose deadline GROWS with distance — which is what the map states,
  // one segment at a time — is comfortably served by one encoder at 4.45x: #199
  // is due in 835 s and arrives in 189 s. So there is no position to fill and
  // nothing to split, whatever the budget says.
  //
  // Measured rather than assumed: this is what the plan answers, and the test
  // was written expecting two encoders before it was run.
  const { actions } = planFor({ speedX: 4.45, penalty: 1, maxRuns: 3 });

  assert.deepEqual(
    actions.map((one) => `${one.type} #${one.from}..#${one.to}`),
    ["keep #0..#-1"],
    "one encoder, its road to the end of the film"
  );
});

test("a stretch nobody is on is split at the middle, and the halves bound each other", () => {
  // Both encoders are fresh, so both owe the same and `d - w` is zero: the
  // meeting point is the midpoint, which is what halving always said. What is
  // new is that each one's road ENDS where the next begins, so neither writes
  // into the other's names.
  const actions = planFor({ speedX: 4.45, penalty: 1, maxRuns: 2, runs: [] }).actions;

  assert.deepEqual(
    actions.map((one) => `${one.type} #${one.from}..#${one.to}`),
    ["start #0..#100", "start #101..#199"],
    "0..199 halved at 100"
  );
});

test("a third encoder halves the widest half that is left", () => {
  const actions = planFor({ speedX: 4.45, penalty: 1, maxRuns: 3, runs: [] }).actions;

  assert.deepEqual(
    actions.map((one) => `${one.type} #${one.from}..#${one.to}`),
    ["start #0..#50", "start #51..#100", "start #101..#199"],
    "the first half is halved again, greedily, widest first"
  );
});

test("a stretch of one piece is not split at all", () => {
  const coverage = new CoverageMap({ segmentCount: 2 });
  const actions = planEncoders({
    coverage,
    windows: [{ from: 0, to: 0, priority: 100, withinSeconds: 0, behind: false }],
    runs: [],
    maxRuns: 3,
    segmentSeconds: SEGMENT_SECONDS,
    speedX: 8.9,
    killCostSec: 0.04,
    firstByteWaitSec: 0.9,
    moveCostSec: 0.94,
    refetchSecPerFilmSecond: 0,
    contentionPenaltyFor: () => 1,
    now: 1_000_000
  });

  assert.equal(
    actions.filter((one) => one.type === "start").length,
    1,
    "there is nothing to share"
  );
});
