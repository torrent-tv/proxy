/**
 * @file Whether the priority map is being served in its own order.
 *
 * The map says what matters most. Until 2026-09-08 nothing said whether what
 * mattered most was delivered first, for either of the two things that read it
 * — so a map read backwards would have looked identical in every log line the
 * proxy writes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { bandOf, WaitLedger } from "../services/priority/WaitLedger.js";
import { SegmentDemand } from "../services/encode/SegmentDemand.js";

test("the top rank is its own band, and the rest fall behind it", () => {
  // The map's ranks are as many as the film needs, and a table with a hundred
  // rows says nothing a reader can hold. What is being asked is coarse.
  assert.equal(bandOf(100, 100), "now", "where the viewer is standing");
  assert.equal(bandOf(95, 100), "soon", "what they reach while watching what they hold");
  assert.equal(bandOf(50, 100), "later", "the rest of the film");
  assert.equal(bandOf(0, 100), "later", "in nobody's zone at all");
});

test("a short map has a top band too", () => {
  // A film with three bands must not report every wait as `later` because its
  // numbers are small: a rank is a position in THIS map, not an absolute.
  assert.equal(bandOf(3, 3), "now");
  assert.equal(bandOf(1, 3), "later");
});

test("a band that never waited is said out loud, not reported as zero", () => {
  const ledger = new WaitLedger();
  ledger.note("out:1080", 40, 100, 100);

  const said = ledger.describe("out:1080");
  assert.match(said, /now 1 wait\(s\) median 40ms worst 40ms/);
  assert.match(said, /soon none/, "silence is not a zero");
  assert.match(said, /later none/);
});

test("nothing waited at all reads as nothing, so it cannot be mistaken for good", () => {
  assert.equal(new WaitLedger().describe("out:1080"), null);
});

test("the count is the whole run and the median is the recent sample", () => {
  // Two different questions: how often, and how badly.
  const ledger = new WaitLedger();
  for (let n = 0; n < 300; n += 1) {
    ledger.note("out:1080", n, 100, 100);
  }

  const said = ledger.describe("out:1080");
  assert.match(said, /now 300 wait\(s\)/, "every wait is counted");
  assert.match(said, /worst 299ms/, "and the worst of what is still held");
});

test("waits of two outputs do not mix", () => {
  const ledger = new WaitLedger();
  ledger.note("out:1080", 5000, 100, 100);
  ledger.note("out:480", 10, 100, 100);

  assert.match(ledger.describe("out:1080"), /now 1 wait\(s\) median 5000ms/);
  assert.match(ledger.describe("out:480"), /now 1 wait\(s\) median 10ms/);
});

test("the map answers what it says about one segment, and about itself", () => {
  // The rank alone cannot be read: a wait means one thing at the top of a map
  // and another at the bottom, so the highest rank stated comes with it.
  const demand = new SegmentDemand();
  demand.state("out:1080", [
    { from: 10, to: 12, priority: 100, withinSeconds: 0 },
    { from: 13, to: 20, priority: 97, withinSeconds: 4 },
    { from: 21, to: 90, priority: 90, withinSeconds: 40 }
  ]);

  assert.deepEqual(demand.rankOf("out:1080", 11), { rank: 100, topRank: 100 });
  assert.deepEqual(demand.rankOf("out:1080", 15), { rank: 97, topRank: 100 });
  assert.deepEqual(
    demand.rankOf("out:1080", 500),
    { rank: 0, topRank: 100 },
    "in nobody's zone is a statement: nothing is coming for it"
  );
  assert.deepEqual(
    demand.rankOf("out:none", 11),
    { rank: 0, topRank: 0 },
    "and a map that has not been built says nothing at all, which is different"
  );
});

test("overlapping zones give a segment the highest rank that covers it", () => {
  // Two viewers a few seconds apart state stretches that overlap; the segment
  // is as urgent as the most urgent claim on it.
  const demand = new SegmentDemand();
  demand.state("out:1080", [
    { from: 0, to: 100, priority: 90, withinSeconds: 40 },
    { from: 10, to: 12, priority: 100, withinSeconds: 0 }
  ]);

  assert.equal(demand.rankOf("out:1080", 11).rank, 100);
});
