/**
 * @file The rung the picture a viewer sees asks for: the smallest height of the
 * ladder whose frame is not smaller than it (roadmap item 98).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { rungForVisiblePicture, visibleHeightCap } from "../../services/encode/quality/visible-rung.js";
import { buildResolutionLadder } from "../../services/encode/hwaccel.js";

const LADDER = buildResolutionLadder(1920, 1080);

test("the smallest rung whose frame is not smaller than the picture seen", () => {
  assert.deepEqual(rungForVisiblePicture(LADDER, { width: 1200, height: 675 }), { width: 1280, height: 720 });
  assert.deepEqual(rungForVisiblePicture(LADDER, { width: 1280, height: 720 }), { width: 1280, height: 720 });
  assert.deepEqual(rungForVisiblePicture(LADDER, { width: 1281, height: 720 }), { width: 1920, height: 1080 });
});

test("a picture seen larger than the source is served at the source's size, never above", () => {
  assert.deepEqual(rungForVisiblePicture(LADDER, { width: 3840, height: 2160 }), { width: 1920, height: 1080 });
});

test("both sides count: a wide picture asks for the rung wide enough", () => {
  // Stretched (object-fit: fill) to 1000 wide and 300 tall.
  assert.equal(rungForVisiblePicture(LADDER, { width: 1000, height: 300 }).height, 720);
});

test("nothing measured bounds nothing", () => {
  assert.equal(rungForVisiblePicture(LADDER, null), null);
  assert.equal(visibleHeightCap(1920, 1080, null), null);
  assert.equal(visibleHeightCap(0, 0, { width: 640, height: 360 }), null);
});

test("the bound is a height of the source's own ladder", () => {
  assert.equal(visibleHeightCap(1920, 1080, { width: 640, height: 360 }), 360);
  assert.equal(visibleHeightCap(1920, 800, { width: 900, height: 375 }), 480);
});
