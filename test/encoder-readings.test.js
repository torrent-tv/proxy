/**
 * @file What two work samples of a running encoder say about its speed.
 *
 * The cases this exists for: a copy whose cumulative speed counts the time it
 * was stopped, and a run whose input waited for the swarm (field 2026-10-01: a
 * copy read 0.21x after waiting 32.93 s and 43.91 s for two pieces). A work
 * sample states the run's own working time, so neither enters the speed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { RunClock } from "../services/encode/RunClock.js";
import { speedFromWork } from "../services/encode/encoder-readings.js";

const sample = (at, producedSeconds, workingMs) => ({ at, producedSeconds, workingMs });

test("film made over the run's own work is the speed", () => {
  assert.equal(speedFromWork(sample(10_000, 100, 5_000), sample(15_000, 140, 10_000)), 8);
});

test("a stretch with nothing made says nothing", () => {
  assert.equal(speedFromWork(sample(10_000, 100, 5_000), sample(20_000, 100, 15_000)), null);
});

test("a run that went backwards says nothing rather than a negative speed", () => {
  assert.equal(speedFromWork(sample(10_000, 200, 5_000), sample(20_000, 100, 15_000)), null);
});

test("a missing sample is not an answer", () => {
  assert.equal(speedFromWork(null, sample(20_000, 100, 1_000)), null);
  assert.equal(speedFromWork(sample(10_000, 100, 1_000), null), null);
});

test("waiting for the input and being stopped are not working time", () => {
  let now = 0;
  const clock = new RunClock({ now: () => now });
  now = 2_000;
  clock.inputWaitBegins();
  now = 34_930; // the field's 32.93 s wait for one piece
  clock.inputWaitEnds();
  now = 36_000;
  clock.stopped();
  now = 50_000;
  clock.continued();
  now = 51_000;
  assert.equal(clock.workingMs(), 2_000 + 1_070 + 1_000);
});

test("two inputs waiting at once, or a wait while stopped, are idle once", () => {
  let now = 0;
  const clock = new RunClock({ now: () => now });
  clock.inputWaitBegins();
  now = 1_000;
  clock.inputWaitBegins();
  clock.stopped();
  now = 3_000;
  clock.inputWaitEnds();
  clock.continued();
  now = 4_000;
  clock.inputWaitEnds();
  now = 5_000;
  assert.equal(clock.workingMs(), 1_000);
  // An ongoing wait is idle up to the moment asked.
  clock.inputWaitBegins();
  now = 6_000;
  assert.equal(clock.workingMs(), 1_000);
});
