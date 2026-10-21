import assert from "node:assert/strict";
import test from "node:test";

import { logger } from "../../utils/logger.js";
import { CutGrid, OutputSpec, VideoOutput } from "../../services/encode/output/index.js";
import { ViewerRequests } from "../../services/server/ViewerRequests.js";

test("early forecasts retain one wait identity, advance revisions, and learn the measured outcome", () => {
  const noted = [];
  const features = [];
  const processEvents = [];
  const viewer = { linkReading: () => ({ linkMbps: 32 }) };
  const requests = new ViewerRequests({
    viewers: { get: id => id === "viewer" ? viewer : null },
    firstFrameSecondsOf: value => { features.push(value); return 14; },
    observeWait: (sourceKey, event, fields) => processEvents.push({ sourceKey, event, ...fields }),
    noteFirstFrame: value => noted.push(value)
  });
  const source = {
    consumerId: "viewer", generation: 2, sourceKey: "torrent:hash", fileIndex: 4,
    fileName: "Film.mkv", linkMbps: 24, linkSampleAgeMs: 130,
    stats: { fileLength: 4_000_000, downloadSpeed: 1_200_000, headerBytes: 600, headerDownloadedBytes: 100,
      connectedPeers: 8, fileAvailable: false },
    waitElapsedMs: 0
  };

  const first = requests.waitEstimateForSource(source);
  const second = requests.waitEstimateForSource(source);
  assert.equal(first.remainingSeconds, 14);
  assert.equal(first.revision, 0);
  assert.equal(second.waitId, first.waitId);
  assert.equal(second.revision, first.revision, "repeating the same source measurement keeps its revision");
  const changed = requests.waitEstimateForSource({ ...source,
    stats: { ...source.stats, downloadSpeed: 1_300_000 }, waitElapsedMs: 1_000 });
  assert.equal(changed.revision, first.revision + 1);
  assert.equal(changed.remainingSeconds, 13);
  assert.deepEqual(processEvents.map(({ sourceKey, event, process, revision }) => ({ sourceKey, event, process, revision })), [
    { sourceKey: "torrent:hash", event: "process", process: "P15", revision: 0 },
    { sourceKey: "torrent:hash", event: "process", process: "P15", revision: 1 }
  ]);
  assert.deepEqual(features[0], {
    extension: "mkv", fileLength: 4_000_000, downloadSpeed: 1_200_000, linkMbps: 24, linkSampleAgeMs: 130,
    preparedOutputBytes: null, fileAvailable: false, headerRemaining: 500,
    peers: 8,
    videoOperation: null, audioOperation: null, videoSpeedX: null, audioSpeedX: null
  });

  requests.noteFirstFrameObservation({ consumerId: "viewer", generation: 2, waitId: first.waitId, wait: 4, elapsedMs: 13_250 });
  assert.equal(noted.length, 1, "one actual run contributes one training observation");
  assert.ok(Math.abs(noted[0].seconds - 13.25) < 0.001);
  assert.deepEqual(noted[0].features, features[0], "the training inputs are those available when the estimate first appeared");
  assert.deepEqual(noted[0].featureSnapshots, [features[2]],
    "later source inputs refine the same run without counting it a second time");
  requests.noteFirstFrameObservation({ consumerId: "viewer", generation: 2, waitId: first.waitId, wait: 4, elapsedMs: 13_250 });
  assert.equal(noted.length, 1);
});

test("a seek starts a new wait identity before the next readiness estimate", () => {
  const file = { sourceKey: "source", fileIndex: 2, name: "Film.avi", length: 800 };
  const output = { file };
  const viewer = {
    outputs: new Set(),
    assignments: { statedGeneration: generation => { viewer.generation = generation; } },
    moveTo: positionSeconds => { viewer.position = positionSeconds; }
  };
  const requests = new ViewerRequests({
    viewers: { get: () => viewer, join: () => viewer },
    outputs: { get: id => id === "session" ? output : null, touch() {} },
    invalidateWaits() {},
    planEncodersSoon() {}
  });

  assert.equal(requests.requestSeek("session", 120, "viewer", 3), true);
  const estimate = requests.waitEstimateForSource({ consumerId: "viewer", generation: 3,
    sourceKey: "source", fileIndex: 2, fileName: "Film.avi",
    stats: { fileLength: 800, downloadSpeed: 100, fileAvailable: true },
    processing: { firstRequiredSegmentsSeconds: 9 } });

  assert.equal(estimate.waitId, "source:2:3");
  assert.equal(estimate.revision, 1);
  assert.equal(estimate.remainingSeconds, 9);
});

test("early source measurements include unique prepared output bytes for the selected file", () => {
  const features = [];
  const output = { file: { sourceKey: "source", fileIndex: 2 }, outputKey: "output" };
  const requests = new ViewerRequests({
    viewers: { get: () => null },
    outputs: new Map([["session-a", output], ["session-b", { ...output }]]),
    segmentStore: { sizesOf: key => key === "output" ? new Map([[0, 100], [1, 250]]) : new Map() },
    firstFrameSecondsOf: value => { features.push(value); return 12; }
  });

  requests.waitEstimateForSource({ consumerId: "viewer", generation: 0, sourceKey: "source", fileIndex: 2,
    fileName: "Film.avi", stats: { downloadSpeed: 0, fileLength: 800, numPeers: 0 } });

  assert.equal(features[0].preparedOutputBytes, 350);
});

test("a component forecast replaces the historical total when first-segment work is measured", () => {
  let historicalLookupCalled = false;
  const requests = new ViewerRequests({
    viewers: { get: () => null },
    firstFrameSecondsOf: () => { historicalLookupCalled = true; return 41.7321; }
  });

  const estimate = requests.waitEstimateForSource({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", stats: { downloadSpeed: 0, fileLength: 800, fileAvailable: true },
    waitElapsedMs: 500, processing: { firstRequiredSegmentsSeconds: 2 } });

  assert.equal(estimate.remainingSeconds, 2);
  assert.equal(historicalLookupCalled, false);
});

test("early forecast logs each revision once and distinguishes historical stages from current first-required work", () => {
  const lines = [];
  const originalInfo = logger.info;
  logger.info = message => lines.push(message);
  try {
    const requests = new ViewerRequests({
      viewers: { get: () => null },
      firstFrameSecondsOf: () => ({ seconds: 20, stagesMs: { transportMs: 1_000, planMs: 2_000,
        prepareMs: 8_000, prebufferMs: 6_000, presentationMs: 3_000 }, observations: 3 })
    });
    const source = { consumerId: "viewer", generation: 4, sourceKey: "source", fileIndex: 2,
      fileName: "Film.avi", stats: { fileLength: 800, downloadSpeed: 100, numPeers: 2 } };
    const first = requests.waitEstimateForSource({ ...source, waitElapsedMs: 1_000 });
    const repeated = requests.waitEstimateForSource({ ...source, waitElapsedMs: 1_000 });
    const revised = requests.waitEstimateForSource({ ...source, stats: { ...source.stats, downloadSpeed: 200 },
      waitElapsedMs: 2_000 });
    const firstRequiredStages = [{ track: "audio", segment: 7, alreadyBuffered: false,
      sourceArrivalSeconds: 0.4, runAdmissionSeconds: 0.6, runOpenSeconds: 0.2,
      productionStartSeconds: 0.8, productionCompleteSeconds: 1.4, deliveryCompleteSeconds: 1.5,
      appendSeconds: 0.05, completionSeconds: 1.55 }];
    const active = requests.waitEstimateForSource({ ...source, stats: { ...source.stats, downloadSpeed: 200 },
      waitElapsedMs: 3_000, processing: { firstRequiredSegmentsSeconds: 5, firstRequiredStages } });

    assert.equal(first.remainingSeconds, 19);
    assert.equal(repeated.remainingSeconds, first.remainingSeconds);
    assert.equal(revised.remainingSeconds, 18);
    assert.equal(active.remainingSeconds, 5);
    assert.equal(lines.length, 3, "the repeated same revision emits no second log line");
    const forecasts = lines.map(line => JSON.parse(line.slice("early wait forecast ".length)));
    assert.deepEqual(forecasts.map(item => item.revision), [0, 1, 2]);
    assert.deepEqual(forecasts.map(item => item.predicted.basis), ["historical-stages", "historical-stages", "first-required"]);
    assert.equal(forecasts[0].predicted.totalSeconds, 20);
    assert.deepEqual(forecasts[0].predicted.stagesMs,
      { transportMs: 1_000, planMs: 2_000, prepareMs: 8_000, prebufferMs: 6_000, presentationMs: 3_000 });
    assert.equal(forecasts[0].predicted.observations, 3);
    assert.equal(forecasts[2].predicted.firstRequiredSegmentsSeconds, 5);
    assert.equal(forecasts[2].predicted.totalSeconds, 8);
    assert.deepEqual(forecasts[2].predicted.firstRequiredStages, firstRequiredStages,
      "the forecast log preserves ordered same-run stage timestamps");
    assert.equal(forecasts[0].elapsedMs, 1_000);
    assert.equal(forecasts[0].consumer, "viewer");
    assert.equal(forecasts[0].generation, 4);
    assert.equal(forecasts[0].waitId, first.waitId);
    assert.equal(forecasts[0].features.downloadSpeed, 100);
    assert.equal(forecasts[1].features.downloadSpeed, 200);
  } finally {
    logger.info = originalInfo;
  }
});

test("progress without mapped source ranges does not relabel the history prior as a component forecast", () => {
  let historicalLookups = 0;
  const requests = new ViewerRequests({
    viewers: { get: () => null },
    firstFrameSecondsOf: () => { historicalLookups += 1; return 14; }
  });
  const source = { consumerId: "viewer", generation: 0, sourceKey: "source", fileIndex: 2,
    fileName: "Film.avi", stats: { fileLength: 800, downloadSpeed: 100, numPeers: 2 } };

  const initial = requests.waitEstimateForSource({ ...source, waitElapsedMs: 0 });
  const unavailable = requests.waitEstimateForSource({ ...source, waitElapsedMs: 5_000,
    processing: { firstRequiredSegmentsSeconds: null } });
  const measured = requests.waitEstimateForSource({ ...source, waitElapsedMs: 6_000,
    processing: { firstRequiredSegmentsSeconds: 2.5 } });

  assert.equal(initial.remainingSeconds, 14);
  assert.equal(unavailable, null, "progress without source ranges must leave the initial estimate intact");
  assert.equal(measured.remainingSeconds, 2.5);
  assert.equal(historicalLookups, 1, "the progress path must not recompute a historical stage estimate");
});

test("source polls and delayed file lists preserve the component estimate once it exists", () => {
  const requests = new ViewerRequests({
    viewers: { get: () => null },
    firstFrameSecondsOf: () => 52.371
  });
  const source = { consumerId: "viewer", generation: 0, sourceKey: "source", fileIndex: 2,
    fileName: "Film.avi", fileLength: 800, stats: { downloadSpeed: 100, fileLength: 800, numPeers: 4 } };
  requests.waitEstimateForSource({ ...source, waitElapsedMs: 0 });
  const active = requests.waitEstimateForSource({ ...source, waitElapsedMs: 50_000,
    processing: { firstRequiredSegmentsSeconds: 14.2 } });
  const sourcePoll = requests.waitEstimateForSource({ ...source,
    stats: { ...source.stats, downloadSpeed: 200 }, waitElapsedMs: 50_500 });
  const delayedFileList = requests.waitEstimateForFile({ consumerId: "viewer", generation: 0,
    sourceKey: "source", fileIndex: 2, fileName: "Film.avi", fileLength: 800, waitElapsedMs: 50_500 });

  assert.ok(Math.abs(active.remainingSeconds - 14.2) < 0.001);
  assert.ok(Math.abs(sourcePoll.remainingSeconds - 13.7) < 0.001,
    "a source-only poll must count down the latest component forecast, not restore the historical prior");
  assert.equal(sourcePoll.revision, active.revision + 1);
  assert.ok(Math.abs(delayedFileList.remainingSeconds - 13.7) < 0.001,
    "a delayed file-list answer must not replace the active component forecast");
});

test("a changed component forecast advances its revision even when source readings do not change", () => {
  const requests = new ViewerRequests({
    viewers: { get: () => null },
    firstFrameSecondsOf: () => 52.371
  });
  const source = { consumerId: "viewer", generation: 0, sourceKey: "source", fileIndex: 2,
    fileName: "Film.avi", fileLength: 800, stats: { downloadSpeed: 100, fileLength: 800, numPeers: 4 } };
  const first = requests.waitEstimateForSource({ ...source, waitElapsedMs: 50_000,
    processing: { firstRequiredSegmentsSeconds: 14.2 } });
  const revised = requests.waitEstimateForSource({ ...source, waitElapsedMs: 51_000,
    processing: { firstRequiredSegmentsSeconds: 13 } });

  assert.equal(revised.remainingSeconds, 13);
  assert.equal(revised.revision, first.revision + 1);
});

test("early source measurements include prepared output files that are only on disk", () => {
  const features = [];
  const outputKey = new OutputSpec({ sourceKey: "source", segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "uniform", fileIndex: 2 }), video: new VideoOutput({ fileIndex: 2 }) }).toKey();
  const otherFileKey = new OutputSpec({ sourceKey: "source", segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "uniform", fileIndex: 3 }), video: new VideoOutput({ fileIndex: 3 }) }).toKey();
  const requests = new ViewerRequests({
    viewers: { get: () => null },
    outputs: new Map(),
    segmentStore: {
      addresses: () => [outputKey, otherFileKey],
      sizesOf: key => key === outputKey ? new Map([[0, 100], [1, 250]]) : new Map([[0, 800]])
    },
    firstFrameSecondsOf: value => { features.push(value); return 12; }
  });

  requests.waitEstimateForSource({ consumerId: "viewer", generation: 0, sourceKey: "source", fileIndex: 2,
    fileName: "Film.avi", stats: { downloadSpeed: 0, fileLength: 800, fileAvailable: true } });

  assert.equal(features[0].preparedOutputBytes, 350);
});

test("the file-list estimate is immediately refined by source readings for the same action", () => {
  const requests = new ViewerRequests({
    viewers: { get: () => ({ linkReading: () => ({ linkMbps: 32 }) }) },
    firstFrameSecondsOf: features => features.downloadSpeed ? 9 : 12,
    noteFirstFrame: () => {}
  });
  const early = requests.waitEstimateForFile({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", fileLength: 800, linkMbps: 20, linkSampleAgeMs: 80, waitElapsedMs: 0 });
  const revised = requests.waitEstimateForSource({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", linkMbps: 20, linkSampleAgeMs: 80,
    stats: { downloadSpeed: 100, fileLength: 800, numPeers: 4 }, waitElapsedMs: 0 });

  assert.equal(early.waitId, revised.waitId);
  assert.equal(revised.revision, early.revision + 1);
  assert.equal(revised.remainingSeconds, 9);
});

test("source readings preserve the early client-link measurement when a viewer is not registered yet", () => {
  const features = [];
  let viewerAvailable = true;
  const requests = new ViewerRequests({
    viewers: { get: () => viewerAvailable ? { linkReading: () => ({ linkMbps: 32 }) } : null },
    firstFrameSecondsOf: value => { features.push(value); return 12; },
    noteFirstFrame: () => {}
  });
  requests.waitEstimateForFile({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", fileLength: 800, linkMbps: 20, linkSampleAgeMs: 80 });
  viewerAvailable = false;

  requests.waitEstimateForSource({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", stats: { downloadSpeed: 0, fileLength: 800, numPeers: 0 } });

  assert.equal(features.at(-1).linkMbps, 20);
  assert.ok(features.at(-1).linkSampleAgeMs >= 80);
  assert.equal(features.at(-1).downloadSpeed, 0);
  assert.equal(features.at(-1).peers, 0);
});

test("early source readings include the age of the viewer's retained client-link measurement", () => {
  let captured;
  const measuredAt = Date.now() - 250;
  const requests = new ViewerRequests({
    viewers: { get: () => ({ linkReading: () => ({ linkMbps: 32, linkMeasuredAt: measuredAt }) }) },
    firstFrameSecondsOf: value => { captured = value; return 12; }
  });

  requests.waitEstimateForSource({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", stats: { downloadSpeed: 0, fileLength: 800, numPeers: 0 } });

  assert.equal(captured.linkMbps, 32);
  assert.ok(captured.linkSampleAgeMs >= 250);
});

test("a delayed file-list estimate cannot replace newer source readings", () => {
  const requests = new ViewerRequests({
    viewers: { get: () => ({ linkReading: () => ({ linkMbps: 32 }) }) },
    firstFrameSecondsOf: features => features.downloadSpeed ? 9 : 12,
    noteFirstFrame: () => {}
  });
  const source = requests.waitEstimateForSource({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", stats: { downloadSpeed: 100, fileLength: 800, numPeers: 4 }, waitElapsedMs: 0 });
  const delayedFileList = requests.waitEstimateForFile({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", fileLength: 800, waitElapsedMs: 0 });

  assert.equal(delayedFileList.revision, source.revision);
  assert.equal(delayedFileList.remainingSeconds, source.remainingSeconds);
});

test("a delayed file list adds file facts without erasing earlier source readings", () => {
  const forecasts = [];
  const requests = new ViewerRequests({
    viewers: { get: () => null },
    firstFrameSecondsOf: features => { forecasts.push(features); return features.downloadSpeed ? 9 : 12; },
    noteFirstFrame: () => {}
  });
  const source = requests.waitEstimateForSource({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "", fileLength: null,
    stats: { downloadSpeed: 100, fileLength: 800, numPeers: 4 }, waitElapsedMs: 0 });
  const fileList = requests.waitEstimateForFile({ consumerId: "viewer", generation: 0, sourceKey: "source",
    fileIndex: 2, fileName: "Film.avi", fileLength: 800, waitElapsedMs: 0 });

  assert.equal(fileList.waitId, source.waitId);
  assert.equal(fileList.revision, source.revision + 1);
  assert.equal(fileList.remainingSeconds, source.remainingSeconds);
  assert.equal(forecasts.at(-1).extension, "avi");
  assert.equal(forecasts.at(-1).downloadSpeed, 100);
  assert.equal(forecasts.at(-1).peers, 4);
});

test("first-frame learning stores one input snapshot from when the estimate first appeared", () => {
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

  assert.equal(noted.length, 1);
  assert.ok(Math.abs(noted[0].seconds - 10) < 0.001);
  assert.equal(noted[0].features.downloadSpeed, null);
  assert.equal(noted[0].features.preparedOutputBytes, null);
  assert.equal(noted[0].features.linkMbps, 20);
  assert.ok(noted[0].features.linkSampleAgeMs >= 80);
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
  assert.equal(noted[0].features.preparedOutputBytes, null);
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
