import test from "node:test";
import assert from "node:assert/strict";
import { PacketIndex } from "../../services/media/container/PacketIndex.js";
import { SegmentInputs } from "../../services/media/SegmentInputs.js";

test("download zones and encode admission use identical packet ranges", () => {
  const index = new PacketIndex();
  const tracks = [{ type: "video", trackNumber: 1 }, { type: "audio", trackNumber: 2 }];
  index.declareTrack(1, { type: "video" });
  index.declareTrack(2, { type: "audio", prerollSeconds: 1 });
  for (let pts = 0; pts < 4; pts++) {
    index.append(1, { pts, duration: 1, keyframe: pts % 2 === 0, ranges: [[100 + pts * 20, 109 + pts * 20]] });
    index.append(2, { pts, duration: 1, ranges: [[500 + pts * 20, 509 + pts * 20]] });
  }
  index.complete(1); index.complete(2);
  const inputs = new SegmentInputs({ index, tracks });
  const interval = { from: 2, to: 3, priority: 100, deadlineAt: 1234 };
  const admission = inputs.forInterval(interval);
  const download = inputs.downloadZones([interval]);
  assert.equal(download.kind, "result");
  assert.deepEqual(download.zones.map(zone => [zone.byteStart, zone.byteEnd]), admission.ranges);
  assert.ok(download.zones.every(zone => zone.priority === 100 && zone.deadlineAt === 1234));
});

test("a missing index does not return partial input from other tracks", () => {
  const index = new PacketIndex();
  index.declareTrack(1, { type: "video" });
  index.append(1, { pts: 0, duration: 1, keyframe: true, ranges: [[0, 9]] });
  const inputs = new SegmentInputs({ index, tracks: [{ type: "video", trackNumber: 1 }] });
  assert.equal(inputs.downloadZones([{ from: 0, to: 1 }]).kind, "needs-index");
});
