import assert from "node:assert/strict";
import test from "node:test";
import { encoderCaptureOf, trackRateReadings } from "../../services/server/ViewerRequests.js";
import { RateTrend, rateSummaryOf } from "../../services/viewer/playback-readiness.js";

const readiness = { RateTrend, rateSummaryOf };
const NOW = 500;

function sample(revision, overrides = {}) {
  return { owner: "proxy-encoder", clock: "performance", clockEpoch: performance.timeOrigin,
    startedAt: revision - 20, completedAt: revision - 10, revision, validity: "valid", unknownReason: null,
    ...overrides };
}

test("projected speed keeps its numeric trend but has no measured capture", () => {
  const track = trackRateReadings([], { predicted: null, projected: 1.75 }, NOW, readiness);
  const seed = new RateTrend();
  seed.add(NOW, 1.75);
  assert.deepEqual(track.summary, seed.snapshot());
  assert.equal(track.captures[0].provenance, "projected");
  assert.equal(track.captures[0].source, "current-cost-projection");
  assert.equal(track.captures[0].validity, "unknown");
  assert.equal(track.captures[0].unknownReason, "projected-encoder-speed-has-no-capture");
  for (const mark of ["clockEpoch", "startedAt", "completedAt", "revision"]) {
    assert.equal(track.captures[0][mark], null, `${mark} is not supplied by the poll`);
  }
  const responseCapture = encoderCaptureOf(track.captures, [], "wait-one", 4);
  assert.equal(responseCapture.validity, "unknown");
  assert.equal(responseCapture.unknownReason, "projected-encoder-speed-has-no-capture");
  assert.equal(responseCapture.projectionSource, "current-cost-projection");
  assert.equal(responseCapture.startedAt, null);
});

test("offer-time prediction precedes the current-cost projection without acquiring poll marks", () => {
  const track = trackRateReadings([], { predicted: 2.25, projected: 9 }, NOW, readiness);
  const expected = new RateTrend();
  expected.add(NOW, 2.25);
  assert.deepEqual(track.summary, expected.snapshot());
  assert.equal(track.captures[0].source, "stored-encode-prediction");
  assert.equal(track.captures[0].validity, "unknown");
});

test("a measured encoder reading takes precedence and preserves its original capture", () => {
  const reading = { speed: 1.2, at: 470, captureOwner: "proxy-encoder", captureClock: "performance",
    captureClockEpoch: performance.timeOrigin, captureStartedAtMonotonic: 430,
    captureCompletedAtMonotonic: 465 };
  const track = trackRateReadings([reading], { predicted: 2.25, projected: 9 }, NOW, readiness);
  assert.deepEqual(track.summary, rateSummaryOf([reading]));
  const capture = encoderCaptureOf(track.captures, [], "wait-one", 4);
  assert.equal(capture.validity, "valid");
  assert.equal(capture.startedAt, 430);
  assert.equal(capture.completedAt, 465);
  assert.equal(capture.revision, 470);
});

test("old or mixed epochs, malformed marks, and reordered captures stay unknown", () => {
  const cases = [
    [sample(10, { clockEpoch: performance.timeOrigin - 1 })],
    [sample(10), sample(20, { clockEpoch: performance.timeOrigin - 1 })],
    [sample(10, { startedAt: null })],
    [sample(20), sample(10)]
  ];
  for (const captures of cases) {
    assert.equal(encoderCaptureOf(captures, [], "wait-one", 4).validity, "unknown");
  }
  const recovered = encoderCaptureOf([sample(30)], [], "wait-one", 4);
  assert.equal(recovered.validity, "valid", "a later well-marked sample can restore validity");
});
