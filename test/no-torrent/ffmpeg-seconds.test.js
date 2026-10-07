import test from "node:test";
import assert from "node:assert/strict";
import { ffmpegSeconds } from "../../services/encode/run-command.js";

test("a real one-millisecond trim survives floating-point subtraction", () => {
  assert.equal(ffmpegSeconds(850.017 - 850.0160000000001), "0.001");
  assert.equal(ffmpegSeconds(0.000125), "0.000125");
});

test("sub-microsecond subtraction noise rounds to zero without exponent notation", () => {
  assert.equal(ffmpegSeconds(3.3333333249174757e-7), "0");
  assert.equal(ffmpegSeconds(-3.3333333249174757e-7), "0");
  assert.equal(ffmpegSeconds(Number.NaN), "0");
});
