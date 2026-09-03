/**
 * @file What a file declares about ITSELF — format, duration, and where its own
 * timeline begins — read from its header by the container layer.
 *
 * These fixtures are built byte by byte rather than produced by ffmpeg, on
 * purpose: a test that runs a real encoder measures the machine it runs on, and
 * two such tests in this suite have failed four times in one day for exactly
 * that reason (roadmap item 54). The numbers here are checked against ffmpeg
 * ONCE, by hand, and the result is recorded rather than re-measured on every
 * run — 2026-09-03, a Matroska file offset by 0.130435 s: ffmpeg reported
 * `Duration: 00:00:02.13, start: 0.130000` and this reader answered
 * `durationSeconds 2.131, startTimeSeconds 0.13`, which is the same number at
 * the precision each prints. The same file as MP4: `start: 0.000000` from
 * ffmpeg, 0 from this reader.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MatroskaContainer } from "../services/container/MatroskaContainer.js";
import { Mp4Container } from "../services/container/Mp4Container.js";
import { AviContainer } from "../services/container/AviContainer.js";

/**
 * An EBML element: its id bytes, a four-byte size, then the payload.
 *
 * @param {number[]} idBytes
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function ebml(idBytes, payload) {
  const size = Buffer.alloc(4);
  // Four-byte size form: `0001xxxx` in the leading byte marks the width.
  size.writeUInt32BE(payload.length);
  size[0] |= 0x10;
  return Buffer.concat([Buffer.from(idBytes), size, payload]);
}

/** @param {number} value @param {number} bytes @returns {Buffer} */
function uint(value, bytes) {
  const out = Buffer.alloc(bytes);
  out.writeUIntBE(value, 0, bytes);
  return out;
}

/** @param {number} value @returns {Buffer} */
function float64(value) {
  const out = Buffer.alloc(8);
  out.writeDoubleBE(value);
  return out;
}

const ID_EBML_HEADER = [0x1a, 0x45, 0xdf, 0xa3];
const ID_SEGMENT = [0x18, 0x53, 0x80, 0x67];
const ID_SEEK_HEAD = [0x11, 0x4d, 0x9b, 0x74];
const ID_SEEK = [0x4d, 0xbb];
const ID_SEEK_ID = [0x53, 0xab];
const ID_SEEK_POSITION = [0x53, 0xac];
const ID_INFO = [0x15, 0x49, 0xa9, 0x66];
const ID_TIMESTAMP_SCALE = [0x2a, 0xd7, 0xb1];
const ID_DURATION = [0x44, 0x89];
const ID_CLUSTER = [0x1f, 0x43, 0xb6, 0x75];
const ID_TIMESTAMP = [0xe7];
const ID_VOID = [0xec];

/**
 * A reader over a buffer, in the shape the container layer takes.
 *
 * @param {Buffer} bytes
 * @returns {(start: number, end: number) => Promise<Buffer>}
 */
function readerOver(bytes) {
  return async (start, end) => bytes.subarray(start, Math.min(end + 1, bytes.length));
}

test("a Matroska file states its duration in ticks and its start in the first cluster", async () => {
  const info = ebml(ID_INFO, Buffer.concat([
    ebml(ID_TIMESTAMP_SCALE, uint(1_000_000, 3)),
    // 2131 ticks of a millisecond each.
    ebml(ID_DURATION, float64(2131))
  ]));
  const cluster = ebml(ID_CLUSTER, ebml(ID_TIMESTAMP, uint(130, 1)));
  const file = Buffer.concat([
    ebml(ID_EBML_HEADER, Buffer.alloc(4)),
    ebml(ID_SEGMENT, Buffer.concat([info, cluster]))
  ]);

  const container = new MatroskaContainer({ readRange: readerOver(file), fileSize: file.length });
  const read = await container.readMediaInfo();

  assert.equal(read.format, "matroska");
  assert.ok(Math.abs(read.durationSeconds - 2.131) < 1e-9, `duration was ${read.durationSeconds}`);
  assert.ok(Math.abs(read.startTimeSeconds - 0.13) < 1e-9, `start was ${read.startTimeSeconds}`);
});

test("a cluster past the head window is found through the SeekHead", async () => {
  // Everything before the cluster is padded past the 64 KB the head read covers,
  // which is the case this second path exists for: a file whose Tracks element
  // is large enough to push the first cluster out of reach.
  const info = ebml(ID_INFO, ebml(ID_TIMESTAMP_SCALE, uint(1_000_000, 3)));
  const padding = ebml(ID_VOID, Buffer.alloc(70 * 1024));
  const cluster = ebml(ID_CLUSTER, ebml(ID_TIMESTAMP, uint(2500, 2)));
  // The SeekHead is written first, so its own length is known before the
  // position it names can be computed — build it with a placeholder, measure,
  // then write the real position.
  const seekHeadFor = (position) => ebml(ID_SEEK_HEAD, ebml(ID_SEEK, Buffer.concat([
    ebml(ID_SEEK_ID, Buffer.from(ID_CLUSTER)),
    ebml(ID_SEEK_POSITION, uint(position, 4))
  ])));
  const seekHeadLength = seekHeadFor(0).length;
  const clusterPosition = seekHeadLength + info.length + padding.length;
  const segmentPayload = Buffer.concat([seekHeadFor(clusterPosition), info, padding, cluster]);
  const file = Buffer.concat([
    ebml(ID_EBML_HEADER, Buffer.alloc(4)),
    ebml(ID_SEGMENT, segmentPayload)
  ]);

  const container = new MatroskaContainer({ readRange: readerOver(file), fileSize: file.length });
  const read = await container.readMediaInfo();

  assert.ok(Math.abs(read.startTimeSeconds - 2.5) < 1e-9, `start was ${read.startTimeSeconds}`);
});

test("a Matroska file that declares no duration says so, rather than saying zero", async () => {
  const cluster = ebml(ID_CLUSTER, ebml(ID_TIMESTAMP, uint(0, 1)));
  const file = Buffer.concat([
    ebml(ID_EBML_HEADER, Buffer.alloc(4)),
    ebml(ID_SEGMENT, cluster)
  ]);

  const container = new MatroskaContainer({ readRange: readerOver(file), fileSize: file.length });
  const read = await container.readMediaInfo();

  assert.equal(read.durationSeconds, null);
  assert.equal(read.startTimeSeconds, 0);
});

/**
 * An ISO/IEC 14496-12 box.
 *
 * @param {string} type
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

test("an MP4 states its duration in mvhd and its start in an empty edit", async () => {
  const mvhd = box("mvhd", Buffer.concat([
    Buffer.alloc(4), // version 0 + flags
    Buffer.alloc(8), // creation, modification
    uint(1000, 4), // timescale: ticks per second
    uint(2000, 4), // duration: two seconds
    Buffer.alloc(80)
  ]));
  const elst = box("elst", Buffer.concat([
    Buffer.alloc(4), // version 0 + flags
    uint(1, 4), // one entry
    uint(130, 4), // segment_duration: 0.130 s at the movie timescale
    Buffer.from([0xff, 0xff, 0xff, 0xff]), // media_time -1: an EMPTY edit
    uint(0x00010000, 4) // media_rate 1.0
  ]));
  const trak = box("trak", box("edts", elst));
  const file = Buffer.concat([
    box("ftyp", Buffer.from("isom", "latin1")),
    box("moov", Buffer.concat([mvhd, trak]))
  ]);

  const container = new Mp4Container({ readRange: readerOver(file), fileSize: file.length });
  const read = await container.readMediaInfo();

  assert.equal(read.format, "mp4");
  assert.ok(Math.abs(read.durationSeconds - 2) < 1e-9, `duration was ${read.durationSeconds}`);
  assert.ok(Math.abs(read.startTimeSeconds - 0.13) < 1e-9, `start was ${read.startTimeSeconds}`);
});

test("an MP4 with no edit list begins at zero, and that is an answer", async () => {
  const mvhd = box("mvhd", Buffer.concat([
    Buffer.alloc(4),
    Buffer.alloc(8),
    uint(600, 4),
    uint(1200, 4),
    Buffer.alloc(80)
  ]));
  const file = Buffer.concat([
    box("ftyp", Buffer.from("isom", "latin1")),
    box("moov", mvhd)
  ]);

  const container = new Mp4Container({ readRange: readerOver(file), fileSize: file.length });
  const read = await container.readMediaInfo();

  assert.ok(Math.abs(read.durationSeconds - 2) < 1e-9, `duration was ${read.durationSeconds}`);
  assert.equal(read.startTimeSeconds, 0);
});

test("an AVI states its length as microseconds per frame times the frame count", async () => {
  const avih = Buffer.concat([
    Buffer.from("avih", "latin1"),
    uint(56, 4),
    Buffer.from(new Uint8Array(new Uint32Array([
      40_000, // dwMicroSecPerFrame: 25 fps
      0, 0, 0,
      50 // dwTotalFrames: two seconds of them
    ]).buffer)),
    Buffer.alloc(36)
  ]);
  const file = Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    uint(0, 4),
    Buffer.from("AVI ", "latin1"),
    Buffer.from("LIST", "latin1"),
    uint(avih.length + 4, 4),
    Buffer.from("hdrl", "latin1"),
    avih
  ]);

  const container = new AviContainer({ readRange: readerOver(file), fileSize: file.length });
  const read = await container.readMediaInfo();

  assert.equal(read.format, "avi");
  assert.ok(Math.abs(read.durationSeconds - 2) < 1e-9, `duration was ${read.durationSeconds}`);
  assert.equal(read.startTimeSeconds, 0);
});
