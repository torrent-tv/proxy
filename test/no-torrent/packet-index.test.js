import test from "node:test";
import assert from "node:assert/strict";
import { PacketIndex } from "../../services/media/container/PacketIndex.js";
import { PacketRecords } from "../../services/media/container/PacketRecords.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";

test("a final copied interval retains all video packets when the movie ends after the proven video end", () => {
  const index = new PacketIndex();
  index.declareTrack(1, { type: "video" });
  for (let pts = 0; pts < 4; pts++) index.append(1, {
    pts, duration: 1, keyframe: pts === 0 || pts === 2, ranges: [[pts * 10, pts * 10 + 9]]
  });
  assert.equal(index.inputFor({ trackId: 1, from: 2, to: 4.064, mode: "copy" }).kind, "terminal",
    "an unfinished index cannot prove that no more video follows");
  index.complete(1);
  const final = index.inputFor({ trackId: 1, from: 2, to: 4.064, mode: "copy" });
  assert.equal(final.kind, "result");
  assert.equal(final.sourceEndSeconds, 4);
  assert.deepEqual(final.packets.map(packet => packet.pts), [2, 3]);
  assert.equal(index.inputFor({ trackId: 1, from: 2, to: 3.5, mode: "copy" }).reason,
    "video-copy-cut-is-not-a-keyframe", "an interior non-keyframe cut still fails");
});

test("a completed transport read retains its packet facts until memory admits them", () => {
  let allowed = false;
  const index = new PacketIndex({ deferMemory: true, packetMemory: { reserve: () => allowed } });
  index.declareTrack(1, { type: "audio" });
  index.append(1, { pts: 0, duration: 1, keyframe: true, ranges: [[10, 19]] });
  index.append(1, { pts: 1, duration: 1, keyframe: true, ranges: [[30, 39]] });
  index.coverThrough(1, 2);
  index.complete(1);
  assert.throws(() => index.inputFor({ trackId: 1, from: 0, to: 2 }), IndexMemoryUnavailable);
  assert.equal(index.allocatedBytes(), 0);
  allowed = true;
  index.flushPending();
  const input = index.inputFor({ trackId: 1, from: 0, to: 2 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.packets.map(packet => packet.pts), [0, 1]);
  assert.deepEqual(input.ranges, [[10, 19], [30, 39]]);
});

test("progressive interval views borrow the source's single binary packet allocation", () => {
  const records = new PacketRecords();
  records.push({ pts: 0, duration: 0.1, keyframe: true, ranges: [[0, 2]] });
  const index = new PacketIndex();
  index.declareTrack(1, { type: "audio" });
  index.sharePackets(1, records);
  assert.equal(index.allocatedBytes(), records.allocatedBytes);
  records.push({ pts: 0.1, duration: 0.1, keyframe: true, ranges: [[3, 5]] });
  index.coverThrough(1, 0.2);
  assert.equal(index.inputFor({ trackId: 1, from: 0, to: 0.2 }).packets.length, 2);
  assert.equal(index.allocatedBytes(), records.allocatedBytes);
});

test("an empty subtitle interval is a fact only after its index covers that interval", () => {
  const index = new PacketIndex();
  index.declareTrack(1, { type: "subtitle" });
  assert.equal(index.inputFor({ trackId: 1, from: 2, to: 4 }).kind, "needs-index");
  index.coverThrough(1, 4);
  const result = index.inputFor({ trackId: 1, from: 2, to: 4 });
  assert.equal(result.kind, "result");
  assert.deepEqual(result.ranges, []);
  assert.deepEqual(result.packets, []);
});

test("a video segment includes its decode start, reordering and codec bytes without filling file gaps", () => {
  const index = new PacketIndex();
  index.declareTrack(1, { type: "video", codecRanges: [[0, 9]], reorderDepth: 1 });
  for (const [order, pts] of [0, 3, 1, 2, 4].entries()) {
    index.append(1, { pts, duration: 1, keyframe: order === 0 || order === 4, ranges: [[100 + order * 20, 109 + order * 20]] });
  }
  index.complete(1);
  const result = index.inputFor({ trackId: 1, from: 1, to: 3 });
  assert.equal(result.kind, "result");
  assert.equal(result.decodeFrom, 0);
  assert.deepEqual(result.ranges, [[0, 9], [100, 109], [120, 129], [140, 149], [160, 169]]);
});

test("copy input excludes the next keyframe and audio preroll", () => {
  const index = new PacketIndex();
  index.declareTrack(1, { type: "video" });
  index.declareTrack(2, { type: "audio", prerollSeconds: 1 });
  for (let pts = 0; pts < 4; pts++) {
    index.append(1, { pts, duration: 1, keyframe: pts % 2 === 0, ranges: [[pts * 10, pts * 10 + 9]] });
    index.append(2, { pts, duration: 1, ranges: [[100 + pts * 10, 109 + pts * 10]] });
  }
  index.complete(1);
  index.complete(2);
  assert.deepEqual(index.inputFor({ trackId: 1, from: 0, to: 2, mode: "copy" }).ranges, [[0, 19]]);
  assert.equal(index.inputFor({ trackId: 1, from: 1, to: 2, mode: "copy" }).reason, "video-copy-cut-is-not-a-keyframe");
  assert.deepEqual(index.inputFor({ trackId: 2, from: 1, to: 2, mode: "copy" }).ranges, [[110, 119]]);
});

test("AAC decoding includes exactly one preceding packet independently of its duration", () => {
  for (const codecId of ["aac", "aac_latm", "mp4a", "A_AAC", "A_AAC/MPEG4/LC"]) {
    const index = new PacketIndex();
    index.declareTrack(1, { type: "audio", codecId });
    for (const [pts, duration, address] of [[0, 0.1, 0], [0.1, 0.3, 10], [0.4, 0.2, 20], [0.6, 0.1, 30]]) {
      index.append(1, { pts, duration, ranges: [[address, address + 9]] });
    }
    index.complete(1);
    assert.deepEqual(index.inputFor({ trackId: 1, from: 0.4, to: 0.6 }).ranges, [[10, 29]], codecId);
    assert.deepEqual(index.inputFor({ trackId: 1, from: 0.4, to: 0.6, mode: "copy" }).ranges, [[20, 29]], codecId);
    assert.deepEqual(index.inputFor({ trackId: 1, from: 0.45, to: 0.6 }).ranges, [[10, 29]], codecId);
  }
});

test("audio decoder preroll is included and adjacent byte ranges are merged", () => {
  const index = new PacketIndex();
  index.declareTrack(2, { type: "audio", prerollSeconds: 1 });
  for (let pts = 0; pts < 4; pts++) index.append(2, { pts, duration: 1, ranges: [[pts * 10, pts * 10 + 9]] });
  index.complete(2);
  assert.deepEqual(index.inputFor({ trackId: 2, from: 2, to: 4 }).ranges, [[10, 39]]);
});

test("copied audio includes a packet crossing the interval start without adding earlier preroll", () => {
  const index = new PacketIndex();
  index.declareTrack(1, { type: "audio", prerollSeconds: 0.08 });
  index.append(1, { pts: -0.0265, duration: 0.02, ranges: [[0, 9]] });
  index.append(1, { pts: -0.0065, duration: 0.02, ranges: [[10, 19]] });
  index.append(1, { pts: 0.0135, duration: 0.02, ranges: [[20, 29]] });
  index.complete(1);
  assert.deepEqual(index.inputFor({ trackId: 1, from: 0, to: 0.0335, mode: "copy" }).ranges, [[10, 29]]);
});

test("a future timestamp is not proof that every reordered packet has been indexed", () => {
  const index = new PacketIndex();
  index.declareTrack(1, { type: "video" });
  index.append(1, { pts: 0, duration: 1, keyframe: true, ranges: [[0, 9]] });
  index.append(1, { pts: 3, duration: 1, ranges: [[10, 19]] });
  assert.equal(index.inputFor({ trackId: 1, from: 0, to: 2 }).kind, "needs-index");
  index.append(1, { pts: 1, duration: 1, ranges: [[20, 29]] });
  index.coverThrough(1, 2);
  assert.deepEqual(index.inputFor({ trackId: 1, from: 0, to: 2 }).ranges, [[0, 29]]);
});
