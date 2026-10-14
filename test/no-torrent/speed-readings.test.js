/**
 * @file Every speed reading of an output's runs reaches the start forecast
 * (torrent-tv/meta#178). Plain values; no torrent, no encoder.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SpeedReadings } from "../../services/encode/SpeedReadings.js";
import { RateTrend } from "../../services/viewer/playback-readiness.js";

test("readings of runs that ended between two polls reach the forecast", () => {
  // r37 on Home Assistant: the runs measured 0.78, 1.80, 2.25, 2.84 and
  // 2.69x; taking the newest reading of a live run at each poll, the forecast
  // got 0.78 and 2.69x, because runs of three pieces ended between polls.
  const output = {};
  const readings = new SpeedReadings(120);
  const trend = new RateTrend(120);
  const at = (s) => 1_000_000 + s * 1000;
  const poll = () => { for (const reading of readings.after(output, trend.lastAt)) trend.add(reading.at, reading.speed); };
  readings.note(output, { speed: 0.78, at: at(27.36) });
  poll();
  readings.note(output, { speed: 1.80, at: at(33.0) }); // the run ends before the next poll
  poll();
  readings.note(output, { speed: 2.25, at: at(40.3) });
  readings.note(output, { speed: 2.84, at: at(41.8) });
  poll();
  readings.note(output, { speed: 2.69, at: at(46.7) });
  poll();
  const snapshot = trend.snapshot();
  assert.equal(snapshot.count, 5);
  assert.ok(Math.abs(snapshot.harmonicValue - 5 / (1 / 0.78 + 1 / 1.8 + 1 / 2.25 + 1 / 2.84 + 1 / 2.69)) < 1e-12);
  assert.equal(readings.after(output, trend.lastAt).length, 0, "a poll takes each reading once");
});

test("a reading older than the horizon is not kept, and other outputs are their own", () => {
  const readings = new SpeedReadings(120);
  const picture = {}, sound = {};
  readings.note(picture, { speed: 1, at: 0 });
  readings.note(picture, { speed: 2, at: 60_000 });
  readings.note(picture, { speed: 3, at: 200_000 });
  readings.note(sound, { speed: 90, at: 200_000 });
  assert.deepEqual(readings.after(picture).map(r => r.speed), [2, 3]);
  assert.deepEqual(readings.after(sound).map(r => r.speed), [90]);
  readings.note(picture, { speed: 0, at: 210_000 });
  readings.note(picture, null);
  assert.deepEqual(readings.after(picture, 60_000).map(r => r.speed), [3], "a reading of no speed is not one");
});
