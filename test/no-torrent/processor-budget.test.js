/**
 * @file The one owner of what the processor gives the encoders answers what
 * the readings it took over answered (torrent-tv/meta#180, phase 2).
 *
 * The readings are recorded ones: the addon host on 2026-08-17 (`ffmpeg=56%
 * proxy=20% system=99%`), the same host idle at 24 % busy with both encoders
 * suspended (2026-08-15), and the contention penalties measured there on
 * 2026-08-18 (2.6x beside one job, 3.7x beside two).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { availableShareFrom, correctForAvailability, leftForEncoders } from "../../services/encode/available-share.js";
import { contentionPenalty } from "../../services/encode/contention.js";
import { ProcessorBudget } from "../../services/encode/ProcessorBudget.js";

const READINGS = [
  availableShareFrom({ systemBusy: 0.99, encoderShare: 0.56, proxyShare: 0.20 }),
  availableShareFrom({ systemBusy: 0.24, encoderShare: 0, proxyShare: 0.17 }),
  availableShareFrom({}),
  undefined
];
const PENALTIES = new Map([[1, 2.6], [2, 3.7]]);

test("every reading gives the share, the corrected speed and the penalty the free functions give", () => {
  for (const reading of READINGS) {
    const budget = new ProcessorBudget({ reading: () => reading, penalties: PENALTIES });
    assert.equal(budget.availability(), reading ?? null);
    assert.equal(budget.left(), leftForEncoders(reading));
    for (const speed of [0, 0.5, 1.83, 7.12]) {
      assert.equal(budget.speedOf(speed), correctForAvailability(speed, reading));
    }
    for (const others of [0, 1, 2, 3]) {
      assert.deepEqual(budget.penaltyFor(others), contentionPenalty(others, PENALTIES));
    }
  }
});

test("the reading is taken at the question, not when the budget was made", () => {
  let reading;
  const budget = new ProcessorBudget({ reading: () => reading });
  assert.equal(budget.availability(), null);
  reading = READINGS[0];
  assert.equal(budget.left(), leftForEncoders(READINGS[0]));
});

test("penalties not measured stay unmeasured, and a new measurement replaces them", () => {
  const budget = new ProcessorBudget({ reading: () => undefined, penalties: "not a map" });
  assert.equal(budget.penalties, null);
  assert.deepEqual(budget.penaltyFor(1), { penalty: 1, measured: false, from: 0 });
  budget.penalties = PENALTIES;
  assert.deepEqual(budget.penaltyFor(1), contentionPenalty(1, PENALTIES));
});

test("a budget with no reading to take is refused", () => {
  assert.throws(() => new ProcessorBudget({}), /requires reading/);
});
