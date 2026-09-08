/**
 * @file What the master playlist declares a variant carries.
 *
 * Measured, and the measurement was available all along: it used to be
 * `height * height * 3.2`, justified by a comment saying no measurement existed
 * before encoding starts. Field 2026-09-08: 3.73 Mbit/s declared for a file
 * carrying 18.4, and the browser sizes its cushion in BYTES from that figure —
 * 120 s asked bought 26 s of film, and the deepest it ever held was 17.1 s.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { declaredRates } from "../services/output/rates.js";
import { bitrateFor } from "../services/output/playlists.js";

// The field file: 2 806 246 976 bytes over 20:18, cut into 291 pieces.
const FIELD = { fileLength: 2_806_246_976, durationSeconds: 1218.73 };

test("the average is the file's own length over its duration", () => {
  const { averageBitsPerSecond } = declaredRates(FIELD);

  // 18.4 Mbit/s, against the 3.73 that was declared.
  assert.ok(
    Math.abs(averageBitsPerSecond / 1_000_000 - 18.42) < 0.01,
    `got ${averageBitsPerSecond}`
  );
});

test("nothing measured is stated as nothing, not as a guess", () => {
  assert.deepEqual(
    declaredRates({ fileLength: 0, durationSeconds: 0 }),
    { averageBitsPerSecond: 0, peakOverAverage: 1 }
  );
  assert.deepEqual(
    declaredRates({ fileLength: 100, durationSeconds: 0 }),
    { averageBitsPerSecond: 0, peakOverAverage: 1 }
  );
});

test("the peak comes from the biggest piece made and the span it covers", () => {
  // The field peak: 38.4 MB over 4.2 s is 73 Mbit/s, four times the average.
  const boundaries = Array.from({ length: 292 }, (_, index) => index * 4.2);
  const { averageBitsPerSecond, peakOverAverage } = declaredRates({
    ...FIELD,
    largest: { index: 2, size: 40_288_299 },
    boundaries
  });

  const peak = averageBitsPerSecond * peakOverAverage;
  assert.ok(Math.abs(peak / 1_000_000 - 76.7) < 0.5, `got ${peak / 1_000_000}Mbit/s`);
});

test("no piece made yet means the peak is not yet measured, so it equals the average", () => {
  // A ratio invented meanwhile is exactly the fabrication this replaced.
  assert.equal(declaredRates(FIELD).peakOverAverage, 1);
  assert.equal(
    declaredRates({ ...FIELD, largest: { index: -1, size: 0 }, boundaries: [0, 4] }).peakOverAverage,
    1
  );
});

test("the peak is never below the average", () => {
  // A short session whose only piece happens to be a small one must not lower
  // the figure the player sizes its cushion from.
  const boundaries = Array.from({ length: 292 }, (_, index) => index * 4.2);
  assert.equal(
    declaredRates({ ...FIELD, largest: { index: 5, size: 1000 }, boundaries }).peakOverAverage,
    1
  );
});

test("a smaller picture is declared at the pixel share of the source's rate", () => {
  const measured = 18_420_000;

  assert.equal(
    bitrateFor({ averageBitsPerSecond: measured, height: 1080, sourceHeight: 1080 }),
    Math.round(measured),
    "the source's own height carries the source's bits"
  );
  assert.equal(
    bitrateFor({ averageBitsPerSecond: measured, height: 2160, sourceHeight: 1080 }),
    Math.round(measured),
    "and a height above it carries no more — there is nothing to upscale from"
  );
  assert.equal(
    bitrateFor({ averageBitsPerSecond: measured, height: 540, sourceHeight: 1080 }),
    Math.round(measured / 4),
    "half the height is a quarter of the pixels"
  );
});

test("a capped height is declared at its cap, which is exact", () => {
  assert.equal(
    bitrateFor({ averageBitsPerSecond: 18_420_000, height: 720, sourceHeight: 1080, capKbps: 2500 }),
    2_500_000,
    "what we impose is known, not estimated"
  );
  assert.equal(
    bitrateFor({ averageBitsPerSecond: 1_000_000, height: 1080, sourceHeight: 1080, capKbps: 99_000 }),
    1_000_000,
    "and a cap above what the source carries takes nothing away from it"
  );
});

test("the floor is a floor on what may be declared, not a belief about content", () => {
  assert.equal(
    bitrateFor({ averageBitsPerSecond: 0, height: 1080, sourceHeight: 1080 }),
    400_000,
    "a file whose rate is not known yet"
  );
  assert.equal(
    bitrateFor({ averageBitsPerSecond: 18_420_000, height: 4, sourceHeight: 1080 }),
    400_000,
    "and a variant so small the arithmetic would go under it"
  );
});
