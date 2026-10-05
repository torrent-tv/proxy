import test from "node:test";
import assert from "node:assert/strict";
import { SubtitleController } from "../../services/server/controllers/SubtitleController.js";
import { SubtitleOrchestrator } from "../../services/media/SubtitleOrchestrator.js";

test("subtitle serving never adds a source and rejects absent or unsupported declared tracks", async () => {
  const tracks = [{ type: "subtitle", trackNumber: 2, declaredIndex: 0, isTextBased: () => false }];
  const subtitles = new SubtitleOrchestrator({ tracks: new Map([["source:0", tracks]]) });
  const torrentPool = { knownTorrent: () => ({ files: [{ name: "video.mkv", length: 100 }] }),
    getTorrent: () => assert.fail("subtitle delivery cannot add a source") };
  const controller = new SubtitleController({ sourceRegistry: { get: () => ({}) }, torrentPool, subtitles });
  assert.equal((await controller.getSubtitle({ sourceKey: "source", fileIndex: 0, trackIndex: 0 })).status, 422);
  assert.equal((await controller.getSubtitle({ sourceKey: "source", fileIndex: 0, trackIndex: 1 })).status, 422);
  torrentPool.knownTorrent = () => null;
  assert.equal((await controller.getSubtitle({ sourceKey: "source", fileIndex: 0, trackIndex: 0 })).pending, true);
});

test("a subtitle document request waits for prepared bytes and cancels with its caller", async () => {
  const subtitles = new SubtitleOrchestrator({});
  const controller = new SubtitleController({ sourceRegistry: { get: () => ({}) },
    torrentPool: { knownTorrent: () => ({ files: [{ name: "text.srt", length: 50 }] }) }, subtitles });
  const cancellation = new AbortController();
  const pending = controller.getSubtitle({ sourceKey: "source", fileIndex: 0, signal: cancellation.signal });
  cancellation.abort();
  await assert.rejects(pending, { name: "AbortError" });
  const ready = controller.getSubtitle({ sourceKey: "source", fileIndex: 0 });
  const bytes = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nText\n");
  await subtitles.inspectFile({ sourceKey: "source", fileIndex: 0, label: "text.srt", fileSize: bytes.length,
    readRange: async () => bytes });
  assert.match((await ready).vtt, /^WEBVTT/);
});
