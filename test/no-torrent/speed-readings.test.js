/**
 * @file Every speed reading of an output's runs reaches the start forecast
 * (torrent-tv/meta#178). Plain values; no torrent, no encoder.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SpeedReadings } from "../../services/encode/SpeedReadings.js";
import { forecastRate, rateSummaryOf } from "../../services/viewer/playback-readiness.js";

const harmonic = (values) => values.length / values.reduce((sum, value) => sum + 1 / value, 0);

test("processing service uses total media work over active time regardless of piece partition", () => {
  for (const samples of [
    [[1, 1], [9, 3]],
    [[1, 1], [3, 1], [6, 2]]
  ]) {
    const readings = new SpeedReadings(120);
    const output = {};
    for (const [index, [workSeconds, workingSeconds]] of samples.entries()) {
      readings.note(output, { at: index * 40_000, speed: workSeconds / workingSeconds,
        workSeconds, workingSeconds });
    }
    const summary = rateSummaryOf(readings.windowOf(output));
    assert.equal(summary.workSeconds, 10);
    assert.equal(summary.workingSeconds, 4);
    assert.equal(summary.spanSeconds, (samples.length - 1) * 40,
      "wall-clock observation span remains distinct from active processing time");
    assert.equal(forecastRate(summary, 120_000, 0, "piece"), 10 / 4,
      "ten seconds of media took four seconds of active processing");
  }
});

test("readings of runs that ended between two polls reach the forecast", () => {
  // r37 on Home Assistant: the runs measured 0.78, 1.80, 2.25, 2.84 and
  // 2.69x; taking the newest reading of a live run at each poll, the forecast
  // got 0.78 and 2.69x, because runs of three pieces ended between polls.
  const output = {};
  const readings = new SpeedReadings(120);
  const at = (s) => 1_000_000 + s * 1000;
  for (const [speed, s] of [[0.78, 27.36], [1.8, 33.0], [2.25, 40.3], [2.84, 41.8], [2.69, 46.7]]) {
    readings.note(output, { speed, at: at(s) });
  }
  const summary = rateSummaryOf(readings.windowOf(output));
  assert.equal(summary.count, 5);
  assert.ok(Math.abs(summary.harmonicValue - harmonic([0.78, 1.8, 2.25, 2.84, 2.69])) < 1e-12);
});

test("two runs of one output told out of order, and in one millisecond, are all kept in the order taken", () => {
  // Each reading carries the time of its own run's last progress report, so
  // the run that reports second can have measured first.
  const output = {};
  const readings = new SpeedReadings(120);
  readings.note(output, { speed: 2, at: 101 });
  const before = rateSummaryOf(readings.windowOf(output));
  readings.note(output, { speed: 1, at: 100 });
  readings.note(output, { speed: 4, at: 101 });
  assert.deepEqual(readings.windowOf(output).map(r => [r.at, r.speed]), [[100, 1], [101, 2], [101, 4]]);
  const after = rateSummaryOf(readings.windowOf(output));
  assert.equal(before.count, 1);
  assert.equal(after.count, 3, "the later-told, earlier-taken reading is not lost, nor one of the same millisecond");
  assert.ok(Math.abs(after.harmonicValue - harmonic([1, 2, 4])) < 1e-12);
  assert.equal(after.lastValue, 4);
});

test("a reading older than the horizon is not kept, and other outputs are their own", () => {
  const readings = new SpeedReadings(120);
  const picture = {}, sound = {};
  readings.note(picture, { speed: 1, at: 0 });
  readings.note(picture, { speed: 2, at: 60_000 });
  readings.note(picture, { speed: 3, at: 200_000 });
  readings.note(sound, { speed: 90, at: 200_000 });
  assert.deepEqual(readings.windowOf(picture).map(r => r.speed), [2, 3], "the newest one before the horizon stays, as the trend keeps it");
  assert.deepEqual(readings.windowOf(sound).map(r => r.speed), [90]);
  readings.note(picture, { speed: 0, at: 210_000 });
  readings.note(picture, null);
  assert.deepEqual(readings.windowOf(picture).map(r => r.speed), [2, 3], "a reading of no speed is not one");
  assert.equal(rateSummaryOf([]), null);
});
