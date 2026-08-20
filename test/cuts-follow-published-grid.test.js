/**
 * @file A run cuts where the player was told the cuts are.
 *
 * There are two boundary tables. The live one is corrected as produced segments
 * reveal where the file's cuts truly are; the published one is the snapshot the
 * playlist text was written from, and a player places every fragment by that
 * text and nothing else. The cut list handed to ffmpeg used to come from the
 * live table, so every correction moved the run away from the timeline the
 * player is reading.
 *
 * Field 2026-08-20, `Minions.and.Monsters.1080p.mkv`: the picture's segments
 * arrived a uniform 2.002 s before the times its playlist named — 119 of 125 of
 * them — against the 0.5 s hls.js bridges. A fragment that does not land is
 * fetched again, and on 2026-08-17 two of them were fetched 1908 times each.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { HlsSessionManager, segmentCutTimesFrom } from "../services/hls-session-manager.js";

/** What the playlist in the player's hands says. */
const PUBLISHED = [0, 4.004, 8.008, 12.012, 16.016, 20.02];
/** The same grid after produced segments moved two of its cuts. */
const CORRECTED = [0, 4.004, 6.006, 12.012, 14.014, 20.02];

/**
 * A session that has published one grid and since corrected another.
 *
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

test("the cut list is the one the playlist was written from", () => {
  const { manager, session } = sessionWithDriftedGrid();
  const grid = manager.publishedGridFor(session);
  assert.deepEqual(grid, PUBLISHED);
  // Interior cuts of a run starting at #1, rebased on the run's own start
  // (4.004 s), and stopping before the last entry, which is the file's end.
  assert.deepEqual(
    segmentCutTimesFrom(grid, 1).map((time) => Number(time.toFixed(3))),
    [4.004, 8.008, 12.012]
  );
});

test("a corrected grid does not move the cuts of a session already being read", () => {
  const { manager, session } = sessionWithDriftedGrid();
  const fromCorrected = segmentCutTimesFrom(session.segmentBoundaries, 1);
  const fromPublished = segmentCutTimesFrom(manager.publishedGridFor(session), 1);
  assert.notDeepEqual(fromCorrected, fromPublished);
  // The gap the field measured: the corrected table would have cut #2 two
  // seconds early, which is four times what a player bridges.
  assert.equal(Number((fromPublished[0] - fromCorrected[0]).toFixed(3)), 2.002);
});

test("a session that published no grid falls back to the live one", () => {
  const { manager } = sessionWithDriftedGrid();
  const session = { id: "no-playlist", segmentBoundaries: [...CORRECTED], publishedBoundaries: [] };
  assert.deepEqual(manager.publishedGridFor(session), CORRECTED);
});
