/**
 * @file Whether the whole machine has a place for one more encoder (roadmap
 * item 97, step 13).
 *
 * What is pinned here:
 *
 * 1. a place is held by an OUTPUT: two preparations onto one output take one
 *    place, and the second is admitted without arithmetic;
 * 2. two preparations onto two DIFFERENT outputs with room for one: the first
 *    is admitted, the second refused, because it is asked after the first is
 *    recorded;
 * 3. one of two viewers giving up a preparation of one output does not free
 *    its place;
 * 4. the cost is what an encoder costs, not a count of processes: a picture
 *    and its soundtrack fit where two pictures do not — the addon host's own
 *    figures, 1080p alone at 1.96x;
 * 5. an admitted encoder is never taken away: the machine's answer is never
 *    below what already runs, nor below one for an output a preparation holds;
 * 6. a new output on a full machine is given no encoder.
 *
 * The records of who is being prepared are stood in for by a set the check
 * writes to, which is what the viewers' records are read as.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EncodeAdmission } from "../services/encode/EncodeAdmission.js";

// 1080p re-encoded on the addon host: 1.96x alone.
const PICTURE_1080 = 1 / 1.96;
// A re-encoded soundtrack: a small fraction of a picture.
const SOUNDTRACK = 0.02;

/**
 * A machine with the outputs named, their costs, what runs and who is being
 * prepared onto what.
 *
 * @param {{ costs: Record<string, number | null>, running?: Record<string, number>, share?: number | null }} how
 */
function machine(how) {
  const running = new Map(Object.entries(how.running ?? {}));
  /** Output address to the viewers being prepared onto it. @type {Map<string, Set<string>>} */
  const preparing = new Map();
  const admission = new EncodeAdmission({
    liveRunsByAddress: () => new Map([...running].filter(([, count]) => count > 0)),
    preparedAddresses: () => new Set([...preparing].filter(([, viewers]) => viewers.size > 0).map(([address]) => address)),
    loadOf: (address) => (address in how.costs ? { costSec: how.costs[address], fileKey: "", fileCostSec: 0 } : null),
    availability: () => (how.share === undefined || how.share === null ? null : { share: how.share, known: true })
  });
  return {
    admission,
    running,
    /** A viewer's preparation recorded, as `Viewer` records it. */
    prepare: (address, viewer) => {
      const viewers = preparing.get(address) ?? new Set();
      viewers.add(viewer);
      preparing.set(address, viewers);
    },
    /** A viewer's preparation ended, on whichever path. */
    giveUp: (address, viewer) => preparing.get(address)?.delete(viewer)
  };
}

test("two preparations onto one output take one place", () => {
  const { admission, prepare } = machine({ costs: { a: PICTURE_1080, b: PICTURE_1080 } });
  assert.equal(admission.admitsPreparation("a").admitted, true);
  prepare("a", "viewer-1");
  const second = admission.admitsPreparation("a");
  assert.equal(second.admitted, true, "the second viewer shares the place");
  assert.match(second.reason, /already holds a place/);
});

test("two preparations onto two different outputs with room for one: the second is refused", () => {
  const { admission, prepare } = machine({ costs: { a: PICTURE_1080, b: PICTURE_1080 } });
  // The first is asked and recorded in one stretch, as the preparation does it.
  assert.equal(admission.admitsPreparation("a").admitted, true);
  prepare("a", "viewer-1");
  const second = admission.admitsPreparation("b");
  assert.equal(second.admitted, false, "both together would make 0.98x of each");
  assert.ok(second.speedX < 1);
});

test("one of two viewers giving up a preparation of one output does not free its place", () => {
  const { admission, prepare, giveUp } = machine({ costs: { a: PICTURE_1080, b: PICTURE_1080 } });
  prepare("a", "viewer-1");
  prepare("a", "viewer-2");
  giveUp("a", "viewer-1");
  assert.equal(admission.admitsPreparation("b").admitted, false, "viewer-2 still holds the place on a");
  assert.equal(admission.placesFor("a", 0).runs, 1, "and a keeps its encoder's place");
  giveUp("a", "viewer-2");
  assert.equal(admission.admitsPreparation("b").admitted, true, "the place ends with the last record");
});

test("a picture and its soundtrack fit where two pictures do not", () => {
  const { admission } = machine({
    costs: { picture: PICTURE_1080, sound: SOUNDTRACK, other: PICTURE_1080 },
    running: { picture: 1 }
  });
  assert.equal(admission.admitsPreparation("sound").admitted, true, "0.53 s/s makes 1.89x");
  assert.equal(admission.placesFor("sound", 0).runs >= 1, true);
  assert.equal(admission.admitsPreparation("other").admitted, false, "1.02 s/s makes 0.98x");
});

test("an admitted encoder is never taken away, and a held place is kept", () => {
  const { admission } = machine({
    costs: { a: PICTURE_1080, b: PICTURE_1080 },
    running: { a: 1, b: 1 }
  });
  assert.equal(admission.placesFor("a", 1).runs, 1, "both running: each keeps its one");
  assert.equal(admission.placesFor("b", 1).runs, 1);
  const { admission: held, prepare: prepareHeld } = machine({
    costs: { a: PICTURE_1080, b: PICTURE_1080 },
    running: { b: 1 }
  });
  prepareHeld("a", "viewer-1");
  assert.equal(held.placesFor("a", 0).runs, 1, "a place promised to a preparation is not withdrawn");
});

test("a new output on a full machine is given no encoder", () => {
  const { admission } = machine({ costs: { a: PICTURE_1080, b: PICTURE_1080 }, running: { a: 1 } });
  assert.equal(admission.placesFor("b", 0).runs, 0);
});

test("the share of the machine nobody has priced is taken off what there is", () => {
  // 0.6 s/s alone makes 1.67x; with a third of the machine taken by work
  // nobody priced it makes 1.11x, and a soundtrack beside it still fits.
  const quiet = machine({ costs: { a: 0.6, b: 0.4 }, share: 1 });
  assert.equal(quiet.admission.admitsPreparation("a").admitted, true);
  const busy = machine({ costs: { a: 0.6, b: 0.4 }, running: { a: 1 }, share: 0.6 });
  assert.equal(busy.admission.admitsPreparation("b").admitted, false, "1.0 s/s at 0.6 of the machine makes 0.6x");
});

test("an output with no measured cost is not admitted", () => {
  const { admission } = machine({ costs: { a: PICTURE_1080, b: null }, running: { a: 1 } });
  const answer = admission.admitsPreparation("b");
  assert.equal(answer.admitted, false);
  assert.match(answer.reason, /no measured encoding cost/);
});

test("unpriced occupied work is neither spare pool headroom nor capacity for another output", () => {
  const { admission } = machine({ costs: { a: null, b: PICTURE_1080 }, running: { a: 1 } });
  assert.equal(admission.headroom().encodeSpeedX, 0, "the pool sees no confirmed room");
  const answer = admission.admitsPreparation("b");
  assert.equal(answer.admitted, false);
  assert.match(answer.reason, /capacity is unknown/);
});

test("a near-free output is answered at once, whatever its price", () => {
  // Field 2026-10-04: a soundtrack priced at 5.4e-14 s per film second kept
  // the main thread counting encoders one at a time for minutes.
  const { admission } = machine({ costs: { sound: 5.36680075607109e-14 }, share: 0.6 });
  const started = Date.now();
  const { runs } = admission.placesFor("sound", 0);
  assert.ok(Date.now() - started < 1_000, "answered without counting one at a time");
  assert.ok(runs > 1e12 && Number.isFinite(runs), `as many as fit: ${runs}`);
});

test("the count is the largest that keeps every output at realtime", () => {
  for (const cost of [0.5, 0.1, 0.03, 0.007, 0.0011]) {
    for (const share of [null, 1, 0.37]) {
      const { admission } = machine({ costs: { a: cost, b: PICTURE_1080 / 4 }, running: { b: 1 }, share });
      const usable = share ?? 1;
      let expected = 0;
      while (usable / (PICTURE_1080 / 4 + (expected + 1) * cost) >= 1) {
        expected += 1;
      }
      assert.equal(admission.placesFor("a", 0).runs, Math.max(expected, 0), `cost ${cost}, share ${share}`);
    }
  }
});
