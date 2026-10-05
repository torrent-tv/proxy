import assert from "node:assert/strict";
import test from "node:test";
import { readMatroskaPackets } from "../../services/media/container/matroska-packets.js";
import { BytesUnavailable } from "../../services/media/container/unavailable.js";
import { ElementReader } from "../../services/media/container/ebml-stream.js";
import { PacketRecords } from "../../services/media/container/PacketRecords.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";

test("a memory shortage inside a laced block rolls back every frame before retry", async () => {
  let allowance = 131072, held = 0;
  const records = new PacketRecords({ reserve: bytes => {
    if (held + bytes > allowance) return false;
    held += bytes;
    return true;
  }, release: bytes => { held -= bytes; } });
  const previousLength = Math.floor(65536 / 72) - 1;
  for (let index = 0; index < previousLength; index++) records.push({ pts: -1, duration: 0.02, ranges: [[0, 0]] });
  const bytes = cluster([element([0xa3], Buffer.from([0x81, 0, 0, 0x84, 2, 1, 2, 3]))]);
  const over = { ...params(bytes, [{ trackNumber: 1, type: "audio", defaultDurationSeconds: 0.02 }]),
    state: { packets: new Map([[1, records]]), at: 0 } };
  await assert.rejects(readMatroskaPackets(over), IndexMemoryUnavailable);
  assert.equal(records.length, previousLength);
  assert.equal(held, 131072);
  allowance += 65536;
  await readMatroskaPackets(over);
  assert.equal(records.length, previousLength + 3);
  assert.deepEqual(records.slice(previousLength).map(packet => packet.pts), [0, 0.02, 0.04]);
  assert.equal(held, records.allocatedBytes);
});

test("an EBML header needs only its own bytes, independently of its body", async () => {
  const bytes = Buffer.from([0xe7, 0x81, 0]);
  const reader = new ElementReader({ fileSize: bytes.length, read: async (a, b) => {
    if (b >= 2) throw new BytesUnavailable(a, b, 0);
    return bytes.subarray(a, b + 1);
  } });
  const header = await reader.header(0, bytes.length);
  assert.deepEqual(header, { id: 0xe7, at: 0, dataOffset: 2, size: 1, end: 3 });
  await assert.rejects(reader.data(header), BytesUnavailable);
});

test("Matroska packet indexing reads block fields without reading a frame body", async () => {
  const bytes = cluster([element([0xa3], Buffer.from([0x81, 0, 0, 0x80, 11]))]);
  const frameAt = bytes.length - 1;
  const over = params(bytes, [{ trackNumber: 1, type: "video", defaultDurationSeconds: 0.04 }]);
  over.readRange = async (a, b) => {
    assert.ok(b < frameAt || a > frameAt, "The frame body is not metadata demand.");
    return bytes.subarray(a, b + 1);
  };
  const index = await readMatroskaPackets(over);
  assert.deepEqual(index.inputFor({ trackId: 1, from: 0, to: 0.04 }).packets[0].ranges, [[frameAt, frameAt]]);
});

function element(id, data) {
  assert.ok(data.length < 127);
  return Buffer.concat([Buffer.from(id), Buffer.from([0x80 | data.length]), data]);
}

function cluster(blocks) {
  return element([0x1f, 0x43, 0xb6, 0x75], Buffer.concat([element([0xe7], Buffer.from([0])), ...blocks]));
}

function params(bytes, tracks) {
  return { readRange: async (a, b) => bytes.subarray(a, b + 1), fileSize: bytes.length,
    layout: { firstClusterAt: 0, segmentEnd: bytes.length, secondsPerTick: 0.001 }, tracks, durationSeconds: 1 };
}

for (const [name, lace, lengths] of [
  ["Xiph", Buffer.from([0x81, 0, 0, 0x82, 2, 2, 3]), [2, 3, 4]],
  ["fixed", Buffer.from([0x81, 0, 0, 0x84, 2]), [3, 3, 3]],
  ["EBML", Buffer.from([0x81, 0, 0, 0x86, 2, 0x82, 0xc0]), [2, 3, 4]]
]) {
  test(`Matroska ${name} lacing indexes separate frame addresses and timestamps`, async () => {
    const payload = Buffer.concat([lace, ...lengths.map((length, position) => Buffer.alloc(length, position + 1))]);
    const bytes = cluster([element([0xa3], payload)]);
    const input = await readMatroskaPackets(params(bytes, [{ trackNumber: 1, type: "audio", defaultDurationSeconds: 0.02,
      seekPrerollSeconds: 0.08, codecDelaySeconds: 0.01 }]));
    const result = input.inputFor({ trackId: 1, from: 0, to: 0.04 });
    assert.equal(result.kind, "result");
    assert.deepEqual(result.packets.map(packet => packet.pts), [-0.01, 0.01, 0.03]);
    assert.deepEqual(result.packets.map(packet => packet.ranges.map(([a, b]) => [...bytes.subarray(a, b + 1)])),
      lengths.map((length, position) => [Array(length).fill(position + 1)]));
  });
}

test("a BlockGroup reference prevents treating its block as a random-access frame", async () => {
  const key = element([0xa3], Buffer.from([0x81, 0, 0, 0x80, 11]));
  const predicted = element([0xa0], Buffer.concat([
    element([0xa1], Buffer.from([0x81, 0, 40, 0, 22])),
    element([0xfb], Buffer.from([0xd8])), element([0x9b], Buffer.from([40]))
  ]));
  const bytes = cluster([key, predicted]);
  const index = await readMatroskaPackets(params(bytes, [{ trackNumber: 1, type: "video", defaultDurationSeconds: 0.04 }]));
  const input = index.inputFor({ trackId: 1, from: 0.04, to: 0.08 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.packets.map(packet => packet.keyframe), [true, false]);
  assert.equal(input.decodeFrom, 0);
});

test("laced block discard padding is distributed across the affected beginning or ending frames", async () => {
  for (const seconds of [0.03, -0.03]) {
    const padding = Buffer.alloc(8);
    padding.writeBigInt64BE(BigInt(Math.round(seconds * 1e9)));
    const bytes = cluster([element([0xa0], Buffer.concat([
      element([0xa1], Buffer.from([0x81, 0, 0, 0x84, 2, 1, 2, 3])),
      element([0x75, 0xa2], padding)
    ]))]);
    const index = await readMatroskaPackets(params(bytes, [{ trackNumber: 1, type: "audio", defaultDurationSeconds: 0.02 }]));
    const input = index.inputFor({ trackId: 1, from: 0, to: 0.06 });
    assert.equal(input.kind, "result");
    assert.deepEqual(input.packets.map(packet => packet.discardPaddingSeconds ?? 0),
      seconds > 0 ? [0, 0.01, 0.02] : [-0.02, -0.01, 0]);
  }
});

test("missing block headers request their actual bytes and malformed lacing is terminal", async () => {
  const bytes = cluster([element([0xa3], Buffer.from([0x81, 0, 0, 0x84, 2, 1, 2]))]);
  const over = params(bytes, [{ trackNumber: 1, type: "audio", defaultDurationSeconds: 0.02 }]);
  await assert.rejects(readMatroskaPackets({ ...over, readRange: async (a, b) => {
    if (b >= 12) throw new BytesUnavailable(a, b, 0);
    return bytes.subarray(a, b + 1);
  } }), BytesUnavailable);
  await assert.rejects(readMatroskaPackets(over), /fixed lace/);
});

test("Matroska resumes inside a Cluster without repeating completed block headers", async () => {
  const first = element([0xa3], Buffer.from([0x81, 0, 0, 0x80, 11]));
  const second = element([0xa3], Buffer.from([0x81, 0, 40, 0, 22]));
  const bytes = cluster([first, second]);
  const secondAt = bytes.length - second.length;
  const state = {};
  let available = secondAt + 2;
  const requested = [];
  const over = { ...params(bytes, [{ trackNumber: 1, type: "video", defaultDurationSeconds: 0.04 }]), state,
    readRange: async (a, b) => {
      requested.push(a);
      if (b >= available) throw new BytesUnavailable(a, b, 0);
      return bytes.subarray(a, b + 1);
    } };
  await assert.rejects(readMatroskaPackets(over), BytesUnavailable);
  assert.equal(state.cluster.cursor, secondAt);
  assert.equal(state.packets.get(1).length, 1);
  requested.length = 0;
  available = bytes.length;
  const index = await readMatroskaPackets(over);
  assert.ok(requested.every(at => at >= secondAt));
  assert.deepEqual(index.inputFor({ trackId: 1, from: 0, to: 0.08 }).packets.map(packet => packet.pts), [0, 0.04]);
});

test("derived packet durations are corrected when a later indexed packet has an earlier presentation time", async () => {
  const blocks = [[1, 0], [2, 0], [2, 100], [1, 40], [2, 50], [1, 80]].map(([track, time]) =>
    element([0xa3], Buffer.from([0x80 | track, time >> 8, time & 255, 0x80, 11])));
  const state = {};
  const over = { ...params(cluster(blocks), [
    { trackNumber: 1, type: "video", defaultDurationSeconds: 0.04, reorderDepth: 0 },
    { trackNumber: 2, type: "subtitle" }
  ]), state };
  await readMatroskaPackets({ ...over, interval: { from: 0, to: 0.04, trackIds: [1] } });
  assert.equal(state.packets.get(2).durationAt(0), 0.1);
  await readMatroskaPackets({ ...over, interval: { from: 0, to: 0.08, trackIds: [1] } });
  assert.equal(state.packets.get(2).durationAt(0), 0.05);
});

test("Matroska admits an interval after codec-bounded lookahead without reading the remaining file", async () => {
  const blocks = [0, 120, 40, 80, 160, 200].map((time, position) =>
    element([0xa3], Buffer.from([0x81, time >> 8, time & 255, position === 0 ? 0x80 : 0, position])));
  const bytes = cluster(blocks);
  const unavailableAt = bytes.length - blocks.at(-1).length;
  const over = params(bytes, [{ trackNumber: 1, type: "video", defaultDurationSeconds: 0.04, reorderDepth: 1 }]);
  over.interval = { from: 0, to: 0.08, trackIds: [1] };
  over.readRange = async (a, b) => {
    if (b >= unavailableAt) throw new BytesUnavailable(a, b, 0);
    return bytes.subarray(a, b + 1);
  };
  const index = await readMatroskaPackets(over);
  assert.equal(index.isComplete(), false);
  const input = index.inputFor({ trackId: 1, from: 0, to: 0.08 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.packets.map(packet => packet.pts), [0, 0.12, 0.04]);
  assert.equal(index.inputFor({ trackId: 1, from: 0.08, to: 0.2 }).kind, "needs-index");
  await assert.rejects(readMatroskaPackets({ ...over, tracks: [{ ...over.tracks[0], reorderDepth: undefined }] }), BytesUnavailable);
});
