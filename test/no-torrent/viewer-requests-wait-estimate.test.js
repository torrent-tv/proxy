import assert from "node:assert/strict";
import test from "node:test";

import { logger } from "../../utils/logger.js";
import { forecastInputState, sourceFileIndexesForOutput, ViewerRequests } from "../../services/server/ViewerRequests.js";

test("playback operations report every source file and retain the output file as fallback", () => {
  assert.deepEqual(sourceFileIndexesForOutput({
    spec: { sourceFileIndexes: [4, 9] }, file: { fileIndex: 4 }
  }), [4, 9]);
  assert.deepEqual(sourceFileIndexesForOutput({
    spec: { sourceFileIndexes: [] }, file: { fileIndex: 4 }
  }), [4]);
});

test("forecast input diagnostics re-read the exact source ranges when a blocker clears", () => {
  const identity = { sourceId: "source", trackId: "audio", segmentIndex: 197, phase: "tail" };
  const blockedTracks = [{ id: "audio", segments: [{ index: 197, sourceInputs: [] }] }];
  const resolvedTracks = [{ id: "audio", segments: [{ index: 197,
    sourceInputs: [{ sourceId: "source", ranges: [{ start: 400, end: 500 }] }] }] }];

  assert.deepEqual(forecastInputState(blockedTracks, identity), {
    ...identity, trackFound: true, segmentFound: true, sourceInputFound: false,
    rangesKnown: false, rangeCount: null
  });
  assert.deepEqual(forecastInputState(resolvedTracks, identity), {
    ...identity, trackFound: true, segmentFound: true, sourceInputFound: true,
    rangesKnown: true, rangeCount: 1
  });
});

test("waits without a current process forecast stay unestimated and retain their identity", () => {
  const noted = [];
  const processEvents = [];
  const viewer = { linkReading: () => ({ linkMbps: 32 }) };
  const requests = new ViewerRequests({
    viewers: { get: id => id === "viewer" ? viewer : null },
    firstFrameSecondsOf: () => { throw new Error("historical outcomes must not be forecast inputs"); },
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

  const earlyFileList = requests.waitEstimateForFile({ consumerId: "viewer", generation: 2,
    sourceKey: "torrent:hash", fileIndex: 4, fileName: "Film.mkv", fileLength: 4_000_000,
    linkMbps: 24, linkSampleAgeMs: 130, waitElapsedMs: 0 });
  const first = requests.waitEstimateForSource(source);
  const second = requests.waitEstimateForSource(source);
  assert.equal(earlyFileList, null);
  assert.equal(first, null);
  assert.equal(second, null);
  const waitId = "torrent:hash:4:2";

  const changed = requests.waitEstimateForSource({ ...source,
    stats: { ...source.stats, downloadSpeed: 1_300_000 }, waitElapsedMs: 1_000 });
  assert.equal(changed, null);
  assert.deepEqual(processEvents, []);

  requests.noteFirstFrameObservation({ consumerId: "viewer", generation: 2, waitId, wait: 4, elapsedMs: 13_250 });
  assert.equal(noted.length, 1, "one actual run contributes one training observation");
  assert.ok(Math.abs(noted[0].seconds - 13.25) < 0.001);
  assert.equal(noted[0].features.downloadSpeed, null,
    "a file-list snapshot is retained as an observation, not used to forecast the wait");
  requests.noteFirstFrameObservation({ consumerId: "viewer", generation: 2, waitId, wait: 4, elapsedMs: 13_250 });
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

test("only the active process forecast is logged", () => {
  const lines = [];
  const originalInfo = logger.info;
  logger.info = message => lines.push(message);
  try {
    const requests = new ViewerRequests({ viewers: { get: () => null },
      firstFrameSecondsOf: () => { throw new Error("historical outcomes must not be forecast inputs"); } });
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

    assert.equal(first, null);
    assert.equal(repeated, null);
    assert.equal(revised, null);
    assert.equal(active.remainingSeconds, 5);
    assert.equal(lines.length, 1, "only an active mathematical estimate emits a forecast line");
    const forecasts = lines.map(line => JSON.parse(line.slice("early wait forecast ".length)));
    assert.deepEqual(forecasts.map(item => item.predicted.basis), ["first-required"]);
    assert.equal(forecasts[0].predicted.firstRequiredSegmentsSeconds, 5);
    assert.equal(forecasts[0].predicted.totalSeconds, 8);
    assert.deepEqual(forecasts[0].predicted.firstRequiredStages, firstRequiredStages,
      "the forecast log preserves ordered same-run stage timestamps");
    assert.equal(forecasts[0].elapsedMs, 3_000);
    assert.equal(forecasts[0].consumer, "viewer");
    assert.equal(forecasts[0].generation, 4);
  } finally {
    logger.info = originalInfo;
  }
});

test("progress without mapped source ranges does not create a historical forecast", () => {
  let historicalLookups = 0;
  const requests = new ViewerRequests({
    viewers: { get: () => null },
    firstFrameSecondsOf: () => { historicalLookups += 1; throw new Error("must not be called"); }
  });
  const source = { consumerId: "viewer", generation: 0, sourceKey: "source", fileIndex: 2,
    fileName: "Film.avi", stats: { fileLength: 800, downloadSpeed: 100, numPeers: 2 } };

  const initial = requests.waitEstimateForSource({ ...source, waitElapsedMs: 0 });
  const unavailable = requests.waitEstimateForSource({ ...source, waitElapsedMs: 5_000,
    processing: { firstRequiredSegmentsSeconds: null } });
  const measured = requests.waitEstimateForSource({ ...source, waitElapsedMs: 6_000,
    processing: { firstRequiredSegmentsSeconds: 2.5 } });

  assert.equal(initial, null);
  assert.equal(unavailable, null);
  assert.equal(measured.remainingSeconds, 2.5);
  assert.equal(historicalLookups, 0);
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

test("the early forecast runs to the start gate, not to the first required pieces", () => {
  // Home Assistant 2026-10-26 (torrent-tv/meta#239): Despicable Me 3 BDRemux
  // supplied at 0.53x. The first pieces were buffered, so the forecast said
  // zero, while the start forecast held the picture 433 s more; the page had
  // no time to show and read "Playback readiness has not been confirmed".
  const lines = [];
  const restore = logger.info;
  logger.info = line => lines.push(line);
  try {
    const requests = new ViewerRequests({ viewers: { get: () => null }, firstFrameSecondsOf: () => null });
    const source = { consumerId: "viewer", generation: 0, sourceKey: "torrent:hash", fileIndex: 0,
      fileName: "Film.mkv", stats: { fileLength: 43_929_276_423, downloadSpeed: 727_327 }, waitElapsedMs: 252_000 };
    const gated = requests.waitEstimateForSource({ ...source,
      processing: { firstRequiredSegmentsSeconds: 0, startGateSeconds: 433.45 } });
    assert.ok(Math.abs(gated.remainingSeconds - 433.45) < 0.5, `remaining ${gated.remainingSeconds}`);
    assert.match(lines.at(-1), /"basis":"start-gate","firstRequiredSegmentsSeconds":0,"startGateSeconds":433\.45/);

    const open = requests.waitEstimateForSource({ ...source, waitElapsedMs: 253_000,
      processing: { firstRequiredSegmentsSeconds: 2.5 } });
    assert.ok(Math.abs(open.remainingSeconds - 2.5) < 0.5, "once the gate is open, the first pieces decide");
  } finally {
    logger.info = restore;
  }
});
