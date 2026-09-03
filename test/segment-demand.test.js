/**
 * @file What viewers want of an output, stated once each and read as a union.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SegmentDemand } from "../services/encode/SegmentDemand.js";

const PICTURE = "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy";
const SOUND = "torrent:abc:fmt=fmp4:grid=kf@0:audio-only:a=0/1/copy";

test("a viewer restating a window replaces it rather than adding to it", () => {
  // A player restates its window every few seconds. Accumulated, the demand
  // would grow to the whole film within a minute.
  const demand = new SegmentDemand();
  demand.state({ claimant: "one", address: PICTURE, from: 0, to: 10, statedAt: 1 });
  demand.state({ claimant: "one", address: PICTURE, from: 30, to: 40, statedAt: 2 });
  assert.deepEqual(demand.spanOn(PICTURE), { from: 30, to: 40 });
  assert.equal(demand.stats().windows, 1);
});

test("one viewer states a window per output, and both stand", () => {
  const demand = new SegmentDemand();
  demand.state({ claimant: "one", address: PICTURE, from: 0, to: 10, statedAt: 1 });
  demand.state({ claimant: "one", address: SOUND, from: 0, to: 10, statedAt: 1 });
  assert.equal(demand.stats().windows, 2);
  assert.deepEqual(demand.addresses().sort(), [SOUND, PICTURE].sort());
});

test("two viewers of one output are a union, not a sum", () => {
  // Two viewers seconds apart want mostly the same segments; counted twice, a
  // stretch would look twice as wanted as it is.
  const demand = new SegmentDemand();
  demand.state({ claimant: "one", address: PICTURE, from: 10, to: 14, statedAt: 1 });
  demand.state({ claimant: "two", address: PICTURE, from: 12, to: 16, statedAt: 1 });
  assert.deepEqual(demand.wantedOn(PICTURE), [10, 11, 12, 13, 14, 15, 16]);
});

test("two viewers far apart make a span that covers the ground between them", () => {
  // Not so it is all made — so that a search for a gap considers all of it.
  const demand = new SegmentDemand();
  demand.state({ claimant: "one", address: PICTURE, from: 0, to: 5, statedAt: 1 });
  demand.state({ claimant: "two", address: PICTURE, from: 900, to: 905, statedAt: 1 });
  assert.deepEqual(demand.spanOn(PICTURE), { from: 0, to: 905 });
});

test("a viewer who leaves takes every window they stated", () => {
  const demand = new SegmentDemand();
  demand.state({ claimant: "one", address: PICTURE, from: 0, to: 5, statedAt: 1 });
  demand.state({ claimant: "one", address: SOUND, from: 0, to: 5, statedAt: 1 });
  demand.state({ claimant: "two", address: PICTURE, from: 0, to: 5, statedAt: 1 });
  assert.equal(demand.forget("one"), 2);
  assert.equal(demand.stats().claimants, 1);
  assert.equal(demand.addresses().length, 1);
});

test("expiry is carried out here and decided elsewhere", () => {
  // The register has no clock on purpose: the rule that says how stale is too
  // stale lives with whoever measures it, and this stays exercisable with
  // numbers alone.
  const demand = new SegmentDemand();
  demand.state({ claimant: "one", address: PICTURE, from: 0, to: 5, statedAt: 1000 });
  demand.state({ claimant: "two", address: PICTURE, from: 0, to: 5, statedAt: 9000 });
  const dropped = demand.forgetStatedBefore(5000);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].claimant, "one");
  assert.equal(demand.stats().windows, 1);
});

test("a window that is not a window is refused rather than stored", () => {
  const demand = new SegmentDemand();
  assert.equal(demand.state({ claimant: "one", address: PICTURE, from: 5, to: 1, statedAt: 1 }), null);
  assert.equal(demand.state({ claimant: "", address: PICTURE, from: 0, to: 1, statedAt: 1 }), null);
  assert.equal(demand.state({ claimant: "one", address: "", from: 0, to: 1, statedAt: 1 }), null);
  assert.equal(demand.stats().windows, 0);
});

test("nothing wanted on an output answers null rather than an empty span", () => {
  const demand = new SegmentDemand();
  assert.equal(demand.spanOn(PICTURE), null);
  assert.deepEqual(demand.wantedOn(PICTURE), []);
});
