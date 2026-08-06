/**
 * @file The host's own timings must reach the browser for the file that needs
 * them most.
 *
 * The plan carries two figures the browser cannot measure for itself: how long
 * this host takes to create a session, and how long it takes to produce a first
 * segment. Both are medians of sessions that have already finished here, so at
 * the moment a plan is BUILT the very first file opened after a restart has
 * neither — and the plan is cached, so that file kept answering `null` for the
 * life of the process however many sessions ran afterwards. Measured
 * 2026-08-05: a fresh proxy answered `null` for both, then created the session
 * in 6 ms and produced the first segment in 21 479 ms.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createPlaybackPlanner } from "../services/playback-planner.js";

/**
 * A planner whose host timings can be changed between calls, over a source that
 * needs no torrent: transcoding disabled short-circuits to a cached direct plan
 * without probing anything.
 */
function plannerWithTimings() {
  const timings = { create: null, first: null };
  const planner = createPlaybackPlanner({
    ffmpegBin: "ffmpeg",
    localBaseUrl: "http://127.0.0.1:9090/stream",
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "magnet:?xt=urn:btih:0" }) },
    torrentPool: { getTorrent: async () => ({ files: [{ name: "a.mkv", length: 10 }] }) },
    transcodeAudioEnabled: false,
    expectedSessionCreateMs: () => timings.create,
    expectedFirstSegmentMs: () => timings.first
  });
  return { planner, timings };
}

test("a plan built before the host had measured anything still reports them later", async () => {
  const { planner, timings } = plannerWithTimings();

  const cold = await planner.getPlan({ sourceKey: "src", fileIndex: 0 });
  assert.equal(cold.expectedSessionCreateMs, null, "nothing has finished yet, so there is nothing to report");
  assert.equal(cold.expectedFirstSegmentMs, null);

  // Sessions run; the host now knows what it costs.
  timings.create = 6;
  timings.first = 21_479;

  const warm = await planner.getPlan({ sourceKey: "src", fileIndex: 0 });
  assert.equal(
    warm.expectedSessionCreateMs,
    6,
    "the cached plan withheld the figure the browser needed"
  );
  assert.equal(warm.expectedFirstSegmentMs, 21_479);
});

test("the figures follow the host as they change", async () => {
  const { planner, timings } = plannerWithTimings();
  timings.create = 100;
  timings.first = 800;
  const first = await planner.getPlan({ sourceKey: "src", fileIndex: 0 });
  assert.equal(first.expectedFirstSegmentMs, 800);

  timings.first = 7_000; // a re-encode session — an order of magnitude slower
  const later = await planner.getPlan({ sourceKey: "src", fileIndex: 0 });
  assert.equal(later.expectedFirstSegmentMs, 7_000, "the plan reported a stale figure");
});
