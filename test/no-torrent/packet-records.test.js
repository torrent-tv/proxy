import test from "node:test";
import assert from "node:assert/strict";
import { PacketRecords } from "../../services/media/container/PacketRecords.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";

test("invalid packet facts cannot consume a reservation or alter retained records", () => {
  let reservations = 0;
  const records = new PacketRecords({ reserve: () => { reservations++; return true; } });
  const packet = { pts: 0, duration: 0.1, ranges: [[0, 1]] };
  records.push(packet);
  const bytes = records.allocatedBytes;
  for (const invalid of [{ ...packet, pts: NaN }, { ...packet, ranges: [[2, 1]] },
    { ...packet, expectedHash: "ab" }, { ...packet, dts: Infinity }]) {
    assert.throws(() => records.push(invalid), TypeError);
  }
  assert.equal(reservations, 1);
  assert.equal(records.length, 1);
  assert.equal(records.allocatedBytes, bytes);
  assert.deepEqual(records.at(0), { ...packet, keyframe: false });
});

test("packet growth is admitted atomically before allocating data or address storage", () => {
  let allowance = 0, held = 0;
  const records = new PacketRecords({ reserve: bytes => {
    if (bytes > allowance - held) return false;
    held += bytes;
    return true;
  }, release: bytes => { held -= bytes; } });
  const packet = { pts: 0, duration: 0.1, keyframe: true, ranges: [[0, 1]] };
  assert.throws(() => records.push(packet), error => error instanceof IndexMemoryUnavailable && error.bytes === 131072);
  assert.equal(records.length, 0);
  assert.equal(records.allocatedBytes, 0);
  assert.equal(held, 0);
  allowance = 131072;
  records.push(packet);
  const limit = Math.floor(65536 / 72);
  for (let index = 1; index < limit; index++) records.push(packet);
  assert.equal(held, records.allocatedBytes);
  assert.throws(() => records.push(packet), IndexMemoryUnavailable);
  assert.equal(records.length, limit);
  allowance += 65536;
  records.push(packet);
  assert.equal(held, records.allocatedBytes);
  records.length = 1;
  assert.equal(held, 131072);
  records.length = 0;
  assert.equal(held, 0);
});

test("binary packet records preserve exact optional facts across storage blocks", () => {
  const records = new PacketRecords();
  assert.equal(records.allocatedBytes, 0);
  const original = { pts: -0.125, dts: -0.5, duration: 1 / 30, keyframe: true,
    discardPaddingSeconds: -0.001, bitOffset: 13, bitLength: 24,
    expectedHash: "0a".repeat(32), ranges: [[2 ** 40, 2 ** 40 + 32], [2 ** 42, 2 ** 42 + 81]] };
  for (let number = 0; number < 10000; number++) records.push({ ...original, pts: number / 30 - 0.125 });
  assert.equal(records.length, 10000);
  assert.deepEqual(records.at(0), original);
  assert.deepEqual(records.at(-1), { ...original, pts: 9999 / 30 - 0.125 });
  assert.equal(records.at(10000), undefined);
  assert.ok(records.allocatedBytes >= 10000 * (56 + 32 + 32 + 8));
  const last = records.at(-1);
  last.ranges[0][0] = 7;
  assert.equal(records.at(-1).ranges[0][0], original.ranges[0][0]);
  records.extendLastPresentation(0.25);
  assert.equal(records.at(-1).duration, original.duration + 0.25);
});

test("rollback releases unused blocks and repeated partial reads cannot grow retained memory", () => {
  const records = new PacketRecords();
  const packet = { pts: 1, keyframe: false, ranges: [[17, 25]] };
  records.push(packet);
  const initial = records.allocatedBytes;
  for (let attempt = 0; attempt < 10; attempt++) {
    for (let number = 0; number < 10000; number++) records.push({ ...packet, pts: number });
    records.length = 1;
    assert.equal(records.allocatedBytes, initial);
    assert.deepEqual(records.at(0), packet);
  }
  records.length = 0;
  assert.equal(records.allocatedBytes, 0);
  records.push(packet);
  assert.deepEqual(records.at(0), packet);
});
