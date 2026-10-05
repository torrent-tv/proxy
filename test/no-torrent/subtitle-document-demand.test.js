import test from "node:test";
import assert from "node:assert/strict";
import { SubtitleOrchestrator } from "../../services/media/SubtitleOrchestrator.js";

test("a missing subtitle document declares exact bytes and never caches absence", async () => {
  const subtitles = new SubtitleOrchestrator({ forget() {} });
  const bytes = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nText\n");
  let available = false;
  let reads = 0;
  const declarations = [];
  const params = { sourceKey: "source", fileIndex: 1, label: "text.srt", fileSize: bytes.length,
    readRange: async (start, end) => {
      reads++;
      assert.deepEqual([start, end], [0, bytes.length - 1]);
      return available ? bytes : null;
    }, onReadResult: async (statement, result) => declarations.push([statement, result.kind]) };
  const missing = await subtitles.inspectFile(params);
  assert.equal(missing.kind, "needs-ranges");
  assert.deepEqual(missing.ranges, [[0, bytes.length - 1]]);
  assert.equal(subtitles.documentFor("source", 1), null);
  available = true;
  const complete = await subtitles.inspectFile(params);
  assert.equal(complete.kind, "result");
  assert.match(complete.value.vtt, /00:00:01\.000/);
  available = false;
  assert.equal((await subtitles.inspectFile(params)).kind, "result");
  assert.equal(reads, 2);
  assert.deepEqual(declarations, [["subtitle-file", "needs-ranges"], ["subtitle-file", "result"], ["subtitle-file", "result"]]);
  subtitles.forget("source", 1);
  assert.equal(subtitles.documentFor("source", 1), null);
});

test("unsupported or oversized subtitle documents refuse before reading", async () => {
  const subtitles = new SubtitleOrchestrator({});
  const params = { sourceKey: "source", fileIndex: 0, label: "text.sup", fileSize: 10,
    readRange: async () => assert.fail("unsupported input must not be read") };
  assert.equal((await subtitles.inspectFile(params)).reason, "subtitle-format-not-supported");
  assert.equal((await subtitles.inspectFile({ ...params, fileIndex: 1, label: "text.srt", fileSize: 9 * 1024 * 1024 })).reason,
    "subtitle-size-not-supported");
});

test("document publication wakes a subscribed caller and cancellation removes its wait", async () => {
  const subtitles = new SubtitleOrchestrator({});
  const cancellation = new AbortController();
  const cancelled = subtitles.waitForDocument("source", 0, cancellation.signal);
  cancellation.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  const waiting = subtitles.waitForDocument("source", 0);
  const bytes = Buffer.from("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nText\n");
  await subtitles.inspectFile({ sourceKey: "source", fileIndex: 0, label: "text.vtt", fileSize: bytes.length,
    readRange: async () => bytes });
  assert.equal((await waiting).kind, "result");
  assert.equal((await subtitles.waitForDocument("source", 0)).kind, "result");
});

test("forgetting a source settles document callers and an obsolete read cannot restore facts", async () => {
  const subtitles = new SubtitleOrchestrator({ forget() {} });
  const waiting = subtitles.waitForDocument("source", 0);
  subtitles.forget("source", 0);
  assert.equal((await waiting).reason, "source-forgotten");
  assert.equal(subtitles.documentFor("source", 0), null);
  const bytes = Buffer.from("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nText\n");
  const result = await subtitles.inspectFile({ sourceKey: "source", fileIndex: 0, label: "text.vtt", fileSize: bytes.length,
    readRange: async () => bytes, isCurrent: () => false });
  assert.equal(result.reason, "request-obsolete");
  assert.equal(subtitles.documentFor("source", 0), null);
});
