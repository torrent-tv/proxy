import assert from "node:assert/strict";
import test from "node:test";

import { logger } from "../../utils/logger.js";
import { ViewerRequests } from "../../services/server/ViewerRequests.js";

test("partial source and start-gate facts do not become a first-frame ETA", () => {
  const lines = [];
  const observations = [];
  const originalInfo = logger.info;
  logger.info = message => lines.push(message);
  const requests = new ViewerRequests({
    viewers: { get: () => ({ linkReading: () => ({ linkMbps: 32 }) }) },
    observeWait: (...values) => observations.push(values)
  });
  try {
    const early = requests.noteWaitFileSnapshot({ consumerId: "viewer", generation: 2,
      sourceKey: "torrent:hash", fileIndex: 4, fileName: "Film.mkv", fileLength: 4_000_000,
      linkMbps: 24, linkSampleAgeMs: 130 });
    const current = requests.noteWaitSourceSnapshot({ consumerId: "viewer", generation: 2,
      sourceKey: "torrent:hash", fileIndex: 4, fileName: "Film.mkv",
      stats: { fileLength: 4_000_000, downloadSpeed: 1_200_000, headerBytes: 600,
        headerDownloadedBytes: 100, connectedPeers: 8, fileAvailable: false },
      processing: { firstRequiredSegmentsSeconds: 0, startGateSeconds: 43_200 } });

    assert.equal(early, undefined);
    assert.equal(current, undefined);
    assert.deepEqual(lines, [], "partial facts do not emit a numerical forecast");
    assert.deepEqual(observations, [], "partial facts do not emit a forecast event");
  } finally {
    logger.info = originalInfo;
  }
});

test("first-frame outcomes remain evaluation observations, not forecast inputs", () => {
  const noted = [];
  const requests = new ViewerRequests({
    viewers: { get: () => ({ linkReading: () => ({ linkMbps: 32 }) }) },
    noteFirstFrame: value => noted.push(value)
  });
  requests.noteWaitFileSnapshot({ consumerId: "viewer", generation: 2, sourceKey: "torrent:hash",
    fileIndex: 4, fileName: "Film.mkv", fileLength: 4_000_000, linkMbps: 20, linkSampleAgeMs: 80 });
  requests.noteWaitSourceSnapshot({ consumerId: "viewer", generation: 2, sourceKey: "torrent:hash",
    fileIndex: 4, fileName: "Film.mkv",
    stats: { downloadSpeed: 100, fileLength: 4_000_000, connectedPeers: 4 } });

  requests.noteFirstFrameObservation({ consumerId: "viewer", generation: 2, waitId: "torrent:hash:4:2",
    wait: 4, elapsedMs: 10_000 });

  assert.equal(noted.length, 1);
  assert.equal(noted[0].seconds, 10);
  assert.equal(noted[0].features.downloadSpeed, null,
    "the initial file-list snapshot stays separate from later source measurements");
  assert.equal(noted[0].featureSnapshots.length, 1);
  assert.equal(noted[0].featureSnapshots[0].downloadSpeed, 100);
  assert.equal(noted[0].features.linkMbps, 20);
});

test("a seek starts a new evaluation group before the next source snapshot", () => {
  const noted = [];
  const file = { sourceKey: "source", fileIndex: 2, name: "Film.avi", length: 800 };
  const viewer = {
    outputs: new Set(),
    assignments: { statedGeneration: () => {} },
    moveTo: () => {}
  };
  const requests = new ViewerRequests({
    viewers: { get: () => viewer, join: () => viewer },
    outputs: { get: id => id === "session" ? { file } : null, touch() {} },
    invalidateWaits() {}, planEncodersSoon() {},
    noteFirstFrame: value => noted.push(value)
  });

  assert.equal(requests.requestSeek("session", 120, "viewer", 3), true);
  assert.equal(requests.noteWaitSourceSnapshot({ consumerId: "viewer", generation: 3,
    sourceKey: "source", fileIndex: 2, fileName: "Film.avi",
    stats: { fileLength: 800, downloadSpeed: 100, fileAvailable: true },
    processing: { firstRequiredSegmentsSeconds: 9 } }), undefined);
  requests.noteFirstFrameObservation({ consumerId: "viewer", generation: 3, waitId: "source:2:3",
    wait: 0, elapsedMs: 4_000 });

  assert.equal(noted.length, 1);
  assert.equal(noted[0].seconds, 4);
  assert.equal(noted[0].features.downloadSpeed, null,
    "the initial seek snapshot stays separate from later source measurements");
  assert.equal(noted[0].featureSnapshots[0].downloadSpeed, 100);
});

test("an outcome from another generation cannot enter the current observation group", () => {
  let noted = false;
  const requests = new ViewerRequests({
    viewers: { get: () => null },
    noteFirstFrame: () => { noted = true; }
  });
  requests.noteWaitSourceSnapshot({ consumerId: "viewer", generation: 3, sourceKey: "source", fileIndex: 0,
    stats: {} });
  requests.noteFirstFrameObservation({ consumerId: "viewer", generation: 2, waitId: "source:0:2",
    wait: 0, elapsedMs: 1_000 });
  assert.equal(noted, false);
});
