import assert from "node:assert/strict";
import test from "node:test";

import { ViewerRequests } from "../../services/server/ViewerRequests.js";

test("early forecasts retain one wait identity, advance revisions, and learn the measured outcome", () => {
  const noted = [];
  const features = [];
  const viewer = { linkReading: () => ({ linkMbps: 32 }) };
  const requests = new ViewerRequests({
    viewers: { get: id => id === "viewer" ? viewer : null },
    firstFrameSecondsOf: value => { features.push(value); return 14; },
    noteFirstFrame: value => noted.push(value)
  });
  const source = {
    consumerId: "viewer", generation: 2, sourceKey: "torrent:hash", fileIndex: 4,
    fileName: "Film.mkv", linkMbps: 24, linkSampleAgeMs: 130,
    stats: { fileLength: 4_000_000, downloadSpeed: 1_200_000, headerBytes: 600, headerDownloadedBytes: 100,
      connectedPeers: 8 }
  };

  const first = requests.waitEstimateForSource(source);
  const second = requests.waitEstimateForSource(source);
  assert.equal(first.remainingSeconds, 14);
  assert.equal(first.revision, 0);
  assert.equal(second.waitId, first.waitId);
  assert.equal(second.revision, 1);
  assert.deepEqual(features[0], {
    extension: "mkv", fileLength: 4_000_000, downloadSpeed: 1_200_000, linkMbps: 24, linkSampleAgeMs: 130,
    headerRemaining: 500, peers: 8
  });

  requests.noteFirstFrameObservation({ consumerId: "viewer", generation: 2, waitId: first.waitId, wait: 4, elapsedMs: 13_250 });
  assert.equal(noted.length, 1);
  assert.ok(Math.abs(noted[0].seconds - 13.25) < 0.001);
  assert.deepEqual(noted[0].features, features[1]);
  requests.noteFirstFrameObservation({ consumerId: "viewer", generation: 2, waitId: first.waitId, wait: 4, elapsedMs: 13_250 });
  assert.equal(noted.length, 1);
});

test("the file-list estimate is immediately refined by source readings for the same action", () => {
  const requests = new ViewerRequests({
    viewers: { get: () => ({ linkReading: () => ({ linkMbps: 32 }) }) },
    firstFrameSecondsOf: features => features.downloadSpeed ? 9 : 12,
    noteFirstFrame: () => {}
  });
  const early = requests.waitEstimateForFile({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", fileLength: 800, linkMbps: 20, linkSampleAgeMs: 80 });
  const revised = requests.waitEstimateForSource({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", linkMbps: 20, linkSampleAgeMs: 80,
    stats: { downloadSpeed: 100, fileLength: 800, numPeers: 4 } });

  assert.equal(early.waitId, revised.waitId);
  assert.equal(revised.revision, early.revision + 1);
  assert.equal(revised.remainingSeconds, 9);
});

test("a delayed file-list estimate cannot replace newer source readings", () => {
  const requests = new ViewerRequests({
    viewers: { get: () => ({ linkReading: () => ({ linkMbps: 32 }) }) },
    firstFrameSecondsOf: features => features.downloadSpeed ? 9 : 12,
    noteFirstFrame: () => {}
  });
  const source = requests.waitEstimateForSource({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", stats: { downloadSpeed: 100, fileLength: 800, numPeers: 4 } });
  const delayedFileList = requests.waitEstimateForFile({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", fileLength: 800 });

  assert.equal(delayedFileList.revision, source.revision);
  assert.equal(delayedFileList.remainingSeconds, source.remainingSeconds);
});

test("first-frame learning pairs each source snapshot with its remaining wait", () => {
  const noted = [];
  const requests = new ViewerRequests({
    viewers: { get: () => ({ linkReading: () => ({ linkMbps: 32 }) }) },
    firstFrameSecondsOf: () => null,
    noteFirstFrame: value => noted.push(value)
  });
  requests.waitEstimateForFile({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", fileLength: 800, linkMbps: 20, linkSampleAgeMs: 80 });
  requests.waitEstimateForSource({ consumerId: "viewer", generation: 0, sourceKey: "source", fileIndex: 2,
    fileName: "Film.avi", linkMbps: 20, linkSampleAgeMs: 80,
    stats: { downloadSpeed: 100, fileLength: 800, numPeers: 4 } });

  requests.noteFirstFrameObservation({ consumerId: "viewer", generation: 0, waitId: "source:2:0",
    wait: 1, elapsedMs: 10_000 });

  assert.equal(noted.length, 2);
  assert.ok(Math.abs(noted[0].seconds - 10) < 0.001);
  assert.ok(Math.abs(noted[1].seconds - 10) < 0.001);
  assert.equal(noted[0].features.downloadSpeed, null);
  assert.equal(noted[1].features.downloadSpeed, 100);
  assert.equal(noted[0].features.linkMbps, 20);
  assert.equal(noted[1].features.linkSampleAgeMs, 80);
});

test("file-list outcomes keep their own source measurements when several videos are listed", () => {
  const noted = [];
  const requests = new ViewerRequests({
    viewers: { get: () => null },
    firstFrameSecondsOf: () => 14,
    noteFirstFrame: value => noted.push(value)
  });
  const first = requests.waitEstimateForFile({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 1, fileName: "one.mkv", fileLength: 100 });
  requests.waitEstimateForFile({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "two.mkv", fileLength: 200 });

  requests.noteFirstFrameObservation({ consumerId: "viewer", generation: 0, waitId: first.waitId,
    wait: 1, elapsedMs: 10_000 });

  assert.equal(noted.length, 1);
  assert.equal(noted[0].features.fileLength, 100);
});

test("an outcome from another generation cannot train the current wait", () => {
  let noted = false;
  const requests = new ViewerRequests({
    viewers: { get: () => null },
    firstFrameSecondsOf: () => 14,
    noteFirstFrame: () => { noted = true; }
  });
  requests.waitEstimateForSource({ consumerId: "viewer", generation: 3, sourceKey: "source", fileIndex: 0,
    stats: {} });
  requests.noteFirstFrameObservation({ consumerId: "viewer", generation: 2, waitId: "source:0:2", wait: 0, elapsedMs: 1_000 });
  assert.equal(noted, false);
});
