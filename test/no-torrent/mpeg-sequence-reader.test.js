import assert from "node:assert/strict";
import test from "node:test";
import { MpegSequenceReader } from "../../services/media/container/mpeg-sequence-reader.js";

function bits(fields) {
  const binary = fields.map(([value, length]) => value.toString(2).padStart(length, "0")).join("");
  assert.equal(binary.length % 8, 0);
  return Buffer.from(binary.match(/.{8}/g).map(value => Number.parseInt(value, 2)));
}

function declarations(matrices) {
  const sequence = bits([[64, 12], [64, 12], [1, 4], [3, 4], [1, 18], [1, 1], [0, 10], [0, 1],
    [matrices ? 1 : 0, 1], ...(matrices ? Array.from({ length: 64 }, () => [1, 8]) : []),
    [matrices ? 1 : 0, 1], ...(matrices ? Array.from({ length: 64 }, () => [2, 8]) : [])]);
  const extension = bits([[1, 4], [0x48, 8], [1, 1], [1, 2], [0, 2], [0, 2], [0, 12], [1, 1], [0, 8], [0, 1], [0, 2], [0, 5]]);
  return Buffer.concat([Buffer.from([0, 0, 1, 0xb3]), sequence, Buffer.from([0, 0, 1, 0xb5]), extension,
    Buffer.from([0, 0, 1, 0xb8, 1])]);
}

for (const matrices of [false, true]) {
  test(`sequence declarations after long user data survive every byte boundary, matrices=${matrices}`, () => {
    const bytes = Buffer.concat([Buffer.from([0, 0, 1, 0xb2]), Buffer.alloc(4096, 5), declarations(matrices)]);
    for (const width of [1, 3, 184, bytes.length]) {
      const reader = new MpegSequenceReader("mpeg2video");
      let facts;
      for (let at = 0; at < bytes.length; at += width) facts = reader.push(bytes.subarray(at, at + width));
      assert.deepEqual(facts, { width: 64, height: 64, fps: 25, codecId: "mpeg2video", bitDepth: 8, progressiveSequence: true });
    }
  });
}
