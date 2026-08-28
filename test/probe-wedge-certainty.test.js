import test from "node:test";
import assert from "node:assert/strict";

import { probeWedgeIsCertain, readProbeState, PROBE_INTERVAL_MS } from "../services/delivery-probe.js";

test("a seen-counter bounded lag is not a wedge, however long it lasts", () => {
  // Session 4dcac61b, field log 2026-08-28: gap held at 6-7 probes for 95+
  // seconds on a backgrounded tab, but `seen` kept climbing right along with
  // `sent` — this connection's own history says gaps up to ~3.5 s (7 probes
  // at 500 ms) are ordinary, so the same 3.5 s stuck must not read as certain.
  const verdict = probeWedgeIsCertain({
    stuckForMs: 3400,
    longestHealthySeenGapMs: 3500
  });
  assert.equal(verdict.certain, false);
});

test("a seen-counter frozen past this connection's own worst legitimate gap is a wedge", () => {
  // Session d85ae4f5, the same field log: `seen` frozen at one value for over
  // a minute while `sent` climbed unbounded — this is the shape the detector
  // exists to catch.
  const verdict = probeWedgeIsCertain({
    stuckForMs: 90_000,
    longestHealthySeenGapMs: 3500
  });
  assert.equal(verdict.certain, true);
});

test("with no healthy history yet, one probe interval is still required", () => {
  const verdict = probeWedgeIsCertain({
    stuckForMs: PROBE_INTERVAL_MS - 1,
    longestHealthySeenGapMs: 0
  });
  assert.equal(verdict.certain, false);
  assert.equal(verdict.needMs, PROBE_INTERVAL_MS);
});

test("readProbeState calls association-stopped only when the unreliable channel agrees", () => {
  // Ordered channels behind, but the unordered/no-retransmit one current:
  // head-of-line blocking in one stream, not the association.
  const streamStuck = readProbeState({
    seq: 100,
    seen: { proxy: 90, "proxy-control": 90, "proxy-fast": 99 },
    labels: ["proxy", "proxy-control", "proxy-fast"],
    echoes: 5,
    echoAgeMs: 100,
    allowed: { proxy: 2, "proxy-control": 2, "proxy-fast": 2 }
  });
  assert.equal(streamStuck.verdict, "stream-stuck");

  const associationStopped = readProbeState({
    seq: 100,
    seen: { proxy: 90, "proxy-control": 90, "proxy-fast": 90 },
    labels: ["proxy", "proxy-control", "proxy-fast"],
    echoes: 5,
    echoAgeMs: 100,
    allowed: { proxy: 2, "proxy-control": 2, "proxy-fast": 2 }
  });
  assert.equal(associationStopped.verdict, "association-stopped");
});
