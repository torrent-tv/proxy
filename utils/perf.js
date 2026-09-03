/**
 * @file Runtime performance instrumentation.
 *
 * Exists because a field seek took minutes and every explanation offered for it
 * — encoder too slow, torrent too slow, channel too slow, event loop starved —
 * was a guess. The numbers that would have settled it were not being recorded.
 * This records them.
 *
 * Two things are measured:
 *
 *  - **Event loop delay** (`perf_hooks.monitorEventLoopDelay`). If synchronous
 *    work (torrent piece hashing, large buffer handling) blocks the loop, every
 *    read and every send waits behind it, and the symptom looks exactly like a
 *    slow network. The histogram distinguishes the two beyond argument.
 *  - **Named operation timings**, so a slow transfer can be attributed to the
 *    step that actually consumed the time rather than to the whole.
 *
 * Deliberately cheap: a histogram sampled every 20 ms, and plain arithmetic per
 * operation. No trace files, no profiler — `--trace-events-enabled` or
 * `--cpu-prof` remain available for a deeper look when these figures point
 * somewhere specific.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";

const NANOSECONDS_PER_MILLISECOND = 1e6;
// Sampling interval for the loop-delay histogram. 20 ms is fine enough to catch
// the stalls that matter (tens of ms and up) without measurable overhead.
const LOOP_SAMPLE_INTERVAL_MS = 20;

const loopDelay = monitorEventLoopDelay({ resolution: LOOP_SAMPLE_INTERVAL_MS });
loopDelay.enable();

/**
 * Event-loop delay since the last {@link resetEventLoopDelay}, in milliseconds.
 *
 * `mean` is the everyday cost; `max` and `p99` are what a single blocking spell
 * does to whatever was waiting. A transfer that looks network-bound but shows a
 * large `max` here was not network-bound at all.
 *
 * @returns {{ meanMs: number, p99Ms: number, maxMs: number }}
 */
export function eventLoopDelay() {
  return {
    meanMs: loopDelay.mean / NANOSECONDS_PER_MILLISECOND,
    p99Ms: loopDelay.percentile(99) / NANOSECONDS_PER_MILLISECOND,
    maxMs: loopDelay.max / NANOSECONDS_PER_MILLISECOND
  };
}

/**
 * Start a fresh measurement window for the loop-delay histogram, so a reported
 * figure describes one operation rather than the process's whole lifetime.
 *
 * @returns {void}
 */
export function resetEventLoopDelay() {
  loopDelay.reset();
}
