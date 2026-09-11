import test from "node:test";
import assert from "node:assert/strict";

import {
  allowedGap,
  probeWedgeIsCertain,
  readProbeState,
  PROBE_INTERVAL_MS,
  UNRELIABLE_LABEL
} from "../services/delivery-probe.js";

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

test("a frozen tab's own event-loop delay counts toward the allowance", () => {
  // Field case 2026-09-03, session 03f211b8. The viewer paused at 15:24:21 with
  // 121.5 s buffered; the tab went hidden at 15:24:35 and its event loop fell
  // behind — loopLag 681 → 1881 → 4297 → 5957 ms. At 15:26:05 the probes read
  // `gap 12 of 11` and printed `association-stopped`, the ring files were kept
  // and a 180 s capture was taken; seven seconds later the same connection read
  // `flowing`. Nothing had stopped: the browser simply could not run the timer
  // that answers a probe.
  // The line printed `gap 12 of 11`; the queue was empty and the round trip
  // 162 ms, so the cadence term is whatever makes the allowance 11.
  const measured = {
    queuedBytes: 0,
    bytesPerSecond: 300,
    rttMs: 162,
    echoIntervalMs: 5000
  };
  const withoutLag = allowedGap(measured);
  const withLag = allowedGap({ ...measured, peerLoopLagMs: 1881 });
  assert.equal(withoutLag, 11, `the field allowance was 11, not ${withoutLag}`);
  assert.ok(withLag > 12, `a gap of 12 must fit inside ${withLag}`);
  const allowed = Object.fromEntries(ALL.map((label) => [label, withLag]));
  const { verdict, detail } = readProbeState(
    state(
      { proxy: 9547, "proxy-control": 9547, "proxy-fast": 9547 },
      {
        seq: 9559,
        allowed,
        echoAgeMs: 5963,
        echoStaleMs: 11 * PROBE_INTERVAL_MS + 162 + 5000 + 1881,
        peerBytesAdvancing: false,
        peerLoopLagMs: 1881,
        peerVisibility: "hidden"
      }
    )
  );
  assert.equal(verdict, "flowing");
  assert.match(detail, /peerLoopLag=1881ms/);
  assert.match(detail, /peerTab=hidden/);
});

test("the peer's lag widens the bound on a stale echo without removing it", () => {
  // The same term must not make `reverse-direction-gone` unreachable: a peer
  // that has genuinely gone silent is still silent for far longer than its own
  // loop delay explains.
  const { verdict } = readProbeState(
    state(
      { proxy: 99, "proxy-control": 99, "proxy-fast": 99 },
      {
        echoAgeMs: 120_000,
        echoStaleMs: 5500 + 162 + 1000 + 4297,
        peerLoopLagMs: 4297,
        peerVisibility: "hidden"
      }
    )
  );
  assert.equal(verdict, "reverse-direction-gone");
});

test("a peer that reports no loop delay is judged exactly as before", () => {
  const reading = readProbeState(
    state({ proxy: 90, "proxy-control": 90, "proxy-fast": 90 }, { peerBytesAdvancing: false })
  );
  assert.equal(reading.verdict, "association-stopped");
  assert.doesNotMatch(reading.detail, /peerLoopLag=/);
  assert.doesNotMatch(reading.detail, /peerTab=/);
});

test("a quiet stretch shorter than a legitimate report is not a wedge", () => {
  // Field 2026-09-11: two captures of 180 s each, triggered at `wedged 1s` and
  // `wedged 2s`, on a connection with `rtt=5ms`, every queue at 0 B and the
  // viewer watching. In its first minutes a connection has shown no healthy gap
  // at all, and the floor under "longer than anything healthy" was a single
  // probe interval — 500 ms — so any quiet moment beat it.
  // Both cadences plus the crossing: a probe sent just after the peer composed
  // a report shows up only in the next one.
  const legitimateReportMs = 500 + 500 + 12 + 0;
  assert.equal(
    probeWedgeIsCertain({ stuckForMs: 1000, longestHealthySeenGapMs: 0, legitimateReportMs }).certain,
    false,
    "a second of quiet is shorter than one legitimate report and says nothing"
  );
  // And what the detector exists for is untouched: a counter frozen for
  // minutes is far past any report this connection could legitimately owe.
  assert.equal(
    probeWedgeIsCertain({ stuckForMs: 60_000, longestHealthySeenGapMs: 0, legitimateReportMs }).certain,
    true
  );
  // A peer whose event loop is late is owed that time as well.
  assert.equal(
    probeWedgeIsCertain({
      stuckForMs: 3000,
      longestHealthySeenGapMs: 0,
      legitimateReportMs: 500 + 12 + 5000
    }).certain,
    false,
    "a peer frozen for five seconds cannot answer sooner than that"
  );
});

test("what is behind is judged in time, not in probes", () => {
  // The same probe goes down every channel including the one carrying the film,
  // and SCTP schedules per association — so a probe waits behind queued video
  // exactly as a segment does. Counting outstanding probes therefore measures
  // the queue, not the association, which is why the count is only printed now.
  const behind = { proxy: 800, "proxy-control": 800, "proxy-fast": 800 };
  const mayWait = { proxy: 2000, "proxy-control": 2000, "proxy-fast": 2000 };

  // Far behind in probes, well within the time its own queue is allowed.
  const healthy = readProbeState(
    state(
      { proxy: 40, "proxy-control": 41, "proxy-fast": 42 },
      { behindMs: behind, allowedWaitMs: mayWait }
    )
  );
  assert.equal(healthy.verdict, "flowing");
  assert.match(healthy.detail, /800ms of 2000ms/, "both readings belong in the line");

  // The same gaps, the same allowance, and the probe is older than the queue
  // could account for: that is the association and not the burst.
  const wedged = readProbeState(
    state(
      { proxy: 40, "proxy-control": 41, "proxy-fast": 42 },
      {
        behindMs: { proxy: 9000, "proxy-control": 9000, "proxy-fast": 9000 },
        allowedWaitMs: mayWait
      }
    )
  );
  assert.equal(wedged.verdict, "association-stopped");
});

test("with no send time recorded the count still decides", () => {
  // A probe older than the history kept, or a connection that has just begun:
  // the reading is absent rather than wrong, and the old comparison stands.
  const { verdict } = readProbeState(
    state({ proxy: 40, "proxy-control": 41, "proxy-fast": 42 }, { behindMs: {}, allowedWaitMs: {} })
  );
  assert.equal(verdict, "association-stopped");
});

test("the measured one-way time is preferred over the age of the report", () => {
  // With the clocks reconciled, the proxy knows how long the probe itself took
  // to reach the peer. The age of the newest reported probe is the same thing
  // plus the peer's reporting cadence and the way back — so where both are
  // known, the measurement wins and its allowance carries neither.
  const { verdict } = readProbeState(
    state(
      { proxy: 40, "proxy-control": 41, "proxy-fast": 42 },
      {
        // The age says far behind against its allowance...
        behindMs: { proxy: 9000, "proxy-control": 9000, "proxy-fast": 9000 },
        allowedWaitMs: { proxy: 2000, "proxy-control": 2000, "proxy-fast": 2000 },
        // ...while the probe itself took 300 ms of the 900 its queue may take.
        oneWayMs: { proxy: 300, "proxy-control": 300, "proxy-fast": 300 },
        allowedOneWayMs: { proxy: 900, "proxy-control": 900, "proxy-fast": 900 }
      }
    )
  );
  assert.equal(verdict, "flowing");
});

test("a one-way time past what the queue can account for is the association", () => {
  const { verdict } = readProbeState(
    state(
      { proxy: 40, "proxy-control": 41, "proxy-fast": 42 },
      {
        oneWayMs: { proxy: 12_000, "proxy-control": 12_000, "proxy-fast": 12_000 },
        allowedOneWayMs: { proxy: 900, "proxy-control": 900, "proxy-fast": 900 }
      }
    )
  );
  assert.equal(verdict, "association-stopped");
});
