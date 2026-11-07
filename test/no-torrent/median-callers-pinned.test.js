/**
 * @file What the median's callers decide today, pinned before they are moved
 * onto `utils/median.js` (torrent-tv/meta#294). Must pass before and after.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { medianOf, scatterOf, movedBeyondScatter } from "../../services/encode/learned-median.js";
import { RunCosts } from "../../services/encode/run-costs.js";

test("learned-median: true median, finite readings only, null when empty", () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 2.5);
  assert.equal(medianOf([1, Number.NaN, 3, Infinity]), 2);
  assert.equal(medianOf([]), null);
  assert.equal(medianOf([Number.NaN]), null);
});

test("learned-median: scatter is the median distance, and a move is judged against it", () => {
  assert.equal(scatterOf([8, 10, 12]), 2);
  assert.equal(scatterOf([1, 2, 3, 4]), 1);
  assert.equal(scatterOf([]), null);
  assert.equal(movedBeyondScatter(10, 11, [8, 10, 12]), false);
  assert.equal(movedBeyondScatter(10, 13, [8, 10, 12]), true);
});

test("run-costs: an output's open is the median of its readings, the mean of the middles when even", () => {
  const odd = new RunCosts();
  [9, 1, 5].forEach((seconds) => odd.noteOpen("picture", seconds));
  assert.deepEqual(odd.openOf("picture"), { seconds: 5, measured: true });

  const even = new RunCosts();
  [2, 4, 6, 10].forEach((seconds) => even.noteOpen("picture", seconds));
  assert.deepEqual(even.openOf("picture"), { seconds: 5, measured: true });
});

test("run-costs: dying and first-output costs are medians, in seconds", () => {
  const costs = new RunCosts();
  costs.note({ dyingMs: 1000, firstOutputMs: 2000 });
  costs.note({ dyingMs: 3000, firstOutputMs: 4000 });
  costs.note({ dyingMs: 8000, firstOutputMs: 9000 });
  assert.deepEqual(costs.seconds(), { killCostSec: 3, firstByteWaitSec: 4, samples: 3 });
  costs.note({ dyingMs: 5000, firstOutputMs: 6000 });
  assert.deepEqual(costs.seconds(), { killCostSec: 4, firstByteWaitSec: 5, samples: 4 }, "mean of the two middles");
});

test("run-costs: nothing measured is zero seconds", () => {
  assert.deepEqual(new RunCosts().seconds(), { killCostSec: 0, firstByteWaitSec: 0, samples: 0 });
});
