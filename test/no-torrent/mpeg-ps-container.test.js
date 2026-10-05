import test from "node:test";
import assert from "node:assert/strict";
import { MpegPsContainer, pesPayload } from "../../services/media/container/MpegPsContainer.js";
import { mpegSectionCrc } from "../../services/media/container/MpegTsContainer.js";
import { isUnavailable } from "../../services/media/container/unavailable.js";

function packet(id, payload) {
  const bytes = Buffer.alloc(6);
  bytes.set([0, 0, 1, id]); bytes.writeUInt16BE(payload.length, 4);
  return Buffer.concat([bytes, payload]);
}
function pack() { return Buffer.from([0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 0, 0, 3, 0]); }
function programMap() {
  const payload = Buffer.from([0xe0, 0xff, 0, 0, 0, 8, 2, 0xe0, 0, 0, 0x81, 0xbd, 0, 0, 0, 0, 0, 0]);
  const bytes = packet(0xbc, payload);
  bytes.writeUInt32BE(mpegSectionCrc(bytes.subarray(0, bytes.length - 4)), bytes.length - 4);
  return bytes;
}

test("MPEG-PS program map declares video and sound without scanning media payloads", async () => {
  const bytes = Buffer.concat([pack(), programMap()]);
  const container = new MpegPsContainer({ readRange: async (a, b) => bytes.subarray(a, b + 1), fileSize: bytes.length });
  assert.deepEqual((await container.readTracks()).map(track => [track.type, track.codecId]), [["video", "mpeg2video"], ["audio", "ac3"]]);
});

test("MPEG-PS PES declarations identify DVD private substreams and elementary audio", async () => {
  const video = packet(0xe0, Buffer.from([0x80, 0, 0, 0, 0, 1, 0xb3, 0, 0, 0, 0, 0, 0, 1, 0xb5, 0x10]));
  const audio = packet(0xc0, Buffer.from([0x80, 0, 0, 0xff, 0xfb, 0x90, 0]));
  const privateAudio = packet(0xbd, Buffer.from([0x80, 0, 0, 0x80, 0, 0, 0]));
  const bytes = Buffer.concat([pack(), video, audio, privateAudio, Buffer.from([0, 0, 1, 0xb9])]);
  const container = new MpegPsContainer({ readRange: async (a, b) => bytes.subarray(a, b + 1), fileSize: bytes.length });
  assert.deepEqual((await container.readTracks()).map(track => track.codecId), ["mpeg2video", "mp3", "ac3"]);
});

test("MPEG-PS missing program map bytes remain retryable", async () => {
  const bytes = Buffer.concat([pack(), programMap()]);
  let available = false;
  const container = new MpegPsContainer({ readRange: async (a, b) => available || b < 14 ? bytes.subarray(a, b + 1) : null, fileSize: bytes.length });
  await assert.rejects(container.readTracks(), isUnavailable);
  available = true;
  assert.equal((await container.readTracks()).length, 2);
});

test("MPEG-PS program map corruption is terminal", async () => {
  const bytes = Buffer.concat([pack(), programMap()]);
  bytes[bytes.length - 1] ^= 1;
  const container = new MpegPsContainer({ readRange: async (a, b) => bytes.subarray(a, b + 1), fileSize: bytes.length });
  await assert.rejects(container.readTracks(), /program map is invalid/);
});

test("PES timestamps preserve all 33 bits and reject broken marker bits", () => {
  const bytes = Buffer.from([0x80, 0x80, 5, 0x29, 0, 1, 0, 1]);
  assert.equal(pesPayload(bytes).pts, 2 ** 32 / 90000);
  bytes[7] = 0;
  assert.throws(() => pesPayload(bytes), /timestamp markers/);
});

test("PES preserves independent decode timestamps and checks both timestamp prefixes", () => {
  for (const header of [[0x80, 0xc0, 10], []]) {
    const bytes = Buffer.from([...header, 0x31, 0, 1, 0, 5, 0x11, 0, 1, 0, 1]);
    assert.equal(pesPayload(bytes).pts, 2 / 90000);
    assert.equal(pesPayload(bytes).dts, 0);
    bytes[header.length + 5] = 0x21;
    assert.throws(() => pesPayload(bytes), /timestamp prefix/);
  }
  assert.throws(() => pesPayload(Buffer.from([0x80, 0x80, 5, 0x31, 0, 1, 0, 1])), /timestamp prefix/);
});

test("a video PES without a length ends at the next system packet rather than a picture start", async () => {
  const video = Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0, 0,
    0, 0, 1, 0xb3, 0, 0, 0, 0, 0, 0, 1, 0xb5, 0x10, 0, 0, 1, 0, 0, 0]);
  const sound = packet(0xc0, Buffer.from([0x80, 0, 0, 0xff, 0xfb, 0x90, 0]));
  const bytes = Buffer.concat([pack(), video, sound, Buffer.from([0, 0, 1, 0xb9])]);
  const container = new MpegPsContainer({ fileSize: bytes.length, portionBytes: 7,
    readRange: async (a, b) => bytes.subarray(a, b + 1) });
  assert.deepEqual((await container.readTracks()).map(track => track.codecId), ["mpeg2video", "mp3"]);
});
