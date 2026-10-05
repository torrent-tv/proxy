import assert from "node:assert/strict";
import test from "node:test";
import { openDmlPackets } from "../../services/media/container/avi-open-dml.js";
import { AviContainer } from "../../services/media/container/AviContainer.js";
import { PacketIndex } from "../../services/media/container/PacketIndex.js";

function standard(base = 0n) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt16LE(2);
  bytes[3] = 1;
  bytes.writeUInt32LE(1, 4);
  bytes.write("00dc", 8);
  bytes.writeBigUInt64LE(base, 12);
  bytes.writeUInt32LE(200, 24);
  bytes.writeUInt32LE(4, 28);
  return bytes;
}

test("OpenDML super indexes follow their standard indexes without reading media payload", async () => {
  const bytes = Buffer.alloc(256);
  const root = bytes.subarray(32, 72);
  root.writeUInt16LE(4);
  root.writeUInt32LE(1, 4);
  root.write("00dc", 8);
  root.writeBigUInt64LE(128n, 24);
  root.writeUInt32LE(40, 32);
  bytes.write("ix00", 128);
  bytes.writeUInt32LE(32, 132);
  standard().copy(bytes, 136);
  bytes.write("00dc", 192);
  bytes.writeUInt32LE(4, 196);
  const reads = [];
  const packets = await Array.fromAsync(openDmlPackets({ indexes: [{ start: 32, end: 72 }], streamId: 0,
    fileSize: bytes.length, readRange: async (start, end) => { reads.push([start, end]); return bytes.subarray(start, end + 1); } }));
  assert.deepEqual(packets, [{ chunkId: "00dc", start: 200, length: 4, keyframe: true }]);
  assert.ok(reads.every(([start, end]) => end < 200 || start > 203));
  root.writeUInt32LE(41, 32);
  await assert.rejects(Array.fromAsync(openDmlPackets({ indexes: [{ start: 32, end: 72 }], streamId: 0,
    fileSize: bytes.length, readRange: async (a, b) => bytes.subarray(a, b + 1) })), /size disagrees/);
});

test("OpenDML addresses beyond 4 GiB retain exact offsets and delta-frame flags", async () => {
  const base = 2n ** 32n;
  const table = standard(base);
  table.writeUInt32LE(0x80000004, 28);
  const header = Buffer.from([48, 48, 100, 99, 4, 0, 0, 0]);
  const packets = await Array.fromAsync(openDmlPackets({ indexes: [{ start: 0, end: 32 }], streamId: 0,
    fileSize: Number(base) + 256, readRange: async (start, end) => start < 32
      ? table.subarray(start, end + 1) : header.subarray(start - Number(base) - 192, end - Number(base) - 191) }));
  assert.equal(packets[0].start, Number(base) + 200);
  assert.equal(packets[0].keyframe, false);
});

function chunk(id, payload) {
  const header = Buffer.alloc(8);
  header.write(id);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, ...(payload.length & 1 ? [Buffer.alloc(1)] : [])]);
}
const list = (type, payload) => chunk("LIST", Buffer.concat([Buffer.from(type), payload]));

test("AVI without an index retains its sequential cursor across missing headers and memory refusal", async () => {
  const strh = Buffer.alloc(56);
  strh.write("vids"); strh.writeUInt32LE(1, 20); strh.writeUInt32LE(25, 24); strh.writeUInt32LE(2, 32);
  const strf = Buffer.alloc(40);
  strf.writeUInt32LE(40); strf.writeInt32LE(64, 4); strf.writeInt32LE(64, 8); strf.writeUInt16LE(24, 14); strf.write("MJPG", 16);
  const hdrl = list("hdrl", list("strl", Buffer.concat([chunk("strh", strh), chunk("strf", strf)])));
  const media = list("movi", list("rec ", Buffer.concat([chunk("00dc", Buffer.from([1, 2, 3, 4])), chunk("00dc", Buffer.from([5, 6, 7, 8]))])));
  const bytes = chunk("RIFF", Buffer.concat([Buffer.from("AVI "), hdrl, media]));
  const first = bytes.indexOf(Buffer.from("00dc")), second = first + 12;
  let allow = false, complete = false;
  const reads = [];
  const container = new AviContainer({ fileSize: bytes.length, packetMemory: { reserve: () => allow },
    readRange: async (a, b) => {
      reads.push([a, b]);
      if (!complete && a === second) return null;
      return bytes.subarray(a, b + 1);
    } });
  await assert.rejects(container.readPacketIndex(), { name: "IndexMemoryUnavailable" });
  allow = true;
  const early = await container.readPacketIndex({ from: 0, to: 0.04 });
  assert.equal(early.isComplete(), false);
  await assert.rejects(container.readPacketIndex(), { name: "BytesUnavailable" });
  const firstReads = reads.filter(([a]) => a === first).length;
  complete = true;
  assert.equal(await container.readPacketIndex(), early);
  assert.equal(reads.filter(([a]) => a === first).length, firstReads);
  const input = early.inputFor({ trackId: 0, from: 0, to: 0.08 });
  assert.deepEqual(input.packets.map(packet => packet.pts), [0, 0.04]);
  assert.deepEqual(input.packets.map(packet => packet.ranges), [[[first + 8, first + 11]], [[second + 8, second + 11]]]);
});

test("dropped AVI frames extend the previous picture instead of shifting later timestamps", () => {
  const index = new PacketIndex();
  index.declareTrack(0, { type: "video" });
  index.append(0, { pts: 0, duration: 0.04, keyframe: true, ranges: [[100, 103]] });
  index.extendLastPresentation(0, 0.04);
  index.append(0, { pts: 0.08, duration: 0.04, keyframe: true, ranges: [[200, 203]] });
  index.complete(0);
  const input = index.inputFor({ trackId: 0, from: 0.04, to: 0.08 });
  assert.equal(input.kind, "result");
  assert.equal(input.packets[0].pts, 0);
  assert.equal(input.packets[0].duration, 0.08);
  assert.deepEqual(input.ranges, [[100, 103]]);
});

test("AVI uses its OpenDML stream index across a later AVIX form", async () => {
  const strh = Buffer.alloc(56);
  strh.write("vids");
  strh.writeUInt32LE(1, 20);
  strh.writeUInt32LE(25, 24);
  strh.writeUInt32LE(2, 32);
  const strf = Buffer.alloc(40);
  strf.writeUInt32LE(40);
  strf.writeInt32LE(64, 4);
  strf.writeInt32LE(64, 8);
  strf.writeUInt16LE(24, 14);
  strf.write("MJPG", 16);
  const table = Buffer.alloc(40);
  standard().subarray(0, 24).copy(table);
  table.writeUInt32LE(2, 4);
  const hdrl = list("hdrl", list("strl", Buffer.concat([chunk("strh", strh), chunk("strf", strf), chunk("indx", table)])));
  const media = list("movi", chunk("00dc", Buffer.from([1, 2, 3, 4])));
  const first = chunk("RIFF", Buffer.concat([Buffer.from("AVI "), hdrl, media]));
  const second = chunk("RIFF", Buffer.concat([Buffer.from("AVIX"), media]));
  const bytes = Buffer.concat([first, second]);
  const tableStart = bytes.indexOf(Buffer.from("indx")) + 8;
  const firstData = bytes.indexOf(Buffer.from("00dc"), tableStart + table.length) + 8;
  const secondData = bytes.indexOf(Buffer.from("00dc"), first.length) + 8;
  for (const [number, start] of [firstData, secondData].entries()) {
    bytes.writeUInt32LE(start, tableStart + 24 + number * 8);
    bytes.writeUInt32LE(4, tableStart + 28 + number * 8);
  }
  const container = new AviContainer({ fileSize: bytes.length, readRange: async (a, b) => bytes.subarray(a, b + 1) });
  const index = await container.readPacketIndex();
  const input = index.inputFor({ trackId: 0, from: 0, to: 0.08 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.packets.map(packet => packet.ranges), [[[firstData, firstData + 3]], [[secondData, secondData + 3]]]);
  assert.deepEqual((await container.parseKeyframeIndex()).times, [0, 0.04]);
});
