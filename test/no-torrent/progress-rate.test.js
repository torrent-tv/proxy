import assert from "node:assert/strict";
import test from "node:test";
import { ProgressRate } from "../../services/viewer/playback-readiness.js";

test("progress rate waits for an advance and measures produced media over elapsed wall time", () => {
  const rate = new ProgressRate(120);
  assert.equal(rate.note(1_000, 0, 0), null);
  const measured = rate.note(3_000, 12, 0);
  assert.equal(measured.count, 1);
  assert.equal(measured.lastValue, 6);
});

test("unchanged progress keeps the original time so a source wait lowers the measured rate", () => {
  const rate = new ProgressRate(120);
  rate.note(1_000, 0, 0);
  rate.note(2_000, 0, 0);
  const measured = rate.note(6_000, 4, 0);
  assert.equal(measured.count, 1);
  assert.equal(measured.lastValue, 0.8);
});

test("a seek resets the progress rate before measuring the new target", () => {
  const rate = new ProgressRate(120);
  rate.note(1_000, 0, 0);
  assert.equal(rate.note(2_000, 4, 0).lastValue, 4);
  assert.equal(rate.note(3_000, 96, 96), null);
  const measured = rate.note(4_000, 100, 96);
  assert.equal(measured.count, 1);
  assert.equal(measured.lastValue, 4);
});
