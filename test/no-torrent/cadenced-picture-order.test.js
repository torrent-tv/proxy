import test from "node:test";
import assert from "node:assert/strict";
import { PacketIndex } from "../../services/media/container/PacketIndex.js";
import { CadencedPictureOrder } from "../../services/media/container/CadencedPictureOrder.js";

test("declared cadence ranks nonproportional picture order and preserves decode order", () => {
  const index = new PacketIndex();
  index.declareTrack(1, { type: "video", reorderDepth: 2 });
  const order = new CadencedPictureOrder({ trackNumber: 1, reorderDepth: 2,
    presentationCadenceSeconds: 0.1, startTimeSeconds: 0 }, index);
  for (const [position, count] of [10, 40, 20, 30].entries()) {
    order.push({ pts: 0, dts: position * 0.1, keyframe: position === 0, ranges: [[position, position]] }, count, position === 0);
  }
  order.finish();
  index.complete(1);
  const input = index.inputFor({ trackId: 1, from: 0, to: 0.4 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.packets.map(packet => Math.round(packet.pts * 10)), [0, 3, 1, 2]);
  assert.deepEqual(input.packets.map(packet => packet.ranges[0][0]), [0, 1, 2, 3]);
});

test("picture order reset completes the preceding interval without resetting presentation time", () => {
  const index = new PacketIndex();
  index.declareTrack(1, { type: "video", reorderDepth: 1 });
  const order = new CadencedPictureOrder({ trackNumber: 1, reorderDepth: 1,
    presentationCadenceSeconds: 1, startTimeSeconds: 0 }, index);
  for (const [position, count] of [0, 2, 1, 0, 2, 1].entries()) {
    order.push({ pts: 0, dts: position, keyframe: count === 0, ranges: [[position, position]] }, count, count === 0);
  }
  order.finish();
  index.complete(1);
  assert.deepEqual(index.inputFor({ trackId: 1, from: 0, to: 6 }).packets.map(packet => packet.pts), [0, 2, 1, 3, 5, 4]);
});
