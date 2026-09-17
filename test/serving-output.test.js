/**
 * @file Which existing output serves a viewer, by the rules decided with the
 * user 2026-09-16.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chooseServingOutput } from "../services/encode/quality/serving-output.js";

const WANTED = { width: 1824, height: 1026 };
const NEXT_LOWER = 1280 * 720;
const anyLink = () => true;

function candidate(key, width, height, { peakMbps = 5, readyHere = true } = {}) {
  return { key, width, height, peakMbps, readyHere };
}

function choose(over) {
  return chooseServingOutput({
    mode: "auto",
    wanted: WANTED,
    nextLowerArea: NEXT_LOWER,
    atRisk: false,
    linkCarries: anyLink,
    candidates: [],
    ...over
  });
}

test("the same quality or higher is served, the nearest of them", () => {
  assert.equal(
    choose({ candidates: [candidate("2160", 3840, 2160), candidate("1080", 1920, 1080)] }),
    "1080"
  );
});

test("higher quality is not served over a link it does not fit", () => {
  assert.equal(
    choose({
      linkCarries: (peak) => peak <= 8,
      candidates: [candidate("1080", 1920, 1080, { peakMbps: 12 })]
    }),
    null
  );
});

test("a little lower — above the next rung down — is served", () => {
  assert.equal(choose({ candidates: [candidate("1000", 1776, 1000)] }), "1000");
});

test("the next rung down or lower is served only when making the wanted format risks a wait", () => {
  const lower = [candidate("720", 1280, 720), candidate("480", 854, 480)];
  assert.equal(choose({ candidates: lower }), null);
  assert.equal(choose({ candidates: lower, atRisk: true }), "720");
});

test("an output without the piece at the viewer's position spares them nothing", () => {
  assert.equal(choose({ candidates: [candidate("1080", 1920, 1080, { readyHere: false })] }), null);
});

test("a size chosen by hand is served only exactly", () => {
  const candidates = [candidate("1080", 1920, 1080), candidate("exact", 1824, 1026)];
  assert.equal(choose({ mode: "manual", candidates }), "exact");
  assert.equal(choose({ mode: "manual", candidates: [candidate("1080", 1920, 1080)], atRisk: true }), null);
});
