import test from "node:test";
import assert from "node:assert/strict";
import { expandToTargetInputs } from "../../services/viewer/target-input-expansion.js";

// Plain map zones; no torrent.

const zone = (index, priority, ranges, extra = {}) => ranges.map(([byteStart, byteEnd]) =>
  ({ outputKey: "picture", index, priority, urgent: priority === 100, behind: false, deferred: false, byteStart, byteEnd, ...extra }));

test("the next run's input takes its first segment's place, as far as the run would copy", () => {
  // Every segment names the header (0-99) and its own media, 1000 bytes each.
  const zones = [...zone(10, 100, [[0, 99], [10_000, 10_999]]), ...zone(11, 99, [[0, 99], [11_000, 11_999]]),
    ...zone(12, 98, [[0, 99], [12_000, 12_999]]), ...zone(13, 98, [[0, 99], [13_000, 13_999]])];
  // Header once and three segments' media: 3100 bytes.
  const expanded = expandToTargetInputs(zones, () => 3100);
  assert.deepEqual(expanded.map(one => [one.index, one.priority, one.urgent]),
    [[10, 100, true], [10, 100, true], [11, 100, true], [11, 100, true], [12, 100, true], [12, 100, true], [13, 98, false], [13, 98, false]]);
  assert.equal(zones[2].priority, 99, "the map's own zones are not changed");
});

test("a segment already made, or not worked out, ends the stretch", () => {
  const zones = [...zone(10, 100, [[10_000, 10_999]]), ...zone(12, 98, [[12_000, 12_999]])];
  assert.deepEqual(expandToTargetInputs(zones, () => 1e9).map(one => one.priority), [100, 98]);
});

test("nothing is raised while the run's size is not known", () => {
  const zones = [...zone(10, 100, [[10_000, 10_999]]), ...zone(11, 99, [[11_000, 11_999]])];
  assert.equal(expandToTargetInputs(zones, () => null), zones);
});

test("each output's first segment is its own", () => {
  const zones = [...zone(10, 100, [[10_000, 10_999]]), ...zone(11, 99, [[11_000, 11_999]]),
    ...zone(4, 90, [[500, 599]], { outputKey: "sound", urgent: false }), ...zone(5, 89, [[600, 699]], { outputKey: "sound", urgent: false })];
  const expanded = expandToTargetInputs(zones, key => key === "sound" ? 200 : 1000);
  assert.deepEqual(expanded.map(one => [one.outputKey, one.index, one.priority]),
    [["picture", 10, 100], ["picture", 11, 99], ["sound", 4, 90], ["sound", 5, 90]]);
});
