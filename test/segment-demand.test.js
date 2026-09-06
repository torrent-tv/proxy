/**
 * @file What is wanted of one output, in its own segment numbers.
 *
 * The class held a window per viewer per band and merged them itself. That was
 * the priority layer's work done a second time in the wrong place, and it
 * carried the viewer's name as the key of a claim — against the rule that the
 * encoding and the viewer are not connected at all. The behaviours those checks
 * pinned (a viewer's own bands, two viewers as a union) are the priority map's
 * and are checked there.
 *
 * What is left is a holder: one map per output, replaced whole, and an empty one
 * meaning nobody is coming.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SegmentDemand } from "../services/encode/SegmentDemand.js";

const PICTURE = "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy";
const SOUND = "torrent:abc:fmt=fmp4:grid=kf@0:audio-only:a=0/0/aac";

test("an output nothing has been said about wants nothing", () => {
  const demand = new SegmentDemand();
  assert.deepEqual(demand.mapOn(PICTURE), []);
  assert.deepEqual(demand.addresses(), []);
});

test("a map replaces whatever was wanted before, rather than adding to it", () => {
  // The map is a statement of what is wanted NOW, built fresh each time from
  // where the viewers are. Accumulating them would keep serving people who have
  // moved or gone.
  const demand = new SegmentDemand();
  demand.state(PICTURE, [{ from: 100, to: 130, priority: 32, withinSeconds: 0 }]);
  demand.state(PICTURE, [{ from: 500, to: 530, priority: 32, withinSeconds: 0 }]);
  assert.deepEqual(demand.mapOn(PICTURE), [{ from: 500, to: 530, priority: 32, withinSeconds: 0 }]);
});

test("an empty map is a statement, and it is kept as one", () => {
  // It says nobody is coming anywhere in this output, which is what stops the
  // encoders on it. Dropped instead of stored, the output would look like one
  // nothing had ever been said about, and the last map with people in it would
  // stand as current.
  const demand = new SegmentDemand();
  demand.state(PICTURE, [{ from: 100, to: 130, priority: 32, withinSeconds: 0 }]);
  demand.state(PICTURE, []);
  assert.deepEqual(demand.mapOn(PICTURE), []);
  assert.deepEqual(demand.addresses(), [PICTURE], "the output is still one that has been spoken about");
});

test("each output holds its own map", () => {
  // Two outputs of one film are cut independently — 454 pieces against 401 on
  // the field file — so the same second is a different number in each, and one
  // map cannot serve both.
  const demand = new SegmentDemand();
  demand.state(PICTURE, [{ from: 100, to: 130, priority: 32, withinSeconds: 0 }]);
  demand.state(SOUND, [{ from: 88, to: 115, priority: 32, withinSeconds: 0 }]);
  assert.equal(demand.mapOn(PICTURE)[0].from, 100);
  assert.equal(demand.mapOn(SOUND)[0].from, 88);
  assert.deepEqual(demand.addresses().sort(), [SOUND, PICTURE].sort());
});

test("an output can be forgotten entirely", () => {
  const demand = new SegmentDemand();
  demand.state(PICTURE, [{ from: 100, to: 130, priority: 32, withinSeconds: 0 }]);
  demand.forget(PICTURE);
  assert.deepEqual(demand.addresses(), []);
});

test("nothing about a viewer can be stated, because nothing about one is held", () => {
  // The check that the rule holds by construction: there is no name to pass and
  // no way to ask about one.
  const demand = new SegmentDemand();
  assert.equal(typeof (/** @type {any} */ (demand).want), "undefined");
  assert.equal(typeof (/** @type {any} */ (demand).windowsOn), "undefined");
  assert.equal(
    demand.state.length,
    2,
    "an address and a map, and nothing else"
  );
});
