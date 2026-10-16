import assert from "node:assert/strict";
import test from "node:test";
import { predictPlaybackReadiness, RateTrend } from "../../services/viewer/playback-readiness.js";
import { predictPlaybackReadiness as wholeFilm } from "./support/whole-film-forecast.js";

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

test("the tail scheduled in seconds gives the whole film's answer within one piece and one open", () => {
  const random = randomFrom(185);
  let compared = 0;
  for (let round = 0; round < 300; round++) {
    const { piece, input } = film(random);
    const reference = wholeFilm(structuredClone(input));
    const answer = predictPlaybackReadiness(structuredClone(input));
    assert.equal(answer.reason === "service-not-advancing", reference.reason === "service-not-advancing");
    if (!Number.isFinite(reference.delaySeconds)) continue;
    // One piece made at the slowest encoder, one open, and one torrent piece
    // at the swarm's rate: the near window waits for whole torrent pieces.
    const slowest = Math.min(...input.tracks.map((track) => track.readings.lastValue));
    const allowance = piece / slowest + Math.max(...input.tracks.map((track) => track.openSeconds)) +
      PIECE_BYTES / input.sources[0].downloadRateReadings.lastValue + 1e-6;
    assert.ok(Math.abs(answer.delaySeconds - reference.delaySeconds) <= allowance,
      `round ${round}: ${answer.delaySeconds} against ${reference.delaySeconds} (allowance ${allowance})`);
    compared++;
  }
  assert.ok(compared > 200, `${compared} answers compared`);
});

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

// #177 r2 after its seek (research/forecast-model-2026-10-11.md, section 5):
// supply sustained at 0.99 of real time over the rest of the film is one wait
// at the start, about (1 - 0.99) of what is left, not a stop while it plays.
test("supply slower than the film over the rest of it holds the start once by the shortfall", () => {
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
  // The last piece's bytes are all there when it starts: the film's bytes
  // over the rate, less the film before that piece.
  const expected = duration / 0.99 - (duration - piece);
  assert.equal(answer.reason, "minimum-safe-delay");
  assert.ok(Math.abs(answer.delaySeconds - expected) < 1, `${answer.delaySeconds} against ${expected}`);
});

// r78, r79 (torrent-tv/meta#185): holds of 21 846 s and 160 774 s named only
// the piece; the answer now says when its input's last bytes come, and
// whether the torrent's queues say so or the measured rate.
test("a hold names when its input's bytes come and whether the torrent's queues say so", () => {
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
  // The piece at 300 s, after the look-ahead, queued to come in 5000 s.
  const queued = predictPlaybackReadiness(input([{ start: byteAt(300), end: byteAt(306), availableAt: now + 5_000_000 }],
    bytesPerSecond * 4));
  assert.equal(queued.holdingBy.segment, 50);
  assert.equal(queued.holdingBy.sourcePlanned, true);
  assert.equal(queued.holdingBy.sourceArrivalSeconds, 5000);
  // Supply at half of real time: the last piece's bytes, at the measured rate.
  const measured = predictPlaybackReadiness(input([], bytesPerSecond / 2));
  assert.equal(measured.holdingBy.segment, count - 1);
  assert.equal(measured.holdingBy.sourcePlanned, false);
  assert.ok(Math.abs(measured.holdingBy.sourceArrivalSeconds - duration * 2) < 1,
    `${measured.holdingBy.sourceArrivalSeconds} against ${duration * 2}`);
});
