import test from "node:test";
import assert from "node:assert/strict";

import { readProbeState, MISSES_FOR_VERDICT, UNRELIABLE_LABEL } from "../services/delivery-probe.js";

const ORDERED = ["proxy", "proxy-control"];
const ALL = [...ORDERED, UNRELIABLE_LABEL];

/**
 * @param {Record<string, number>} seen
 * @param {object} [overrides]
 */
function state(seen, overrides = {}) {
  return {
    seq: 100,
    seen,
    labels: ALL,
    echoes: 5,
    echoAgeMs: 400,
    ...overrides
  };
}

test("every channel current reads as flowing", () => {
  const { verdict } = readProbeState(state({ proxy: 100, "proxy-control": 99, "proxy-fast": 100 }));
  assert.equal(verdict, "flowing");
});

test("a lag shorter than the verdict window is still flowing", () => {
  const behind = 100 - (MISSES_FOR_VERDICT - 1);
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
  assert.match(detail, /proxy=40\(gap 60\)/);
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
  assert.match(detail, /proxy=\?\(gap \?\)/);
});
