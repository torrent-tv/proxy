/**
 * @file The decode-cost fit, and the case it exists to prevent.
 *
 * The failure being pinned is real and dated: on 2026-08-17 three clips for
 * three unknowns returned `0.007542 × Mpx/s + 0.000000 × Mbit/s + 0.0000 s/s`,
 * with the bitrate term and the constant exactly zero, and the prediction built
 * on it was 1.8-2.2x optimistic. An exact system cannot notice that two of its
 * points said the same thing; these tests hold the replacement to noticing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { decodeCostOf, fitDecodeCost } from "../services/decode-cost-fit.js";

const FPS = 24;

/**
 * A clip's measurement, priced by a known truth so a fit can be checked against
 * the answer it should recover.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} megabitsPerSecond
 * @param {{ pixel: number, bitrate: number, constant: number, noise?: number }} truth
 * @returns {{ megapixelsPerSecond: number, megabitsPerSecond: number, costSecondsPerSecond: number }}
 */
function clip(width, height, megabitsPerSecond, truth) {
  const megapixelsPerSecond = (width * height * FPS) / 1e6;
  const cost =
    truth.pixel * megapixelsPerSecond + truth.bitrate * megabitsPerSecond + truth.constant + (truth.noise ?? 0);
  return { megapixelsPerSecond, megabitsPerSecond, costSecondsPerSecond: cost };
}

/** The set the clips were cut to: three sizes, two bitrates, varied independently. */
const SIZES = [
  [1920, 1080],
  [1280, 720],
  [854, 480]
];
const BITRATES = [9.5, 1.1];

/**
 * @param {{ pixel: number, bitrate: number, constant: number }} truth
 * @param {number[]} [noise] - Per-clip disturbance, in order.
 * @returns {ReturnType<typeof clip>[]}
 */
function wellConditionedSet(truth, noise = []) {
  const samples = [];
  let index = 0;
  for (const [width, height] of SIZES) {
    for (const bitrate of BITRATES) {
      samples.push(clip(width, height, bitrate, { ...truth, noise: noise[index] ?? 0 }));
      index += 1;
    }
  }
  return samples;
}

test("a well-conditioned set recovers every term", () => {
  const truth = { pixel: 0.0055, bitrate: 0.0099, constant: 0.057 };
  const model = fitDecodeCost(wellConditionedSet(truth));

  assert.ok(model, "six clips over three unknowns must produce a model");
  assert.equal(model.shape, "pixels+bitrate+constant");
  assert.deepEqual(model.dropped, []);
  assert.ok(Math.abs(model.pixelTerm - truth.pixel) < 1e-6, `pixel term ${model.pixelTerm}`);
  assert.ok(Math.abs(model.bitrateTerm - truth.bitrate) < 1e-6, `bitrate term ${model.bitrateTerm}`);
  assert.ok(Math.abs(model.constantTerm - truth.constant) < 1e-6, `constant ${model.constantTerm}`);
});

test("three clips are refused outright — an exact system cannot see its own degeneracy", () => {
  // Exactly the shape that shipped: two clips at the same pixel rate differing
  // only in bitrate, and a third at another size.
  const truth = { pixel: 0.0055, bitrate: 0.0099, constant: 0.057 };
  const three = [clip(1920, 1080, 11.4, truth), clip(1920, 1080, 0.97, truth), clip(1280, 720, 2.25, truth)];

  assert.equal(
    fitDecodeCost(three),
    null,
    "with no residual there is nothing to notice a degeneracy with, so no model may be published"
  );
});

test("a term the measurements do not determine is dropped, and said so", () => {
  // A host whose decoding does not depend on bitrate at all: the term is not
  // small, it is absent. What must NOT happen is publishing a zero as though it
  // had been measured.
  const truth = { pixel: 0.0055, bitrate: 0, constant: 0.057 };
  // Deliberately NOT alternating with the bitrate column: an earlier version
  // of this test put positive noise on every high-bitrate clip and negative on
  // every low one, which IS a bitrate signal — the fit found it, correctly, and
  // the test was wrong.
  const noise = [0.004, 0.003, -0.004, 0.002, -0.003, -0.002];
  const model = fitDecodeCost(wellConditionedSet(truth, noise));

  assert.ok(model);
  assert.ok(model.dropped.includes("bitrate"), `dropped: ${model.dropped.join(",") || "nothing"}`);
  assert.equal(model.bitrateTerm, 0);
  assert.ok(model.shape.includes("pixels"));
});

test("noise in the readings does not become a term", () => {
  // Pure noise around a pixels-only truth, larger than any bitrate effect.
  const truth = { pixel: 0.0055, bitrate: 0, constant: 0 };
  const noise = [0.01, 0.009, -0.012, 0.011, -0.008, -0.01];
  const model = fitDecodeCost(wellConditionedSet(truth, noise));

  assert.ok(model);
  assert.ok(model.pixelTerm > 0, "the one relationship every reading agrees on survives");
  assert.ok(
    model.dropped.length > 0,
    "and the terms the noise could have supplied are reported as undetermined"
  );
});

test("without a measurable dependence on the source there is no model", () => {
  // Every clip costs the same regardless of size or bitrate: nothing here says
  // what a bigger picture costs, and inventing it is worse than having none.
  const flat = wellConditionedSet({ pixel: 0, bitrate: 0, constant: 0.3 });
  assert.equal(fitDecodeCost(flat), null);
  assert.equal(fitDecodeCost([]), null);
  assert.equal(fitDecodeCost(null), null);
});

test("readings that are not measurements are left out", () => {
  const truth = { pixel: 0.0055, bitrate: 0.0099, constant: 0.057 };
  const samples = [
    ...wellConditionedSet(truth),
    { megapixelsPerSecond: Number.NaN, megabitsPerSecond: 5, costSecondsPerSecond: 1 },
    { megapixelsPerSecond: 20, megabitsPerSecond: 5, costSecondsPerSecond: 0 }
  ];
  const model = fitDecodeCost(samples);
  assert.ok(model);
  assert.equal(model.samples, 6);
});

test("what a model prices a film at", () => {
  const model = fitDecodeCost(wellConditionedSet({ pixel: 0.0055, bitrate: 0.0099, constant: 0.057 }));
  // The field film: 1080p24 at about 8 Mbit/s.
  const cost = decodeCostOf(model, { megapixelsPerSecond: 49.77, megabitsPerSecond: 8 });
  assert.ok(cost > 0);
  // Which is a decode speed of 1/cost — the figure the quality offer rests on.
  assert.ok(1 / cost > 1 && 1 / cost < 10, `decodes at ${(1 / cost).toFixed(2)}x`);
});
