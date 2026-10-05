import test from "node:test";
import assert from "node:assert/strict";
import { avcPacketSlices } from "../../services/encode/annex-b-input.js";

test("Annex B start codes across borrowed slices become length declarations without copying payload", () => {
  const bytes = Buffer.from([0, 0, 0, 1, 0x67, 4, 5, 0, 0, 1, 0x65, 6, 7, 0, 0]);
  for (let at = 1; at < bytes.length; at++) {
    const output = avcPacketSlices([bytes.subarray(0, at), bytes.subarray(at)]);
    assert.deepEqual(Buffer.concat(output), Buffer.from([0, 0, 0, 3, 0x67, 4, 5, 0, 0, 0, 3, 0x65, 6, 7]));
    const payload = output.filter(slice => slice.buffer === bytes.buffer);
    assert.deepEqual(Buffer.concat(payload), Buffer.from([0x67, 4, 5, 0x65, 6, 7]));
  }
});

test("incomplete or unframed AVC packets are refused", () => {
  for (const bytes of [[], [0, 0, 1], [1, 2, 3], [0, 0, 1, 0, 0, 1, 0x65]]) {
    assert.throws(() => avcPacketSlices([Buffer.from(bytes)]), /AVC Annex B/);
  }
});
