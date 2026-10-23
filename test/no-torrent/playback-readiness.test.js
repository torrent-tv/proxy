import assert from "node:assert/strict";
import test from "node:test";
import { predictPlaybackReadiness, RateTrend, forecastRate } from "../../services/viewer/playback-readiness.js";

/** Served ranges in milliseconds, as the format states them for a piece. */
function servedMs(...pairs) {
  return { timescale: 1000n, ranges: pairs.map(([start, end]) => ({ start: BigInt(start), end: BigInt(end), frame: 0n })) };
}

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
        { index: 0, startSeconds: 0, endSeconds: 4, sourceInputs: [{ sourceId: "source", ranges: [{ start: 0, end: 4 }] }] },
        { index: 1, startSeconds: 4, endSeconds: 8, sourceInputs: [{ sourceId: "source", ranges: [{ start: 4, end: 8 }] }] }
      ],
      readySegmentIndices: [0],
      segmentSizesBytes: new Map([[0, 40]])
    }],
    linkReadings: [{ at: now - 1_000, value: 320 }, { at: now, value: 320 }],
    ...overrides
  };
}

test("a later prepared piece places the predicted origin on the same clock", () => {
  const state = input();
  state.tracks[0].segments[1].mediaRanges = servedMs([4042, 8042]);
  state.tracks[0].readySegmentIndices = [1];
  state.tracks[0].clientRanges = [];
  state.tracks[0].segmentSizesBytes = new Map([[1, 40]]);
  const forecast = predictPlaybackReadiness(state);
  assert.equal(forecast.reason, "minimum-safe-delay");
  assert.ok(Number.isFinite(forecast.delaySeconds));
  // Moving a measured piece does not erase a genuine hole between pieces.
  state.tracks[0].segments[0].mediaRanges = servedMs([42, 3000]);
  assert.equal(predictPlaybackReadiness(state).reason, "media-continuity-unavailable");
});

test("finds the first safe start from segments delivered before playback", () => {
  const forecast = predictPlaybackReadiness(input());

  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "minimum-safe-delay");
  assert.ok(Math.abs(forecast.delaySeconds - 1) < 1e-8);
});

test("forecasts the first required segment from source, processing, and client delivery service", () => {
  const forecast = predictPlaybackReadiness(input());

  assert.equal(forecast.firstRequiredSegmentsSeconds, 1);
  assert.deepEqual(forecast.firstRequiredStages, [{
    track: "video",
    segment: 0,
    alreadyBuffered: false,
    sourceArrivalSeconds: 0,
    runAdmissionSeconds: null,
    runOpenSeconds: 0,
    productionStartSeconds: 0,
    productionCompleteSeconds: 0,
    deliveryCompleteSeconds: 1,
    appendSeconds: 0,
    completionSeconds: 1
  }]);
});

test("a delivered first segment does not hide a later delivery gap", () => {
  const state = input();
  state.tracks[0].clientRanges = [{ start: 0, end: 4 }];
  state.tracks[0].readySegmentIndices = [1];
  state.tracks[0].segmentSizesBytes = new Map([[1, 400]]);

  const forecast = predictPlaybackReadiness(state);

  assert.equal(forecast.firstRequiredSegmentsSeconds, 0);
  assert.equal(forecast.ready, false);
  // Segment 1 is 400 bytes: at 320 bit/s it takes 10 s to deliver.
  // The browser already holds 4 s, so playback needs a 10 - 4 = 6 s delay.
  assert.ok(Math.abs(forecast.delaySeconds - 6) < 1e-5, `${forecast.delaySeconds} seconds`);
});

test("an encoder's rate is its pieces over their time, and a swarm's its bytes over the span", () => {
  // A first piece of credits read 6.49x and the next 0.57x (Home Assistant
  // 2026-10-12, torrent-tv/meta#178): the film they make together took the
  // time of both.
  const pieces = [{ at: 1_000, value: 6.49 }, { at: 9_000, value: 0.57 }, { at: 13_000, value: 1.4 }];
  const together = 3 / (1 / 6.49 + 1 / 0.57 + 1 / 1.4);
  assert.ok(Math.abs(forecastRate(pieces, 20_000, 0, "piece") - together) < 1e-9);
  assert.equal(forecastRate(pieces, 20_000), 1.4, "the last reading, where nothing else is asked");
  // 1 MB/s for 8 s, then 5 MB/s for 4 s: 28 MB over 12 s.
  const swarm = [{ at: 0, value: 1 }, { at: 8_000, value: 5 }, { at: 12_000, value: 3 }];
  assert.ok(Math.abs(forecastRate(swarm, 20_000, 0, "time") - 28 / 12) < 1e-9);
});

test("a piece no live run was given starts a run of its own, and pays its open", () => {
  const baseline = predictPlaybackReadiness(input()).delaySeconds;
  const opening = input();
  opening.tracks[0].openSeconds = 3;
  const opened = predictPlaybackReadiness(opening);
  assert.ok(opened.delaySeconds > baseline, `${opened.delaySeconds} against ${baseline}`);
  assert.equal(opened.holdingBy.segment, 1, "the piece behind the open holds the start");
  // The same piece inside a live run's stretch is made by that run: no open.
  const live = input();
  live.tracks[0].openSeconds = 3;
  live.tracks[0].runSpans = [{ start: 0, end: 8 }];
  assert.equal(predictPlaybackReadiness(live).delaySeconds, baseline);
  // And the first start, already charged as startup, is not charged twice.
  const starting = input();
  starting.tracks[0].openSeconds = 3;
  starting.tracks[0].startupRemainingSeconds = 3;
  const started = predictPlaybackReadiness(starting);
  const once = input();
  once.tracks[0].startupRemainingSeconds = 3;
  assert.equal(started.delaySeconds, predictPlaybackReadiness(once).delaySeconds);
});

test("a held start names the piece that holds it, and the difference is the delay", () => {
  // The log could only say that some term was positive while a cold AVI's
  // picture stood for 17 s (Home Assistant 2026-10-12, torrent-tv/meta#178).
  const forecast = predictPlaybackReadiness(input());
  // Piece 0 is made and not yet at the page: 40 bytes at 320 bit/s arrive in
  // 1 s with nothing before them.
  assert.equal(forecast.holdingBy.track, "video");
  assert.equal(forecast.holdingBy.segment, 0);
  assert.equal(forecast.holdingBy.kind, "delivery");
  assert.ok(Math.abs(forecast.holdingBy.atSeconds - forecast.holdingBy.aheadSeconds - forecast.delaySeconds) < 1e-8);
  const ready = input();
  ready.tracks[0].readySegmentIndices = [0, 1];
  ready.tracks[0].segmentSizesBytes = new Map([[0, 40], [1, 40]]);
  ready.bufferedAheadSeconds = 8;
  const started = predictPlaybackReadiness(ready);
  assert.equal(started.ready, true, started.reason);
  assert.ok(!started.holdingBy, "nothing holds a start that may happen");
});

test("startup delay is independent of browser capacity and proxy lookahead", () => {
  for (const bufferLimitSeconds of [undefined, null, 0, 1, 120]) {
    for (const lookaheadSeconds of [undefined, 0, 4, 120]) {
      assert.equal(predictPlaybackReadiness(input({ bufferLimitSeconds, lookaheadSeconds })).delaySeconds, 1);
    }
  }
});

test("missing duration or required audio cannot be reported as fully buffered", () => {
  assert.equal(predictPlaybackReadiness(input({ durationSeconds: 0 })).reason, "incomplete-state");
  assert.equal(predictPlaybackReadiness(input({ requiredAudio: true, bufferedAheadSeconds: 8 })).ready, false);
});

test("held input does not require a second download or a download rate", () => {
  const state = input();
  state.sources[0] = { id: "source", complete: false, bytesPerMediaSecond: 1, readings: [],
    residence: [{ start: 0, end: 8, location: "disk" }] };
  assert.equal(predictPlaybackReadiness(state).delaySeconds, 1);
});

test("exact input addresses use residence without inventing a constant-rate byte position", () => {
  const state = input();
  state.sources[0] = { id: "source", complete: false, bytesPerMediaSecond: 1000, readings: [],
    residence: [{ start: 100, end: 108, location: "disk" }] };
  state.tracks[0].segments[1].sourceInputs = [{ sourceId: "source", ranges: [{ start: 100, end: 108 }] }];
  assert.equal(predictPlaybackReadiness(state).delaySeconds, 1);
});

test("exact missing input is priced by its byte count before segment processing", () => {
  const state = input({ reserveSeconds: 0 });
  state.sources[0] = { id: "source", complete: false, bytesPerMediaSecond: 1000,
    readings: [{ at: state.now, value: 2 }], residence: [{ start: 100, end: 108, location: "missing" }],
    downloadForecast: { ranges: [{ start: 100, end: 108, availableAt: state.now + 4000 }] } };
  state.tracks[0].segments[1].sourceInputs = [{ sourceId: "source", ranges: [{ start: 100, end: 108 }] }];
  // Eight bytes take 4 s, four media seconds take 2 s to encode, transfer 1 s.
  // The second segment begins at 4 s, so its required startup delay is 3 s.
  assert.equal(predictPlaybackReadiness(state).delaySeconds, 3);
});

test("mapped piece arrivals retain other viewers' wait and require the whole piece", () => {
  const state = input({ reserveSeconds: 0 });
  state.tracks[0].readySegmentIndices = [];
  state.sources[0] = { id: "source", complete: false, readings: [], residence: [],
    downloadForecast: { measuredAt: state.now, ranges: [{ start: 0, end: 16384, availableAt: state.now + 2000 }] } };
  const delayed = predictPlaybackReadiness(state);
  assert.equal(delayed.delaySeconds, 5);
  state.sources[0].downloadForecast.ranges[0].availableAt = state.now + 1000;
  assert.equal(predictPlaybackReadiness(state).delaySeconds, 4);
  state.sources[0].downloadForecast.ranges[0].availableAt = null;
  assert.equal(predictPlaybackReadiness(state).reason, "download-rate-unavailable");
});

test("a declared map forecast cannot invent an absent future range from download speed", () => {
  const state = input({ reserveSeconds: 0 });
  state.sources[0] = { id: "source", complete: false, residence: [],
    readings: [{ at: state.now, value: 1e9 }], downloadForecast: { ranges: [] } };
  const result = predictPlaybackReadiness(state);
  assert.equal(result.reason, "download-rate-unavailable");
  assert.deepEqual(result.unavailableSource, { sourceId: "source", segmentIndex: 1,
    range: { start: 4, end: 8 }, missing: [{ start: 4, end: 8 }] });
});

test("unmapped source pieces use the measured torrent download rate in media order", () => {
  const state = input({ reserveSeconds: 0 });
  state.tracks[0].readySegmentIndices = [];
  state.sources[0] = {
    id: "source",
    complete: false,
    fileOffset: 0,
    fileLength: 8,
    pieceLength: 4,
    residence: [],
    downloadForecast: { ranges: [] },
    downloadRateReadings: { count: 1, lastAt: state.now, lastValue: 4, meanValue: 4, spanSeconds: 0 }
  };

  const forecast = predictPlaybackReadiness(state);

  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "minimum-safe-delay");
  assert.equal(forecast.delaySeconds, 4);
});

test("source files from one torrent share its measured download service", () => {
  const state = input({ reserveSeconds: 0 });
  state.bufferedAheadSeconds = 4;
  state.tracks[0].readySegmentIndices = [0];
  state.requiredAudio = true;
  state.tracks[0].sourceIds = ["video-source"];
  state.tracks[0].segments[1].sourceInputs = [
    { sourceId: "video-source", ranges: [{ start: 4, end: 8 }] }
  ];
  const audioTrack = {
    ...state.tracks[0],
    id: "audio",
    sourceIds: ["audio-source"],
    segments: state.tracks[0].segments.map((segment, index) => ({
      ...segment,
      sourceInputs: index === 1 ? [{ sourceId: "audio-source", ranges: [{ start: 0, end: 4 }] }] : []
    }))
  };
  state.tracks.push(audioTrack);
  const readings = { count: 1, lastAt: state.now, lastValue: 1, meanValue: 1, spanSeconds: 0 };
  state.sources = [
    { id: "video-source", serviceKey: "torrent", complete: false, fileOffset: 0,
      fileLength: 8, pieceLength: 4, residence: [], downloadForecast: { ranges: [] },
      downloadRateReadings: readings },
    { id: "audio-source", serviceKey: "torrent", complete: false, fileOffset: 8,
      fileLength: 8, pieceLength: 4, residence: [], downloadForecast: { ranges: [] },
      downloadRateReadings: readings }
  ];

  const forecast = predictPlaybackReadiness(state);

  assert.equal(forecast.reason, "minimum-safe-delay");
  const sharedDelay = forecast.delaySeconds;
  state.sources[1].serviceKey = "another-torrent";
  const separateDelay = predictPlaybackReadiness(state).delaySeconds;
  assert.ok(sharedDelay > separateDelay);
});

test("an unmapped source piece stays unknown without positive measured download service", () => {
  const state = input();
  state.sources[0] = {
    id: "source",
    complete: false,
    fileOffset: 0,
    fileLength: 8,
    pieceLength: 4,
    residence: [],
    downloadForecast: { ranges: [] },
    downloadRateReadings: { count: 1, lastAt: state.now, lastValue: 0, meanValue: 0, spanSeconds: 0 }
  };

  const forecast = predictPlaybackReadiness(state);

  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "service-not-advancing");
  assert.equal(forecast.delaySeconds, null);
  assert.equal(forecast.firstRequiredSegmentsSeconds ?? null, null,
    "an unavailable first required segment has an unknown arrival time, not zero seconds");
});

test("overlapping unordered arrivals preserve the latest required byte and ignore unrelated arrivals", () => {
  const state = input({ reserveSeconds: 0 });
  state.sources[0] = { id: "source", complete: false, residence: [], readings: [],
    downloadForecast: { ranges: [
      { start: 7, end: 8, availableAt: state.now + 3000 },
      { start: 0, end: 6, availableAt: state.now + 1000 },
      { start: 5, end: 7, availableAt: state.now + 2000 },
      { start: 100, end: 200, availableAt: state.now + 90000 }
    ] } };
  assert.equal(predictPlaybackReadiness(state).delaySeconds, 2);
  state.sources[0].downloadForecast.ranges[2].end = 6;
  assert.deepEqual(predictPlaybackReadiness(state).unavailableSource.missing, [{ start: 6, end: 7 }]);
});

test("missing packet addresses cannot be replaced by file-average density even when bytes are held", () => {
  const state = input();
  state.sources[0] = { id: "source", complete: false, bytesPerMediaSecond: 1,
    readings: [{ at: state.now, value: 2 }], residence: [{ start: 0, end: 8, location: "disk" }] };
  delete state.tracks[0].segments[1].sourceInputs;
  const forecast = predictPlaybackReadiness(state);
  assert.equal(forecast.reason, "source-input-ranges-unavailable");
  assert.equal(forecast.delaySeconds, null);
  assert.deepEqual(forecast.unavailableSource, {
    sourceId: "source", trackId: "video", segmentIndex: 1, phase: "near"
  });
});

test("an unmapped tail segment identifies the dependency preventing startup even when its bytes are held", () => {
  const state = input({ lookaheadSeconds: 4, reserveSeconds: 0, bufferedAheadSeconds: 4 });
  state.tracks[0].clientRanges = [{ start: 0, end: 4 }];
  state.sources[0] = { id: "source", complete: false, residence: [{ start: 0, end: 8, location: "disk" }] };
  const segment = state.tracks[0].segments[1];
  const mapped = segment.sourceInputs;
  delete segment.sourceInputs;

  const waiting = predictPlaybackReadiness(state);
  assert.equal(waiting.ready, false);
  assert.equal(waiting.delaySeconds, null);
  assert.equal(waiting.reason, "source-input-ranges-unavailable");
  assert.deepEqual(waiting.unavailableSource, {
    sourceId: "source", trackId: "video", segmentIndex: 1, phase: "tail"
  });

  segment.sourceInputs = mapped;
  assert.equal(predictPlaybackReadiness(state).ready, true,
    "the same held bytes and measured services suffice once their segment dependency is known");
});

test("subtracts progress only inside the actual processing run interval", () => {
  const state = input({ reserveSeconds: 0 });
  state.tracks[0].readySegmentIndices = [];
  state.tracks[0].readings = [{ at: state.now, value: 1 }];
  state.tracks[0].processingRanges = [{ start: 0, end: 3 }];
  assert.equal(predictPlaybackReadiness(state).delaySeconds, 2);
  state.tracks[0].processingRanges = [{ start: 40, end: 50 }];
  assert.equal(predictPlaybackReadiness(state).delaySeconds, 5);
});

test("partial or malformed exact inputs cannot omit a required source", () => {
  for (const sourceInputs of [[], [{ sourceId: "source", ranges: null }],
    [{ sourceId: "source", ranges: [null] }]]) {
    const state = input();
    state.sources[0].complete = false;
    state.tracks[0].segments[1].sourceInputs = sourceInputs;
    assert.equal(predictPlaybackReadiness(state).reason, "source-input-ranges-unavailable");
  }
  const state = input();
  state.sources.push({ id: "audio-source", complete: false, readings: [] });
  state.tracks[0].sourceIds.push("audio-source");
  assert.equal(predictPlaybackReadiness(state).reason, "source-input-ranges-unavailable");
});

test("future cuts follow measured track time without inventing a permanent clock gap", () => {
  const state = input({ bufferedAheadSeconds: 3.9, reserveSeconds: 0 });
  state.tracks[0].clientRanges = [{ start: 0, end: 3.9 }];
  state.tracks[0].segments[0].mediaRanges = servedMs([0, 3900]);
  const forecast = predictPlaybackReadiness(state);
  assert.notEqual(forecast.reason, "no-safe-start-found");
  state.tracks[0].segments[1].mediaRanges = servedMs([4000, 8000]);
  state.tracks[0].readySegmentIndices = [0, 1];
  assert.equal(predictPlaybackReadiness(state).reason, "media-continuity-unavailable");
});

test("a continuity refusal names the track and both edges of the hole", () => {
  // torrent-tv/meta#105: the refusal did not say which track stopped where,
  // so its field occurrences could not be told apart.
  const delivered = input({ bufferedAheadSeconds: 3.9, reserveSeconds: 0 });
  delivered.tracks[0].clientRanges = [{ start: 0, end: 3.9 }];
  delivered.tracks[0].segments[0].mediaRanges = servedMs([0, 3900]);
  delivered.tracks[0].segments[1].mediaRanges = servedMs([4000, 8000]);
  delivered.tracks[0].readySegmentIndices = [0, 1];
  const refused = predictPlaybackReadiness(delivered);
  assert.equal(refused.reason, "media-continuity-unavailable");
  // The page's 3.9 s is read as every time it can denote, 3 µs wider.
  assert.deepEqual(refused.discontinuity,
    { trackId: "video", segmentIndex: 1, contiguousEndSeconds: 3.900003, rangeStartSeconds: 4 });

  const held = input({ bufferedAheadSeconds: 3, reserveSeconds: 0 });
  held.tracks[0].clientRanges = [{ start: 0, end: 3 }, { start: 4, end: 8 }];
  held.tracks[0].segments[0].mediaRanges = servedMs([0, 3000]);
  held.tracks[0].segments[1].mediaRanges = servedMs([4000, 8000]);
  held.tracks[0].readySegmentIndices = [0, 1];
  const stops = predictPlaybackReadiness(held);
  assert.equal(stops.reason, "media-continuity-unavailable");
  assert.deepEqual(stops.discontinuity,
    { trackId: "video", segmentIndex: null, contiguousEndSeconds: 3.000003, rangeStartSeconds: 3.999997,
      trackEndSeconds: 8 });
});

test("a held range is compared with served ticks exactly, not through rounded seconds", () => {
  // 1418768 ticks of 16000 is 88.673 s; as a double the page reports the end
  // of the same media as 88.67299999999999. Measured 2026-10-02: the float
  // comparison called this join a hole.
  const state = input({ durationSeconds: 92.673, reserveSeconds: 0 });
  const piece = (start, end) => ({ timescale: 16000n, ranges: [{ start, end, frame: 672n }] });
  state.tracks[0].clientRanges = [{ start: 0, end: 88.67299999999999 }];
  state.tracks[0].segments = [
    { index: 0, startSeconds: 0, endSeconds: 88.673, mediaRanges: piece(0n, 1418768n) },
    { index: 1, startSeconds: 88.673, endSeconds: 92.673, mediaRanges: piece(1418768n, 1482768n) }
  ];
  state.tracks[0].readySegmentIndices = [0, 1];
  state.tracks[0].segmentSizesBytes = new Map([[0, 40], [1, 40]]);
  const forecast = predictPlaybackReadiness(state);
  assert.notEqual(forecast.reason, "media-continuity-unavailable");
  assert.equal(forecast.preparedSegments, 2);
});

test("a browser range within Chromium's microsecond truncation still holds the piece", () => {
  const state = input({ reserveSeconds: 0 });
  state.tracks[0].segments[0].mediaRanges = servedMs([0, 4000]);
  state.tracks[0].clientRanges = [{ start: 0, end: 4 - 2e-6 }];
  state.tracks[0].readySegmentIndices = [0, 1];
  state.tracks[0].segmentSizesBytes = new Map([[0, 40], [1, 40]]);
  const held = predictPlaybackReadiness(state);
  state.tracks[0].clientRanges = [];
  const absent = predictPlaybackReadiness(state);
  assert.ok(held.delaySeconds < absent.delaySeconds);
});

test("accepts the browser's initial media range when one track starts within its frame slack", () => {
  const state = input({ durationSeconds: 64, bufferedAheadSeconds: 60, requiredAudio: true });
  const segments = Array.from({ length: 16 }, (_, index) => ({
    index,
    startSeconds: index * 4,
    endSeconds: (index + 1) * 4,
    sourceInputs: [{ sourceId: "source", ranges: [{ start: index * 4, end: (index + 1) * 4 }] }]
  }));
  const readySegmentIndices = segments.map(({ index }) => index);
  const segmentSizesBytes = new Map(readySegmentIndices.map((index) => [index, 40]));
  state.tracks[0] = {
    ...state.tracks[0],
    processedSeconds: 64,
    clientRanges: [{ start: 1 / 12, end: 60 }],
    segments,
    readySegmentIndices,
    segmentSizesBytes
  };
  state.tracks.push({
    ...state.tracks[0],
    id: "audio",
    clientRanges: [{ start: 0, end: 60 }]
  });

  const forecast = predictPlaybackReadiness(state);

  assert.equal(forecast.bufferedSeconds, 60);
  assert.equal(forecast.ready, true);
  assert.equal(forecast.reason, "trajectory-safe-now");

  state.tracks[0].clientRanges = [{ start: 0.250001, end: 60 }];
  const outsideSlack = predictPlaybackReadiness(state);
  assert.equal(outsideSlack.bufferedSeconds, 0);
  assert.equal(outsideSlack.ready, false);
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
      downloadForecast: { ranges: [{ start: 8, end: 10, availableAt: now + 1000 }, { start: 10, end: 12, availableAt: now + 2000 }] }
    }],
    tracks: [{
      id: "video",
      sourceIds: ["source"],
      processedSeconds: 8,
      bitsPerMediaSecond: 80,
      readings: [{ at: now - 1_000, value: 2 }, { at: now, value: 2 }],
      segments: [
        { index: 0, startSeconds: 0, endSeconds: 2, sourceInputs: [{ sourceId: "source", ranges: [{ start: 0, end: 2 }] }] },
        { index: 1, startSeconds: 2, endSeconds: 4, sourceInputs: [{ sourceId: "source", ranges: [{ start: 2, end: 4 }] }] },
        { index: 2, startSeconds: 4, endSeconds: 6, sourceInputs: [{ sourceId: "source", ranges: [{ start: 4, end: 6 }] }] },
        { index: 3, startSeconds: 6, endSeconds: 8, sourceInputs: [{ sourceId: "source", ranges: [{ start: 6, end: 8 }] }] },
        { index: 4, startSeconds: 8, endSeconds: 10, sourceInputs: [{ sourceId: "source", ranges: [{ start: 8, end: 10 }] }] },
        { index: 5, startSeconds: 10, endSeconds: 12, sourceInputs: [{ sourceId: "source", ranges: [{ start: 10, end: 12 }] }] }
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

test("finishes source input before encoding the segment and delivering it", () => {
  const source = {
    id: "source",
    complete: false,
    bytesPerMediaSecond: 1,
    downloadForecast: { ranges: [{ start: 4, end: 8, availableAt: 12_000 }] }
  };
  const track = {
    ...input().tracks[0],
    readings: [{ at: 9_000, value: 10 }, { at: 10_000, value: 10 }]
  };
  const forecast = predictPlaybackReadiness(input({ sources: [source], tracks: [track] }));

  assert.equal(forecast.ready, false);
  // Four source seconds take two seconds to download, then 0.4 to encode.
  assert.ok(Math.abs(forecast.delaySeconds - 2.4) < 1e-8);
});

test("does not produce an ETA without a client-link measurement", () => {
  const forecast = predictPlaybackReadiness(input({ linkReadings: [] }));

  assert.equal(forecast.ready, false);
  assert.equal(forecast.delaySeconds, null);
  assert.equal(forecast.firstRequiredSegmentsSeconds ?? null, null);
  assert.equal(forecast.reason, "link-rate-unavailable");
});

test("rate forecast does not extrapolate acceleration beyond observed service", () => {
  const trend = new RateTrend();
  trend.add(9_000, 2);
  trend.add(10_000, 4);

  const predicted = forecastRate(trend.snapshot(), 10_000, 2);
  assert.equal(predicted, 4);
  assert.equal(forecastRate(trend.snapshot(), 100_000, 2), 4);
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

test("overlaps independent track processing and serializes their shared client delivery", () => {
  const common = input();
  const video = { ...common.tracks[0], readySegmentIndices: [],
    readings: [{ at: 9_000, value: 2 }, { at: 10_000, value: 2 }] };
  const audio = { ...common.tracks[0], id: "audio", readySegmentIndices: [],
    readings: [{ at: 9_000, value: 4 }, { at: 10_000, value: 4 }] };
  const forecast = predictPlaybackReadiness({
    ...common,
    sources: [{ id: "source", complete: true, bytesPerMediaSecond: 1, readings: [] }],
    tracks: [video, audio],
    requiredAudio: true,
    linkReadings: [{ at: 9_000, value: 3_200 }, { at: 10_000, value: 3_200 }]
  });

  assert.equal(forecast.firstRequiredSegmentsSeconds, 2.2,
    "video and audio processing overlap; both outputs then share one delivery path");
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
  assert.equal(forecast.reason, "media-continuity-unavailable");
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
        { index: 0, startSeconds: 0, endSeconds: 2, sourceInputs: [{ sourceId: "shared", ranges: [{ start: 0, end: 2 }] }] },
        { index: 1, startSeconds: 2, endSeconds: 4, sourceInputs: [{ sourceId: "shared", ranges: [{ start: 2, end: 4 }] }] }
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
      segments: [{ index: 11, startSeconds: 0, endSeconds: 4, sourceInputs: [{ sourceId: "shared", ranges: [{ start: 0, end: 4 }] }] }],
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
      downloadForecast: { ranges: [{ start: 0, end: 4, availableAt: now + 2000 }] }
    }],
    tracks,
    linkReadings: [{ at: now - 1_000, value: 10_000 }, { at: now, value: 10_000 }]
  });

  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "minimum-safe-delay");
  // The full audio input takes 2 s, encoding takes 0.4 s, delivery 0.032 s.
  assert.ok(Math.abs(forecast.delaySeconds - 2.432) < 1e-8);
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
      segments: [{ index: 0, startSeconds: 0, endSeconds: 4, sourceInputs: [{ sourceId: "video-source", ranges: [{ start: 0, end: 4 }] }] }],
      readySegmentIndices: [],
      segmentSizesBytes: new Map([[0, 40]])
    },
    {
      id: "audio",
      sourceIds: ["audio-source"],
      processedSeconds: 0,
      bitsPerMediaSecond: 80,
      readings,
      segments: [{ index: 7, startSeconds: 0, endSeconds: 4, sourceInputs: [{ sourceId: "audio-source", ranges: [{ start: 0, end: 4 }] }] }],
      readySegmentIndices: [],
      segmentSizesBytes: new Map([[7, 40]])
    }
  ];
  const downloadForecast = { ranges: [{ start: 0, end: 4, availableAt: now + 2000 }] };
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
      { id: "video-source", complete: false, downloadForecast },
      { id: "audio-source", complete: false, downloadForecast }
    ],
    tracks,
    linkReadings: [{ at: now - 1_000, value: 10_000 }, { at: now, value: 10_000 }]
  });

  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "minimum-safe-delay");
  // Both inputs arrive at 2 s, both encode until 2.4 s, two transfers cost 0.064 s.
  assert.ok(Math.abs(forecast.delaySeconds - 2.464) < 1e-8);
});

test("shared torrent scheduling retains distinct video and audio file arrival times", () => {
  const now = 10_000;
  const readings = [{ at: now - 1_000, value: 10 }, { at: now, value: 10 }];
  const tracks = [
    {
      id: "video",
      sourceIds: ["torrent:video-file"],
      processedSeconds: 0,
      bitsPerMediaSecond: 80,
      readings,
      segments: [{ index: 0, startSeconds: 0, endSeconds: 4, sourceInputs: [{ sourceId: "torrent:video-file", ranges: [{ start: 0, end: 4 }] }] }],
      readySegmentIndices: [],
      segmentSizesBytes: new Map([[0, 40]])
    },
    {
      id: "audio",
      sourceIds: ["torrent:audio-file"],
      processedSeconds: 0,
      bitsPerMediaSecond: 80,
      readings,
      segments: [{ index: 7, startSeconds: 0, endSeconds: 4, sourceInputs: [{ sourceId: "torrent:audio-file", ranges: [{ start: 0, end: 4 }] }] }],
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
        downloadForecast: { ranges: [{ start: 0, end: 4, availableAt: now + 2000 }] }
      },
      {
        id: "torrent:audio-file",
        serviceId: "torrent",
        complete: false,
        bytesPerMediaSecond: 1,
        downloadForecast: { ranges: [{ start: 0, end: 4, availableAt: now + 4000 }] }
      }
    ],
    tracks,
    linkReadings: [{ at: now - 1_000, value: 10_000 }, { at: now, value: 10_000 }]
  });

  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "minimum-safe-delay");
  // The shared source service takes 4 s, followed by 0.4 s encode and 0.032 s transfer.
  assert.ok(Math.abs(forecast.delaySeconds - 4.432) < 1e-8);
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
  assert.equal(forecast.reason, "minimum-safe-delay");
  // The two pieces took 1/0.1 + 1/0.15 of their film: no faster than that is assumed.
  const rate = 2 / (1 / 0.1 + 1 / 0.15);
  assert.ok(Math.abs(forecast.delaySeconds - (4 / rate + 8 / 100 - 6)) < 1e-8);
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

test("pieces already played and never read change no answer, so they are not planned again", () => {
  // The forecast runs on every poll of a waiting viewer; converting the whole
  // film before dropping what was played held the proxy's main thread for
  // seconds after a seek back (torrent-tv/meta#178). Dropping them must not
  // move the answer.
  const now = 10_000;
  const segments = Array.from({ length: 60 }, (_, index) => ({
    index, startSeconds: index * 4, endSeconds: (index + 1) * 4,
    sourceInputs: [{ sourceId: "source", ranges: [{ start: index * 4, end: (index + 1) * 4 }] }]
  }));
  const state = (pieces) => ({
    now, positionSeconds: 150, durationSeconds: 240, bufferedAheadSeconds: 2, bufferLimitSeconds: 120,
    reserveSeconds: 4, lookaheadSeconds: 120,
    sources: [{ id: "source", complete: false, fileOffset: 0, fileLength: 240, pieceLength: 8,
      residence: [{ location: "disk", start: 0, end: 160 }],
      downloadRateReadings: [{ at: now - 1_000, value: 2 }, { at: now, value: 2 }] }],
    tracks: [{ id: "video", sourceIds: ["source"], processedSeconds: 152, bitsPerMediaSecond: 80,
      readings: [{ at: now - 1_000, value: 1.5 }, { at: now, value: 1.5 }], segments: pieces,
      readySegmentIndices: [10, 37, 38], segmentSizesBytes: new Map([[10, 50], [37, 40], [38, 40]]) }],
    linkReadings: [{ at: now - 1_000, value: 320 }, { at: now, value: 320 }]
  });
  const everything = predictPlaybackReadiness(state(segments));
  const withoutPlayed = predictPlaybackReadiness(state(segments.filter(({ index, endSeconds }) =>
    index === 0 || index === 10 || endSeconds > 150)));
  assert.equal(everything.reason, "minimum-safe-delay");
  assert.deepEqual(withoutPlayed, everything);
});

test("a track's time geometry kept between polls is the one worked out anew", () => {
  // Gathering every remaining piece's edges for the timescale and placing each
  // on the page's clock on every poll was about 3 s of Home Assistant's main
  // thread in 15 minutes (torrent-tv/meta#178).
  const state = input({ durationSeconds: 12 });
  const [first] = state.tracks[0].segments;
  state.tracks[0].segments = [first,
    { index: 1, startSeconds: 4, endSeconds: 6, sourceInputs: first.sourceInputs },
    { index: 2, startSeconds: 6, endSeconds: 8, sourceInputs: first.sourceInputs },
    { index: 3, startSeconds: 8, endSeconds: 12, sourceInputs: first.sourceInputs, mediaRanges: servedMs([8001, 12001]) }];
  first.mediaRanges = servedMs([42, 4042]);
  state.tracks[0].readySegmentIndices = [0, 3];
  state.tracks[0].segmentSizesBytes = new Map([[0, 40], [3, 40]]);
  state.tracks[0].clientRanges = [{ start: 0, end: 0.5 }];
  const geometry = {};
  const poll = (change) => {
    change?.(state);
    const anew = {};
    const answer = predictPlaybackReadiness({ ...state, tracks: state.tracks.map(track => ({ ...track, geometry })) });
    assert.deepEqual(answer, predictPlaybackReadiness({ ...state, tracks: state.tracks.map(track => ({ ...track, geometry: anew })) }));
    assert.deepEqual(answer, predictPlaybackReadiness(state));
    assert.deepEqual(geometry.placed, anew.placed);
    return geometry.placed;
  };
  const placed = poll();
  assert.equal(poll(), placed, "the same pieces, timescale and clock: the placement is the one kept");
  poll(s => { s.positionSeconds = 0.1; });
  poll(s => { s.tracks[0].clockOffsetSeconds = -0.042; });
  poll(s => { s.tracks[0].clockOffsetSeconds = -0.5; });
  poll(s => { s.tracks[0].clockOffsetSeconds = -0.25; });
  poll(s => { s.tracks[0].segments[3].mediaRanges = servedMs([8003, 12003]); });
  poll(s => { s.tracks[0].segments[2].endSeconds = 7.5; });
  poll(s => { s.tracks[0].segments[3].startSeconds = 7.5; });
  poll(s => { s.tracks[0].segments[1].index = 5; });
  poll(s => { s.bufferedAheadSeconds = 0.30000000000000004; });
});

test("a piece whose inputs are told again keeps its times, and is read with its new inputs", () => {
  // The download map tells a piece's torrent inputs again, and the piece is a
  // new object with the same times: in r37 most polls placed every piece of the
  // film again (torrent-tv/meta#178).
  const state = input({ durationSeconds: 12 });
  const [first] = state.tracks[0].segments;
  first.mediaRanges = servedMs([42, 4042]);
  state.tracks[0].segments = [first,
    { index: 1, startSeconds: 4, endSeconds: 8, sourceInputs: [{ sourceId: "source", ranges: [{ start: 0, end: 4 }] }] },
    { index: 2, startSeconds: 8, endSeconds: 12, sourceInputs: [{ sourceId: "source", ranges: [{ start: 0, end: 4 }] }] }];
  state.tracks[0].clientRanges = [{ start: 0, end: 0.5 }];
  Object.assign(state.sources[0], { complete: false, fileOffset: 0, fileLength: 100, pieceLength: 4,
    residence: [{ location: "memory", start: 0, end: 5 }],
    downloadRateReadings: [{ at: state.now - 1_000, value: 1 }, { at: state.now, value: 1 }] });
  const geometry = {};
  const kept = () => predictPlaybackReadiness({ ...state, tracks: state.tracks.map(track => ({ ...track, geometry })) });
  const before = kept();
  const times = geometry.placed;
  state.tracks[0].segments[2] = { ...state.tracks[0].segments[2], sourceInputs: [{ sourceId: "source", ranges: [{ start: 60, end: 64 }] }] };
  const after = kept();
  assert.equal(geometry.placed, times, "the times are the ones kept");
  assert.notDeepEqual(after, before, "bytes not held yet move the answer");
  assert.deepEqual(after, predictPlaybackReadiness(state));
});

test("a forecast time already past does not make missing bytes held", () => {
  // 2.99.11 read a stale arrival as `max(0, at - now)`: a piece forecast to
  // come, whose peer then stopped, counted as held (torrent-tv/meta#178).
  const now = 10_000;
  const readings = [{ at: now - 1_000, value: 10 }, { at: now, value: 10 }];
  const forecast = predictPlaybackReadiness({
    now,
    positionSeconds: 0,
    durationSeconds: 4,
    bufferedAheadSeconds: 0,
    bufferLimitSeconds: 4,
    reserveSeconds: 4,
    lookaheadSeconds: 4,
    requiredAudio: false,
    sources: [{
      id: "shared",
      complete: false,
      bytesPerMediaSecond: 1,
      downloadForecast: { ranges: [{ start: 0, end: 4, availableAt: now - 1000 }] }
    }],
    tracks: [{
      id: "video",
      sourceIds: ["shared"],
      processedSeconds: 0,
      bitsPerMediaSecond: 80,
      readings,
      segments: [{ index: 0, startSeconds: 0, endSeconds: 4, sourceInputs: [{ sourceId: "shared", ranges: [{ start: 0, end: 4 }] }] }],
      readySegmentIndices: [],
      segmentSizesBytes: new Map([[0, 40]])
    }],
    linkReadings: [{ at: now - 1_000, value: 10_000 }, { at: now, value: 10_000 }]
  });

  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "download-rate-unavailable");
});
