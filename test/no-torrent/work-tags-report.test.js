/**
 * @file The once-per-file work-tags line (torrent-tv/meta#280, design.md §6.5).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { WorkTagsReport } from "../../services/media/WorkTagsReport.js";
import { describeWorkTags } from "../../services/media/ContainerOrchestrator.js";

const result = { kind: "result", value: { title: "Film", cover: null } };

test("work tags are logged once per file", () => {
  const lines = [];
  const report = new WorkTagsReport({ log: line => lines.push(line) });
  report.note({ sourceKey: "src", fileIndex: 0 }, "film.mkv", result);
  report.note({ sourceKey: "src", fileIndex: 0 }, "film.mkv", result);
  assert.deepEqual(lines, [`container metadata "film.mkv": ${describeWorkTags(result)}`]);
});

test("another file of the same source is logged on its own", () => {
  const lines = [];
  const report = new WorkTagsReport({ log: line => lines.push(line) });
  report.note({ sourceKey: "src", fileIndex: 0 }, "a.mkv", result);
  report.note({ sourceKey: "src", fileIndex: 1 }, "b.mkv", result);
  assert.equal(lines.length, 2);
});

test("a result still pending or needing ranges is not logged and does not use up the file", () => {
  const lines = [];
  const report = new WorkTagsReport({ log: line => lines.push(line) });
  report.note({ sourceKey: "src", fileIndex: 0 }, "film.mkv", { kind: "pending" });
  report.note({ sourceKey: "src", fileIndex: 0 }, "film.mkv", { kind: "needs-ranges", ranges: [[0, 9]] });
  assert.deepEqual(lines, []);
  report.note({ sourceKey: "src", fileIndex: 0 }, "film.mkv", result);
  assert.equal(lines.length, 1);
});
