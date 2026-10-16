import assert from "node:assert/strict";
import test from "node:test";
import { sourceService } from "../../services/server/ViewerRequests.js";
import { forecastRate, predictPlaybackReadiness, RateTrend } from "../../services/viewer/playback-readiness.js";

/** A source's rate summary from readings `[at, bytes per second]`, as the trend keeps it. */
function summaryOf(...readings) {
  const trend = new RateTrend();
  for (const [at, value] of readings) trend.add(at, value);
  return trend.snapshot();
}

/** The rate the forecast reads from a source's summary, as the server passes it. */
const rateOf = (summary) => forecastRate(summary, 0, 0, "time");

// r54 (torrent-tv/meta#178): a stretch our selection held nothing back read
// 0 B/s while the torrent carried 5-18 MB/s, and the viewer was held.
test("the forecast's source service is never below what the swarm carried", () => {
  const free = summaryOf([0, 0]), delivered = summaryOf([0, 9_000_000]);
  assert.equal(sourceService(free, delivered, rateOf), delivered);
  const capacity = summaryOf([0, 14_000_000]);
  assert.equal(sourceService(capacity, delivered, rateOf), capacity, "where it carried more unheld, that is its capacity");
  assert.equal(sourceService(null, delivered, rateOf), delivered);
  assert.equal(sourceService(free, null, rateOf), free);
  assert.equal(sourceService(null, null, rateOf), null);
});

// r74 (torrent-tv/meta#185): our selection held a peer back 100 % of the time
// on both sides of one 5 s stretch that read 10.67 MB/s, and that unheld rate
// stood as the last reading for over a minute. Chosen by its last reading, it
// won over the 3.4 MB/s carried, and the forecast read its span: "service not
// advancing" with no delay, after a return to 30 s whose media the page already
// held. The zero before it is reconstructed — the summary was not logged whole —
// as the one span that gives the forecast's answer.
test("a source's service is chosen by the rate the forecast reads from it", () => {
  const free = summaryOf([60_000, 0], [61_500, 10_668_941]);
  const delivered = summaryOf([57_000, 3_440_000], [58_500, 3_440_000], [60_000, 3_440_000]);
  const chosen = sourceService(free, delivered, rateOf);
  assert.equal(chosen, delivered);

  const forecast = (readings) => predictPlaybackReadiness({
    now: 61_500,
    positionSeconds: 0,
    durationSeconds: 8,
    bufferedAheadSeconds: 0,
    reserveSeconds: 0,
    lookaheadSeconds: 8,
    sources: [{ id: "source", complete: false, fileOffset: 0, fileLength: 8_000_000, pieceLength: 1_000_000,
      residence: [{ start: 0, end: 4_000_000, location: "memory" }], downloadForecast: { ranges: [] },
      downloadRateReadings: readings }],
    tracks: [{
      id: "video",
      sourceIds: ["source"],
      processedSeconds: 0,
      bitsPerMediaSecond: 80,
      readings: [{ at: 60_000, value: 2 }, { at: 61_000, value: 2 }],
      segments: [
        { index: 0, startSeconds: 0, endSeconds: 4,
          sourceInputs: [{ sourceId: "source", ranges: [{ start: 0, end: 4_000_000 }] }] },
        { index: 1, startSeconds: 4, endSeconds: 8,
          sourceInputs: [{ sourceId: "source", ranges: [{ start: 4_000_000, end: 8_000_000 }] }] }
      ],
      readySegmentIndices: [0],
      segmentSizesBytes: new Map([[0, 40]])
    }],
    linkReadings: [{ at: 60_000, value: 320 }, { at: 61_000, value: 320 }]
  });
  assert.equal(forecast(free).reason, "service-not-advancing", "the summary the last reading chose");
  const answer = forecast(chosen);
  assert.equal(answer.reason, "minimum-safe-delay");
  assert.ok(Number.isFinite(answer.delaySeconds));
});
