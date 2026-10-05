import test from "node:test";
import assert from "node:assert/strict";
import { readAsfPackets } from "../../services/media/container/asf-packets.js";
import { strictReader, isUnavailable } from "../../services/media/container/unavailable.js";

function uint(value, width) { const result = Buffer.alloc(width); result.writeUIntLE(value, 0, width); return result; }
function packet({ stream = 1, number = 0, offset = 0, size = 4, pts = 0, data, compressed = false }) {
  const replica = compressed ? Buffer.from([20]) : Buffer.concat([uint(size, 4), uint(pts, 4)]);
  const payload = Buffer.concat([Buffer.from([0x80 | stream, number]), uint(offset, 4), Buffer.from([replica.length]), replica, uint(data.length, 2), data]);
  const header = Buffer.concat([Buffer.from([0x82, 0, 0, 0x29, 0x5d, 0, 0]), uint(pts, 4), uint(20, 2), Buffer.from([0x81])]);
  header[5] = header.length + payload.length;
  return { bytes: Buffer.concat([header, payload]), payloadAt: header.length + payload.length - data.length };
}
function file(packets) {
  const head = Buffer.concat([Buffer.from("3626b2758e66cf11a6d900aa0062ce6c", "hex"), Buffer.alloc(8), Buffer.alloc(16), Buffer.alloc(8), Buffer.from([1, 1])]);
  const bytes = Buffer.concat([head, ...packets.map(packet => packet.bytes)]);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 16);
  bytes.writeBigUInt64LE(BigInt(packets.length), 40);
  return { bytes, info: { dataOffset: 0, packetLength: 100, prerollSeconds: 0, durationSeconds: 1 } };
}

test("ASF fragmented media objects yield exact disjoint payload ranges without reading their bodies", async () => {
  const first = packet({ data: Buffer.from("ab") });
  const second = packet({ offset: 2, data: Buffer.from("cd") });
  const { bytes, info } = file([first, second]);
  const payloads = [[50 + first.payloadAt, 51 + first.payloadAt],
    [50 + first.bytes.length + second.payloadAt, 51 + first.bytes.length + second.payloadAt]];
  const index = await readAsfPackets({ info, fileSize: bytes.length, tracks: [{ trackNumber: 1, type: "video" }],
    readRange: async (a, b) => {
      assert.ok(payloads.every(([start, end]) => b < start || a > end), "Indexing must not read frame payloads.");
      return bytes.subarray(a, b + 1);
    } });
  const input = index.inputFor({ trackId: 1, from: 0, to: 0.5 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.packets[0].ranges, payloads);
  assert.equal(index.boundsOf(1).end, 1);
});

test("ASF compressed payloads separate frames and preserve their declared time delta", async () => {
  const packed = packet({ stream: 2, offset: 0, compressed: true, data: Buffer.from([2, 11, 12, 3, 21, 22, 23]) });
  const { bytes, info } = file([packed]);
  const index = await readAsfPackets({ info, fileSize: bytes.length, tracks: [{ trackNumber: 2, type: "audio" }],
    readRange: async (a, b) => bytes.subarray(a, b + 1) });
  const input = index.inputFor({ trackId: 2, from: 0, to: 0.03 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.packets.map(packet => packet.pts), [0, 0.02]);
  assert.deepEqual(input.packets.map(packet => Buffer.concat(packet.ranges.map(([a, b]) => bytes.subarray(a, b + 1)))),
    [Buffer.from([11, 12]), Buffer.from([21, 22, 23])]);
});

test("ASF first-picture metadata stops before an unavailable later packet", async () => {
  const first = packet({ size: 4, pts: 40, data: Buffer.from("abcd") });
  const second = packet({ number: 1, pts: 80, data: Buffer.from("efgh") });
  const { bytes, info } = file([first, second]);
  const result = await readAsfPackets({ info, fileSize: bytes.length, firstPicture: true,
    tracks: [{ trackNumber: 1, type: "video" }],
    readRange: strictReader(async (a, b) => b < 50 + first.bytes.length ? bytes.subarray(a, b + 1) : null, bytes.length) });
  assert.deepEqual(result, { startTimeSeconds: 0.04 });
});

test("ASF resumes at the unfinished packet and rolls back its partial compressed frames", async () => {
  const first = packet({ size: 4, data: Buffer.from("abcd") });
  const second = packet({ number: 1, offset: 40, compressed: true, data: Buffer.from([2, 11, 12, 2, 21, 22]) });
  const { bytes, info } = file([first, second]);
  const secondAt = 50 + first.bytes.length;
  let available = secondAt + second.payloadAt + 3;
  const requested = [];
  const readRange = strictReader(async (a, b) => {
    requested.push(a);
    return b < available ? bytes.subarray(a, b + 1) : null;
  }, bytes.length);
  const state = {};
  const params = { readRange, state, info, fileSize: bytes.length, tracks: [{ trackNumber: 1, type: "video" }] };
  await assert.rejects(readAsfPackets(params), isUnavailable);
  assert.equal(state.at, secondAt);
  assert.equal(state.frames.get(1).length, 1);
  requested.length = 0;
  available = bytes.length;
  const index = await readAsfPackets(params);
  assert.ok(requested.every(at => at >= secondAt), "Completed packet headers must not be read again.");
  assert.deepEqual(index.inputFor({ trackId: 1, from: 0, to: 0.1 }).packets.map(packet => packet.pts), [0, 0.04, 0.06]);
});

test("ASF refuses a missing fragment instead of returning an incomplete decoder input", async () => {
  const { bytes, info } = file([packet({ data: Buffer.from("ab") }), packet({ offset: 3, data: Buffer.from("cd") })]);
  await assert.rejects(readAsfPackets({ info, fileSize: bytes.length, tracks: [{ trackNumber: 1, type: "video" }],
    readRange: async (a, b) => bytes.subarray(a, b + 1) }), /fragments are incomplete/);
  await assert.rejects(readAsfPackets({ info, fileSize: bytes.length, tracks: [{ trackNumber: 1, type: "video" }],
    readRange: strictReader(async () => null, bytes.length) }), isUnavailable);
});
