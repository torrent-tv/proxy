/**
 * The playlist and the real segments must describe the same thing.
 *
 * They did not. The playlist was built from the container index while ffmpeg
 * chose its own cut points from a target duration, and the two only ever agreed
 * by luck — on a field file the index listed 1902 keyframes, ffmpeg found about
 * twice as many, and segment #876 meant 1:26:50 to the player and roughly
 * minute 58 to ffmpeg. Seeks landed nowhere near where they were aimed.
 *
 * These tests pin the arithmetic that ties the two together.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { segmentCutTimesFrom } from "../services/hls-session-manager.js";

test("cut times are the interior boundaries, rebased on the run start", () => {
  // Segments 0-10, 10-20, 20-30, 30-40 (file ends at 40).
  const boundaries = [0, 10, 20, 30, 40];

  assert.deepEqual(
    segmentCutTimesFrom(boundaries, 0),
    [10, 20, 30],
    "from the start, the cuts are every boundary except 0 and the file end"
  );

  // Restarting at segment 2 means the run begins at 20 s; a cut at 30 s is 10 s
  // into the run. Sending 30 would put it at 50 — `-segment_times` counts from
  // the run, which is what made a seek land in the wrong place.
  assert.deepEqual(
    segmentCutTimesFrom(boundaries, 2),
    [10],
    "after a restart the times must be relative to where the run starts"
  );
});

test("uneven, real-world boundaries survive the rebasing exactly", () => {
  // Keyframes never land on round numbers; rounding here is what would push a
  // cut past its keyframe and silently double a segment.
  // Starting at segment 1 leaves segments 1, 2 and 3 — three segments, so two
  // cuts between them, each measured from the run start at 10.427.
  const boundaries = [0, 10.427, 20.854, 31.281, 41.708];
  assert.deepEqual(segmentCutTimesFrom(boundaries, 1), [10.427, 20.854]);
});

test("boundaries that cannot serve are refused rather than half-used", () => {
  assert.equal(segmentCutTimesFrom(null, 0), null);
  assert.equal(segmentCutTimesFrom([], 0), null);
  assert.equal(segmentCutTimesFrom([0], 0), null, "a single boundary describes no segment");
  assert.equal(
    segmentCutTimesFrom([0, 10, 20], 2),
    null,
    "a start index at or past the last boundary has no run to describe"
  );
});

test("the final run has no interior cuts and asks for none", () => {
  assert.deepEqual(
    segmentCutTimesFrom([0, 10, 20], 1),
    [],
    "starting at the last segment leaves nothing to cut, which is not an error"
  );
});
