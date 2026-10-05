import test from "node:test";
import assert from "node:assert/strict";
import { MpegElementaryIndex } from "../../services/media/container/mpeg-elementary-index.js";

const track = () => ({ trackNumber: 1, type: "video", codecId: "mpeg2video", fps: 10 });
const picture = (reference, type) => Buffer.from([0, 0, 1, 0, reference >> 2, ((reference & 3) << 6) | (type << 3), 1]);

test("an unsupported unselected audio track cannot prevent indexing selected picture", () => {
  const reader = new MpegElementaryIndex([track(), { type: "audio", trackNumber: 2, codecId: "unknown" }]);
  reader.push(1, picture(0, 1), 100, { pts: 0 });
  const index = reader.complete();
  assert.equal(index.inputFor({ trackId: 1, from: 0, to: 0.1 }).kind, "result");
  assert.deepEqual(index.inputFor({ trackId: 2, from: 0, to: 0.1 }),
    { kind: "terminal", reason: "elementary-index-unavailable:unknown", trackId: 2 });
});

test("MPEG audio layer comes from the frame rather than the program declaration", () => {
  for (const [layer, size, codecId, samples] of [[3, 32, "mp1", 384], [2, 96, "mp2", 1152], [1, 96, "mp3", 1152]]) {
    const audio = { trackNumber: 2, type: "audio", codecId: "mp2" };
    const reader = new MpegElementaryIndex([audio]);
    const bytes = Buffer.alloc(size);
    bytes.set([0xff, 0xe0 | (3 << 3) | (layer << 1) | 1, 0x14, 0]);
    reader.push(2, bytes.subarray(0, 3), 100, { pts: 0 });
    reader.push(2, bytes.subarray(3), 300);
    const index = reader.complete();
    const input = index.inputFor({ trackId: 2, from: 0, to: samples / 48000 });
    assert.equal(audio.codecId, codecId);
    assert.equal(input.kind, "result");
    assert.deepEqual(input.ranges, [[100, 102], [300, 300 + size - 4]]);
    assert.equal(input.packets[0].duration, samples / 48000);
  }
});

test("PES clock wrap preserves a negative first decode time and B-frame presentation order", () => {
  const reader = new MpegElementaryIndex([track()]);
  const cycle = 2 ** 33 / 90000;
  reader.push(1, picture(0, 1), 100, { pts: 0, dts: cycle - 0.1 });
  reader.push(1, picture(3, 2), 200, { pts: 0.3, dts: 0 });
  reader.push(1, picture(1, 3), 300, { pts: 0.1, dts: 0.1 });
  const index = reader.complete();
  const input = index.inputFor({ trackId: 1, from: 0, to: 0.4 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.packets.map(packet => packet.pts), [0, 0.3, 0.1]);
  assert.ok(Math.abs(input.packets[0].dts + 0.1) < 1e-10);
  assert.deepEqual(input.packets.slice(1).map(packet => packet.dts), [0, 0.1]);
  assert.deepEqual(input.ranges, [[100, 106], [200, 206], [300, 306]]);
});

test("field pictures are refused instead of assigned an incorrect frame duration", () => {
  const reader = new MpegElementaryIndex([track()]);
  assert.throws(() => reader.push(1, Buffer.concat([picture(0, 1),
    Buffer.from([0, 0, 1, 0xb5, 0x81, 0x11, 0x10, 0, 0])]), 0, { pts: 0 }), /field-specific packet timing/);
});

test("AAC ADTS framing preserves split payload addresses and removes its CRC header", () => {
  const audio = { trackNumber: 2, type: "audio", codecId: "aac" };
  const reader = new MpegElementaryIndex([audio]);
  const bytes = Buffer.from([0xff, 0xf0, 0x4c, 0x40, 1, 0x9f, 0xfc, 0, 0, 10, 11, 12]);
  reader.push(2, bytes.subarray(0, 10), 100, { pts: 0 });
  reader.push(2, bytes.subarray(10), 200);
  const input = reader.complete().inputFor({ trackId: 2, from: 0, to: 1024 / 48000 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.ranges, [[109, 109], [200, 201]]);
  assert.equal(audio.samplingFrequency, 48000);
  assert.equal(audio.channels, 1);
  assert.equal(audio.codecPrivateB64, Buffer.from([0x11, 0x88]).toString("base64"));
});
