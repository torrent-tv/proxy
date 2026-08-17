/**
 * @file The price of a second job, with the readings it was derived from.
 *
 * Measured on the addon host 2026-08-18: decoding the same clip ran at 2.20x
 * alone, 0.85x with one encoder beside it and 0.60x with two. The budget has
 * been adding independent prices, and these say two jobs that each fit alone do
 * not fit together.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { contentionPenalty, costWithContention, penaltiesFrom } from "../services/contention.js";

/** The addon host's own readings. */
const ALONE = 2.2;
const BESIDE = [
  { others: 1, speed: 0.85 },
  { others: 2, speed: 0.6 }
];

test("the penalties are the ratios of the measured speeds", () => {
  const penalties = penaltiesFrom(ALONE, BESIDE);

  assert.ok(penalties);
  // 2.2 / 0.85 = 2.59: the same work costs two and a half times more with one
  // encoder beside it.
  assert.ok(Math.abs(penalties.get(1) - 2.588) < 0.01, `${penalties.get(1)}`);
  assert.ok(Math.abs(penalties.get(2) - 3.667) < 0.01, `${penalties.get(2)}`);
});

test("alone on the machine is what the benchmarks measure, so nothing is corrected", () => {
  const penalties = penaltiesFrom(ALONE, BESIDE);
  const answer = contentionPenalty(0, penalties);
  assert.equal(answer.penalty, 1);
  assert.equal(answer.measured, true);
  assert.equal(costWithContention(0.45, 0, penalties), 0.45);
});

test("a cost beside one other job is the measured multiple, not the sum of two prices", () => {
  const penalties = penaltiesFrom(ALONE, BESIDE);
  // Decoding priced at 0.45 s/s alone becomes 1.17 s/s beside an encoder —
  // which is what the field measured (1.18), and what additivity cannot say.
  const corrected = costWithContention(0.45, 1, penalties);
  assert.ok(Math.abs(corrected - 1.165) < 0.01, `${corrected}`);
});

test("beyond the readings it holds the largest instead of extrapolating", () => {
  const penalties = penaltiesFrom(ALONE, BESIDE);
  const four = contentionPenalty(4, penalties);
  assert.equal(four.penalty, penalties.get(2), "two readings say nothing about a fourth job");
  assert.equal(four.from, 2, "and the answer says which reading it came from");
  assert.equal(four.measured, true);
});

test("with nothing measured the prediction is left alone, not guessed at", () => {
  const answer = contentionPenalty(1, null);
  assert.equal(answer.penalty, 1);
  assert.equal(answer.measured, false, "the caller must be able to say the figure is uncorrected");
  assert.equal(costWithContention(0.45, 1, null), 0.45);
  assert.equal(contentionPenalty(1, new Map()).measured, false);
});

test("a machine that got faster for being busier has no penalty to measure", () => {
  // Noise on a fast host, not a discovery. Measured on the developer's desktop,
  // the difference between one and two jobs is inside the scatter.
  const penalties = penaltiesFrom(20, [{ others: 1, speed: 21 }]);
  assert.equal(penalties.get(1), 1);
});

test("readings that are not measurements are left out", () => {
  assert.equal(penaltiesFrom(0, BESIDE), null, "every penalty is relative to the alone reading");
  assert.equal(penaltiesFrom(ALONE, []), null);
  assert.equal(penaltiesFrom(ALONE, [{ others: 0, speed: 2 }]), null, "zero others is not a penalty");
  assert.equal(penaltiesFrom(ALONE, [{ others: 1, speed: Number.NaN }]), null);
});
