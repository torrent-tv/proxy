/**
 * @file What an output is encoded AS is decided once, for the output.
 *
 * The realtime budget decides the box, the frame rate and the speed setting
 * from what the machine could hold at that moment. Decided per SESSION, two
 * sessions of one output made minutes apart could be given different pictures
 * while claiming the same identity — and everything downstream assumes they
 * cannot be, from a segment of one standing in for a segment of the other to
 * the single RESOLUTION the master names for both.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Output, Outputs } from "../services/output/Output.js";

const KEY = "torrent:abc:fmt=fmp4:grid=even@0:video-only:v=0/enc:1280x720:auto";

test("the second session of one output is given the shape the first was", () => {
  const outputs = new Outputs();
  const first = outputs.get(KEY, () => new Output({
    encodeWidth: 1280,
    encodeHeight: 720,
    outputFps: 24,
    softwarePreset: "veryfast",
    applyTonemap: false
  }));
  // A minute later the machine is busier and the budget would answer 480p. It
  // is not asked: the shape of this output was settled when it was first made.
  const second = outputs.get(KEY, () => {
    throw new Error("deciding twice is how two sessions of one output diverge");
  });

  assert.equal(second, first);
  assert.equal(second.encodeHeight, 720);
});

test("two outputs are two shapes", () => {
  const outputs = new Outputs();
  const tall = outputs.get(KEY, () => new Output({ encodeWidth: 1280, encodeHeight: 720, outputFps: 24 }));
  const short = outputs.get(`${KEY}:other`, () => new Output({
    encodeWidth: 854,
    encodeHeight: 480,
    outputFps: 24
  }));

  assert.notEqual(short, tall);
  assert.equal(short.encodeHeight, 480);
});

test("a copied picture has no box of its own, and says so with zeroes", () => {
  // Zero means the source's own size, which is what a copy is by definition:
  // no box asked for can change one byte of it.
  const copied = new Output({ encodeWidth: 0, encodeHeight: 0, outputFps: 24 });

  assert.equal(copied.encodeWidth, 0);
  assert.equal(copied.encodeHeight, 0);
  assert.equal(copied.softwarePreset, null, "and no speed setting, having no encoder");
});

test("a shape nobody holds is dropped", () => {
  const outputs = new Outputs();
  const kept = outputs.get(KEY, () => new Output({ encodeWidth: 1280, encodeHeight: 720, outputFps: 24 }));
  outputs.get(`${KEY}:other`, () => new Output({ encodeWidth: 854, encodeHeight: 480, outputFps: 24 }));

  assert.equal(outputs.size, 2);
  assert.equal(outputs.forgetUnused(new Set([kept])), 1);
  assert.equal(outputs.size, 1);
});
