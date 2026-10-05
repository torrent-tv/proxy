import test from "node:test";
import assert from "node:assert/strict";
import { h264Configuration } from "../../services/media/container/h264-configuration.js";
import { configuration } from "./helpers/avc-configuration.js";

test("AVC configuration derives its declared reorder depth, dimensions and fixed frame rate", () => {
  assert.deepEqual(h264Configuration(configuration()), { width: 64, height: 64, fps: 25, bitDepth: 8,
    reorderDepth: 2, nalLengthBytes: 4, frameOnly: true, timingTickSeconds: 0.02, picStructPresent: false, seiDelayBits: 0 });
});
test("invalid reorder bounds and missing SPS data cannot become decoder facts", () => {
  assert.throws(() => h264Configuration(configuration({ reorder: 3, buffering: 2 })), /reorder buffer/);
  assert.throws(() => h264Configuration(configuration().subarray(0, 11)), /SPS exceeds/);
  assert.throws(() => h264Configuration(Buffer.alloc(7)), /configuration is invalid/);
  const reserved = configuration();
  reserved[4] = 254;
  assert.throws(() => h264Configuration(reserved), /length size is reserved/);
});
