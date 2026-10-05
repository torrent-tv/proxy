import assert from "node:assert/strict";
import test from "node:test";
import { MpegAudioReservoir } from "../../services/media/container/mpeg-audio-reservoir.js";
import { PacketIndex } from "../../services/media/container/PacketIndex.js";
import { strictReader, BytesUnavailable } from "../../services/media/container/unavailable.js";
import { mp3PacketFacts } from "../../services/media/container/mp3-packet-dependencies.js";

test("indexed MP3 dependencies read only headers and reuse their admitted binary fields", async () => {
  const bytes = Buffer.concat([frame(0), frame(100), frame(400)]);
  const index = new PacketIndex();
  index.declareTrack(1, { type: "audio", codecId: "A_MPEG/L3" });
  for (let position = 0; position < 3; position++) {
    index.append(1, { pts: position, duration: 1, ranges: [[position * 417, position * 417 + 416]] });
  }
  index.complete(1);
  const allocated = index.allocatedBytes();
  let reads = 0, available = false;
  const read = strictReader(async (start, end) => {
    reads++;
    assert.ok(end % 417 < 36, "Compressed MP3 frame bodies are not metadata.");
    return available ? bytes.subarray(start, end + 1) : null;
  }, bytes.length);
  const interval = { from: 2, to: 3, trackIds: [1] };
  await index.prepareAudioDependencies({ ...interval, modes: { 1: "copy" } }, read);
  assert.equal(reads, 0);
  await assert.rejects(index.prepareAudioDependencies(interval, read), BytesUnavailable);
  available = true;
  await index.prepareAudioDependencies(interval, read);
  assert.deepEqual(index.inputFor({ trackId: 1, ...interval }).ranges, [[0, 1250]]);
  assert.deepEqual(index.inputFor({ trackId: 1, ...interval, mode: "copy" }).ranges, [[834, 1250]]);
  assert.equal(index.allocatedBytes(), allocated);
  const before = reads;
  await index.prepareAudioDependencies(interval, read);
  assert.equal(reads, before);
});

test("MP3 packet groups and disjoint addresses preserve exact external reservoir demand", async () => {
  const bytes = Buffer.concat([frame(100), frame(400)]);
  const packet = { ranges: [[0, 1], [2, 414], [415, bytes.length - 1]] };
  assert.deepEqual(await mp3PacketFacts(packet, async (start, end) => bytes.subarray(start, end + 1)),
    { required: 100, capacity: 762 });
});

function frame(required) {
  const bytes = Buffer.alloc(417);
  bytes.set([0xff, 0xfb, 0x90, 0]);
  bytes[4] = required >> 1;
  bytes[5] = (required & 1) << 7;
  return bytes;
}

test("MP3 decoder input includes the frames supplying its exact bit reservoir", () => {
  const reservoir = new MpegAudioReservoir();
  const index = new PacketIndex();
  index.declareTrack(0, { type: "audio" });
  for (const [position, required] of [0, 100, 400].entries()) {
    const dependency = reservoir.prepare(frame(required), 417, position);
    index.append(0, { pts: position, duration: 1, keyframe: true,
      ranges: [[position * 417, (position + 1) * 417 - 1]], decodeFromIndex: dependency.decodeFromIndex });
    dependency.commit();
  }
  index.complete(0);
  assert.deepEqual(index.inputFor({ trackId: 0, from: 2, to: 3 }).ranges, [[0, 1250]]);
  assert.deepEqual(index.inputFor({ trackId: 0, from: 2, to: 3, mode: "copy" }).ranges, [[834, 1250]]);
});

test("uncommitted MP3 metadata cannot supply a later frame after allocation refusal", () => {
  const reservoir = new MpegAudioReservoir();
  reservoir.prepare(frame(0), 417, 0);
  assert.throws(() => reservoir.prepare(frame(100), 417, 1), /before the available source frames/);
  reservoir.prepare(frame(0), 417, 0).commit();
  assert.equal(reservoir.prepare(frame(100), 417, 1).decodeFromIndex, 0);
});
