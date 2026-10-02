import test from "node:test";
import assert from "node:assert/strict";
import { fmp4Format } from "../services/encode/segment-formats/fmp4.js";
import { producedThroughSeconds, readPresentationRanges, walkBoxes } from "../services/encode/segment-formats/mp4-boxes.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SegmentStore } from "../services/storage/segment-store/SegmentStore.js";
import { Viewer } from "../services/viewer/Viewer.js";

function box(type, body) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, body]);
}

function init(emptyMs, mediaTime, kind = "vide") {
  const mvhd = Buffer.alloc(24);
  mvhd.writeUInt32BE(1000, 12);
  const tkhd = Buffer.alloc(20);
  tkhd.writeUInt32BE(1, 12);
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(24000, 12);
  const hdlr = Buffer.alloc(12);
  hdlr.write(kind, 8);
  const elst = Buffer.alloc(32);
  elst.writeUInt32BE(2, 4);
  elst.writeUInt32BE(emptyMs, 8);
  elst.writeInt32BE(-1, 12);
  elst.writeUInt32BE(1000, 20);
  elst.writeInt32BE(mediaTime, 24);
  return box("moov", Buffer.concat([box("mvhd", mvhd), box("trak", Buffer.concat([
    box("tkhd", tkhd), box("edts", box("elst", elst)),
    box("mdia", Buffer.concat([box("mdhd", mdhd), box("hdlr", hdlr)]))
  ]))]));
}

function fragment(decodeTime, composition) {
  const tfhd = Buffer.alloc(12);
  tfhd.writeUIntBE(8, 1, 3);
  tfhd.writeUInt32BE(1, 4);
  tfhd.writeUInt32BE(1000, 8);
  const tfdt = Buffer.alloc(12);
  tfdt[0] = 1;
  tfdt.writeBigUInt64BE(BigInt(decodeTime), 4);
  const trun = Buffer.alloc(12);
  trun.writeUIntBE(0x800, 1, 3);
  trun.writeUInt32BE(1, 4);
  trun.writeUInt32BE(composition, 8);
  return box("moof", box("traf", Buffer.concat([
    box("tfhd", tfhd), box("tfdt", tfdt), box("trun", trun)
  ])));
}

test("an interrupted frame cannot prove coverage of a full future cut", () => {
  const ranges = readPresentationRanges(Buffer.concat([init(456000, 0), fragment(0, 0)]));
  assert.ok(producedThroughSeconds(ranges) > 456);
  assert.ok(producedThroughSeconds(ranges) < 456.1);
});

test("a shared init preserves presentation times without adding composition delay twice", () => {
  const shared = fmp4Format.prepareSharedInit(init(83, 2000));
  const own = init(4125, 3000);
  const media = Buffer.concat([fragment(0, 3000), fragment(48000, 3000)]);
  const raw = Buffer.concat([own, media]);
  const prepared = fmp4Format.prepareSegmentBytes(media, {
    startSeconds: 4.125, initBytes: shared, rawBytes: raw
  });
  assert.deepEqual(readPresentationRanges(Buffer.concat([shared, prepared])), readPresentationRanges(raw));
  const times = [];
  walkBoxes(prepared, (type, start) => {
    if (type === "tfdt") times.push(Number(prepared.readBigUInt64BE(start + 4)));
  });
  assert.deepEqual(times, [98000, 146000]);
});

test("a piece states each range in ticks with the frame duration a browser allows it", () => {
  const coverage = readPresentationRanges(Buffer.concat([init(0, 0, "vide"), fragment(24000, 0)]));
  assert.deepEqual(coverage.tracks[0].ranges, [{ start: 24000n, end: 25000n, frame: 1000n }]);
  assert.equal(coverage.tracks[0].timescale, 24000n);
});

test("a shared init first read after a seek also supports returning to the beginning", () => {
  const shared = fmp4Format.prepareSharedInit(init(304083, 2000));
  const media = fragment(0, 2000);
  const raw = Buffer.concat([init(83, 2000), media]);
  const prepared = fmp4Format.prepareSegmentBytes(media, {
    startSeconds: 0.083, initBytes: shared, rawBytes: raw
  });
  assert.deepEqual(readPresentationRanges(Buffer.concat([shared, prepared])), readPresentationRanges(raw));
});

test("HLS fragments use the separate init and the same timeline translation as serving", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "presentation-ranges-"));
  const store = new SegmentStore({ root });
  t.after(() => {
    store.dropAll("the check is over");
    rmSync(root, { recursive: true, force: true });
  });
  const key = "encoded-video";
  store.useFormat(key, fmp4Format);
  const dir = store.directoryFor(key);
  const media = fragment(0, 2000);
  writeFileSync(path.join(dir, fmp4Format.segmentFileName(1)), media);
  assert.equal(store.mediaRangesOf(key, 1, { startSeconds: 4 }), undefined);
  const header = init(0, 0);
  writeFileSync(path.join(dir, fmp4Format.initFileName), header);
  const served = fmp4Format.prepareSegmentBytes(media, { initBytes: header, startSeconds: 4 });
  assert.deepEqual(store.mediaRangesOf(key, 1, { startSeconds: 4 }),
    readPresentationRanges(Buffer.concat([header, served])));
  assert.ok(store.mediaRangesOf(key, 1).tracks[0].ranges[0].start > 4n * 24000n);
});

test("a decode gap between fragments is two ranges, for video as for audio", () => {
  // Joining across a gap is the browser's decision, made in the viewer
  // component; the piece states what it holds.
  const media = Buffer.concat([fragment(0, 0), fragment(72000, 0)]);
  for (const kind of ["vide", "soun"]) {
    const coverage = readPresentationRanges(Buffer.concat([init(0, 0, kind), media]));
    assert.deepEqual(coverage.tracks[0].ranges.map(({ start, end }) => [start, end]),
      [[0n, 1000n], [72000n, 73000n]]);
  }
});

test("served ranges move every track by the session init's position, in ticks", () => {
  const audioHeader = init(0, 0, "soun");
  const audio = readPresentationRanges(Buffer.concat([audioHeader, fragment(96000, 0)]));
  assert.equal(fmp4Format.servedMediaRanges(audio, { initBytes: audioHeader }).ranges[0].start, 96000n);
  const shared = fmp4Format.prepareSharedInit(init(83, 2000));
  const video = readPresentationRanges(Buffer.concat([init(83, 2000), fragment(0, 2000)]));
  // The piece's own edit puts its first frame at round(83 ms * 24000) = 1992
  // ticks; the served bytes carry the composition delay the shared init's
  // edit removes, which is what a page's timestampOffset then takes back.
  assert.equal(video.tracks[0].ranges[0].start, 1992n);
  assert.equal(fmp4Format.servedMediaRanges(video, { initBytes: shared }).ranges[0].start, 1992n + 2000n);
  assert.deepEqual(fmp4Format.servedMediaRanges(video, { initBytes: null }).ranges, video.tracks[0].ranges);
});

test("a viewer retains only finite per-track player clock offsets", () => {
  const viewer = new Viewer("clock-reading", 1);
  viewer.report({ timestampOffsets: { video: -0.083, audio: 0, media: 400 } }, 2);
  assert.deepEqual(viewer.linkReading().timestampOffsets, { video: -0.083, audio: 0 });
  viewer.report({ timestampOffsets: { video: Number.POSITIVE_INFINITY } }, 3);
  assert.deepEqual(viewer.linkReading().timestampOffsets, {});
});
