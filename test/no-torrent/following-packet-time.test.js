import test from "node:test";
import assert from "node:assert/strict";
import { PacketRecords } from "../../services/media/container/PacketRecords.js";
import { followingPacketTime } from "../../services/media/container/following-packet-time.js";
import { IndexMemory } from "../../services/storage/IndexMemory.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";

test("a failed timestamp read releases admitted sorting memory", () => {
  const memory = new IndexMemory({ reviseBudget() {}, changed() {} });
  memory.allow(8);
  assert.throws(() => followingPacketTime({ length: 1, ptsAt() { throw new Error("unreadable"); } }, 1,
    memory.forFile("source", 0)), /unreadable/);
  assert.equal(memory.held(), 0);
  memory.forget("source");
  assert.equal(memory.held(), 0);
});

test("presentation sorting waits for its memory allowance and releases temporary bytes", () => {
  const records = new PacketRecords();
  for (const pts of [1, 0, 0.5]) records.push({ pts, duration: 0, keyframe: true, ranges: [[0, 1]] });
  const memory = new IndexMemory({ reviseBudget() {}, changed() {} });
  const allocation = memory.forFile("source", 0);
  assert.throws(() => followingPacketTime(records, 2, allocation), IndexMemoryUnavailable);
  assert.equal(memory.held(), 0);
  assert.equal(memory.required(), 24);
  memory.allow(24);
  const next = followingPacketTime(records, 2, allocation);
  assert.equal(memory.held(), 24);
  assert.equal(memory.packetBytes(), 0);
  assert.equal(next(0.5), 1);
  next.dispose();
  assert.equal(memory.held(), 0);
  next.dispose();
  assert.equal(memory.held(), 0);
});

test("the next distinct presentation time follows reordering and preserves an undeclared ending", () => {
  const records = new PacketRecords();
  for (const pts of [1, -0.125, 1, 0, 0.5]) records.push({ pts, duration: 0, keyframe: true, ranges: [[0, 1]] });
  const next = followingPacketTime(records, null);
  assert.equal(next(-0.125), 0);
  assert.equal(next(0), 0.5);
  assert.equal(next(0.5), 1);
  assert.equal(next(1), null);
  assert.equal(followingPacketTime(records, 2)(1), 2);
  assert.deepEqual([...records].map(packet => packet.pts), [1, -0.125, 1, 0, 0.5]);
});
