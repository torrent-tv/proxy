import test from "node:test";
import assert from "node:assert/strict";
import { HevcElementaryIndex } from "../../services/media/container/hevc-elementary-index.js";
import { PacketIndex } from "../../services/media/container/PacketIndex.js";
import { hevcSequence } from "../../services/media/container/hevc-configuration.js";

function ue(value) {
  const binary = (value + 1).toString(2);
  return "0".repeat(binary.length - 1) + binary;
}
function packed(binary) {
  return Buffer.from(binary.padEnd(Math.ceil(binary.length / 8) * 8, "0").match(/.{8}/g).map(value => Number.parseInt(value, 2)));
}
function escaped(bytes) {
  const output = [];
  let zeroes = 0;
  for (const byte of bytes) {
    if (zeroes === 2 && byte <= 3) { output.push(3); zeroes = 0; }
    output.push(byte);
    zeroes = byte === 0 ? zeroes + 1 : 0;
  }
  return Buffer.from(output);
}
function sps(proportional) {
  const fields = "00000001" + "0".repeat(96) + ue(0) + ue(1) + ue(64) + ue(64) + "0" + ue(0) + ue(0) + ue(0) +
    "1" + ue(2) + ue(1) + ue(0) + ue(0).repeat(6) + "0000" + ue(0) + "0001" + "0".repeat(8) + "1" +
    (1).toString(2).padStart(32, "0") + (10).toString(2).padStart(32, "0") + (proportional ? "1" + ue(0) : "0") + "0001";
  return Buffer.concat([Buffer.from([66, 1]), escaped(packed(fields))]);
}
function nal(type, binary) { return Buffer.concat([Buffer.from([type << 1, 1]), packed(binary)]); }
function unit(bytes) { return Buffer.concat([Buffer.from([0, 0, 1]), bytes]); }

test("HEVC missing PES clocks use declared proportional picture order and preserve B-frame positions", () => {
  const sequence = sps(true);
  assert.equal(hevcSequence(sequence).pocProportional, true);
  const track = { trackNumber: 1 };
  const index = new PacketIndex();
  index.declareTrack(1, { type: "video", reorderDepth: 1 });
  const reader = new HevcElementaryIndex(track, index);
  const declarations = Buffer.concat([
    unit(Buffer.from("40010c01ffff01600000030090000003000003001e959809", "hex")),
    unit(sequence), unit(Buffer.from("4401c172b42240", "hex"))]);
  const pictures = [[0, 19, { pts: 0, dts: 0 }], [3, 1, { pts: 0.3, dts: 0.1 }],
    [1, 0, null], [2, 0, null], [4, 1, { pts: 0.4, dts: 0.4 }]];
  let position = declarations.length;
  reader.push(declarations, 0, null);
  for (const [count, type, stamp] of pictures) {
    const bytes = unit(nal(type, "1" + (type === 19 ? "0" : "") + ue(0) + ue(2) +
      (type === 19 ? "" : count.toString(2).padStart(4, "0")) + "1"));
    reader.push(bytes, position, stamp);
    position += bytes.length;
  }
  reader.complete();
  const input = index.inputFor({ trackId: 1, from: 0, to: 0.5 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.packets.map(packet => Number(packet.pts.toFixed(6))), [0, 0.3, 0.1, 0.2, 0.4]);
  assert.deepEqual(input.packets.map(packet => Number(packet.dts.toFixed(6))), [0, 0.1, 0.2, 0.3, 0.4]);
  assert.equal(input.ranges[0][0], 0);
  assert.equal(input.ranges.at(-1)[1], position - 1);
});
