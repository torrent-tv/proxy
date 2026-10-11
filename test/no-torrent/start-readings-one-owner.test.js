/**
 * @file Start readings without our own pauses, kept by one owner
 * (torrent-tv/meta#184).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RunClock } from "../../services/encode/RunClock.js";
import { RunCosts } from "../../services/encode/run-costs.js";

test("the clock keeps paused time apart from input waits", () => {
  let at = 0;
  const clock = new RunClock({ now: () => at });
  at = 100; clock.inputWaitBegins();
  at = 150; clock.inputWaitEnds();
  at = 200; clock.stopped();
  at = 500;
  assert.equal(clock.stoppedMs(), 300, "still stopped: counted to now");
  clock.continued();
  at = 900;
  assert.equal(clock.stoppedMs(), 300);
  assert.equal(clock.workingMs(), 900 - 50 - 300, "working time leaves out both");
});

test("a run that produced nothing is a lower bound on the first output without its pauses", () => {
  const costs = new RunCosts();
  costs.note({ livedMs: 10_000, stoppedMs: 7_000, firstOutputMs: null });
  assert.equal(costs.seconds().firstByteWaitSec, 3);
});

test("an output's own opens are preferred to the host's startup reading, and both are said for what they are", () => {
  const costs = new RunCosts();
  assert.equal(costs.openOf("picture"), null);
  costs.noteStartup({ firstByteWaitSec: 0.7, killCostSec: 0 });
  assert.deepEqual(costs.openOf("picture"), { seconds: 0.7, measured: false });
  costs.noteOpen("picture", 6);
  costs.noteOpen("picture", 12);
  assert.deepEqual(costs.openOf("picture"), { seconds: 9, measured: true });
  assert.deepEqual(costs.openOf("soundtrack"), { seconds: 0.7, measured: false }, "another output's opens are not this one's");
  costs.forgetOpens("picture");
  assert.equal(costs.openOf("picture").measured, false);
});
