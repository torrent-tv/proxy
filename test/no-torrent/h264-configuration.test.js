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
test("an emulation prevention byte before a byte above 0x03 is removed the way decoders remove it", () => {
  // LostFilm's LostCoder, field 2026-10-06: the SPS carries 00 00 03 b3, which H.264 §7.4.1 forbids and ffmpeg
  // decodes anyway as time_scale 46000 (torrent-tv/meta#147).
  const avcc = Buffer.from("0164001fffe100176764001fac2cac05005bb01100000303e8000003b3b08401000468ee3cb0", "hex");
  assert.deepEqual(h264Configuration(avcc), { width: 1280, height: 720, fps: 23, bitDepth: 8, reorderDepth: 5,
    frameOnly: true, timingTickSeconds: 1000 / 46000, picStructPresent: false, seiDelayBits: 0, nalLengthBytes: 4 });
});
