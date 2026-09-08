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
  // The field torrent: waits of 1.49 s with 0.73 s of running between them, and
  // the worst of them 3.16 s. Written out rather than generated, because the
  // point of the test is that these exact spans give that exact answer.
  const waits = [
    { waitedMs: 1490, at: 1490 },   // 0.00..1.49
    { waitedMs: 1490, at: 3710 },   // 2.22..3.71
    { waitedMs: 1490, at: 5930 },   // 4.44..5.93
    { waitedMs: 3160, at: 9820 },   // 6.66..9.82  ← the worst
    { waitedMs: 1490, at: 12_040 }, // 10.55..12.04
    { waitedMs: 1490, at: 14_260 }  // 12.77..14.26
  ];

  const answer = requiredSpeedFrom(waits);

  assert.ok(answer);
  assert.equal(answer.worstWaitSec, 3.16);
  // 2.22 s from one wait's end to the next one's END, of which 1.49 s was spent
  // waiting — so the encoder ran for 0.73 s. That running stretch is what the
  // derivation calls T: `(v - 1) x T > W` prices what is GAINED between
  // interruptions, and nothing is gained during one.
  assert.ok(Math.abs(answer.medianIntervalSec - 0.73) < 0.001, `got ${answer.medianIntervalSec}`);
  // THE SHARE OF ITS TIME THE SUPPLY LOST, over whole cycles: from the first
  // interruption's start to the last one's, 12.77 s, of which 9.12 s was
  // interruption. So the reading delivered for 3.65 s of every 12.77, and
  // producing film at that share costs 1/(1 - 0.714) = 3.50x.
  //
  // The formula it replaced divided the WORST interruption by the TYPICAL gap —
  // 1 + 3.16/0.73 = 5.33 — which asks what would happen if the worst recurred
  // at the typical rate, a case that never occurred in this data, and which
  // divides by a gap that goes to zero whenever interruptions arrive in a burst.
  // Field 2026-09-08: 0.79 s over 0.01 s gave 158.60x on a file already
  // downloaded whole, and every quality step was refused against it.
  //
  // The failure this file was written for is still caught: a step admitted at
  // 1.5 ran at 1.05x and stalled, and 3.91x refuses 1.5 exactly as 5.33x did.
  assert.ok(Math.abs(answer.lostShare - 0.7142) < 0.001, `got ${answer.lostShare}`);
  assert.ok(Math.abs(answer.requiredSpeed - 3.4986) < 0.001, `got ${answer.requiredSpeed}`);
});

test("one stall seen by three readers is one interruption, not three", () => {
  // The picture and two audio renditions walk the same file, so a piece that
  // has not arrived blocks all three, and their waits end within milliseconds
  // of each other. Field 2026-08-31: `worst wait 13.26s, one every 0.00s,
  // 2 measured` produced a required speed of 4422.00x, and every quality step
  // was refused against it.
  const answer = requiredSpeedFrom([
    { waitedMs: 13_260, at: 1_000_000 },
    { waitedMs: 13_257, at: 1_000_003 }
  ]);

  // Two overlapping waits are one interruption, and one interruption shows no
  // interval — so the honest answer is that it is not known yet.
  assert.equal(answer, null);
});

test("overlapping waits merge, and the gap between stalls is what is left", () => {
  const answer = requiredSpeedFrom([
    // First stall: 10s..20s, noticed by two readers a moment apart.
    { waitedMs: 10_000, at: 20_000 },
    { waitedMs: 9_000, at: 19_500 },
    // Second stall: 30s..34s, again seen twice.
    { waitedMs: 4_000, at: 34_000 },
    { waitedMs: 3_500, at: 33_800 }
  ]);

  assert.ok(answer);
  assert.equal(answer.samples, 2, "two interruptions");
  assert.equal(answer.waits, 4, "from four waits");
  assert.equal(answer.worstWaitSec, 10, "the merged stall, not one reader's view of it");
  assert.equal(answer.medianIntervalSec, 10, "20s to 30s is when the encoder ran");
  // One whole cycle: 10 s to 30 s, of which the 10 s interruption is half. The
  // supply delivered for the other half, so a step must run at twice realtime.
  assert.equal(answer.spanSec, 20);
  assert.equal(answer.lostSec, 10);
  assert.equal(answer.requiredSpeed, 2);
});

test("a copy at 8x clears its own supply with room to spare", () => {
  // The same file's copied stream: waits up to 4.82 s, and it never stalled.
  const waits = evenlySpaced(6, 15.5, 4.82);
  const answer = requiredSpeedFrom(waits);
  assert.ok(answer);
  // Waits end 15.5 s apart and last 4.82 s, so the supply delivers for 10.68 s
  // of every 15.5: 0.311 of its time lost, and 1/(1 - 0.311) = 1.45 against the
  // 8x measured. Which is why a copy is the step a stranded viewer is always
  // able to return to.
  assert.ok(answer.requiredSpeed < 1.5, `got ${answer.requiredSpeed}`);
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
  assert.equal(answer.waits, 3, "only the three real waits count");
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
