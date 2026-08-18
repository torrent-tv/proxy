/**
 * @file Adopting a new median only when it has moved further than the readings
 * behind it disagree with each other.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { medianOf, movedBeyondScatter, scatterOf } from "../services/learned-median.js";

test("the median is the middle reading, and the mean of the two middle ones", () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 2.5);
  assert.equal(medianOf([]), null);
  assert.equal(medianOf([Number.NaN]), null);
});

test("the scatter is the median distance from the middle", () => {
  assert.equal(scatterOf([10, 10, 10]), 0);
  assert.equal(scatterOf([8, 10, 12]), 2);
  assert.equal(scatterOf([]), null);
});

test("the first answer is always adopted", () => {
  assert.equal(movedBeyondScatter(null, 5, [5]), true);
});

test("a move smaller than the readings' own disagreement is the same answer", () => {
  assert.equal(movedBeyondScatter(10, 11, [8, 10, 12]), false);
});

test("a move larger than that disagreement is adopted", () => {
  assert.equal(movedBeyondScatter(10, 13, [8, 10, 12]), true);
});

test("readings that all agree let any change through", () => {
  assert.equal(movedBeyondScatter(10, 10.4, [10, 10, 10]), true);
  assert.equal(movedBeyondScatter(10, 10, [10, 10, 10]), false);
});
