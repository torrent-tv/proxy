import test from "node:test";
import assert from "node:assert/strict";
import { MpegTsContainer, mpegSectionCrc } from "../../services/media/container/MpegTsContainer.js";
import { ContainerFactory } from "../../services/media/container/ContainerFactory.js";
import { BytesUnavailable } from "../../services/media/container/unavailable.js";

function section(bytes) {
  const header = Buffer.from(bytes);
  const length = header.length + 4 - 3;
  header[1] = 0xb0 | (length >> 8);
  header[2] = length & 255;
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(mpegSectionCrc(header));
  return Buffer.concat([header, crc]);
}

function packet(pid, payload, counter = 0, start = true) {
  const bytes = Buffer.alloc(188, 0xff);
  bytes.set([0x47, (start ? 0x40 : 0) | (pid >> 8), pid & 255, 0x10 | counter]);
  if (start) bytes[4] = 0;
  payload.copy(bytes, start ? 5 : 4);
  return bytes;
}

function tables({ extended = false } = {}) {
  const pat = section([0, 0, 0, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0]);
  const streams = [0x1b, 0xe1, 1, 0xf0, 0, 0x0f, 0xe1, 2, 0xf0, 6, 0x0a, 4, 101, 110, 103, 0];
  if (extended) {
    for (let index = 0; index < 31; index++) streams.push(0x03, 0xe2, index, 0xf0, 0);
  }
  const pmt = section([2, 0, 0, 0, 1, 0xc1, 0, 0, 0xe1, 1, 0xf0, 0, ...streams]);
  const parts = [packet(0, pat), packet(0x100, pmt.subarray(0, 183))];
  if (pmt.length > 183) parts.push(packet(0x100, pmt.subarray(183), 1, false));
  parts.push(packet(0x1fff, Buffer.alloc(0)));
  return parts;
}

const reader = bytes => ({ fileSize: bytes.length, readRange: async (start, end) => bytes.subarray(start, end + 1) });

test("MPEG section CRC matches the independent standard check value", () => {
  assert.equal(mpegSectionCrc(Buffer.from("123456789")), 0x0376e6e7);
});

for (const width of [188, 192, 204]) {
  test(`transport packets of ${width} bytes declare video and language-tagged audio`, async () => {
    const bytes = Buffer.concat(tables().map(raw => width === 192
      ? Buffer.concat([Buffer.alloc(4), raw])
      : width === 204 ? Buffer.concat([raw, Buffer.alloc(16)]) : raw));
    const container = await ContainerFactory.create(reader(bytes));
    assert.ok(container instanceof MpegTsContainer);
    const tracks = await container.readTracks();
    assert.deepEqual(tracks.map(track => [track.type, track.codecId, track.trackNumber, track.language]),
      [["video", "h264", 257, ""], ["audio", "aac", 258, "eng"]]);
  });
}

test("a program section crossing packets is assembled before tracks are published", async () => {
  const bytes = Buffer.concat(tables({ extended: true }));
  const container = new MpegTsContainer(reader(bytes));
  assert.equal((await container.readTracks()).length, 33);
});

test("a missing program packet states its exact range and continues after availability changes", async () => {
  const bytes = Buffer.concat(tables());
  let missing = true;
  const container = new MpegTsContainer({ fileSize: bytes.length, readRange: async (start, end) =>
    missing && start === 188 && end === 375 ? null : bytes.subarray(start, end + 1) });
  await assert.rejects(container.readTracks(), error => error instanceof BytesUnavailable && error.start === 188 && error.end === 375);
  missing = false;
  assert.equal((await container.readTracks()).length, 2);
});

test("damaged program bytes are rejected by their CRC", async () => {
  const bytes = Buffer.concat(tables());
  bytes[188 + 20] ^= 1;
  await assert.rejects(new MpegTsContainer(reader(bytes)).readTracks(), /CRC/);
});
