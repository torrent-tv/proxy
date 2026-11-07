/**
 * @file The one median (torrent-tv/meta#294, acceptance 1).
 *
 * `utils/median.js` owns three functions:
 * - `medianOf(values)`: the true median. Non-finite readings are ignored, null
 *   when none remain, the two middle readings averaged on an even count.
 * - `scatterOf(values)`: the median distance from that median (moved here from
 *   encode/learned-median.js, behaviour unchanged).
 * - `upperMiddleOf(values)`: the element at index floor(n / 2) of the sorted
 *   finite readings, never an average, so an integer count stays an integer
 *   (what `slackPieces` always did). Null when none remain.
 *
 * `encode/learned-median.js` re-exports `medianOf` and `scatterOf`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { medianOf, scatterOf, upperMiddleOf } from "../../utils/median.js";
import * as learned from "../../services/encode/learned-median.js";

test("the median of an odd count is the middle reading, whatever the order", () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([7]), 7);
});

test("the median of an even count is the mean of the two middle readings", () => {
  assert.equal(medianOf([1, 2, 3, 4]), 2.5);
  assert.equal(medianOf([10, 1]), 5.5);
  assert.equal(medianOf([1, 2]), 1.5, "not rounded");
});

test("no readings have no median: null, not NaN and not zero", () => {
  assert.equal(medianOf([]), null);
  assert.equal(medianOf(undefined), null);
});

test("readings that are not finite numbers are left out", () => {
  assert.equal(medianOf([Number.NaN]), null);
  assert.equal(medianOf([Number.NaN, Infinity, -Infinity]), null);
  assert.equal(medianOf([1, Number.NaN, 3, Infinity]), 2);
  assert.equal(medianOf([Number.NaN, 5, 9, 1]), 5);
});

test("the median does not reorder what it was given", () => {
  const readings = [3, 1, 2];
  medianOf(readings);
  assert.deepEqual(readings, [3, 1, 2]);
});

test("the scatter is the median distance from the median", () => {
  assert.equal(scatterOf([10, 10, 10]), 0);
  assert.equal(scatterOf([8, 10, 12]), 2);
  assert.equal(scatterOf([1, 2, 3, 4]), 1, "distances 1.5 .5 .5 1.5 -> 1");
  assert.equal(scatterOf([]), null);
  assert.equal(scatterOf([Number.NaN]), null);
  assert.equal(scatterOf([8, Number.NaN, 10, 12]), 2);
});

test("the upper middle is the element at floor(n / 2) of the sorted readings", () => {
  assert.equal(upperMiddleOf([3, 1, 2]), 2);
  assert.equal(upperMiddleOf([1, 2, 3, 4]), 3, "the upper of the two middles, not their mean");
  assert.equal(upperMiddleOf([4, 1]), 4);
  assert.equal(upperMiddleOf([9]), 9);
});

test("the upper middle of nothing is null, and non-finite readings are left out", () => {
  assert.equal(upperMiddleOf([]), null);
  assert.equal(upperMiddleOf([Number.NaN]), null);
  assert.equal(upperMiddleOf([1, Number.NaN, 2, 3, Infinity]), 2);
});

test("the upper middle keeps an integer count an integer", () => {
  assert.ok(Number.isInteger(upperMiddleOf([1, 2, 3, 4])));
  assert.notEqual(upperMiddleOf([1, 2, 3, 4]), medianOf([1, 2, 3, 4]));
});

test("learned-median re-exports the same functions", () => {
  assert.equal(learned.medianOf, medianOf);
  assert.equal(learned.scatterOf, scatterOf);
});
