import test from "node:test";
import assert from "node:assert/strict";
import { SubtitleOrchestrator } from "../../services/media/SubtitleOrchestrator.js";
import { PacketIndex } from "../../services/media/container/PacketIndex.js";
import { MatroskaContainer } from "../../services/media/container/MatroskaContainer.js";
import { BytesUnavailable } from "../../services/media/container/unavailable.js";
import { ContainerOrchestrator } from "../../services/media/ContainerOrchestrator.js";

test("subtitle indexing shares the source's serialized packet reader and publishes only its cue outcome", async () => {
  const track = { type: "subtitle", trackNumber: 3, declaredIndex: 0, codecId: "S_TEXT/UTF8", isTextBased: () => true };
  const index = new PacketIndex();
  index.declareTrack(3, { type: "subtitle" });
  index.append(3, { pts: 1, duration: 1, ranges: [[10, 12]] });
  index.complete(3);
  let release, entered, calls = 0, outcomes = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const entering = new Promise(resolve => { entered = resolve; });
  const containers = new ContainerOrchestrator();
  containers.cache.set("source:0", { readTracks: async () => [track], cueTextOf: MatroskaContainer.cueTextOf,
    readPacketIndex: async () => {
      if (++calls === 1) { entered(); await blocked; }
      return index;
    } });
  const params = { sourceKey: "source", fileIndex: 0, subtitleTrackIndex: 0, fileSize: 30,
    packetInterval: { from: 0, to: 2, trackIds: [3] }, readRange: async () => Buffer.from("One") };
  const original = containers.inspect(params, "packets");
  await entering;
  const subtitles = new SubtitleOrchestrator(containers);
  const cues = subtitles.inspectPackets({ ...params, onReadResult: (statement, result) => {
    assert.equal(statement, "subtitle-cues");
    assert.equal(result.kind, "result");
    outcomes++;
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await original;
  assert.equal((await cues).kind, "result");
  assert.equal(calls, 2);
  assert.equal(outcomes, 1);
});

test("missing subtitle seed bytes are retried without retaining the failed initialization", async () => {
  const track = { type: "subtitle", trackNumber: 3, declaredIndex: 0, codecId: "S_TEXT/UTF8", isTextBased: () => true };
  const index = new PacketIndex();
  index.declareTrack(3, { type: "subtitle" });
  index.append(3, { pts: 1, duration: 1, ranges: [[10, 12]] });
  index.complete(3);
  let attempts = 0;
  const published = [];
  const subtitles = new SubtitleOrchestrator({ containerFor: async () => ({
    readTracks: async () => [track], readPacketIndex: async () => index, cueTextOf: MatroskaContainer.cueTextOf
  }) }, { held: async () => {
    if (++attempts === 1) throw new BytesUnavailable(20, 22, 0);
    return { cues: [{ seq: 10 }] };
  }, publish: entry => published.push(entry) });
  const params = { sourceKey: "source", fileIndex: 0, subtitleTrackIndex: 0, fileSize: 30,
    packetInterval: { from: 0, to: 2, trackIds: [3] }, readRange: async () => Buffer.from("One") };
  assert.equal((await subtitles.inspectPackets(params)).kind, "needs-ranges");
  assert.equal(subtitles.hasPacketCues("source", 0, 0), false);
  assert.equal((await subtitles.inspectPackets(params)).kind, "result");
  assert.equal(attempts, 2);
  assert.equal(published[0].cues[0].seq, 11);
});

test("a later subtitle interval corrects an earlier open-ended cue and advances delivery", async () => {
  const track = { type: "subtitle", trackNumber: 3, declaredIndex: 0, codecId: "S_TEXT/UTF8", isTextBased: () => true };
  const index = new PacketIndex();
  index.declareTrack(3, { type: "subtitle" });
  index.append(3, { pts: 1, duration: 0, ranges: [[10, 12]] });
  index.append(3, { pts: 3, duration: 1, ranges: [[20, 22]] });
  index.complete(3);
  const pushed = [];
  const container = { readTracks: async () => [track], readPacketIndex: async () => index,
    cueTextOf: MatroskaContainer.cueTextOf };
  const subtitles = new SubtitleOrchestrator({ containerFor: async () => container }, { publish: event => pushed.push(event) });
  const params = { sourceKey: "source", fileIndex: 0, subtitleTrackIndex: 0, fileSize: 30,
    readRange: async from => Buffer.from(from === 10 ? "One" : "Two") };
  await subtitles.inspectPackets({ ...params, packetInterval: { from: 0, to: 2, trackIds: [3] } });
  const old = pushed[0].cues[0];
  await subtitles.inspectPackets({ ...params, packetInterval: { from: 2, to: 4, trackIds: [3] } });
  assert.deepEqual(pushed[1].withdrawn, [old.seq]);
  const correction = pushed[1].cues.find(cue => cue.text === "One");
  assert.equal(correction.endSeconds, 3);
  assert.ok(correction.seq > old.seq);
  const held = await subtitles.getCues({}, 0, "source", 3);
  assert.deepEqual(held.cues.map(cue => cue.startSeconds), [1, 3]);
});

test("forgetting a source during packet reading cannot restore its subtitle state", async () => {
  const track = { type: "subtitle", trackNumber: 3, declaredIndex: 0, codecId: "S_TEXT/UTF8", isTextBased: () => true };
  const index = new PacketIndex();
  index.declareTrack(3, { type: "subtitle" });
  index.append(3, { pts: 1, duration: 1, ranges: [[10, 12]] });
  index.complete(3);
  const container = { readTracks: async () => [track], readPacketIndex: async () => index,
    cueTextOf: MatroskaContainer.cueTextOf };
  const subtitles = new SubtitleOrchestrator({ containerFor: async () => container, forget() {} });
  const result = await subtitles.inspectPackets({ sourceKey: "source", fileIndex: 0,
    subtitleTrackIndex: 0, fileSize: 30, packetInterval: { from: 0, to: 2, trackIds: [3] },
    readRange: async () => { subtitles.forget("source", 0); return Buffer.from("One"); } });
  assert.equal(result.reason, "request-obsolete");
  assert.equal(subtitles.hasPacketCues("source", 0, 0), false);
});

test("subtitle packet reading declares missing payload and publishes complete text only once", async () => {
  const track = { type: "subtitle", trackNumber: 3, declaredIndex: 0, codecId: "S_TEXT/UTF8", isTextBased: () => true };
  const index = new PacketIndex();
  index.declareTrack(3, { type: "subtitle" });
  index.append(3, { pts: 1, duration: 1, ranges: [[10, 12]] });
  index.append(3, { pts: 2, duration: 1, ranges: [[20, 22]] });
  index.complete(3);
  const container = { readTracks: async () => [track], readPacketIndex: async () => index,
    cueTextOf: MatroskaContainer.cueTextOf };
  const pushed = [];
  const subtitles = new SubtitleOrchestrator({ containerFor: async () => container }, { publish: entry => pushed.push(entry) });
  let available = false;
  const params = { sourceKey: "source", fileIndex: 0, subtitleTrackIndex: 0, fileSize: 30,
    packetInterval: { from: 0, to: 4, trackIds: [3] }, readRange: async (from, to) => {
      assert.ok((from === 10 || from === 20) && to === from + 2);
      return from === 10 || available ? Buffer.from(from === 10 ? "One" : "Two") : null;
    } };
  const missing = await subtitles.inspectPackets(params);
  assert.equal(missing.kind, "needs-ranges");
  assert.deepEqual(missing.ranges, [[20, 22]]);
  assert.equal(pushed.length, 0);
  assert.equal(await subtitles.getCues({}, 0, "source", 3), null);
  available = true;
  assert.equal((await subtitles.inspectPackets(params)).kind, "result");
  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0].cues.map(cue => [cue.seq, cue.text]), [[1, "One"], [2, "Two"]]);
  assert.equal((await subtitles.inspectPackets(params)).kind, "result");
  assert.equal(pushed.length, 1);
  assert.equal((await subtitles.getCues({}, 0, "source", 3)).cues.length, 2);
});
