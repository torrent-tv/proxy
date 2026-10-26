import assert from "node:assert/strict";
import test from "node:test";
import { predictPlaybackReadiness, RateTrend, SessionRate } from "../../services/viewer/playback-readiness.js";

/** A deterministic sequence in [0, 1). */
function randomFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    state = Math.imul(state ^ (state >>> 13), 3266489909) >>> 0;
    return ((state ^ (state >>> 16)) >>> 0) / 4294967296;
  };
}

/** A torrent piece's length: the near window waits for whole pieces, the tail counts bytes. */
const PIECE_BYTES = 262_144;

function summaryOf(value, now) {
  const trend = new RateTrend();
  trend.add(now - 2000, value);
  trend.add(now, value);
  return trend.snapshot();
}

/**
 * A film of evenly cut pieces read from one source in byte order, with held
 * stretches, a played-up-to position, made pieces around it and measured rates.
 */
function film(random, { lookaheadSeconds = 120, tracks: trackCount = 1 + Math.floor(random() * 2),
  bytesPerSecond = 200_000 + random() * 1_000_000 } = {}) {
  const now = 1_000_000;
  const piece = 2 + Math.floor(random() * 6);
  const count = 40 + Math.floor(random() * 300);
  const duration = piece * count;
  const fileLength = Math.round(duration * bytesPerSecond);
  const byteAt = (seconds) => Math.min(fileLength, Math.round(seconds * bytesPerSecond));
  const position = Math.floor(random() * count * 0.6) * piece;
  const residence = [];
  for (let at = 0; at < duration; at += piece * (5 + Math.floor(random() * 40))) {
    if (random() < 0.4) residence.push({ start: byteAt(at), end: byteAt(at + piece * (1 + Math.floor(random() * 20))), location: "memory" });
  }
  const tracks = [];
  for (let index = 0; index < trackCount; index++) {
    const made = new Set();
    for (let place = Math.floor(position / piece); place < Math.floor(position / piece) + 3; place++) {
      if (random() < 0.5) made.add(place);
    }
    tracks.push({
      id: `track-${index}`,
      sourceIds: ["source"],
      processedSeconds: position,
      startupRemainingSeconds: 0,
      openSeconds: random() * 6,
      bitsPerMediaSecond: index === 0 ? 2_000_000 + random() * 6_000_000 : 128_000,
      readings: summaryOf(0.6 + random() * 3, now),
      segments: Array.from({ length: count }, (_, place) => ({
        index: place, startSeconds: place * piece, endSeconds: (place + 1) * piece,
        sourceInputs: [{ sourceId: "source", ranges: [{ start: byteAt(place * piece), end: byteAt((place + 1) * piece) }] }]
      })),
      readySegmentIndices: [...made],
      segmentSizesBytes: new Map([...made].map((place) => [place, Math.round(piece * 250_000)]))
    });
  }
  return {
    piece,
    input: {
      now, positionSeconds: position, durationSeconds: duration, bufferedAheadSeconds: 0, reserveSeconds: random() * 5,
      lookaheadSeconds,
      requiredAudio: trackCount === 2,
      sources: [{ id: "source", complete: false, fileOffset: 0, fileLength, pieceLength: PIECE_BYTES, residence,
        downloadForecast: { ranges: [] }, downloadRateReadings: summaryOf(bytesPerSecond * (0.3 + random() * 2), now) }],
      tracks,
      linkReadings: summaryOf(20_000_000 + random() * 80_000_000, now)
    }
  };
}

test("a piece far ahead with no planned arrival is supplied at the measured rate, not left unknown", () => {
  const { input } = film(randomFrom(7), { tracks: 1 });
  input.sources[0].residence = [];
  const answer = predictPlaybackReadiness(input);
  assert.equal(answer.reason, "minimum-safe-delay");
  assert.ok(Number.isFinite(answer.delaySeconds));
  input.sources[0].downloadRateReadings = summaryOf(0, input.now);
  const stopped = predictPlaybackReadiness(input);
  assert.equal(stopped.reason, "service-not-advancing");
  assert.equal(stopped.delaySeconds, null);
  assert.ok(stopped.unavailableSource, "the answer names the source it waits for");
});

test("the aggregate suffix uses measured source service without tracing its segments", () => {
  const now = 1_000_000;
  const piece = 6, count = 800, duration = piece * count, position = 0;
  const bytesPerSecond = 4_700_000;
  const byteAt = (seconds) => Math.round(seconds * bytesPerSecond);
  const answer = predictPlaybackReadiness({
    now, positionSeconds: position, durationSeconds: duration, bufferedAheadSeconds: 0, reserveSeconds: 0,
    lookaheadSeconds: 120,
    sources: [{ id: "source", complete: false, fileOffset: 0, fileLength: byteAt(duration), pieceLength: PIECE_BYTES,
      residence: [], downloadForecast: { ranges: [] }, downloadRateReadings: summaryOf(bytesPerSecond * 0.99, now) }],
    tracks: [{
      id: "video", sourceIds: ["source"], processedSeconds: 0, startupRemainingSeconds: 0, openSeconds: 0,
      bitsPerMediaSecond: 8_000_000, readings: summaryOf(92, now),
      segments: Array.from({ length: count }, (_, place) => ({
        index: place, startSeconds: place * piece, endSeconds: (place + 1) * piece,
        sourceInputs: [{ sourceId: "source", ranges: [{ start: byteAt(place * piece), end: byteAt((place + 1) * piece) }] }]
      })),
      readySegmentIndices: [], segmentSizesBytes: new Map()
    }],
    linkReadings: summaryOf(1_000_000_000, now)
  });
  assert.equal(answer.reason, "minimum-safe-delay");
  assert.ok(answer.delaySeconds > 0, `${answer.delaySeconds} seconds`);
  assert.ok(answer.delaySeconds < duration, `${answer.delaySeconds} against ${duration}`);
});

test("an exact queue arrival beyond the near window does not replace the aggregate estimate", () => {
  const now = 1_000_000;
  const piece = 6, count = 100, duration = piece * count;
  const bytesPerSecond = 1_000_000;
  const byteAt = (seconds) => Math.round(seconds * bytesPerSecond);
  const input = (ranges, rate) => ({
    now, positionSeconds: 0, durationSeconds: duration, bufferedAheadSeconds: 0, reserveSeconds: 0,
    lookaheadSeconds: 120,
    sources: [{ id: "source", complete: false, fileOffset: 0, fileLength: byteAt(duration), pieceLength: PIECE_BYTES,
      residence: [], downloadForecast: { ranges }, downloadRateReadings: summaryOf(rate, now) }],
    tracks: [{
      id: "video", sourceIds: ["source"], processedSeconds: 0, startupRemainingSeconds: 0, openSeconds: 0,
      bitsPerMediaSecond: 8_000_000, readings: summaryOf(50, now),
      segments: Array.from({ length: count }, (_, place) => ({
        index: place, startSeconds: place * piece, endSeconds: (place + 1) * piece,
        sourceInputs: [{ sourceId: "source", ranges: [{ start: byteAt(place * piece), end: byteAt((place + 1) * piece) }] }]
      })),
      readySegmentIndices: [], segmentSizesBytes: new Map()
    }],
    linkReadings: summaryOf(1_000_000_000, now)
  });
  // The piece at 300 s is beyond the exact near window. Its individual queue
  // arrival is not used as the suffix estimate.
  const queued = predictPlaybackReadiness(input([{ start: byteAt(300), end: byteAt(306), availableAt: now + 5_000_000 }],
    bytesPerSecond * 4));
  assert.ok(queued.delaySeconds < 5000, `${queued.delaySeconds} seconds`);
  assert.notEqual(queued.holdingBy?.segment, 50);
  assert.notEqual(queued.holdingBy?.sourcePlanned, true);
  // A slower aggregate rate still increases the estimated delay.
  const measured = predictPlaybackReadiness(input([], bytesPerSecond / 2));
  assert.ok(Number.isFinite(measured.delaySeconds));
  assert.ok(measured.delaySeconds > queued.delaySeconds,
    `${measured.delaySeconds} against ${queued.delaySeconds}`);
});

/**
 * Despicable Me 3 BDRemux as Home Assistant saw it on 2026-10-26
 * (torrent-tv/meta#239): 43 929 276 423 bytes over 5 380.4 s, a copied picture,
 * the swarm at 1.4 MB/s. Cut in 4 s pieces, the viewer at the start.
 */
function despicableMe3({ recent = 1_400_000, session = null, storage = null } = {}) {
  const now = 1_000_000, piece = 4, duration = 5380.4, fileLength = 43_929_276_423;
  const count = Math.ceil(duration / piece);
  const byteAt = (seconds) => Math.min(fileLength, Math.round(seconds * fileLength / duration));
  return {
    now, positionSeconds: 0, durationSeconds: duration, bufferedAheadSeconds: 0, reserveSeconds: 4,
    lookaheadSeconds: 120,
    ...(storage === null ? {} : { sourceStorageBytes: storage }),
    sources: [{ id: "source", complete: false, fileOffset: 0, fileLength, pieceLength: 16_777_216,
      residence: [], downloadForecast: { ranges: [] }, downloadRateReadings: summaryOf(recent, now),
      ...(session === null ? {} : { tailRateReadings: summaryOf(session, now) }) }],
    tracks: [{
      id: "video", sourceIds: ["source"], processedSeconds: 0, startupRemainingSeconds: 0, openSeconds: 0,
      bitsPerMediaSecond: 65_000_000, readings: summaryOf(97, now),
      segments: Array.from({ length: count }, (_, place) => ({
        index: place, startSeconds: place * piece, endSeconds: Math.min(duration, (place + 1) * piece),
        sourceInputs: [{ sourceId: "source", ranges: [{ start: byteAt(place * piece), end: byteAt((place + 1) * piece) }] }]
      })),
      readySegmentIndices: [], segmentSizesBytes: new Map()
    }],
    linkReadings: summaryOf(1_000_000_000, now)
  };
}

test("a film supplied slower than it plays waits until the whole rest of it can arrive in time", () => {
  // Downloading 43.9 GB at 1.4 MB/s takes 31 378 s against 5 380 s of film:
  // the start waits about 25 998 s. Windowed to the viewer, the field started
  // after 12 minutes and stood still 40 times in the next 10.
  const answer = predictPlaybackReadiness(despicableMe3());
  assert.equal(answer.reason, "minimum-safe-delay");
  assert.ok(Math.abs(answer.delaySeconds - 25_998) < 150, `${answer.delaySeconds} s`);
});

test("the rest of the film is priced at the session's mean rate, the near window at the recent one", () => {
  // A recent burst to 2.5 MB/s does not shorten the wait the session's
  // 1.35 MB/s still asks for.
  const recentOnly = predictPlaybackReadiness(despicableMe3({ recent: 2_500_000 }));
  const withSession = predictPlaybackReadiness(despicableMe3({ recent: 2_500_000, session: 1_350_000 }));
  assert.ok(withSession.delaySeconds > recentOnly.delaySeconds * 1.5,
    `${withSession.delaySeconds} s against ${recentOnly.delaySeconds} s`);
  // The first 120 s of film come at the recent rate, the rest at the mean.
  const window = 120 * 43_929_276_423 / 5380.4;
  const expected = window / 2_500_000 + (43_929_276_423 - window) / 1_350_000 - 5380.4;
  assert.ok(Math.abs(withSession.delaySeconds - expected) < 150, `${withSession.delaySeconds} s against ${expected} s`);
});

test("a start whose stock cannot be kept on this proxy says so and keeps waiting", () => {
  // At the start everything that arrived during the wait is held: about 36 GB
  // here, against the 29.5 GB share the field host gave downloaded pieces.
  const short = predictPlaybackReadiness(despicableMe3({ storage: 29_529_000_000 }));
  assert.equal(short.reason, "cushion-exceeds-storage");
  assert.equal(short.ready, false);
  assert.equal(short.delaySeconds, null);
  assert.ok(short.cushionBytes > 29_529_000_000 && short.cushionBytes < 43_929_276_423, `${short.cushionBytes} bytes`);
  const roomy = predictPlaybackReadiness(despicableMe3({ storage: 60_000_000_000 }));
  assert.equal(roomy.reason, "minimum-safe-delay");
});

test("a film supplied faster than it plays does not wait for the rest of it", () => {
  const answer = predictPlaybackReadiness(despicableMe3({ recent: 12_000_000, session: 12_000_000, storage: 29_529_000_000 }));
  assert.notEqual(answer.reason, "cushion-exceeds-storage");
  assert.ok(!(answer.delaySeconds > 60), `${answer.delaySeconds} s`);
});

test("the session's rate weighs each reading by how long it stood, in constant memory", () => {
  // 3 MB/s for 10 s, then 1 MB/s for 30 s: 1.5 MB/s over the session, while
  // the last reading says 1 MB/s and the plain mean of the three says 1.67.
  const rate = new SessionRate();
  rate.add(0, 3_000_000);
  rate.add(10_000, 1_000_000);
  rate.add(40_000, 1_000_000);
  rate.add(40_000, 9_000_000); // not later: ignored
  const summary = rate.snapshot();
  assert.equal(summary.count, 3);
  assert.equal(summary.timeWeightedValue, 1_500_000);
  assert.equal(summary.spanSeconds, 40);
  assert.equal(summary.lastValue, 1_000_000);
});
