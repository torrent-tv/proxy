import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";

import { SourceFile } from "../../services/media/SourceFile.js";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { Output } from "../../services/encode/output/Output.js";
import { outputSpec } from "./helpers/output-spec.js";
import { managerWithOwnStore } from "./helpers/manager.js";
import { handleApiTranscodeSessionsProgressGet } from "../../routes/api/transcode-sessions/progress/get.js";

const SESSION_ID = "aaaaaaaabbbbcccc";

function fakeSession({ id = SESSION_ID, outputKey = "parity:fmt=fmp4:grid=kf@0:video-only:v=0/copy" } = {}) {
  const file = new SourceFile({ sourceKey: "torrent:abc", fileIndex: 0, name: "video.mkv", length: 100_000_000 })
    .learn({ width: 1920, height: 1080, durationSeconds: 40, bitrateKbps: 20_000 });
  return {
    id,
    spec: outputSpec({ cutGrid: "keyframe", audioSeparate: false }),
    outputKey,
    dirPath: path.join(os.tmpdir(), "viewer-forecast-parity-unused"),
    file,
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    timeline: new Timeline({ boundaries: Array.from({ length: 11 }, (_, index) => index * 4), cutGrid: "keyframe" }),
    segmentFormat: fmp4Format,
    output: new Output({ encodeWidth: 0, encodeHeight: 0, outputFps: 24, softwarePreset: null, applyTonemap: false }),
    transcodeVideo: false,
    transcodeAudio: true,
    audioTrackIndex: 0,
    audioSourceTrackIndex: 0,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentCount: 10,
    progress: { state: "running", processedSeconds: 4, startPositionSeconds: 0 }
  };
}

async function forecastProjection(t) {
  const previousNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  const { manager, cleanup } = managerWithOwnStore();
  t.after(() => { Date.now = previousNow; cleanup(); });
  const session = fakeSession();
  manager.outputs.set(session.id, session);
  const viewer = manager.viewers.selectsFile("viewer", "torrent:abc", 0);
  manager.viewers.of(session, "viewer");
  viewer.report({ linkMbps: 100, linkSampleMbps: 100, linkSampleAt: 1_800_000_000_000,
    linkSampleAgeMs: 0, positionSeconds: 0, bufferedAheadSec: 0, bufferLimitSeconds: 30, waiting: true, playing: false });
  manager.encodeCost.projectedSpeedOf = () => 0.5;
  manager.sourceInputsFor = (_output, index) => [{ sourceId: "torrent:abc:0",
    ranges: [{ start: index * 10_000_000, end: (index + 1) * 10_000_000 }] }];
  manager.getSourceStats = async () => {
    const startedAt = performance.now();
    return { fileAvailable: false, downloadSpeed: 50_000_000,
      fileOffset: 0, fileLength: 100_000_000, pieceLength: 1 << 20,
      sourceCapture: { owner: "torrent-worker", clock: "performance", clockEpoch: performance.timeOrigin,
        startedAt, completedAt: performance.now(), revision: 1, validity: "valid", unknownReason: null } };
  };

  let progress;
  await handleApiTranscodeSessionsProgressGet({ params: { sessionId: session.id }, query: { consumer: "viewer" } },
    { send(value) { progress = value; return value; }, code() { return this; } }, manager);
  const readiness = progress.playbackReadiness;
  return {
    progress: {
      sessionId: progress.sessionId,
      state: progress.state,
      minimumBufferSeconds: progress.minimumBufferSeconds,
      processedSeconds: progress.processedSeconds,
      inputBytes: progress.inputBytes,
      startPositionSeconds: progress.startPositionSeconds,
      totalSeconds: progress.totalSeconds,
      percent: progress.percent,
      remainingSeconds: progress.remainingSeconds,
      segmentDurationSec: progress.segmentDurationSec,
      outputMbps: progress.outputMbps,
      requestedHeight: progress.requestedHeight,
      requestedUrgent: progress.requestedUrgent,
      error: progress.error
    },
    playbackReadiness: {
      ready: readiness.ready,
      reason: readiness.reason,
      delaySeconds: readiness.delaySeconds,
      firstRequiredSegmentsSeconds: readiness.firstRequiredSegmentsSeconds,
      holdingBy: readiness.holdingBy
    }
  };
}

test("forecast and HTTP progress fields match the recorded pre-refactor result", async t => {
  const projection = await forecastProjection(t);
  assert.deepEqual(projection, {
    // Captured by running origin/main 08dc188 (before this refactor) against
    // this same route, fake clock and input sequence. It is an output fixture,
    // not a second implementation of the forecast equations.
    progress: {
      sessionId: "aaaaaaaabbbbcccc",
      state: "starting",
      minimumBufferSeconds: 4,
      processedSeconds: 0,
      inputBytes: 0,
      startPositionSeconds: 0,
      totalSeconds: 40,
      percent: 0,
      remainingSeconds: 40,
      segmentDurationSec: 4,
      outputMbps: null,
      requestedHeight: 0,
      requestedUrgent: false,
      error: ""
    },
    playbackReadiness: {
      ready: false,
      reason: "minimum-safe-delay",
      delaySeconds: 48.209715200000005,
      firstRequiredSegmentsSeconds: null,
      holdingBy: {
        kind: "production",
        track: "parity:fmt=fmp4:grid=kf@0:video-only:v=0/copy",
        segment: 9,
        atSeconds: 80.2097152,
        aheadSeconds: 32,
        requiresSource: true,
        sourceArrivalSeconds: 1.9999999999999998,
        sourcePlanned: false
      }
    }
  });
});

test("a disposed session's pending progress request cannot create viewer or geometry state", async t => {
  const { manager, cleanup } = managerWithOwnStore();
  t.after(cleanup);
  const session = fakeSession();
  const other = fakeSession({ id: "bbbbbbbbccccdddd", outputKey: "other-output" });
  manager.outputs.set(session.id, session);
  manager.outputs.set(other.id, other);
  const viewer = manager.viewers.selectsFile("viewer", "torrent:abc", 0);
  manager.viewers.of(session, "viewer");
  manager.viewers.of(other, "viewer");
  let resolveQuality;
  let qualityStarted;
  const started = new Promise(resolve => { qualityStarted = resolve; });
  const quality = new Promise(resolve => { resolveQuality = resolve; });
  manager.quality.observedStreamMbps = () => { qualityStarted(); return quality; };

  const pending = manager.viewerRequests.getSessionProgress(session.id, "viewer");
  await started;
  await manager.lifecycle.disposeSession(session.id);
  resolveQuality(5);
  assert.equal(await pending, null);

  assert.equal(manager.outputs.get(session.id), undefined);
  assert.equal(manager.viewers.get("viewer"), viewer, "the viewer is still live on the other output");
  assert.equal(manager.viewerPlaybackState.viewerCount(), 0);
  assert.equal(manager.outputForecastGeometry.size(), 0);
});

test("a late separate-audio answer cannot restore geometry after that output is disposed", async t => {
  const { manager, cleanup } = managerWithOwnStore();
  t.after(cleanup);
  const session = fakeSession();
  const audio = fakeSession({ id: "bbbbbbbbccccdddd", outputKey: "audio-output" });
  manager.outputs.set(session.id, session);
  manager.outputs.set(audio.id, audio);
  manager.viewers.selectsFile("viewer", "torrent:abc", 0);
  manager.viewers.of(session, "viewer");
  manager.viewers.of(audio, "viewer");
  manager.renditions.servesAudioSeparately = () => true;
  manager.renditions.playbackAudioOutputFor = () => audio;
  manager.getSourceStats = async () => {
    const startedAt = performance.now();
    return { fileAvailable: true, downloadSpeed: 10_000_000,
      fileOffset: 0, fileLength: 100_000_000, pieceLength: 1 << 20,
      sourceCapture: { owner: "torrent-worker", clock: "performance", clockEpoch: performance.timeOrigin,
        startedAt, completedAt: performance.now(), revision: 1, validity: "valid", unknownReason: null } };
  };
  let resolveAudioQuality;
  let audioQualityStarted;
  const started = new Promise(resolve => { audioQualityStarted = resolve; });
  const audioQuality = new Promise(resolve => { resolveAudioQuality = resolve; });
  manager.quality.observedStreamMbps = output => output === audio
    ? (audioQualityStarted(), audioQuality)
    : 5;

  const pending = manager.viewerRequests.getSessionProgress(session.id, "viewer");
  await started;
  assert.equal(manager.viewerPlaybackState.viewerCount(), 1);
  assert.equal(manager.outputForecastGeometry.size(), 2);
  await manager.lifecycle.disposeSession(audio.id);
  assert.equal(manager.outputForecastGeometry.size(), 1);
  resolveAudioQuality(2);
  const progress = await pending;

  assert.ok(progress, "the video session remains live");
  assert.equal(manager.outputs.get(audio.id), undefined);
  assert.equal(manager.viewerPlaybackState.viewerCount(), 1);
  assert.equal(manager.outputForecastGeometry.size(), 1);
  assert.equal(manager.outputForecastGeometry.get(audio), null);
});

test("a pending answer cannot recreate an old variant after the viewer selects another live variant", async t => {
  const { manager, cleanup } = managerWithOwnStore();
  t.after(cleanup);
  const base = fakeSession();
  const oldVariant = fakeSession({ id: "bbbbbbbbccccdddd", outputKey: "old-variant" });
  const newVariant = fakeSession({ id: "ccccccccddddeeee", outputKey: "new-variant" });
  manager.outputs.set(base.id, base);
  manager.outputs.set(oldVariant.id, oldVariant);
  manager.outputs.set(newVariant.id, newVariant);
  manager.viewers.of(base, "viewer");
  const viewer = manager.viewers.of(oldVariant, "viewer");
  manager.viewers.of(newVariant, "viewer");
  viewer.activeVariantId = oldVariant.id;

  let resolveQuality;
  let qualityStarted;
  const started = new Promise(resolve => { qualityStarted = resolve; });
  const quality = new Promise(resolve => { resolveQuality = resolve; });
  manager.quality.observedStreamMbps = () => { qualityStarted(); return quality; };

  const pending = manager.viewerRequests.getSessionProgress(base.id, "viewer");
  await started;
  viewer.activeVariantId = newVariant.id;
  assert.equal(await manager.lifecycle.viewerLeaves(oldVariant, "viewer"), true);
  assert.equal(manager.outputs.get(oldVariant.id), oldVariant, "other viewers can still use the old variant");
  resolveQuality(5);

  assert.equal(await pending, null);
  assert.equal(manager.viewerPlaybackState.viewerCount(), 0);
  assert.equal(manager.outputForecastGeometry.get(oldVariant), null);
});

test("a seek that replaces the forecast generation cancels its pending source snapshot", async t => {
  const { manager, cleanup } = managerWithOwnStore();
  t.after(cleanup);
  const session = fakeSession();
  manager.outputs.set(session.id, session);
  const viewer = manager.viewers.of(session, "viewer");

  let resolveStats;
  let statsStarted;
  const started = new Promise(resolve => { statsStarted = resolve; });
  const stats = new Promise(resolve => { resolveStats = resolve; });
  manager.getSourceStats = () => { statsStarted(); return stats; };

  const pending = manager.viewerRequests.getSessionProgress(session.id, "viewer", 0);
  await started;
  viewer.assignments.statedGeneration(1, Date.now());
  resolveStats({ fileAvailable: false, downloadSpeed: 10_000_000, fileOffset: 0,
    fileLength: 100_000_000, pieceLength: 1 << 20 });

  assert.deepEqual(await pending, { superseded: true }, "a response assembled for the old seek cannot become current");
});

test("a seek that happens during the initial rate lookup cancels the progress response", async t => {
  const { manager, cleanup } = managerWithOwnStore();
  t.after(cleanup);
  const session = fakeSession();
  manager.outputs.set(session.id, session);
  const viewer = manager.viewers.of(session, "viewer");

  let resolveRate;
  let rateStarted;
  const started = new Promise(resolve => { rateStarted = resolve; });
  const rate = new Promise(resolve => { resolveRate = resolve; });
  manager.quality.observedStreamMbps = () => { rateStarted(); return rate; };

  const pending = manager.viewerRequests.getSessionProgress(session.id, "viewer", 0);
  await started;
  viewer.assignments.statedGeneration(1, Date.now());
  resolveRate(5);

  assert.deepEqual(await pending, { superseded: true }, "a pre-seek request cannot be restamped with the new generation");
});
