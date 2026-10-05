import assert from "node:assert/strict";
import test from "node:test";
import { readMpegTsPackets } from "../../services/media/container/mpeg-ts-packets.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";

test("TS resumes after a completed transport packet when its index allocation was refused", async () => {
  const frame = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc, 1, 2, 3, 4]);
  const payload = Buffer.concat([frame, frame]);
  const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xc0, 0, payload.length + 8, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1]), payload]);
  const packet = Buffer.alloc(188, 0xff);
  packet.set([0x47, 0x40, 1, 0x30, 183 - pes.length, 0]);
  pes.copy(packet, 188 - pes.length);
  let allowed = false, reads = 0;
  const state = {};
  const options = { readRange: async (start, end) => { reads++; return packet.subarray(start, end + 1); },
    fileSize: 188, layout: { width: 188, sync: 0 },
    tracks: [{ trackNumber: 1, type: "audio", codecId: "aac" }], state,
    packetMemory: { reserve: () => allowed } };
  await assert.rejects(readMpegTsPackets(options), IndexMemoryUnavailable);
  assert.equal(state.offset, 188);
  assert.equal(reads, 1);
  allowed = true;
  const index = await readMpegTsPackets(options);
  assert.equal(reads, 1);
  const input = index.inputFor({ trackId: 1, from: 0, to: 0.04 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.packets.map(packet => packet.pts), [0, 1024 / 44100]);
  assert.equal(input.packets.length, 2);
  assert.equal(index.isComplete(), true);
});
