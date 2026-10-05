import assert from "node:assert/strict";
import test from "node:test";
import { hevcConfiguration, hevcConfigurationFromUnits, hevcSequence } from "../../services/media/container/hevc-configuration.js";

// Captured from a synthetic 64x64 lavfi source, encoded at ten frames per second.
const vps = Buffer.from("40010c01ffff01600000030090000003000003001e959809", "hex");
const sps = Buffer.from("42010101600000030090000003000003001ea020810596566924caf0168080000003008000000504", "hex");
const pps = Buffer.from("4401c172b42240", "hex");

test("HEVC in-band declarations preserve dimensions, reorder depth, chroma and timing in hvcC", () => {
  const facts = hevcConfigurationFromUnits(vps, sps, pps);
  assert.equal(facts.width, 64);
  assert.equal(facts.height, 64);
  assert.equal(facts.bitDepth, 8);
  assert.equal(facts.chromaFormat, 1);
  assert.equal(facts.fps, 10);
  assert.equal(facts.timingTickSeconds, 0.1);
  assert.ok(facts.reorderDepth > 0);
  const bytes = Buffer.from(facts.codecPrivateB64, "base64");
  assert.equal(bytes[16] & 3, facts.chromaFormat);
  const decoded = hevcConfiguration(bytes);
  assert.equal(decoded.fps, 10);
  assert.equal(decoded.reorderDepth, facts.reorderDepth);
  assert.equal(decoded.nalLengthBytes, 4);
});

test("truncated, mismatched and multilayer HEVC declarations cannot become decoder facts", () => {
  assert.throws(() => hevcSequence(sps.subarray(0, 18)), /HEVC.*truncated/);
  const layered = Buffer.from(sps); layered[1] |= 8;
  assert.throws(() => hevcSequence(layered), /multilayer/);
  const bytes = Buffer.from(hevcConfigurationFromUnits(vps, sps, pps).codecPrivateB64, "base64");
  assert.throws(() => hevcConfiguration(bytes.subarray(0, bytes.length - 1)), /exceeds/);
  bytes[23] = 34;
  assert.throws(() => hevcConfiguration(bytes), /does not match/);
});
