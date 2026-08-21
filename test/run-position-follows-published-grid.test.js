/**
 * @file A run is POSITIONED where the player was told the segment begins.
 *
 * The companion of `cuts-follow-published-grid`, and the half that was missing.
 * 2.45.0 moved the cut list onto the published table and left the position on
 * the live one — but `-segment_times` are measured from wherever the run really
 * began, so any distance between the two moves EVERY cut of that run by it. The
 * live table keeps being corrected, and the corrections run backwards, so each
 * restart began a little earlier than the grid its cuts were stated on and the
 * distance accumulated across restarts.
 *
 * Field 2026-08-21, `JUFD665.mp4` (MP4, copy path, index read cleanly): after
 * one seek restart a produced segment held the boundary two places before its
 * own number — 16.684 s, which is 2.0000 segments — and after the next restart,
 * four places, 33.5 s. The player's buffer then stopped extending at all,
 * because every fragment's content landed before the time its playlist entry
 * named: `bufferEnd` stood still at 4571.1 s through four `frag-far` warnings
 * until hls.js gave up and jumped the viewer 16.8 s forward.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { HlsSessionManager, describeGridDrift, segmentCutTimesFrom } from "../services/hls-session-manager.js";

/** What the playlist in the player's hands says. */
const PUBLISHED = [0, 8.342, 16.684, 25.026, 33.368, 41.71];
/** The same grid after produced segments moved two of its cuts backwards. */
const CORRECTED = [0, 8.342, 14.682, 25.026, 31.366, 41.71];

/**
 * @returns {{ manager: HlsSessionManager, session: object }}
 */
function sessionWithDriftedGrid() {
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const session = {
    id: "picture",
    segmentBoundaries: [...CORRECTED],
    publishedBoundaries: [...PUBLISHED]
  };
  return { manager, session };
}

test("a run starts at the time the player was told, not at the corrected one", () => {
  const { manager, session } = sessionWithDriftedGrid();
  assert.equal(manager.runStartTimeFor(session, 2), 16.684);
  assert.notEqual(manager.runStartTimeFor(session, 2), session.segmentBoundaries[2]);
});

test("position and cut list come from the same table", () => {
  const { manager, session } = sessionWithDriftedGrid();
  const grid = manager.publishedGridFor(session);
  const start = manager.runStartTimeFor(session, 2);
  // The cut list is stated as offsets from where the run begins. Adding the
  // position back must land on the published boundaries exactly — which is the
  // property that was false while the two came from different tables.
  const absolute = segmentCutTimesFrom(grid, 2).map((offset) => Number((start + offset).toFixed(3)));
  assert.deepEqual(absolute, [25.026, 33.368]);
});

test("a session that published no grid positions on the live one", () => {
  const { manager } = sessionWithDriftedGrid();
  const session = { id: "no-playlist", segmentBoundaries: [...CORRECTED], publishedBoundaries: [] };
  assert.equal(manager.runStartTimeFor(session, 2), CORRECTED[2]);
});

test("an index beyond the table is clamped rather than returning nothing", () => {
  const { manager, session } = sessionWithDriftedGrid();
  assert.equal(manager.runStartTimeFor(session, 9999), PUBLISHED[PUBLISHED.length - 1]);
  assert.equal(manager.runStartTimeFor(session, -3), PUBLISHED[0]);
});

test("the drift between the two tables is stated in full", () => {
  assert.equal(describeGridDrift(PUBLISHED, PUBLISHED), "identical");
  assert.equal(
    describeGridDrift(PUBLISHED, CORRECTED),
    "2 of 6 boundaries apart, worst 2.002s at #2"
  );
  assert.equal(describeGridDrift(PUBLISHED, [0, 1]), "a different length (6 against 2)");
  assert.equal(describeGridDrift(null, CORRECTED), "not comparable");
  assert.equal(describeGridDrift([], []), "not comparable");
});
