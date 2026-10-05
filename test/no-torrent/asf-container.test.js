import test from "node:test";
import assert from "node:assert/strict";
import { AsfContainer } from "../../services/media/container/AsfContainer.js";
import { ContainerFactory } from "../../services/media/container/ContainerFactory.js";
import { isUnavailable } from "../../services/media/container/unavailable.js";
import { IndexMemory } from "../../services/storage/IndexMemory.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";

test("ASF declaration allocation resumes without rereading retained objects", async () => {
  const bytes = fileOf();
  const memory = new IndexMemory({ reviseBudget() {}, changed() {} });
  memory.allow(80);
  let propertiesReads = 0;
  const container = new AsfContainer({ fileSize: bytes.length, packetMemory: memory.forFile("source", 0),
    readRange: async (start, end) => {
      if (start === 54) propertiesReads++;
      return bytes.subarray(start, end + 1);
    } });
  await assert.rejects(container.readTracks(), IndexMemoryUnavailable);
  assert.equal(memory.held(), 80);
  memory.allow(bytes.length);
  assert.equal((await container.readTracks()).length, 2);
  assert.equal(propertiesReads, 1);
  assert.equal(memory.held(), 80 + 54 + 55 + 54 + 20);
  assert.equal(memory.packetBytes(), 0);
  memory.forget("source");
  assert.equal(memory.held(), 0);
});

function object(guid, payload) {
  const header = Buffer.alloc(24);
  Buffer.from(guid, "hex").copy(header);
  header.writeBigUInt64LE(BigInt(24 + payload.length), 16);
  return Buffer.concat([header, payload]);
}
function stream(type, id, format) {
  const data = Buffer.alloc(54);
  Buffer.from(type, "hex").copy(data);
  data.writeUInt32LE(format.length, 40);
  data.writeUInt16LE(id, 48);
  return object("9107dcb7b7a9cf118ee600c00c205365", Buffer.concat([data, format]));
}
function fileOf(extra = [], { streaming = false, audioOnly = false } = {}) {
  const properties = Buffer.alloc(80);
  properties.writeBigUInt64LE(123_0000000n, 40);
  properties.writeBigUInt64LE(3000n, 56);
  properties.writeUInt32LE(2048, 68);
  properties.writeUInt32LE(2048, 72);
  properties.writeUInt32LE(1500000, 76);
  if (streaming) properties.writeUInt32LE(1, 64);
  const video = Buffer.alloc(55);
  video.writeUInt32LE(44, 11);
  video.writeInt32LE(1280, 15); video.writeInt32LE(720, 19);
  video.writeUInt16LE(1, 23); video.writeUInt16LE(24, 25);
  video.write("WMV3", 27);
  Buffer.from([1, 2, 3, 4]).copy(video, 51);
  const audio = Buffer.alloc(20);
  audio.writeUInt16LE(0x161, 0); audio.writeUInt16LE(2, 2);
  audio.writeUInt32LE(48000, 4); audio.writeUInt16LE(2, 16);
  const children = [object("a1dcab8c47a9cf118ee400c00c205365", properties),
    ...(audioOnly ? [] : [stream("c0ef19bc4d5bcf11a8fd00805f5c442b", 1, video)]),
    stream("409e69f84d5bcf11a8fd00805f5c442b", 2, audio), ...extra];
  const header = Buffer.alloc(30);
  Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex").copy(header);
  header.writeBigUInt64LE(BigInt(30 + children.reduce((sum, child) => sum + child.length, 0)), 16);
  header.writeUInt32LE(children.length, 24); header[28] = 1; header[29] = 2;
  return Buffer.concat([header, ...children]);
}

test("streaming audio-only ASF obtains duration from complete declared payload timing", async () => {
  const header = fileOf([], { streaming: true, audioOnly: true });
  const packet = Buffer.from([0x82, 0, 0, 0x29, 0x5d, 0, 0,
    0, 0, 0, 0, 20, 0, 0x81,
    0x82, 0, 0xb8, 0x0b, 0, 0, 1, 20, 6, 0, 2, 11, 12, 2, 21, 22]);
  packet[5] = packet.length;
  const data = Buffer.alloc(50);
  Buffer.from("3626b2758e66cf11a6d900aa0062ce6c", "hex").copy(data);
  data.writeBigUInt64LE(BigInt(data.length + packet.length), 16);
  data.writeBigUInt64LE(1n, 40);
  data[48] = 1; data[49] = 1;
  const bytes = Buffer.concat([header, data, packet]);
  const container = new AsfContainer({ fileSize: bytes.length,
    readRange: async (start, end) => bytes.subarray(start, end + 1) });
  assert.equal((await container.readMediaInfo()).durationSeconds, null);
  await container.readPacketIndex();
  const media = await container.readMediaInfo();
  assert.equal(media.startTimeSeconds, 0);
  assert.equal(Math.round(media.durationSeconds * 1000), 40);
});

test("ASF supplies declared streams, codec settings and duration excluding preroll", async () => {
  const bytes = fileOf();
  const container = await ContainerFactory.create({ readRange: async (a, b) => bytes.subarray(a, b + 1), fileSize: bytes.length });
  assert.ok(container instanceof AsfContainer);
  const tracks = await container.readTracks();
  assert.deepEqual(tracks.map(track => [track.type, track.trackNumber, track.codecId]), [["video", 1, "WMV3"], ["audio", 2, "wmav2"]]);
  assert.equal(tracks[0].width, 1280); assert.equal(tracks[0].height, 720);
  assert.equal(tracks[0].codecPrivateB64, "AQIDBA==");
  assert.equal(tracks[1].samplingFrequency, 48000);
  const info = await container.readMediaInfo();
  assert.equal(info.durationSeconds, 120);
  assert.equal(info.packetLength, 2048);
});

test("ASF resumes incomplete header reads without caching absent tracks", async () => {
  const bytes = fileOf();
  let available = 134;
  const container = new AsfContainer({ readRange: async (a, b) => b < available ? bytes.subarray(a, b + 1) : null, fileSize: bytes.length });
  await assert.rejects(container.readTracks(), isUnavailable);
  available = bytes.length;
  assert.equal((await container.readTracks()).length, 2);
});

test("ASF extended declarations supply cadence, language and bounded payload extensions", async () => {
  const language = Buffer.from("en-US\0", "utf16le");
  const list = Buffer.concat([Buffer.from([1, 0, language.length]), language]);
  const name = Buffer.from("Main picture\0", "utf16le");
  const properties = Buffer.alloc(64);
  properties.writeUInt16LE(1, 48);
  properties.writeBigUInt64LE(400000n, 52);
  properties.writeUInt16LE(1, 60);
  properties.writeUInt16LE(1, 62);
  const nameHeader = Buffer.alloc(4);
  nameHeader.writeUInt16LE(name.length, 2);
  const extension = Buffer.alloc(22);
  extension[0] = 0x54;
  extension.writeUInt16LE(2, 16);
  const extended = Buffer.concat([properties, nameHeader, name, extension]);
  const bytes = fileOf([object("7c4346a9efe0fc4bb229393ede415c85", list), object("cba5e61472c632438399a96952065b5a", extended)]);
  const container = new AsfContainer({ readRange: async (a, b) => bytes.subarray(a, b + 1), fileSize: bytes.length });
  const [track] = await container.readTracks();
  assert.equal(track.fps, 25);
  assert.equal(track.averageFrameDurationSeconds, 0.04);
  assert.equal(track.defaultDurationSeconds, undefined, "an average is not an individual packet duration");
  assert.equal(track.languageBcp47, "en-US");
  assert.equal(track.name, "Main picture");
  assert.equal(track.payloadExtensions[0].size, 2);
  extension.writeUInt32LE(1, 18);
  const invalid = fileOf([object("cba5e61472c632438399a96952065b5a", Buffer.concat([properties, nameHeader, name, extension]))]);
  const malformed = new AsfContainer({ readRange: async (a, b) => invalid.subarray(a, b + 1), fileSize: invalid.length });
  await assert.rejects(malformed.readTracks(), /extension information exceeds/);
});

test("ASF rejects an object extending beyond its declared header", async () => {
  const bytes = fileOf();
  bytes.writeBigUInt64LE(BigInt(bytes.length), 46);
  const container = new AsfContainer({ readRange: async (a, b) => bytes.subarray(a, b + 1), fileSize: bytes.length });
  await assert.rejects(container.readTracks(), /exceeds its header/);
});
