import test from "node:test";
import assert from "node:assert/strict";
import { urgentOutputsReady } from "../../services/viewer/urgent-output-ready.js";

function readiness(outputs, closed = () => true, overrides = {}) {
  return urgentOutputsReady({ sourceKey: "film", fileIndex: 0, durationSeconds: 12,
    atSeconds: 1, seconds: 6, outputs, consumed: () => true,
    segmentIndex: () => 0, segmentStart: (_output, index) => Math.min(12, index * 4),
    closed, ...overrides });
}
function output(key, fileIndex = 0) {
  return { outputKey: key, timeline: {}, file: { sourceKey: "film", fileIndex } };
}

test("both selected picture and sound must cover the entire urgent interval", () => {
  const outputs = [output("picture"), output("sound")];
  assert.equal(readiness(outputs), true);
  assert.equal(readiness(outputs, (key, index) => key !== "sound" || index !== 1), false);
  assert.equal(readiness(outputs, (_key, index) => index !== 0), false);
});

test("absent, unrelated and unconsumed outputs do not prove readiness", () => {
  assert.equal(readiness([]), false);
  assert.equal(readiness([output("other", 1)]), false);
  assert.equal(readiness([output("picture")], undefined, { consumed: () => false }), false);
});

test("unknown timing and nonprogressing boundaries cannot enable pause attenuation", () => {
  const outputs = [output("picture")];
  assert.equal(readiness(outputs, undefined, { atSeconds: NaN }), false);
  assert.equal(readiness(outputs, undefined, { segmentStart: () => 0 }), false);
  assert.equal(readiness(outputs, undefined, { segmentStart: () => NaN }), false);
  assert.equal(readiness(outputs, undefined, { segmentStart: () => 2 }), false);
});
