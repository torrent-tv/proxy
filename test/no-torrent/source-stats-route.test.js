import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { handleApiSourceStatsGet } from "../../routes/api/sources/stats/get.js";
import { ViewerRequests } from "../../services/server/ViewerRequests.js";
import { Viewers } from "../../services/viewer/Viewers.js";
import { ViewerPlaybackState } from "../../services/viewer/ViewerPlaybackState.js";

test("statistics cannot add a source and report missing metadata without waiting", async () => {
  const reply = { status: 200, code(status) { this.status = status; return this; }, send: value => value };
  const result = await handleApiSourceStatsGet({ params: { sourceKey: "source" }, query: {} }, reply, {
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "unused" }) },
    torrentPool: { knownTorrent: () => null, getTorrent: () => { throw new Error("Statistics cannot add a source"); } }
  });
  assert.equal(reply.status, 202);
  assert.deepEqual(result, { pending: true });
});

test("a registered source records file facts without returning an estimate before metadata is ready", async () => {
  const reply = { status: 200, code(status) { this.status = status; return this; }, send: value => value };
  const calls = [];
  const result = await handleApiSourceStatsGet({ params: { sourceKey: "source" },
    query: { fileIndex: "0", consumer: "viewer", generation: "3", fileName: "Film.mkv", fileLength: "800",
      linkMbps: "18.5", linkSampleAgeMs: "120" } }, reply, {
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "unused" }) },
    torrentPool: { knownTorrent: () => null },
    viewerRequests: { noteWaitFileSnapshot: input => calls.push(input) }
  });

  assert.equal(reply.status, 202);
  assert.deepEqual(calls[0], { consumerId: "viewer", generation: 3, sourceKey: "source", fileIndex: 0,
    fileName: "Film.mkv", fileLength: 800, linkMbps: 18.5, linkSampleAgeMs: 120 });
  assert.equal(result.pending, true);
  assert.equal(Object.hasOwn(result, "waitEstimate"), false);
});

test("a pending torrent statistics answer keeps file facts without making an estimate", async () => {
  const reply = { status: 200, code(status) { this.status = status; return this; }, send: value => value };
  let sourceEstimateCalls = 0;
  const fileEstimateCalls = [];
  const result = await handleApiSourceStatsGet({ params: { sourceKey: "source" },
    query: { fileIndex: "0", consumer: "viewer", generation: "3", fileName: "Film.mkv", fileLength: "800",
      linkMbps: "18.5", linkSampleAgeMs: "120" } }, reply, {
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "unused" }) },
    torrentPool: { knownTorrent: () => ({}), getFileStats: async () => ({ pending: true }) },
    viewerRequests: {
      noteWaitFileSnapshot: input => fileEstimateCalls.push(input),
      noteWaitSourceSnapshot: () => { sourceEstimateCalls += 1; }
    }
  });

  assert.equal(reply.status, 202);
  assert.deepEqual(fileEstimateCalls[0], { consumerId: "viewer", generation: 3, sourceKey: "source", fileIndex: 0,
    fileName: "Film.mkv", fileLength: 800, linkMbps: 18.5, linkSampleAgeMs: 120 });
  assert.equal(sourceEstimateCalls, 0);
  assert.equal(Object.hasOwn(result, "waitEstimate"), false);
});

test("source statistics record viewer facts only for a stated generation", async () => {
  const reply = { status: 200, code(status) { this.status = status; return this; }, send: value => value };
  const calls = [];
  const torrent = { infoHash: "hash", files: [{ length: 10 }], uploadSpeed: 0, uploaded: 0, done: true };
  const stats = { downloadSpeed: 20, fileProgress: 0.5, fileLength: 10, fileDownloaded: 5,
    headerBytes: 4, headerDownloadedBytes: 2, numPeers: 1 };
  const result = await handleApiSourceStatsGet({ params: { sourceKey: "source" },
    query: { fileIndex: "0", consumer: "viewer", generation: "3", linkMbps: "18.5", linkSampleAgeMs: "120" } }, reply, {
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "unused" }) },
    torrentPool: { knownTorrent: () => torrent, getFileStats: async () => {
      const startedAt = performance.now();
      Object.assign(stats, { sourceCapture: { owner: "torrent-worker", clock: "performance",
        clockEpoch: performance.timeOrigin, startedAt, completedAt: performance.now(), revision: 1,
        validity: "valid", unknownReason: null } });
      return stats;
    } },
    viewerRequests: { noteWaitSourceSnapshot: input => calls.push(input) }
  });

  assert.deepEqual(calls[0], { consumerId: "viewer", generation: 3, sourceKey: "source", fileIndex: 0,
    fileName: "", fileLength: null, stats, linkMbps: 18.5, linkSampleAgeMs: 120 });
  assert.equal(Object.hasOwn(result, "waitEstimate"), false);
  assert.equal(result.downloadSpeed, 20);
  const timing = result.sourceSnapshotTransport;
  assert.equal(timing.clockEpoch, performance.timeOrigin);
  assert.equal(timing.snapshotClockEpoch, performance.timeOrigin);
  assert.ok(Number.isFinite(timing.requestReceivedAtProxyMs));
  assert.ok(Number.isFinite(timing.snapshotStartedAtProxyMs));
  assert.ok(Number.isFinite(timing.snapshotCompletedAtProxyMs));
  assert.ok(Number.isFinite(timing.responsePreparedAtProxyMs));
  assert.ok(timing.requestReceivedAtProxyMs <= timing.snapshotStartedAtProxyMs);
  assert.ok(timing.snapshotStartedAtProxyMs <= timing.snapshotCompletedAtProxyMs);
  assert.ok(timing.snapshotCompletedAtProxyMs <= timing.responsePreparedAtProxyMs);
});

test("malformed viewer generations cannot record wait facts", async () => {
  const reply = { status: 200, code(status) { this.status = status; return this; }, send: value => value };
  let called = false;
  const result = await handleApiSourceStatsGet({ params: { sourceKey: "source" },
    query: { fileIndex: "0", consumer: "viewer", generation: "3.5" } }, reply, {
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "unused" }) },
    torrentPool: { knownTorrent: () => ({ infoHash: "hash", files: [{ length: 10 }], uploadSpeed: 0, uploaded: 0, done: true }),
      getFileStats: async () => ({ downloadSpeed: 20, fileProgress: 0.5, fileLength: 10, fileDownloaded: 5,
        headerBytes: 4, headerDownloadedBytes: 2, numPeers: 1 }) },
    viewerRequests: { noteWaitSourceSnapshot: () => { called = true; } }
  });

  assert.equal(called, false);
  assert.equal(Object.hasOwn(result, "waitEstimate"), false);
});

test("late source statistics cannot attach an old viewing's link sample to a reused viewer id", async () => {
  let resolveStats;
  let statsStarted;
  const started = new Promise(resolve => { statsStarted = resolve; });
  const statsWait = new Promise(resolve => { resolveStats = resolve; });
  const viewers = new Viewers();
  const original = viewers.selectsFile("reused", "old-source", 0);
  original.report({ linkMbps: 99, linkSampleMbps: 99, linkSampleAgeMs: 0 });
  const playbackState = new ViewerPlaybackState();
  const viewerRequests = new ViewerRequests({ viewers, viewerPlaybackState: playbackState });
  const reply = { status: 200, code(status) { this.status = status; return this; }, send(value) { return value; } };
  const request = handleApiSourceStatsGet({ params: { sourceKey: "old-source" },
    query: { fileIndex: "0", consumer: "reused", generation: "0", fileName: "Old.mkv", fileLength: "100",
      linkMbps: "99", linkSampleAgeMs: "0" } }, reply, {
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "unused" }) },
    torrentPool: {
      knownTorrent: () => ({ infoHash: "hash", files: [{ length: 100 }], uploadSpeed: 0, uploaded: 0, done: true }),
      getFileStats: () => { statsStarted(); return statsWait; }
    },
    viewerRequests
  });
  await started;

  viewers.hasGone("reused");
  const replacement = viewers.selectsFile("reused", "new-source", 1);
  replacement.report({ linkMbps: 3, linkSampleMbps: 3, linkSampleAgeMs: 0 });
  resolveStats({ downloadSpeed: 200, fileProgress: 0.5, fileLength: 100, fileDownloaded: 50,
    headerBytes: 4, headerDownloadedBytes: 2, numPeers: 1 });
  await request;

  assert.equal(playbackState.waitCount(replacement), 0);
  assert.equal(playbackState.viewerCount(), 0);
});
