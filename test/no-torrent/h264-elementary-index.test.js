import test from "node:test";
import assert from "node:assert/strict";
import { MpegElementaryIndex } from "../../services/media/container/mpeg-elementary-index.js";
import { configuration } from "./helpers/avc-configuration.js";

const unit = bytes => Buffer.concat([Buffer.from([0, 0, 0, 1]), bytes]);

for (const pocType of [1, 2]) test(`container cadence places AVC type ${pocType} without proportional POC timing`, () => {
  const avcc = configuration({ pocType });
  const size = avcc.readUInt16BE(6);
  const declarations = Buffer.concat([unit(avcc.subarray(8, 8 + size)), unit(Buffer.from([0x68, 0xe0]))]);
  const track = { trackNumber: 1, type: "video", codecId: "h264", presentationCadenceSeconds: 0.04, startTimeSeconds: 0 };
  const reader = new MpegElementaryIndex([track]);
  const slice = (frame, header) => {
    let bits = "111" + frame.toString(2).padStart(4, "0") + (header === 0x65 ? "1" : "") + "1";
    bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0");
    return unit(Buffer.from([header, ...bits.match(/.{8}/g).map(value => Number.parseInt(value, 2))]));
  };
  const bytes = Buffer.concat([declarations, slice(0, 0x65), slice(1, 0x41),
    slice(pocType === 1 ? 2 : 1, 0x01), slice(pocType === 1 ? 3 : 2, 0x41)]);
  reader.push(1, bytes, 0, { pts: 0, dts: 0 });
  const result = reader.complete().inputFor({ trackId: 1, from: 0, to: 0.16 });
  assert.equal(result.kind, "result");
  assert.deepEqual(result.packets.map(packet => Math.round(packet.pts * 1000)), [0, 80, 40, 120]);
  assert.deepEqual(result.packets.map(packet => Math.round(packet.duration * 1000)), [40, 40, 40, 40]);
});

test("SEI picture structure determines a repeated final AVC frame duration", () => {
  const avcc = configuration({ picStruct: true });
  const size = avcc.readUInt16BE(6);
  const declarations = Buffer.concat([unit(avcc.subarray(8, 8 + size)), unit(Buffer.from([0x68, 0xe0]))]);
  for (const split of [1, 3, 7, declarations.length]) {
    const track = { trackNumber: 1, type: "video", codecId: "h264" };
    const reader = new MpegElementaryIndex([track]);
    const first = Buffer.concat([declarations, unit(Buffer.from([0x65, 0x80]))]);
    reader.push(1, first.subarray(0, split), 100, { pts: 0, dts: 0 });
    reader.push(1, first.subarray(split), 300);
    const second = Buffer.concat([unit(Buffer.from([6, 1, 1, 0x80, 0x80])), unit(Buffer.from([0x41, 0x80]))]);
    for (let at = 0; at < second.length; at++) reader.push(1, second.subarray(at, at + 1), 500 + at,
      at === 0 ? { pts: 0.04, dts: 0.04 } : {});
    const input = reader.complete().inputFor({ trackId: 1, from: 0, to: 0.16 });
    assert.equal(input.kind, "result");
    assert.deepEqual(input.packets.map(packet => packet.duration), [0.04, 0.12]);
    assert.deepEqual(input.packets.map(packet => packet.keyframe), [true, false]);
    assert.equal(track.picStructPresent, true);
  }
});
