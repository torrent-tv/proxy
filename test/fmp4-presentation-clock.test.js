import test from "node:test";
import assert from "node:assert/strict";
import { fmp4Format } from "../services/encode/segment-formats/fmp4.js";
import { readPresentationRanges, walkBoxes } from "../services/encode/segment-formats/mp4-boxes.js";

function box(type, body) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, body]);
}

function init(emptyMs, mediaTime) {
  const mvhd = Buffer.alloc(24);
  mvhd.writeUInt32BE(1000, 12);
  const tkhd = Buffer.alloc(20);
  tkhd.writeUInt32BE(1, 12);
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(24000, 12);
  const elst = Buffer.alloc(32);
  elst.writeUInt32BE(2, 4);
  elst.writeUInt32BE(emptyMs, 8);
  elst.writeInt32BE(-1, 12);
  elst.writeUInt32BE(1000, 20);
  elst.writeInt32BE(mediaTime, 24);
  return box("moov", Buffer.concat([box("mvhd", mvhd), box("trak", Buffer.concat([
    box("tkhd", tkhd), box("edts", box("elst", elst)), box("mdia", box("mdhd", mdhd))
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

test("a shared init first read after a seek also supports returning to the beginning", () => {
  const shared = fmp4Format.prepareSharedInit(init(304083, 2000));
  const media = fragment(0, 2000);
  const raw = Buffer.concat([init(83, 2000), media]);
  const prepared = fmp4Format.prepareSegmentBytes(media, {
    startSeconds: 0.083, initBytes: shared, rawBytes: raw
  });
  assert.deepEqual(readPresentationRanges(Buffer.concat([shared, prepared])), readPresentationRanges(raw));
});
