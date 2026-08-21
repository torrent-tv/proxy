/**
 * @file Ask ffmpeg late enough that it lands where we meant.
 *
 * `fftools/ffmpeg_demux.c` moves an input seek back by `3*AV_TIME_BASE / 23` —
 * 130.435 ms — whenever the container does not declare `AVFMT_SEEK_TO_PTS` and
 * a stream carries B-frames. So asking for a keyframe lands on the one before
 * it, and since `-segment_times` is measured from where the run really began,
 * every cut of that run inherits the shift.
 *
 * Measured 2026-08-21 on Matroska with keyframes every 2 s: `-ss 10` produced a
 * first segment starting at 8.000, `-ss 10.130435` one starting at 10.000. On
 * MP4, where the heuristic does not fire, 10, 10.130435 and 10.2 all produced
 * 10.000 — right in one case, harmless in the other.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { seekLandingOffsetFor } from "../services/hls-session-manager.js";

const OFFSET = 3 / 23;

test("a copied picture is asked for one heuristic later than the keyframe", () => {
  const session = { transcodeVideo: false, keyframeTimes: [0, 2.002, 4.004, 6.006] };
  assert.equal(seekLandingOffsetFor(session, 2.002), OFFSET);
});

test("a re-encode is asked for exactly what it should produce", () => {
  // It decodes from the keyframe and discards frames up to the requested time,
  // so pushing the request later would start its output late.
  const session = { transcodeVideo: true, keyframeTimes: [0, 2.002, 4.004] };
  assert.equal(seekLandingOffsetFor(session, 2.002), 0);
});

test("the offset never reaches the next keyframe", () => {
  // Keyframes 0.1 s apart: half of that is the most that can be added without
  // risking a landing on the NEXT one where the heuristic does not fire.
  const session = { transcodeVideo: false, keyframeTimes: [0, 0.1, 0.2, 0.3] };
  assert.equal(seekLandingOffsetFor(session, 0.1), 0.05);
});

test("the last keyframe has nothing after it to collide with", () => {
  const session = { transcodeVideo: false, keyframeTimes: [0, 2.002, 4.004] };
  assert.equal(seekLandingOffsetFor(session, 4.004), OFFSET);
});

test("no keyframe list is still answered", () => {
  assert.equal(seekLandingOffsetFor({ transcodeVideo: false }, 5), OFFSET);
  assert.equal(seekLandingOffsetFor(null, 5), OFFSET);
});

test("a grid whose times are approximate is asked for that much later again", () => {
  // AVI names a keyframe by its frame NUMBER and the time is that number times
  // the frame duration, so a name can sit just BELOW the keyframe it refers to
  // — measured 2026-08-21, 10-44 ms out on two files, always under one frame.
  // Asking at the name alone would seek to before the real keyframe and land on
  // the one before that, which is the fault this offset exists for.
  const session = {
    transcodeVideo: false,
    keyframeTolerance: 0.04,
    keyframeTimes: [0, 4.004, 8.008, 12.012]
  };
  assert.equal(seekLandingOffsetFor(session, 4.004), OFFSET + 0.04);
});

test("an exact grid claims no tolerance", () => {
  // Matroska and MP4 state instants outright — measured the same day, nine
  // files and 11 665 keyframes with not one disagreement.
  const session = { transcodeVideo: false, keyframeTolerance: 0, keyframeTimes: [0, 4.004, 8.008] };
  assert.equal(seekLandingOffsetFor(session, 4.004), OFFSET);
});

test("the bound still holds once a tolerance is added", () => {
  const session = { transcodeVideo: false, keyframeTolerance: 1, keyframeTimes: [0, 0.1, 0.2] };
  assert.equal(seekLandingOffsetFor(session, 0.1), 0.05);
});
