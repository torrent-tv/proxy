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

test("zones walked beside the segments give what filtering every zone for every segment gave", () => {
  // The map's zones come ascending and apart, so they are walked beside the
  // grid (torrent-tv/meta#178). The reference is the filter it replaced.
  const reference = (output, zones) => {
    const grid = output.timeline.published;
    const tracks = [{ type: "video", index: 0, mode: "copy" }];
    const demands = [];
    for (let index = 0; index + 1 < grid.length; index++) {
      const from = grid[index], to = grid[index + 1];
      const overlapping = zones.filter(zone => zone.priority > 0 && zone.from < to && zone.to > from);
      if (!overlapping.length) continue;
      const deadlineOf = zone => Number.isFinite(zone.deadlineAt) ? zone.deadlineAt + Math.max(0, from - zone.from) * 1000 : Infinity;
      demands.push({ index, from, to, tracks, owner: overlapping.reduce((first, zone) => deadlineOf(zone) < deadlineOf(first) ? zone : first),
        priority: Math.max(...overlapping.map(zone => zone.priority)), urgent: overlapping.some(zone => zone.urgent),
        behind: overlapping.every(zone => zone.behind), deferred: overlapping.every(zone => zone.deferred),
        deadlineAt: Math.min(...overlapping.map(deadlineOf)) });
    }
    return demands.sort((left, right) => left.deadlineAt - right.deadlineAt || right.priority - left.priority || left.index - right.index);
  };
  let state = 5;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let round = 0; round < 500; round++) {
    const grid = [0];
    while (grid.length < 2 + Math.floor(random() * 60)) grid.push(grid.at(-1) + 0.5 + random() * 6);
    const zones = [];
    let at = random() < 0.3 ? random() * 20 : 0;
    while (at < grid.at(-1) + 5 && zones.length < 30) {
      at += random() < 0.2 ? random() * 5 : 0;
      const to = Math.floor(at + 0.5 + random() * 20) + 1;
      zones.push({ from: Math.floor(at), to, priority: Math.floor(random() * 5) * 25, urgent: random() < 0.3, behind: random() < 0.3,
        deferred: random() < 0.2, deadlineAt: random() < 0.1 ? undefined : 1000 + Math.floor(random() * 5) * 1000 });
      at = to;
    }
    const output = { spec: { video: { fileIndex: 0 } }, timeline: { published: grid } };
    assert.deepEqual(segmentDemands(output, 0, zones), reference(output, zones), `round ${round}`);
  }
});
