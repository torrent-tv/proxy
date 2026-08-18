/**
 * @file What the torrent costs per megabyte, once the draw that would have
 * happened anyway is taken off.
 *
 * The readings behind these cases are the addon host's own, 2026-08-18:
 * 145.4 ms/MB over 8.7 MB and 23.1 ms/MB over 54 MB in the same session, which
 * is what a fixed minimum-megabytes threshold failed to stop.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { baseDrawFrom, costPerMegabyteFrom } from "../services/torrent-cost.js";

test("the base draw is the share of a core spent with nothing to do", () => {
  assert.equal(baseDrawFrom({ cpuSeconds: 0.5, elapsedSeconds: 5 }), 0.1);
  assert.equal(baseDrawFrom({ cpuSeconds: 0, elapsedSeconds: 5 }), 0);
  assert.equal(baseDrawFrom({ cpuSeconds: 1, elapsedSeconds: 0 }), null);
  assert.equal(baseDrawFrom({ cpuSeconds: Number.NaN, elapsedSeconds: 5 }), null);
});

test("the draw comes off before the megabytes are divided by", () => {
  // 1 s of CPU over 5 s, of which 0.1 of a core is spent regardless: 0.5 s left
  // for 50 MB.
  const cost = costPerMegabyteFrom({ cpuSeconds: 1, elapsedSeconds: 5, megabytes: 50, baseDraw: 0.1 });
  assert.equal(cost, 0.01);
});

test("a small interval no longer reports a huge price", () => {
  // The same host and the same draw, one interval moving 54 MB and one moving
  // 8.7 MB. Without the subtraction the second reads six times the first.
  const draw = 0.1;
  const big = costPerMegabyteFrom({ cpuSeconds: 1.85, elapsedSeconds: 5, megabytes: 54, baseDraw: draw });
  const small = costPerMegabyteFrom({ cpuSeconds: 0.72, elapsedSeconds: 5, megabytes: 8.7, baseDraw: draw });
  assert.ok(Math.abs(big - small) / big < 0.05, `${big} vs ${small}`);
});

test("with no base draw measured the interval says nothing", () => {
  assert.equal(costPerMegabyteFrom({ cpuSeconds: 1, elapsedSeconds: 5, megabytes: 50, baseDraw: null }), null);
});

test("an interval that spent no more than the draw says nothing either", () => {
  assert.equal(costPerMegabyteFrom({ cpuSeconds: 0.5, elapsedSeconds: 5, megabytes: 50, baseDraw: 0.1 }), null);
});

test("nothing moved cannot be priced per megabyte", () => {
  assert.equal(costPerMegabyteFrom({ cpuSeconds: 1, elapsedSeconds: 5, megabytes: 0, baseDraw: 0.1 }), null);
});

test("a remainder inside the draw's own disagreement is not a price", () => {
  // The draw is 0.1 of a core and its readings disagree by 0.01 of one. Over a
  // five-second interval that is 0.05 s of CPU nobody can attribute, so a
  // remainder smaller than that says nothing however many megabytes moved.
  const noisy = costPerMegabyteFrom({
    cpuSeconds: 0.53,
    elapsedSeconds: 5,
    megabytes: 0.5,
    baseDraw: 0.1,
    drawScatter: 0.01
  });
  assert.equal(noisy, null);

  // The same host and the same disagreement, an interval that moved enough for
  // the remainder to exceed it.
  const solid = costPerMegabyteFrom({
    cpuSeconds: 1.74,
    elapsedSeconds: 5,
    megabytes: 54,
    baseDraw: 0.1,
    drawScatter: 0.01
  });
  assert.ok(Math.abs(solid - 0.023) < 0.001, `${solid}`);
});
