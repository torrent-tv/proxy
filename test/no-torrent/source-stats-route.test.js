import assert from "node:assert/strict";
import test from "node:test";
import { handleApiSourceStatsGet } from "../../routes/api/sources/stats/get.js";

test("statistics cannot add a source and report missing metadata without waiting", async () => {
  const reply = { status: 200, code(status) { this.status = status; return this; }, send: value => value };
  const result = await handleApiSourceStatsGet({ params: { sourceKey: "source" }, query: {} }, reply, {
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "unused" }) },
    torrentPool: { knownTorrent: () => null, getTorrent: () => { throw new Error("Statistics cannot add a source"); } }
  });
  assert.equal(reply.status, 202);
  assert.deepEqual(result, { pending: true });
});

test("a registered source can return a file estimate before torrent metadata is ready", async () => {
  const reply = { status: 200, code(status) { this.status = status; return this; }, send: value => value };
  const calls = [];
  const result = await handleApiSourceStatsGet({ params: { sourceKey: "source" },
    query: { fileIndex: "0", consumer: "viewer", generation: "3", fileName: "Film.mkv", fileLength: "800",
      linkMbps: "18.5", linkSampleAgeMs: "120", waitElapsedMs: "4250" } }, reply, {
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "unused" }) },
    torrentPool: { knownTorrent: () => null },
    viewerRequests: { waitEstimateForFile: input => { calls.push(input); return {
      version: 1, waitId: "source:0:3", revision: 0, remainingSeconds: 12, ageMs: 0
    }; } }
  });

  assert.equal(reply.status, 202);
  const { waitElapsedMs, ...request } = calls[0];
  assert.deepEqual(request, { consumerId: "viewer", generation: 3, sourceKey: "source", fileIndex: 0,
    fileName: "Film.mkv", fileLength: 800, linkMbps: 18.5, linkSampleAgeMs: 120 });
  assert.ok(waitElapsedMs >= 4250 && waitElapsedMs < 4300);
  assert.equal(result.pending, true);
  assert.equal(result.waitEstimate.remainingSeconds, 12);
});

test("a pending torrent statistics answer keeps the file estimate stable until measurements arrive", async () => {
  const reply = { status: 200, code(status) { this.status = status; return this; }, send: value => value };
  let sourceEstimateCalls = 0;
  const fileEstimateCalls = [];
  const result = await handleApiSourceStatsGet({ params: { sourceKey: "source" },
    query: { fileIndex: "0", consumer: "viewer", generation: "3", fileName: "Film.mkv", fileLength: "800",
      linkMbps: "18.5", linkSampleAgeMs: "120", waitElapsedMs: "4250" } }, reply, {
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "unused" }) },
    torrentPool: { knownTorrent: () => ({}), getFileStats: async () => ({ pending: true }) },
    viewerRequests: {
      waitEstimateForFile: input => { fileEstimateCalls.push(input); return {
        version: 1, waitId: "source:0:3", revision: 0, remainingSeconds: 12, ageMs: 0
      }; },
      waitEstimateForSource: () => { sourceEstimateCalls += 1; return null; }
    }
  });

  assert.equal(reply.status, 202);
  const { waitElapsedMs, ...request } = fileEstimateCalls[0];
  assert.deepEqual(request, { consumerId: "viewer", generation: 3, sourceKey: "source", fileIndex: 0,
    fileName: "Film.mkv", fileLength: 800, linkMbps: 18.5, linkSampleAgeMs: 120 });
  assert.ok(waitElapsedMs >= 4250 && waitElapsedMs < 4300);
  assert.equal(sourceEstimateCalls, 0);
  assert.equal(result.waitEstimate.revision, 0);
});

test("source statistics request an early estimate only for a stated viewer generation", async () => {
  const reply = { status: 200, code(status) { this.status = status; return this; }, send: value => value };
  const calls = [];
  const torrent = { infoHash: "hash", files: [{ length: 10 }], uploadSpeed: 0, uploaded: 0, done: true };
  const stats = { downloadSpeed: 20, fileProgress: 0.5, fileLength: 10, fileDownloaded: 5,
    headerBytes: 4, headerDownloadedBytes: 2, numPeers: 1 };
  const result = await handleApiSourceStatsGet({ params: { sourceKey: "source" },
    query: { fileIndex: "0", consumer: "viewer", generation: "3", linkMbps: "18.5", linkSampleAgeMs: "120",
      waitElapsedMs: "4250" } }, reply, {
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "unused" }) },
    torrentPool: { knownTorrent: () => torrent, getFileStats: async () => stats },
    viewerRequests: { waitEstimateForSource: input => { calls.push(input); return {
      version: 1, waitId: "viewer:3", revision: 1, remainingSeconds: 4, ageMs: 0
    }; } }
  });

  const { waitElapsedMs, ...request } = calls[0];
  assert.deepEqual(request, { consumerId: "viewer", generation: 3, sourceKey: "source", fileIndex: 0,
    fileName: "", fileLength: null, stats, linkMbps: 18.5, linkSampleAgeMs: 120 });
  assert.ok(waitElapsedMs >= 4250 && waitElapsedMs < 4300);
  assert.equal(result.waitEstimate.remainingSeconds, 4);
  assert.equal(result.downloadSpeed, 20);
});

test("malformed viewer generations cannot request another wait estimate", async () => {
  const reply = { status: 200, code(status) { this.status = status; return this; }, send: value => value };
  let called = false;
  const result = await handleApiSourceStatsGet({ params: { sourceKey: "source" },
    query: { fileIndex: "0", consumer: "viewer", generation: "3.5" } }, reply, {
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "unused" }) },
    torrentPool: { knownTorrent: () => ({ infoHash: "hash", files: [{ length: 10 }], uploadSpeed: 0, uploaded: 0, done: true }),
      getFileStats: async () => ({ downloadSpeed: 20, fileProgress: 0.5, fileLength: 10, fileDownloaded: 5,
        headerBytes: 4, headerDownloadedBytes: 2, numPeers: 1 }) },
    viewerRequests: { waitEstimateForSource: () => { called = true; return null; } }
  });

  assert.equal(called, false);
  assert.equal(Object.hasOwn(result, "waitEstimate"), false);
});
