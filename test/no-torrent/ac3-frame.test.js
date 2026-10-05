import assert from "node:assert/strict";
import test from "node:test";
import { ac3Frame } from "../../services/media/container/ac3-frame.js";
import { MpegElementaryIndex } from "../../services/media/container/mpeg-elementary-index.js";

test("AC-3 frame length follows the alternating 44.1 kHz word count and reduced sample rate", () => {
  for (const [code, version, bytes, rate] of [[0, 8, 138, 44100], [1, 8, 140, 44100], [36, 8, 2786, 44100], [37, 8, 2788, 44100], [0, 9, 138, 22050]]) {
    const header = Buffer.from([0x0b, 0x77, 0, 0, 0x40 | code, version << 3, 0x40]);
    const frame = ac3Frame(header);
    assert.equal(frame.size, bytes);
    assert.equal(frame.sampleRate, rate);
    assert.equal(frame.duration, 1536 / rate);
    assert.equal(frame.channels, 2);
  }
});

test("E-AC-3 block count controls duration and dependent streams are refused explicitly", () => {
  for (const [code, blocks] of [[0, 1], [1, 2], [2, 3], [3, 6]]) {
    const header = Buffer.from([0x0b, 0x77, 0, 63, (code << 4) | 4, 16 << 3, 0]);
    const frame = ac3Frame(header);
    assert.equal(frame.size, 128);
    assert.equal(frame.duration, blocks * 256 / 48000);
    assert.equal(frame.codecId, "eac3");
    header[2] = 0x40;
    assert.throws(() => ac3Frame(header), /dependent substreams/);
  }
});

test("AC-3 split frames retain exact physical ranges and cannot complete inside a frame", () => {
  const track = { trackNumber: 1, type: "audio", codecId: "ac3" };
  const reader = new MpegElementaryIndex([track]);
  const bytes = Buffer.alloc(128);
  bytes.set([0x0b, 0x77, 0, 0, 0, 8 << 3, 0x40]);
  reader.push(1, bytes.subarray(0, 6), 100, { pts: 0 });
  reader.push(1, bytes.subarray(6), 300);
  const input = reader.complete().inputFor({ trackId: 1, from: 0, to: 1536 / 48000 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.ranges, [[100, 105], [300, 421]]);
  const truncated = new MpegElementaryIndex([{ ...track }]);
  truncated.push(1, bytes.subarray(0, 127), 0, { pts: 0 });
  assert.throws(() => truncated.complete(), /inside a frame/);
});
