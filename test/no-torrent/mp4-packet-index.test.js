import test from "node:test";
import assert from "node:assert/strict";
import { Mp4Container } from "../../services/media/container/Mp4Container.js";
import { isUnavailable } from "../../services/media/container/unavailable.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";

function u32(...values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, at) => bytes.writeUInt32BE(value >>> 0, at * 4));
  return bytes;
}

test("a declared MP4 table requests its complete memory instead of reparsing one block at a time", async () => {
  const { bytes } = fileOf({ uniformCount: 10000 });
  let held = 0, allowed = Infinity;
  const container = new Mp4Container({ fileSize: 1000000,
    readRange: async (a, b) => bytes.subarray(a, b + 1),
    packetMemory: { reserve(bytes) { if (held + bytes > allowed) return false; held += bytes; return true; },
      release(bytes) { held -= bytes; } } });
  const tracks = await container.readTracks();
  assert.equal(tracks[0].fps, 1, "sample timing supplies cadence when codec settings omit it");
  assert.equal(await container.readTracks(), tracks);
  const declarations = held;
  allowed = declarations;
  await assert.rejects(container.readPacketIndex(), error => error instanceof IndexMemoryUnavailable && error.bytes > 655360);
  assert.equal(held, declarations);
  allowed = Infinity;
  const index = await container.readPacketIndex();
  const input = index.inputFor({ trackId: tracks[0].trackNumber, from: 0, to: 10000 });
  assert.equal(input.packets.length, 10000);
  assert.equal(held - declarations, index.allocatedBytes());
});
function box(type, bytes) {
  return Buffer.concat([u32(bytes.length + 8), Buffer.from(type), bytes]);
}
function full(type, bytes) { return box(type, Buffer.concat([u32(0), bytes])); }

function fileOf({ brokenCount = false, uniformCount = 0 } = {}) {
  const tkhd = full("tkhd", Buffer.concat([u32(0, 0, 1, 0, 4000), Buffer.alloc(60)]));
  const mdhd = full("mdhd", Buffer.concat([u32(0, 0, 1000, 4000), Buffer.alloc(4)]));
  const hdlr = full("hdlr", Buffer.concat([u32(0), Buffer.from("vide"), Buffer.alloc(12)]));
  const stsd = full("stsd", Buffer.concat([u32(1), box("avc1", Buffer.alloc(78))]));
  const count = uniformCount || 4;
  const stts = full("stts", u32(1, brokenCount ? 3 : count, 1000));
  const ctts = full("ctts", u32(4, 1, 0, 1, 1000, 1, -1000, 1, 0));
  // Signed composition offsets are version 1, with decode order PTS 0,2,1,3.
  ctts[8] = 1;
  const stsz = full("stsz", uniformCount ? u32(1, count) : u32(0, 4, 10, 20, 15, 25));
  const stsc = full("stsc", u32(1, 1, count, 1));
  const stss = full("stss", u32(2, 1, 4));
  const moovAt = start => box("moov", box("trak", Buffer.concat([tkhd, box("mdia", Buffer.concat([
    mdhd, hdlr, box("minf", box("stbl", Buffer.concat([stsd, stts, ...(uniformCount ? [] : [ctts]), stsz, stsc, stss, full("stco", u32(1, start))])))
  ]))])));
  const ftyp = box("ftyp", Buffer.concat([Buffer.from("isom"), u32(0), Buffer.from("isom")]));
  const draft = moovAt(0);
  const start = ftyp.length + draft.length + 8;
  return { bytes: Buffer.concat([ftyp, moovAt(start), box("mdat", Buffer.alloc(70))]), start };
}

test("a compact MP4 table cannot expand billions of samples before index admission", async () => {
  const { bytes } = fileOf({ uniformCount: 1000000000 });
  let reservations = 0;
  const container = new Mp4Container({ fileSize: 2000000000,
    readRange: async (a, b) => bytes.subarray(a, b + 1),
    packetMemory: { reserve: () => { reservations++; return false; } } });
  await assert.rejects(container.readPacketIndex(), { name: "IndexMemoryUnavailable" });
  assert.equal(reservations, 1);
  assert.equal(container.packetIndexBytes(), 0);
});

test("MP4 packet index uses real sample sizes, composition times and decode order", async () => {
  const { bytes, start } = fileOf();
  const container = new Mp4Container({ readRange: async (a, b) => bytes.subarray(a, b + 1), fileSize: bytes.length });
  const index = await container.readPacketIndex();
  const input = index.inputFor({ trackId: 1, from: 1, to: 2 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.packets.map(packet => packet.pts), [0, 2, 1]);
  assert.deepEqual(input.ranges.at(-1), [start, start + 44]);
  assert.equal(await container.readPacketIndex(), index);
});

test("MP4 missing table bytes do not become a cached packet index", async () => {
  const { bytes } = fileOf();
  let available = false;
  const container = new Mp4Container({ readRange: async (a, b) => available ? bytes.subarray(a, b + 1) : null, fileSize: bytes.length });
  await assert.rejects(container.readPacketIndex(), isUnavailable);
  assert.equal(container.packetIndex, undefined);
  available = true;
  assert.ok(await container.readPacketIndex());
});

test("MP4 packet index refuses inconsistent timing instead of inventing packets", async () => {
  const { bytes } = fileOf({ brokenCount: true });
  const container = new Mp4Container({ readRange: async (a, b) => bytes.subarray(a, b + 1), fileSize: bytes.length });
  await assert.rejects(container.readPacketIndex(), /timing count differs/);
});
