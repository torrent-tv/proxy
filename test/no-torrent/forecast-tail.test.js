import assert from "node:assert/strict";
import test from "node:test";
import { predictPlaybackReadiness, RateTrend } from "../../services/viewer/playback-readiness.js";

/** A deterministic sequence in [0, 1). */
function randomFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    state = Math.imul(state ^ (state >>> 13), 3266489909) >>> 0;
    return ((state ^ (state >>> 16)) >>> 0) / 4294967296;
  };
}

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

test("near input without a planned arrival uses measured source service", () => {
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
