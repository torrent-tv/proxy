import test from "node:test";
import assert from "node:assert/strict";
import { segmentDemands, sourceDeadline } from "../../services/viewer/segment-demands.js";

test("a partial demand orders the complete segment and only its selected source tracks", () => {
  const output = { spec: { video: { fileIndex: 7, encode: false }, audio: { fileIndex: 2, trackIndex: 3, transcode: true } },
    timeline: { published: [0, 4, 8], boundaries: [0, 3, 8] } };
  const demands = segmentDemands(output, 7, [{ from: 2, to: 3, priority: 100, urgent: true, deadlineAt: 1000 }]);
  assert.deepEqual(demands.map(({ from, to, tracks }) => ({ from, to, tracks })),
    [{ from: 0, to: 4, tracks: [{ type: "video", index: 0, mode: "copy" }] }]);
  assert.deepEqual(segmentDemands(output, 2, [{ from: 5, to: 6, priority: 5 }])[0].tracks,
    [{ type: "audio", index: 3, mode: "transcode" }]);
  assert.deepEqual(segmentDemands(output, 8, [{ from: 0, to: 8, priority: 100 }]), []);
});

test("map demand merges before whole segments are ordered by earliest deadline", () => {
  const output = { spec: { video: { fileIndex: 0, encode: true } }, timeline: { published: [0, 4, 8] } };
  const demands = segmentDemands(output, 0, [
    { from: 0, to: 2, priority: 2, deadlineAt: 4000, deferred: true },
    { from: 2, to: 4, priority: 100, deadlineAt: 3000, urgent: true },
    { from: 4, to: 8, priority: 50, deadlineAt: 1000 }
  ]);
  assert.deepEqual(demands.map(demand => demand.index), [1, 0]);
  assert.equal(demands[1].priority, 100);
  assert.equal(demands[1].urgent, true);
  assert.equal(demands[1].deferred, false);
});

test("source deadline subtracts observed processing and delivery and retains overdue demand", () => {
  const demand = { from: 4, to: 8, deadlineAt: 5000 };
  assert.equal(sourceDeadline(demand, { encodeSpeed: 2, outputBytes: 1_000_000, linkMbps: 4 }), 1000);
  assert.equal(sourceDeadline(demand, { encodeSpeed: 0.5, outputBytes: 1_000_000, linkMbps: 4 }), -5000);
  assert.equal(sourceDeadline(demand, {}), 5000);
});

test("a broad equal-priority zone retains each segment's presentation deadline", () => {
  const output = { spec: { video: { fileIndex: 0 } }, timeline: { published: [0, 10, 20, 30] } };
  const demands = segmentDemands(output, 0, [{ from: 0, to: 30, priority: 100,
    urgent: true, deadlineAt: 1000 }]);
  assert.deepEqual(demands.map(demand => demand.deadlineAt), [1000, 11000, 21000]);
});
