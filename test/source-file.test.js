/**
 * @file The file as a handle: its key, its name, what a probe said about it,
 * and the address this proxy serves it at.
 *
 * The reason this object exists is the key. Twenty places in the session
 * manager assembled `${sourceKey}:${fileIndex}` by hand, through five different
 * spellings, to reach caches that are keyed by a file. These checks pin the
 * shape those call sites now depend on, and the one property the registry has
 * to have: the same file asked for twice is the same object, or a fact learned
 * through one reference would be invisible through the other.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SourceFile, SourceFiles, sourceDecodeCharacteristics } from "../services/source/SourceFile.js";

test("a file's key is the pair that identifies it, spelled in one place", () => {
  const file = new SourceFile({ sourceKey: "abc123", fileIndex: 4 });
  assert.equal(file.key, "abc123:4");
  assert.equal(SourceFiles.keyFor("abc123", 4), file.key);
});

test("a file with no name is named by its index, so no log line is about a nameless thing", () => {
  assert.equal(new SourceFile({ sourceKey: "s", fileIndex: 7 }).name, "file#7");
  assert.equal(new SourceFile({ sourceKey: "s", fileIndex: 7, name: "  Film.mkv  " }).name, "Film.mkv");
});

test("facts are absent until a probe answers, and 'absent' is not 'zero'", () => {
  const file = new SourceFile({ sourceKey: "s", fileIndex: 0 });
  assert.equal(file.width, null, "an unread frame size is unknown, not 0x0");
  assert.equal(file.height, null);
  assert.equal(file.fps, null);
  assert.equal(file.durationSeconds, null);
  assert.equal(file.hasDuration, false);
  assert.equal(file.isHdr, false, "a file nobody has read is not claimed to be HDR");
  assert.equal(file.startTime, 0, "no stated start time means the timeline begins at zero");
  assert.equal(file.decode, null, "and nothing is priced from facts that were never read");
});

test("a fresher reading replaces the first, because a cold torrent answers incompletely", () => {
  const file = new SourceFile({ sourceKey: "s", fileIndex: 0 });
  file.learn({ width: 1920, height: 1080, fps: 24, durationSeconds: 0, startTime: 1.5 });
  assert.equal(file.width, 1920);
  assert.equal(file.hasDuration, false, "a duration of zero is no duration");
  assert.equal(file.startTime, 1.5);

  file.learn({ width: 1920, height: 1080, fps: 24, durationSeconds: 5400, startTime: 1.5 });
  assert.equal(file.durationSeconds, 5400);
  assert.equal(file.hasDuration, true);

  file.learn(null);
  assert.equal(file.durationSeconds, 5400, "nothing is unlearned by an answer that did not come");
});

test("what decoding costs is derived from the file's own facts, per codec family", () => {
  const file = new SourceFile({ sourceKey: "s", fileIndex: 0 });
  file.learn({ width: 1920, height: 1080, fps: 24, bitrateKbps: 8000, codec: "hevc", bitDepth: 10 });
  assert.deepEqual(file.decode, {
    megapixelsPerSecond: (1920 * 1080 * 24) / 1e6,
    megabitsPerSecond: 8,
    codec: "hevc",
    bitDepth: 10
  });
  // The same arithmetic, still callable on a plain reading — the offer prices a
  // file it has not made a session for.
  assert.deepEqual(sourceDecodeCharacteristics({ width: 1920, height: 1080, fps: 24, bitrateKbps: 8000 }), {
    megapixelsPerSecond: (1920 * 1080 * 24) / 1e6,
    megabitsPerSecond: 8,
    codec: "",
    bitDepth: null
  });
});

test("the address carries the file and the session, and the proxy's own base is a parameter", () => {
  const file = new SourceFile({ sourceKey: "abc", fileIndex: 2 });
  const url = file.streamUrl("http://127.0.0.1:9090", { sessionId: "sess-1" });
  assert.equal(url.pathname, "/stream");
  assert.equal(url.searchParams.get("sourceKey"), "abc");
  assert.equal(url.searchParams.get("fileIndex"), "2");
  assert.equal(url.searchParams.get("session"), "sess-1");

  const noSession = file.streamUrl("http://127.0.0.1:9090");
  assert.equal(noSession.searchParams.has("session"), false, "a read nobody is accounting for says so");
});

test("the same file asked for twice is the same object, or a fact learned once is lost", () => {
  const files = new SourceFiles();
  const first = files.get("abc", 1, "Film.mkv");
  first.learn({ width: 1280, height: 720, fps: 25, durationSeconds: 60 });

  const second = files.get("abc", 1);
  assert.equal(second, first, "two viewers of one file must not hold two copies of its facts");
  assert.equal(second.width, 1280);
  assert.equal(second.name, "Film.mkv");

  const other = files.get("abc", 2);
  assert.notEqual(other, first, "and a different file in the same torrent is a different file");
});

test("a name learned later is kept, since the first caller often has only an index", () => {
  const files = new SourceFiles();
  const bare = files.get("abc", 1);
  assert.equal(bare.name, "file#1");
  files.get("abc", 1, "Film.mkv");
  assert.equal(bare.name, "Film.mkv");
  files.get("abc", 1, "Something.else.mkv");
  assert.equal(bare.name, "Film.mkv", "and it is not renamed underneath a log line already written");
});

test("files nobody names are dropped, and a file still named survives the sweep", () => {
  const files = new SourceFiles();
  const kept = files.get("abc", 1);
  files.get("abc", 2);
  files.get("def", 9);
  assert.equal(files.size, 3);

  const dropped = files.forgetUnused(new Set([kept]));
  assert.equal(dropped, 2);
  assert.equal(files.size, 1);
  assert.equal(files.peek(kept.key), kept);
  assert.equal(files.peek("abc:2"), null);
});
