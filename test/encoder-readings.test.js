/**
 * @file What two readings of a running encoder say about its speed.
 *
 * The case this exists for is a COPY. ffmpeg's own cumulative `speed=` counts
 * the seconds the look-ahead cap keeps the encoder stopped, and a copy is
 * stopped for most of its life — reaching the cap in about fifteen seconds and
 * then waiting a minute. Read cumulatively, a copy running at 8x reports 1.6x,
 * which filed as the price of copying would refuse rungs on a measurement of a
 * pause.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { speedFromReadings } from "../services/encoder-readings.js";

const at = (seconds, processedSeconds) => ({ takenAt: seconds * 1000, processedSeconds });

test("a copy producing eight seconds of video per second reads as eight", () => {
  assert.equal(speedFromReadings(at(10, 100), at(15, 140), 3), 8);
});

test("a stretch too short to divide by says nothing", () => {
  assert.equal(speedFromReadings(at(10, 100), at(11, 108), 3), null);
});

test("a run that produced nothing between the readings says nothing", () => {
  // What a repositioned run looks like before it reaches its new start.
  assert.equal(speedFromReadings(at(10, 100), at(20, 100), 3), null);
});

test("a run that went BACKWARDS says nothing rather than a negative speed", () => {
  assert.equal(speedFromReadings(at(10, 200), at(20, 100), 3), null);
});

test("a missing reading is not an answer", () => {
  assert.equal(speedFromReadings(null, at(20, 100), 3), null);
  assert.equal(speedFromReadings(at(10, 100), null, 3), null);
});

test("the pair is judged on wall clock, so a pause between them is the caller's problem", () => {
  // Deliberate: this function cannot see a pause. The session drops its
  // previous reading whenever the encoder is stopped or restarted, which is
  // what makes every surviving pair an uninterrupted stretch.
  assert.equal(speedFromReadings(at(0, 0), at(60, 60), 3), 1);
});
