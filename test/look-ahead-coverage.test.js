/**
 * @file What "the encoder is ahead of the viewer" actually means.
 *
 * It was measured as the highest segment number lying in the session's
 * directory. That equals the look-ahead only while a viewer moves forward
 * through one encoder run, and the difference destroyed a session on
 * 2026-08-06: a seek forward left segments 662-665 on disk, the viewer then
 * seeked BACK to 646, and the limiter compared 6950 s of output against a
 * viewer at 6700 s, called it "250s ahead", and suspended a run 136 ms after it
 * started — before it had produced anything. With the encoder stopped nothing
 * read the input, so no pieces were requested (`0 selection(s)` with 33 peers
 * connected) and segment 646 was never made. The viewer sat on a spinner while
 * a stopped ffmpeg was held for being "too far ahead".
 *
 * The measure is the unbroken run of segments starting where the viewer is.
 * Segments beyond a hole are not look-ahead: the viewer cannot reach them until
 * the hole is filled.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { contiguousEnd } from "../services/hls-session-manager.js";

test("an unbroken run reports its last segment", () => {
  assert.equal(contiguousEnd(new Set([10, 11, 12, 13]), 10), 13);
});

test("a hole stops the count, whatever lies beyond it", () => {
  assert.equal(
    contiguousEnd(new Set([10, 11, 662, 663, 664, 665]), 10),
    11,
    "segments past a gap are unreachable and must not count as ready"
  );
});

test("the field case: a backward seek onto a segment nobody has made", () => {
  // What the directory held after the forward seek, and where the viewer went.
  const onDisk = new Set([661, 662, 663, 664, 665]);
  assert.equal(
    contiguousEnd(onDisk, 646),
    null,
    "the viewer's own segment is missing — that is a wait, not a look-ahead"
  );
});

test("a single segment counts as itself", () => {
  assert.equal(contiguousEnd(new Set([5]), 5), 5);
});

test("nothing on disk is not zero ahead — it is unknown", () => {
  assert.equal(
    contiguousEnd(new Set(), 0),
    null,
    "zero and null lead to opposite decisions: pause versus encode now"
  );
});
