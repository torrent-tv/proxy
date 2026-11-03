import assert from "node:assert/strict";
import test from "node:test";
import { predictPlaybackReadiness, RateTrend, SessionRate } from "../../services/viewer/playback-readiness.js";
import { OutputForecastGeometry } from "../../services/viewer/OutputForecastGeometry.js";

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

test("live output geometry projects every remaining segment and preserves missing source maps", () => {
  let mapped = false;
  const geometry = new OutputForecastGeometry({
    lookaheadSeconds: 8,
    endsWithinPlayerSeekTolerance: () => false,
    sourceInputsFor: (_output, index) => mapped && index === 3
      ? [{ sourceId: "source", ranges: [{ start: 30, end: 40 }] }]
      : index === 2 || index === 4 ? [{ sourceId: "source", ranges: [{ start: index * 10, end: index * 10 + 10 }] }]
        : null
  });
  const output = { timeline: { segmentCount: 5, publishedStartOf: index => index * 4 } };
  geometry.segmentsOf(output, null, new Map(), 0);
  const first = geometry.get(output).tailSegments;
  assert.deepEqual(first.map(segment => segment.index), [2, 3, 4]);
  assert.equal(first[0].sourceInputs[0].ranges[0].start, 20);
  assert.equal(Object.hasOwn(first[1], "sourceInputs"), true);
  assert.equal(first[1].sourceInputs, undefined, "an unknown map remains explicit");
  mapped = true;
  geometry.segmentsOf(output, null, new Map(), 0);
  assert.equal(geometry.get(output).tailSegments[1].sourceInputs[0].ranges[0].start, 30);
});

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

test("an exact tail queue arrival holds the segment whose mapped source pieces it names", () => {
  const now = 1_000_000;
  const piece = 6, count = 100, duration = piece * count;
  const bytesPerSecond = 1_000_000;
  const byteAt = (seconds) => Math.round(seconds * bytesPerSecond);
  const segments = Array.from({ length: count }, (_, place) => ({
    index: place, startSeconds: place * piece, endSeconds: (place + 1) * piece,
    sourceInputs: [{ sourceId: "source", ranges: [{ start: byteAt(place * piece), end: byteAt((place + 1) * piece) }] }]
  }));
  const input = (ranges, rate) => ({
    now, positionSeconds: 0, durationSeconds: duration, bufferedAheadSeconds: 0, reserveSeconds: 0,
    lookaheadSeconds: 120,
    sources: [{ id: "source", complete: false, fileOffset: 0, fileLength: byteAt(duration), pieceLength: PIECE_BYTES,
      residence: [], downloadForecast: { ranges }, downloadRateReadings: summaryOf(rate, now) }],
    tracks: [{
      id: "video", sourceIds: ["source"], processedSeconds: 0, startupRemainingSeconds: 0, openSeconds: 0,
      bitsPerMediaSecond: 8_000_000, readings: summaryOf(50, now), segments,
      tailSegments: segments.filter(segment => segment.startSeconds >= 120),
      readySegmentIndices: [], segmentSizesBytes: new Map()
    }],
    linkReadings: summaryOf(1_000_000_000, now)
  });
  // The torrent piece containing the source bytes at 300 s begins just before
  // that segment boundary, so it is also required by segment 49 and takes that
  // earlier 300 s deadline.
  const plannedStart = Math.floor(byteAt(300) / PIECE_BYTES) * PIECE_BYTES;
  const plannedEnd = Math.ceil(byteAt(306) / PIECE_BYTES) * PIECE_BYTES;
  const queued = predictPlaybackReadiness(input([{ start: plannedStart, end: plannedEnd, availableAt: now + 5_000_000 }],
    bytesPerSecond * 4));
  assert.ok(queued.delaySeconds > 4_600 && queued.delaySeconds < 5_000, `${queued.delaySeconds} seconds`);
  assert.equal(queued.holdingBy?.segment, 49);
  assert.equal(queued.holdingBy?.sourcePlanned, true);
  // Without the extreme queue arrival, the lower measured rate still has a
  // finite source schedule over the whole remaining film.
  const measured = predictPlaybackReadiness(input([], bytesPerSecond / 2));
  assert.ok(Number.isFinite(measured.delaySeconds));
  assert.ok(measured.delaySeconds < queued.delaySeconds,
    `${measured.delaySeconds} against ${queued.delaySeconds}`);
});

/**
 * Despicable Me 3 BDRemux as Home Assistant saw it on 2026-10-26
 * (torrent-tv/meta#239): 43 929 276 423 bytes over 5 380.4 s, a copied picture,
 * the swarm at 1.4 MB/s. Cut in 4 s pieces, the viewer at the start.
 */
function despicableMe3({ recent = 1_400_000, session = null, storage = null, fileOffset = 0, plannedToEnd = false, readsIndex = false } = {}) {
  const now = 1_000_000, piece = 4, duration = 5380.4, fileLength = 43_929_276_423;
  const count = Math.ceil(duration / piece);
  const byteAt = (seconds) => Math.min(fileLength, Math.round(seconds * fileLength / duration));
  return {
    now, positionSeconds: 0, durationSeconds: duration, bufferedAheadSeconds: 0, reserveSeconds: 4,
    lookaheadSeconds: 120,
    ...(storage === null ? {} : { sourceStorageBytes: storage }),
    sources: [{ id: "source", complete: false, fileOffset, fileLength, pieceLength: 16_777_216,
      // A copied Matroska file reads its index at the end, held from the open.
      residence: readsIndex ? [{ start: fileLength - 2_330_631, end: fileLength, location: "disk" }] : [],
      // The torrent thread's plan, which can reach the end of the file.
      downloadForecast: { ranges: plannedToEnd ? [{ start: fileLength - 16_777_216, end: fileLength, availableAt: now + 3_600_000 }] : [] },
      downloadRateReadings: summaryOf(recent, now),
      ...(session === null ? {} : { tailRateReadings: summaryOf(session, now) }) }],
    tracks: [{
      id: "video", sourceIds: ["source"], processedSeconds: 0, startupRemainingSeconds: 0, openSeconds: 0,
      bitsPerMediaSecond: 65_000_000, readings: summaryOf(97, now),
      segments: Array.from({ length: count }, (_, place) => ({
        index: place, startSeconds: place * piece, endSeconds: Math.min(duration, (place + 1) * piece),
        sourceInputs: [{ sourceId: "source", ranges: [{ start: byteAt(place * piece), end: byteAt((place + 1) * piece) },
          ...(readsIndex && place === 0 ? [{ start: fileLength - 2_330_631, end: fileLength }] : [])] }]
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
  assert.equal(roomy.cushionBytes, short.cushionBytes, "the forecast exposes its stock requirement even when storage can hold it");
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

test("the rest of the film is not taken as held because the torrent's plan reaches the end of the file", () => {
  // The field case: the third file of a trilogy, its bytes 80 GB into the
  // torrent, with the torrent thread planning a piece at the end of the file.
  // Taken as the near window's end, that plan left the tail no bytes at all.
  const answer = predictPlaybackReadiness(despicableMe3({ fileOffset: 80_000_000_000, plannedToEnd: true }));
  assert.ok(Math.abs(answer.delaySeconds - 25_998) < 150, `${answer.delaySeconds} s`);
});

test("the rest of the film is not taken as held because the first piece reads the index at the end of the file", () => {
  // Despicable Me 3 on 2.107.41: the bytes the near window read ended at the
  // file's last byte, and the 43.6 GB still to come counted as held.
  const answer = predictPlaybackReadiness(despicableMe3({ readsIndex: true }));
  assert.ok(Math.abs(answer.delaySeconds - 25_998) < 150, `${answer.delaySeconds} s`);
  assert.ok(answer.tail.every(part => !part.skipped), JSON.stringify(answer.tail));
});

/** A twelve-second film whose third piece needs ten times the other source bytes. */
function variableDensityFilm({ lookaheadSeconds = 3, trackCount = 1, mapTail = true, identifySource = true } = {}) {
  const now = 1_000_000;
  const lengths = [1_000, 1_000, 10_000, 1_000];
  let offset = 0;
  const sourceInputs = lengths.map(length => {
    const ranges = [{ start: offset, end: offset + length }];
    offset += length;
    return ranges;
  });
  const segments = lengths.map((_, segmentIndex) => ({
    index: segmentIndex, startSeconds: segmentIndex * 3, endSeconds: (segmentIndex + 1) * 3,
    ...(mapTail || segmentIndex === 0 ? { sourceInputs: [{ sourceId: "source", ranges: sourceInputs[segmentIndex] }] } : {})
  }));
  return {
    now, positionSeconds: 0, durationSeconds: 12, bufferedAheadSeconds: 0, reserveSeconds: 0,
    lookaheadSeconds, requiredAudio: trackCount === 2,
    sources: [{ id: "source", complete: false, fileOffset: 0, fileLength: offset, pieceLength: 1_000,
      residence: [], downloadForecast: { ranges: [] }, downloadRateReadings: summaryOf(1_000, now) }],
    tracks: Array.from({ length: trackCount }, (_, index) => ({
      id: `track-${index}`, sourceIds: identifySource ? ["source"] : [], processedSeconds: 0,
      startupRemainingSeconds: 0, openSeconds: 0,
      bitsPerMediaSecond: 1_000, readings: summaryOf(1_000_000, now),
      segments,
      tailSegments: segments.filter(segment => segment.startSeconds >= lookaheadSeconds),
      readySegmentIndices: [], segmentSizesBytes: new Map()
    })),
    linkReadings: summaryOf(1_000_000_000, now)
  };
}

test("mapped tail source bytes meet each intermediate piece deadline, including variable density", () => {
  const answer = predictPlaybackReadiness(variableDensityFilm());
  assert.equal(answer.reason, "minimum-safe-delay");
  // The 10 KB third piece takes 10 s after the first 2 KB. It is due at 9 s,
  // so the viewer needs a 3 s start delay even though the whole suffix ends
  // close to the film's 12 s completion deadline.
  assert.ok(Math.abs(answer.delaySeconds - 3) < 1e-6, `${answer.delaySeconds} s`);
  const tailSource = answer.tail.filter(part => part.sourceId === "source");
  assert.equal(tailSource.length, 1);
  assert.equal(tailSource[0].uniquePieces, 12);
  assert.ok(tailSource.every(part => part.addressed === true));
});

test("source bytes shared by two tracks are charged once in the exact tail", () => {
  const answer = predictPlaybackReadiness(variableDensityFilm({ trackCount: 2 }));
  const tailSource = answer.tail.filter(part => part.sourceId === "source");
  assert.equal(tailSource.reduce((sum, part) => sum + part.totalBytes, 0), 12_000);
  assert.equal(tailSource.reduce((sum, part) => sum + part.uniquePieces, 0), 12);
});

test("unmapped tail addresses retain an explicit aggregate work estimate", () => {
  const answer = predictPlaybackReadiness(variableDensityFilm({ mapTail: false }));
  const source = answer.tail.find(part => part.sourceId === "source");
  assert.equal(answer.reason, "tail-source-addresses-unavailable");
  assert.equal(answer.delaySeconds, null, "the unbounded estimate cannot be presented as a full-film delay");
  assert.ok(Number.isFinite(answer.diagnosticDelaySeconds), "the density result remains available for diagnostics");
  assert.deepEqual(answer.unavailableTailSources, ["source"]);
  assert.equal(source.addressed, false);
  assert.equal(source.estimatedAddress, "file-density");
  assert.ok(source.missingBytes > 0, "unmapped work remains in the tail");
});

test("a tail without source identities stays explicitly unavailable", () => {
  const answer = predictPlaybackReadiness(variableDensityFilm({ identifySource: false, mapTail: false }));
  assert.equal(answer.reason, "tail-source-addresses-unavailable");
  assert.equal(answer.delaySeconds, null);
  assert.deepEqual(answer.unavailableTailTracks, ["track-0"]);
});

test("the near-tail boundary neither repeats nor drops the next mapped source pieces", () => {
  const answer = predictPlaybackReadiness(variableDensityFilm({ lookaheadSeconds: 6 }));
  const tailSource = answer.tail.filter(part => part.sourceId === "source");
  assert.equal(tailSource.reduce((sum, part) => sum + part.totalBytes, 0), 11_000);
  assert.ok(tailSource.every(part => part.start >= 2_000));
});

test("the exact schedule covers the entire remaining film when the horizon reaches its end", () => {
  const answer = predictPlaybackReadiness(variableDensityFilm({ lookaheadSeconds: 12 }));
  assert.equal(answer.tail.length, 0);
  assert.equal(answer.reason, "minimum-safe-delay");
  assert.ok(Number.isFinite(answer.delaySeconds));
});

test("the saved 3,600-second suffix counterexample stays at the first-piece completion", () => {
  const now = 1_000_000, piece = 4, duration = 3_600, count = duration / piece;
  const answer = predictPlaybackReadiness({
    now, positionSeconds: 0, durationSeconds: duration, bufferedAheadSeconds: 0, reserveSeconds: 0,
    lookaheadSeconds: 120,
    sources: [{ id: "source", complete: true, fileOffset: 0, fileLength: 1, pieceLength: PIECE_BYTES,
      residence: [], downloadForecast: { ranges: [] } }],
    tracks: [{
      id: "video", sourceIds: ["source"], processedSeconds: 0, startupRemainingSeconds: 0, openSeconds: 0,
      bitsPerMediaSecond: 8_000_000, readings: summaryOf(1.5, now),
      segments: Array.from({ length: count }, (_, index) => ({ index, startSeconds: index * piece,
        endSeconds: (index + 1) * piece })),
      readySegmentIndices: [], segmentSizesBytes: new Map()
    }],
    linkReadings: summaryOf(12_000_000, now)
  });
  assert.equal(answer.reason, "minimum-safe-delay");
  assert.ok(Math.abs(answer.delaySeconds - 5.333333333333333) < 1e-9, `${answer.delaySeconds} s`);
});
