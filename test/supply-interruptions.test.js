/**
 * @file The speed a step needs, and the buffer a viewer needs, from what the
 * supply actually did.
 *
 * The field numbers these are checked against (2026-08-17, one torrent, one
 * session): waits of 1.49 s median and 3.16 s worst, one every 2.22 s. The
 * margin chosen by hand was 1.5; the arithmetic says 1.67; the step measured
 * 1.05 and stalled.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  minimumBufferSeconds,
  requiredSpeedFrom,
  summariseInterruptions,
  withInterruption
} from "../services/torrent-worker/supply-interruptions.js";

/**
 * Interruptions of `waitMs`, one every `gapMs`.
 *
 * @param {number[]} waitsMs
 * @param {number} gapMs
 * @returns {Array<{ waitedMs: number, at: number }>}
 */
function series(waitsMs, gapMs) {
  let samples = [];
  let at = 1_000_000;
  for (const waitedMs of waitsMs) {
    samples = withInterruption(samples, { waitedMs, at });
    at += gapMs;
  }
  return samples;
}

test("the field session's numbers produce the field session's answer", () => {
  // Waits around 1.49 s with a worst of 3.16 s, one every 2.22 s.
  const samples = series([1490, 1490, 3160, 1490, 1490], 2220);
  const summary = summariseInterruptions(samples);

  assert.equal(summary.worstWaitSeconds, 3.16);
  assert.equal(summary.medianGapSeconds, 2.22);

  const required = requiredSpeedFrom(summary);
  assert.ok(required !== null);
  assert.ok(
    Math.abs(required - 2.42) < 0.01,
    `1 + 3.16/2.22 = ${required?.toFixed(2)} — the supply asks for it, nobody chose it`
  );
});

test("a supply that rarely interrupts asks for almost nothing", () => {
  // One short wait every couple of minutes: a step barely faster than realtime
  // rebuilds the cushion long before the next one.
  const summary = summariseInterruptions(series([200, 200, 200], 120_000));
  const required = requiredSpeedFrom(summary);
  assert.ok(required !== null && required < 1.01, `asked ${required}`);
});

test("a supply that interrupts constantly asks for a great deal", () => {
  const summary = summariseInterruptions(series([4000, 4000, 4000], 1000));
  assert.equal(requiredSpeedFrom(summary), 5);
});

test("too little evidence is answered with nothing, never with a number", () => {
  // The whole point of deriving the margin is that it stops being invented. One
  // reading has no interval at all, and a caller must keep what it had.
  assert.equal(requiredSpeedFrom(summariseInterruptions([])), null);
  assert.equal(requiredSpeedFrom(summariseInterruptions(series([1000], 0))), null);
  assert.equal(requiredSpeedFrom(null), null);
  assert.equal(requiredSpeedFrom({ samples: 9, worstWaitSeconds: 3, medianGapSeconds: 0 }), null);
});

test("the worst wait decides, not the typical one", () => {
  // A step that survives the median interruption still stalls on the others,
  // and a stall is what the viewer sees.
  const summary = summariseInterruptions(series([100, 100, 5000, 100], 1000));
  assert.equal(summary.medianWaitSeconds, 0.1);
  assert.equal(summary.worstWaitSeconds, 5);
  assert.equal(requiredSpeedFrom(summary), 6);
});

test("only the recent interruptions are judged", () => {
  // A swarm that has recovered must not be sentenced by how it behaved ten
  // minutes ago, so the record is bounded.
  let samples = series(Array.from({ length: 40 }, () => 9000), 1000);
  samples = withInterruption(samples, { waitedMs: 10, at: 2_000_000 });
  assert.ok(samples.length <= 24, `kept ${samples.length}`);
  assert.equal(samples[samples.length - 1].waitedMs, 10);
});

test("a reading without a time or a duration is not a reading", () => {
  const samples = withInterruption([], { waitedMs: Number.NaN, at: 1 });
  assert.deepEqual(samples, []);
  assert.deepEqual(withInterruption([], { waitedMs: 100 }), []);
});

test("the minimum buffer is one segment plus the worst interruption", () => {
  // The field torrent: 4 s segments, a worst supply wait of 3.16 s, production
  // gaps within the segment length, transfer measured in milliseconds.
  const seconds = minimumBufferSeconds({
    segmentSeconds: 4,
    supplySeconds: 3.16,
    productionSeconds: 1.2,
    transferSeconds: 0.066
  });
  assert.ok(Math.abs(seconds - 7.16) < 0.001, `${seconds}s against the 25 s chosen by hand`);
});

test("whichever source is worst is the one that sizes the buffer", () => {
  // A step at 1.0x makes production the binding term even on a swarm that never
  // stalls, which is exactly the case a supply-only figure would miss.
  assert.equal(
    minimumBufferSeconds({ segmentSeconds: 4, supplySeconds: 0.2, productionSeconds: 6 }),
    10
  );
});

test("a term nobody measured contributes nothing, not a guess", () => {
  assert.equal(minimumBufferSeconds({ segmentSeconds: 4 }), 4);
  assert.equal(minimumBufferSeconds({ segmentSeconds: 4, supplySeconds: Number.NaN }), 4);
  assert.equal(minimumBufferSeconds({}), 0);
});
