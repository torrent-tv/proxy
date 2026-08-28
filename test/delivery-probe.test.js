import test from "node:test";
import assert from "node:assert/strict";

import { allowedGap, readProbeState, PROBE_INTERVAL_MS, UNRELIABLE_LABEL } from "../services/delivery-probe.js";

const ORDERED = ["proxy", "proxy-control"];
const ALL = [...ORDERED, UNRELIABLE_LABEL];

/**
 * @param {Record<string, number>} seen
 * @param {object} [overrides]
 */
function state(seen, overrides = {}) {
  const allowed = {};
  for (const label of overrides.labels ?? ALL) {
    allowed[label] = 3;
  }
  return {
    seq: 100,
    seen,
    labels: ALL,
    echoes: 5,
    echoAgeMs: 400,
    allowed,
    ...overrides
  };
}

test("every channel current reads as flowing", () => {
  const { verdict } = readProbeState(state({ proxy: 100, "proxy-control": 99, "proxy-fast": 100 }));
  assert.equal(verdict, "flowing");
});

test("a lag shorter than the verdict window is still flowing", () => {
  const behind = 100 - 3;
  const { verdict } = readProbeState(
    state({ proxy: behind, "proxy-control": behind, "proxy-fast": 100 })
  );
  assert.equal(verdict, "flowing");
});

test("ordered channels behind while the unordered one keeps up names a stuck stream", () => {
  const { verdict, detail } = readProbeState(
    state({ proxy: 40, "proxy-control": 41, "proxy-fast": 100 })
  );
  assert.equal(verdict, "stream-stuck");
  // The numbers that produced the verdict must be in the line beside it.
  assert.match(detail, /proxy=40\(gap 60 of 3\)/);
});

test("every channel behind names the association", () => {
  const { verdict } = readProbeState(
    state({ proxy: 40, "proxy-control": 41, "proxy-fast": 42 })
  );
  assert.equal(verdict, "association-stopped");
});

test("without the unordered channel the verdict says it cannot compare", () => {
  const { verdict } = readProbeState(
    state({ proxy: 40, "proxy-control": 41 }, { labels: ORDERED })
  );
  assert.equal(verdict, "ordered-behind-no-comparison");
});

test("a stale echo means the reverse direction went too", () => {
  const { verdict } = readProbeState(
    state({ proxy: 40, "proxy-control": 41, "proxy-fast": 42 }, { echoAgeMs: 30_000 })
  );
  assert.equal(verdict, "reverse-direction-gone");
});

test("before the first echo nothing is claimed", () => {
  const { verdict } = readProbeState(state({}, { echoes: 0, echoAgeMs: null }));
  assert.equal(verdict, "no-echo-yet");
});

test("a channel that has never reported counts as behind, not as unknown", () => {
  const { verdict, detail } = readProbeState(
    state({ "proxy-fast": 100 })
  );
  assert.equal(verdict, "stream-stuck");
  assert.match(detail, /proxy=\?\(gap \? of 3\)/);
});

test("the allowance is the queue's own drain time, not a chosen number", () => {
  // 8 MB queued at 8 MB/s is one second of draining; probes go twice a second,
  // so two of them may legitimately be outstanding, plus the round trip.
  assert.equal(
    allowedGap({ queuedBytes: 8 * 1024 * 1024, bytesPerSecond: 8 * 1024 * 1024, rttMs: 0 }),
    Math.ceil(1000 / PROBE_INTERVAL_MS)
  );
  // An empty queue still allows the one probe that is always in flight.
  assert.equal(allowedGap({ queuedBytes: 0, bytesPerSecond: 8 * 1024 * 1024, rttMs: 0 }), 1);
  // The round trip counts: the echo has to come back too.
  assert.ok(
    allowedGap({ queuedBytes: 0, bytesPerSecond: 1024, rttMs: 2000 }) >
      allowedGap({ queuedBytes: 0, bytesPerSecond: 1024, rttMs: 0 })
  );
});

test("with no rate measured nothing is claimed", () => {
  assert.equal(allowedGap({ queuedBytes: 1024, bytesPerSecond: 0, rttMs: 10 }), null);
  const { verdict } = readProbeState(
    state({ proxy: 40, "proxy-control": 41, "proxy-fast": 42 }, { allowed: {} })
  );
  assert.equal(verdict, "no-rate-yet");
});

test("a burst big enough to explain the lag is not called a stopped association", () => {
  // The 2026-08-26 false positive: all three channels at gap 7 while 150 Mbps
  // crossed the association. 64 MB queued at 18 MB/s is three and a half
  // seconds of draining, which is seven probe intervals.
  const allowance = allowedGap({
    queuedBytes: 64 * 1024 * 1024,
    bytesPerSecond: 18 * 1024 * 1024,
    rttMs: 16
  });
  assert.ok(allowance >= 7);
  const allowed = Object.fromEntries(ALL.map((label) => [label, allowance]));
  const { verdict } = readProbeState(
    state({ proxy: 93, "proxy-control": 93, "proxy-fast": 93 }, { allowed })
  );
  assert.equal(verdict, "flowing");
});

test("the peer's own answering cadence counts toward the allowance", () => {
  // Field case 2026-08-27: queues empty, 3.4 MB/s crossing, tab hidden so the
  // browser echoed about once a second. Without the peer's cadence the
  // allowance is one probe and every other line read `association-stopped`.
  const withoutCadence = allowedGap({
    queuedBytes: 0,
    bytesPerSecond: 3.4 * 1024 * 1024,
    rttMs: 9
  });
  assert.equal(withoutCadence, 1);
  const withCadence = allowedGap({
    queuedBytes: 0,
    bytesPerSecond: 3.4 * 1024 * 1024,
    rttMs: 9,
    echoIntervalMs: 1000
  });
  assert.ok(withCadence >= 3, `a second of cadence must allow more than ${withCadence}`);
  const allowed = Object.fromEntries(ALL.map((label) => [label, withCadence]));
  const { verdict } = readProbeState(
    state({ proxy: 98, "proxy-control": 98, "proxy-fast": 98 }, { allowed, echoAgeMs: 977 })
  );
  assert.equal(verdict, "flowing");
});

test("a stale echo is judged against the peer's cadence, not a fixed half second", () => {
  // The same numbers with the cadence unknown must still be able to say the
  // reverse direction is gone — the bound rises with the cadence, it does not
  // disappear.
  const { verdict } = readProbeState(
    state({ proxy: 99, "proxy-control": 99, "proxy-fast": 99 }, { echoAgeMs: 60_000, echoStaleMs: 2000 })
  );
  assert.equal(verdict, "reverse-direction-gone");
});

test("bytes still arriving outrank the probe gaps — the cushion fill is not a wedge", () => {
  // The field shape of 2026-08-28: every queue at 0 B, so the allowance is
  // small, the probes are far behind because the browser is busy pulling two
  // minutes of film, and the association is perfectly healthy. Before the peer's
  // own byte counter was consulted this read as `association-stopped`, four
  // times in the first two minutes of a session nobody was troubled by.
  const state = {
    seq: 88,
    seen: { proxy: 78, "proxy-control": 78, "proxy-fast": 78 },
    labels: ["proxy", "proxy-control", "proxy-fast"],
    echoes: 40,
    echoAgeMs: 1305,
    allowed: { proxy: 9, "proxy-control": 9, "proxy-fast": 9 },
    echoStaleMs: 6000,
    peerBytesAdvancing: true
  };
  const reading = readProbeState(state);
  assert.equal(reading.verdict, "flowing");
  assert.match(reading.detail, /peerBytes=advancing/);
});

test("the same gaps with the peer's counter STILL are the wedge", () => {
  // One field changes, and it is the one that says whether anything is
  // arriving. This is the shape of a real freeze: probes behind, and the far
  // end receiving nothing.
  const reading = readProbeState({
    seq: 88,
    seen: { proxy: 78, "proxy-control": 78, "proxy-fast": 78 },
    labels: ["proxy", "proxy-control", "proxy-fast"],
    echoes: 40,
    echoAgeMs: 1305,
    allowed: { proxy: 9, "proxy-control": 9, "proxy-fast": 9 },
    echoStaleMs: 6000,
    peerBytesAdvancing: false
  });
  assert.equal(reading.verdict, "association-stopped");
  assert.match(reading.detail, /peerBytes=still/);
});

test("a browser that does not report its bytes is judged as before", () => {
  // The term says nothing rather than guessing, and the rule falls back.
  const reading = readProbeState({
    seq: 88,
    seen: { proxy: 78, "proxy-control": 78, "proxy-fast": 78 },
    labels: ["proxy", "proxy-control", "proxy-fast"],
    echoes: 40,
    echoAgeMs: 1305,
    allowed: { proxy: 9, "proxy-control": 9, "proxy-fast": 9 },
    echoStaleMs: 6000,
    peerBytesAdvancing: null
  });
  assert.equal(reading.verdict, "association-stopped");
  assert.doesNotMatch(reading.detail, /peerBytes=/);
});
