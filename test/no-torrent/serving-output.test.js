/**
 * @file Which existing output serves a viewer: the rules decided with the user
 * 2026-09-16, with the viewer's own link asked in every mode and on every
 * branch (roadmap item 97, step 11).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chooseServingOutput } from "../../services/encode/quality/serving-output.js";
import { linkCouldCarry, loadOf, PEAK_CLASS } from "../../services/encode/quality/link-budget.js";

const WANTED = { width: 1824, height: 1026 };
const NEXT_LOWER = 1280 * 720;

/**
 * @param {string} key
 * @param {number} width
 * @param {number} height
 * @param {{ mbps?: number | null, peakClass?: string, readyHere?: boolean }} [over]
 */
function candidate(key, width, height, { mbps = 5, peakClass = PEAK_CLASS.KNOWN, readyHere = true } = {}) {
  return { key, width, height, readyHere, load: loadOf({ mbps, peakClass: mbps === null ? PEAK_CLASS.UNKNOWN : peakClass }, null) };
}

/**
 * @param {object} over
 * @param {number | null} [linkMbps] - What this viewer's link measured.
 */
function choose(over, linkMbps = null) {
  return chooseServingOutput({
    mode: "auto",
    wanted: WANTED,
    nextLowerArea: NEXT_LOWER,
    atRisk: false,
    judge: (one) => linkCouldCarry(linkMbps, one.load),
    candidates: [],
    ...over
  })?.key ?? null;
}

test("the same quality or higher is served, the nearest of them", () => {
  assert.equal(choose({ candidates: [candidate("2160", 3840, 2160), candidate("1080", 1920, 1080)] }), "1080");
});

test("higher quality is not served over a link it does not fit", () => {
  assert.equal(choose({ candidates: [candidate("1080", 1920, 1080, { mbps: 12 })] }, 10), null);
});

test("a little lower — above the next rung down — is served, and only if the link admits it", () => {
  assert.equal(choose({ candidates: [candidate("1000", 1776, 1000)] }), "1000");
  assert.equal(
    choose({ candidates: [candidate("1000", 1776, 1000, { mbps: 12 })] }, 10),
    null,
    "a smaller picture proves nothing by itself: its own load is asked"
  );
});

test("the next rung down or lower is served only when making the wanted format risks a wait, and only if it fits", () => {
  const lower = [candidate("720", 1280, 720), candidate("480", 854, 480)];
  assert.equal(choose({ candidates: lower }), null);
  assert.equal(choose({ candidates: lower, atRisk: true }), "720");
  assert.equal(
    choose({ candidates: [candidate("720", 1280, 720, { mbps: 12 }), candidate("480", 854, 480, { mbps: 3 })], atRisk: true }, 10),
    "480",
    "the larger one does not fit this link, so it is not taken"
  );
});

test("an output without the piece at the viewer's position spares them nothing", () => {
  assert.equal(choose({ candidates: [candidate("1080", 1920, 1080, { readyHere: false })] }), null);
});

test("a size chosen by hand is served only exactly, and only if the link admits it", () => {
  const candidates = [candidate("1080", 1920, 1080), candidate("exact", 1824, 1026)];
  assert.equal(choose({ mode: "manual", candidates }), "exact");
  assert.equal(choose({ mode: "manual", candidates: [candidate("1080", 1920, 1080)], atRisk: true }), null);
  assert.equal(
    choose({ mode: "manual", candidates: [candidate("exact", 1824, 1026, { mbps: 12 })] }, 10),
    null,
    "the size they picked, but more than their link carries: not handed over"
  );
});

test("of two outputs of the size picked by hand, the higher limit the link admits is served", () => {
  const candidates = [candidate("2800", 1824, 1026, { mbps: 3.64 }), candidate("1400", 1824, 1026, { mbps: 1.82 })];
  assert.equal(choose({ mode: "manual", candidates }, 10), "2800");
  assert.equal(choose({ mode: "manual", candidates }, 3), "1400", "the link admits only the lower limit");
});

test("a bound is taken before an average, even when the average's limit is higher", () => {
  const candidates = [
    candidate("estimated", 1824, 1026, { mbps: 6, peakClass: PEAK_CLASS.ESTIMATED }),
    candidate("known", 1824, 1026, { mbps: 4, peakClass: PEAK_CLASS.KNOWN })
  ];
  assert.equal(choose({ mode: "manual", candidates }, 10), "known");
});

test("an output with no bound is not served against a measured link, and is while nothing measured it", () => {
  const candidates = [candidate("hardware", 1824, 1026, { mbps: null })];
  assert.equal(choose({ mode: "manual", candidates }, 50), null);
  assert.equal(choose({ mode: "manual", candidates }, null), "hardware");
});
