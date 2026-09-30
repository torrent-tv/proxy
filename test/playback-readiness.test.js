import assert from "node:assert/strict";
import test from "node:test";
import { predictPlaybackReadiness, RateTrend, forecastRate } from "../services/server/playback-readiness.js";

function input(overrides = {}) {
  const now = 10_000;
  return {
    now,
    positionSeconds: 0,
    durationSeconds: 8,
    bufferedAheadSeconds: 0,
    bufferLimitSeconds: 8,
    reserveSeconds: 4,
    lookaheadSeconds: 8,
    sources: [{ id: "source", complete: true, bytesPerMediaSecond: 1, readings: [] }],
    tracks: [{
      id: "video",
      sourceIds: ["source"],
      processedSeconds: 4,
      bitsPerMediaSecond: 80,
      readings: [{ at: now - 1_000, value: 2 }, { at: now, value: 2 }],
      segments: [
        { index: 0, startSeconds: 0, endSeconds: 4 },
        { index: 1, startSeconds: 4, endSeconds: 8 }
      ],
      readySegmentIndices: [0],
      segmentSizesBytes: new Map([[0, 40]])
    }],
    linkReadings: [{ at: now - 1_000, value: 320 }, { at: now, value: 320 }],
    ...overrides
  };
}

test("finds the first safe start from segments delivered before playback", () => {
  const forecast = predictPlaybackReadiness(input());

  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "minimum-safe-delay");
  assert.ok(Math.abs(forecast.delaySeconds - 1) < 1e-8);
});

test("keeps source-stall reserve in the proxy's prepared timeline, not the capped browser buffer", () => {
  const now = 10_000;
  const forecast = predictPlaybackReadiness({
    now,
    positionSeconds: 0,
    durationSeconds: 12,
    bufferedAheadSeconds: 2,
    bufferLimitSeconds: 4,
    reserveSeconds: 6,
    lookaheadSeconds: 12,
    sources: [{
      id: "source",
      complete: false,
      bytesPerMediaSecond: 1,
      readings: [{ at: now - 1_000, value: 2 }, { at: now, value: 2 }]
    }],
    tracks: [{
      id: "video",
      sourceIds: ["source"],
      processedSeconds: 8,
      bitsPerMediaSecond: 80,
      readings: [{ at: now - 1_000, value: 2 }, { at: now, value: 2 }],
      segments: [
        { index: 0, startSeconds: 0, endSeconds: 2 },
        { index: 1, startSeconds: 2, endSeconds: 4 },
        { index: 2, startSeconds: 4, endSeconds: 6 },
        { index: 3, startSeconds: 6, endSeconds: 8 },
        { index: 4, startSeconds: 8, endSeconds: 10 },
        { index: 5, startSeconds: 10, endSeconds: 12 }
      ],
      readySegmentIndices: [0, 1, 2, 3],
      segmentSizesBytes: new Map([[0, 20], [1, 20], [2, 20], [3, 20], [4, 20], [5, 20]])
    }],
    linkReadings: [{ at: now - 1_000, value: 80_000 }, { at: now, value: 80_000 }]
  });

  assert.equal(forecast.ready, true);
  assert.equal(forecast.reason, "trajectory-safe-now");
  assert.equal(forecast.reserveSeconds, 6);
  assert.equal(forecast.bufferedSeconds, 2);
  assert.equal(forecast.preparedSegments, 4);
});

test("overlaps source reads and encoding, then waits for the slower stage and delivery", () => {
  const source = {
    id: "source",
    complete: false,
    bytesPerMediaSecond: 1,
    readings: [{ at: 9_000, value: 2 }, { at: 10_000, value: 2 }]
  };
  const track = {
    ...input().tracks[0],
    readings: [{ at: 9_000, value: 10 }, { at: 10_000, value: 10 }]
  };
  const forecast = predictPlaybackReadiness(input({ sources: [source], tracks: [track] }));

  assert.equal(forecast.ready, false);
  assert.ok(Math.abs(forecast.delaySeconds - 2) < 1e-8);
});

test("does not produce an ETA without a client-link measurement", () => {
  const forecast = predictPlaybackReadiness(input({ linkReadings: [] }));

  assert.equal(forecast.ready, false);
  assert.equal(forecast.delaySeconds, null);
  assert.equal(forecast.reason, "link-rate-unavailable");
});

test("rate forecast does not extrapolate acceleration beyond observed service", () => {
  const trend = new RateTrend();
  trend.add(9_000, 2);
  trend.add(10_000, 4);

  const predicted = forecastRate(trend.snapshot(), 10_000, 2);
  assert.ok(predicted > 3 && predicted < 4);
  assert.ok(forecastRate(trend.snapshot(), 100_000, 2) >= 3);
});

test("uses each track's own segment boundaries and requires continuous coverage on both tracks", () => {
  const common = input();
  const video = common.tracks[0];
  const audio = {
    id: "audio",
    sourceIds: ["source"],
    processedSeconds: 2,
    bitsPerMediaSecond: 80,
    readings: [{ at: 9_000, value: 2 }, { at: 10_000, value: 2 }],
    segments: [
      { index: 7, startSeconds: 0, endSeconds: 2 },
      { index: 8, startSeconds: 2, endSeconds: 4 },
      { index: 9, startSeconds: 4, endSeconds: 8 }
    ],
    readySegmentIndices: [7],
    segmentSizesBytes: new Map([[7, 20], [8, 20], [9, 40]])
  };
  video.segmentSizesBytes.set(1, 40);
  const forecast = predictPlaybackReadiness({
    ...common,
    requiredAudio: true,
    tracks: [video, audio]
  });

  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "minimum-safe-delay");
  assert.ok(forecast.delaySeconds > 0);
  assert.equal(forecast.preparedSegments, 2);
});

test("does not start when only one required track has continuous coverage", () => {
  const common = input();
  const audio = {
    id: "audio",
    sourceIds: ["source"],
    processedSeconds: 0,
    bitsPerMediaSecond: 80,
    readings: [{ at: 9_000, value: 2 }, { at: 10_000, value: 2 }],
    segments: [
      { index: 4, startSeconds: 0, endSeconds: 2 },
      { index: 5, startSeconds: 3, endSeconds: 8 }
    ],
    readySegmentIndices: [4, 5],
    segmentSizesBytes: new Map([[4, 20], [5, 50]])
  };
  const forecast = predictPlaybackReadiness({
    ...common,
    requiredAudio: true,
    tracks: [common.tracks[0], audio]
  });

  assert.equal(forecast.ready, false);
  assert.equal(forecast.delaySeconds, null);
  assert.equal(forecast.reason, "no-safe-start-found");
});

test("downloads an overlapping source interval once when two tracks use the same file", () => {
  const now = 10_000;
  const readings = [{ at: now - 1_000, value: 10 }, { at: now, value: 10 }];
  const tracks = [
    {
      id: "video",
      sourceIds: ["shared"],
      processedSeconds: 2,
      bitsPerMediaSecond: 80,
      readings,
      segments: [
        { index: 0, startSeconds: 0, endSeconds: 2 },
        { index: 1, startSeconds: 2, endSeconds: 4 }
      ],
      readySegmentIndices: [0],
      segmentSizesBytes: new Map([[0, 20], [1, 20]])
    },
    {
      id: "audio",
      sourceIds: ["shared"],
      processedSeconds: 0,
      bitsPerMediaSecond: 80,
      readings,
      segments: [{ index: 11, startSeconds: 0, endSeconds: 4 }],
      readySegmentIndices: [],
      segmentSizesBytes: new Map([[11, 40]])
    }
  ];
  const forecast = predictPlaybackReadiness({
    now,
    positionSeconds: 0,
    durationSeconds: 4,
    bufferedAheadSeconds: 0,
    bufferLimitSeconds: 4,
    reserveSeconds: 4,
    lookaheadSeconds: 4,
    requiredAudio: true,
    sources: [{
      id: "shared",
      complete: false,
      bytesPerMediaSecond: 1,
      readings: [{ at: now - 1_000, value: 2 }, { at: now, value: 2 }]
    }],
    tracks,
    linkReadings: [{ at: now - 1_000, value: 10_000 }, { at: now, value: 10_000 }]
  });

  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "minimum-safe-delay");
  assert.ok(Math.abs(forecast.delaySeconds - 2.032) < 1e-8);
});

test("downloads sources on separate torrents concurrently", () => {
  const now = 10_000;
  const readings = [{ at: now - 1_000, value: 10 }, { at: now, value: 10 }];
  const tracks = [
    {
      id: "video",
      sourceIds: ["video-source"],
      processedSeconds: 0,
      bitsPerMediaSecond: 80,
      readings,
      segments: [{ index: 0, startSeconds: 0, endSeconds: 4 }],
      readySegmentIndices: [],
      segmentSizesBytes: new Map([[0, 40]])
    },
    {
      id: "audio",
      sourceIds: ["audio-source"],
      processedSeconds: 0,
      bitsPerMediaSecond: 80,
      readings,
      segments: [{ index: 7, startSeconds: 0, endSeconds: 4 }],
      readySegmentIndices: [],
      segmentSizesBytes: new Map([[7, 40]])
    }
  ];
  const sourceReadings = [{ at: now - 1_000, value: 2 }, { at: now, value: 2 }];
  const forecast = predictPlaybackReadiness({
    now,
    positionSeconds: 0,
    durationSeconds: 4,
    bufferedAheadSeconds: 0,
    bufferLimitSeconds: 4,
    reserveSeconds: 4,
    lookaheadSeconds: 4,
    requiredAudio: true,
    sources: [
      { id: "video-source", complete: false, bytesPerMediaSecond: 1, readings: sourceReadings },
      { id: "audio-source", complete: false, bytesPerMediaSecond: 1, readings: sourceReadings }
    ],
    tracks,
    linkReadings: [{ at: now - 1_000, value: 10_000 }, { at: now, value: 10_000 }]
  });

  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "minimum-safe-delay");
  assert.ok(Math.abs(forecast.delaySeconds - 2.064) < 1e-8);
});

test("shares one torrent download rate across distinct video and audio files", () => {
  const now = 10_000;
  const readings = [{ at: now - 1_000, value: 10 }, { at: now, value: 10 }];
  const sourceReadings = [{ at: now - 1_000, value: 2 }, { at: now, value: 2 }];
  const tracks = [
    {
      id: "video",
      sourceIds: ["torrent:video-file"],
      processedSeconds: 0,
      bitsPerMediaSecond: 80,
      readings,
      segments: [{ index: 0, startSeconds: 0, endSeconds: 4 }],
      readySegmentIndices: [],
      segmentSizesBytes: new Map([[0, 40]])
    },
    {
      id: "audio",
      sourceIds: ["torrent:audio-file"],
      processedSeconds: 0,
      bitsPerMediaSecond: 80,
      readings,
      segments: [{ index: 7, startSeconds: 0, endSeconds: 4 }],
      readySegmentIndices: [],
      segmentSizesBytes: new Map([[7, 40]])
    }
  ];
  const forecast = predictPlaybackReadiness({
    now,
    positionSeconds: 0,
    durationSeconds: 4,
    bufferedAheadSeconds: 0,
    bufferLimitSeconds: 4,
    reserveSeconds: 4,
    lookaheadSeconds: 4,
    requiredAudio: true,
    sources: [
      {
        id: "torrent:video-file",
        serviceId: "torrent",
        complete: false,
        bytesPerMediaSecond: 1,
        readings: sourceReadings
      },
      {
        id: "torrent:audio-file",
        serviceId: "torrent",
        complete: false,
        bytesPerMediaSecond: 1,
        readings: sourceReadings
      }
    ],
    tracks,
    linkReadings: [{ at: now - 1_000, value: 10_000 }, { at: now, value: 10_000 }]
  });

  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "minimum-safe-delay");
  assert.ok(Math.abs(forecast.delaySeconds - 4.032) < 1e-8);
});

test("does not invent future encode acceleration to start an unsustainable output", () => {
  const now = 1_000;
  const forecast = predictPlaybackReadiness({
    now,
    positionSeconds: 0,
    durationSeconds: 8,
    bufferedAheadSeconds: 4,
    bufferLimitSeconds: 8,
    reserveSeconds: 1,
    lookaheadSeconds: 4,
    sources: [{ id: "source", complete: true, bytesPerMediaSecond: 1, readings: [] }],
    tracks: [{
      id: "video",
      sourceIds: ["source"],
      processedSeconds: 4,
      bitsPerMediaSecond: 2,
      readings: [{ at: 0, value: 0.1 }, { at: now, value: 0.15 }],
      segments: [
        { index: 0, startSeconds: 0, endSeconds: 4 },
        { index: 1, startSeconds: 4, endSeconds: 6 },
        { index: 2, startSeconds: 6, endSeconds: 8 }
      ],
      readySegmentIndices: [0],
      segmentSizesBytes: new Map([[0, 1], [1, 1], [2, 1]])
    }],
    linkReadings: [{ at: 0, value: 105.3 }, { at: now, value: 100 }]
  });

  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "no-safe-start-found");
  assert.equal(forecast.delaySeconds, null);
});

test("a faster old probe cannot turn positive delivery into a permanent zero rate", () => {
  const trend = new RateTrend(120);
  trend.add(0, 112_400_000);
  trend.add(66_757, 37_640_000);
  assert.equal(forecastRate(trend.snapshot(), 20 * 60_000, 1443.97), 37_640_000);
  assert.equal(trend.add(66_757, 37_640_000), false);
});

test("the measurement window retains one boundary sample and discards older history", () => {
  const trend = new RateTrend(2);
  trend.add(0, 100);
  trend.add(1_000, 40);
  trend.add(4_000, 20);
  assert.equal(trend.snapshot().count, 2);
  assert.equal(trend.snapshot().meanValue, 30);
});

function preparedEpisode(bufferLimitSeconds, linkReadings) {
  const durationSeconds = 1443.97;
  const boundaries = [0, 10.01, 18.977, 29.488];
  for (let index = 4; index <= 197; index += 1) {
    boundaries.push(29.488 + (durationSeconds - 29.488) * (index - 3) / 194);
  }
  const segments = boundaries.slice(0, -1).map((startSeconds, index) => ({
    index, startSeconds, endSeconds: boundaries[index + 1]
  }));
  const tracks = [9_257_176.8, 189_000].map((bitsPerMediaSecond, index) => ({
    id: String(index),
    sourceIds: ["source"],
    processedSeconds: 1437.269,
    bitsPerMediaSecond,
    readings: [],
    segments,
    readySegmentIndices: segments.map(({ index }) => index),
    segmentSizesBytes: new Map(segments.map((segment) => [segment.index,
      (segment.endSeconds - segment.startSeconds) * bitsPerMediaSecond / 8]))
  }));
  return {
    now: 20 * 60_000,
    positionSeconds: 0,
    durationSeconds,
    bufferedAheadSeconds: 19.187,
    bufferLimitSeconds,
    reserveSeconds: 5.674,
    lookaheadSeconds: 120,
    requiredAudio: true,
    sources: [{ id: "source", complete: false, bytesPerMediaSecond: 1, readings: [{ at: 0, value: 0 }] }],
    tracks,
    linkReadings
  };
}

test("starts a prepared episode despite an old declining link measurement", () => {
  const forecast = predictPlaybackReadiness(preparedEpisode(120, [
    { at: 0, value: 112_400_000 }, { at: 66_757, value: 37_640_000 }
  ]));
  assert.equal(forecast.preparedSegments, 394);
  assert.equal(forecast.ready, true);
  assert.equal(forecast.reason, "trajectory-safe-now");
});

test("the measured buffer proves capacity even when the loader reports a smaller target", () => {
  const forecast = predictPlaybackReadiness(preparedEpisode(9.092, [{ at: 0, value: 37_640_000 }]));
  assert.equal(forecast.ready, true);
});

test("a measured source stop is not replaced by hypothetical future recovery", () => {
  const forecast = predictPlaybackReadiness(input({ sources: [{
    id: "source", complete: false, bytesPerMediaSecond: 1,
    readings: [{ at: 9_000, value: 10 }, { at: 10_000, value: 0 }]
  }] }));
  assert.equal(forecast.ready, false);
  assert.equal(forecast.delaySeconds, null);
});
