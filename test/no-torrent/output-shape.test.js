/**
 * @file The shape an encoder is given for an output.
 *
 * The format itself is the output's identity (`OutputSpec`), decided before
 * the output is named; this is that format in the terms the encoder takes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Output } from "../../services/encode/output/Output.js";

test("a copied picture has no box of its own, and says so with zeroes", () => {
  // Zero means the source's own size, which is what a copy is by definition:
  // no box asked for can change one byte of it.
  const copied = new Output({ encodeWidth: 0, encodeHeight: 0, outputFps: 24 });

  assert.equal(copied.encodeWidth, 0);
  assert.equal(copied.encodeHeight, 0);
  assert.equal(copied.softwarePreset, null, "and no speed setting, having no encoder");
});

