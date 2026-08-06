/**
 * @file A segment that is short of a track must not be served.
 *
 * A run that is terminated closes its current output file properly — trailing
 * index and all — but the file holds only what had been muxed by then, and
 * after a seek-restart that is routinely one track of two. Nothing about it
 * looks unfinished, so the readiness rule called it done and served it, and the
 * player could not complete the seek. Measured 2026-08-06: segment #133 carried
 * one `tfdt` where its neighbours carried two, every request for it was
 * answered in 98 ms, and the viewer sat on a spinner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fmp4Format } from "../services/segment-formats/fmp4.js";
// Build a minimal init declaring two tracks, and fragments declaring one/two.
function box(type, body) {
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt32BE(8 + body.length, 0); b.write(type, 4, "latin1"); body.copy(b, 8);
  return b;
}
function mdhd(timescale) { const b = Buffer.alloc(20); b.writeUInt32BE(timescale, 12); return box("mdhd", b); }
function tkhd(id) { const b = Buffer.alloc(84); b.writeUInt32BE(id, 12); return box("tkhd", b); }
function trak(id, ts) { return box("trak", Buffer.concat([tkhd(id), box("mdia", mdhd(ts))])); }
const init = box("moov", Buffer.concat([trak(1, 16000), trak(2, 48000)]));
function tfhd(id) { const b = Buffer.alloc(8); b.writeUInt32BE(id, 4); return box("tfhd", b); }
function moof(ids) { return box("moof", Buffer.concat(ids.map((id) => box("traf", tfhd(id))))); }

test("a segment with every track is accepted", () => {
  assert.equal(fmp4Format.hasEveryTrack(moof([1, 2]), init), true);
});
test("a segment left short of a track by a killed run is refused", () => {
  assert.equal(fmp4Format.hasEveryTrack(moof([1]), init), false,
    "one track of two is what a terminated run leaves behind, and it looks complete");
});
test("an empty file is refused", () => {
  assert.equal(fmp4Format.hasEveryTrack(Buffer.alloc(0), init), false);
});
test("without an init there is nothing to compare against, so it is allowed", () => {
  assert.equal(fmp4Format.hasEveryTrack(moof([1]), null), true);
});
