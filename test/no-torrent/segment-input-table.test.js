import test from "node:test";
import assert from "node:assert/strict";
import { SegmentInputTable } from "../../services/viewer/segment-input-table.js";

// Plain ranges; no torrent.

test("a segment's bytes are found by the forecast whatever the torrent is told, in one list per reading", () => {
  const table = new SegmentInputTable();
  const joined = [[100, 107], [200, 209]];
  table.set("source", 7, "picture", 2, joined);
  const first = table.inputsFor("source", "picture", 2);
  assert.deepEqual(first, [{ sourceId: "source:7", ranges: [{ start: 100, end: 108 }, { start: 200, end: 210 }] }]);
  table.set("source", 7, "picture", 2, joined);
  assert.equal(table.inputsFor("source", "picture", 2), first, "the same reading keeps its list");
  table.set("source", 7, "picture", 2, [[300, 309]]);
  assert.deepEqual(table.inputsFor("source", "picture", 2)[0].ranges, [{ start: 300, end: 310 }], "a newer reading replaces it");
  table.set("source", 8, "picture", 2, [[0, 9]]);
  assert.deepEqual(table.inputsFor("source", "picture", 2).map(input => input.sourceId), ["source:7", "source:8"]);
  assert.equal(table.inputsFor("source", "another", 2), null);
  table.forget("source");
  assert.equal(table.inputsFor("source", "picture", 2), null);
});
