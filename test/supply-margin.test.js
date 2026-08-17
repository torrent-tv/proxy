/**
 * @file The margin and the buffer, checked against the session they were
 * derived from.
 *
 * The figures in these tests are the field measurements of 2026-08-17, so a
 * change that breaks the arithmetic fails against reality rather than against
 * an example someone invented.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { minimumBufferFrom, requiredSpeedFrom } from "../services/supply-margin.js";

/**
 * Waits spaced by `intervalSec`, each lasting `waitSec`.
 *
 * @param {number} count
 * @param {number} intervalSec
 * @param {number} waitSec
 * @returns {Array<{ waitedMs: number, at: number }>}
 */
function evenlySpaced(count, intervalSec, waitSec) {
  const waits = [];
  for (let index = 0; index < count; index += 1) {
    waits.push({ waitedMs: waitSec * 1000, at: 1_000_000 + index * intervalSec * 1000 });
  }
  return waits;
}

test("the margin is what the supply's own interruptions demand", () => {
  // The field torrent: a wait every 2.22 s, the worst of them 3.16 s.
  const waits = evenlySpaced(10, 2.22, 1.49);
  waits[4].waitedMs = 3160;

  const answer = requiredSpeedFrom(waits);

  assert.ok(answer);
  assert.equal(answer.worstWaitSec, 3.16);
  assert.equal(answer.medianIntervalSec, 2.22);
  // 1 + 3.16 / 2.22 = 2.42. The step that was admitted by the hand-chosen 1.5
  // ran at 1.05x and stalled; this is the bar it should have been held to.
  assert.ok(Math.abs(answer.requiredSpeed - 2.4234) < 0.001, `got ${answer.requiredSpeed}`);
});

test("a copy at 8x clears its own supply with room to spare", () => {
  // The same file's copied stream: waits up to 4.82 s, and it never stalled.
  const waits = evenlySpaced(6, 15.5, 4.82);
  const answer = requiredSpeedFrom(waits);
  assert.ok(answer);
  // 1 + 4.82/15.5 = 1.31, against 8x measured. Which is why a copy is the step
  // a stranded viewer is always able to return to.
  assert.ok(answer.requiredSpeed < 1.35, `got ${answer.requiredSpeed}`);
});

test("with too little evidence it says so instead of inventing a number", () => {
  assert.equal(requiredSpeedFrom([]), null);
  assert.equal(requiredSpeedFrom([{ waitedMs: 1500, at: 1 }]), null, "one wait shows no interval");
  assert.equal(requiredSpeedFrom(null), null);
  // Every wait at the same instant: no interval was observed, so no interval
  // may be stated.
  assert.equal(
    requiredSpeedFrom([
      { waitedMs: 1000, at: 5 },
      { waitedMs: 1000, at: 5 }
    ]),
    null
  );
});

test("readings that are not measurements are ignored, not averaged in", () => {
  const answer = requiredSpeedFrom([
    { waitedMs: 0, at: 1000 },
    { waitedMs: Number.NaN, at: 2000 },
    { waitedMs: 1000, at: 3000 },
    { waitedMs: 2000, at: 5000 },
    { waitedMs: 1500, at: 7000 }
  ]);
  assert.ok(answer);
  assert.equal(answer.samples, 3, "only the three real waits count");
});

test("the buffer is one segment plus the worst interruption, and names which", () => {
  const answer = minimumBufferFrom({
    segmentSeconds: 4,
    worstSupplyWaitSec: 3.16,
    worstProductionGapSec: 1.2,
    worstTransferSec: 0.066
  });
  assert.ok(answer);
  assert.equal(answer.seconds, 7.16, "7.16 s against the 25 s that was chosen by hand");
  assert.equal(answer.from, "supply");
});

test("a step that cannot keep up sets the buffer itself", () => {
  const answer = minimumBufferFrom({
    segmentSeconds: 4,
    worstSupplyWaitSec: 1.4,
    worstProductionGapSec: 6.5,
    worstTransferSec: 0.05
  });
  assert.equal(answer.seconds, 10.5);
  assert.equal(answer.from, "production", "the encoder, not the swarm, is what the viewer is waiting for");
});

test("a term with nothing observed contributes nothing", () => {
  const answer = minimumBufferFrom({ segmentSeconds: 4 });
  assert.equal(answer.seconds, 4, "one whole segment is the floor: the one being played");
  assert.equal(answer.from, "none");
  assert.equal(minimumBufferFrom({}), null, "without a segment duration nothing can be said");
  assert.equal(minimumBufferFrom({ segmentSeconds: 0 }), null);
});
