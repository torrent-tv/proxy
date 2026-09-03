/**
 * @file Where a viewer's resume position falls in the file, in bytes.
 *
 * The warm-up fetches a file's two edges, because that is what the codec probe
 * reads. The region the VIEWER will resume at was asked for by nobody until the
 * encoder opened its input — field 2026-09-03, 53 s after the Retry button on a
 * cold torrent, and the piece it then needed took another 46.3 s to arrive.
 * Turning the position into an offset is the only arithmetic in that path, so it
 * is the only part with anything to get wrong.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resumeByteOffset } from "../services/torrent-worker/container-tracks.js";

test("a position halfway through a film is halfway through its file", () => {
  assert.equal(resumeByteOffset(1000, 100, 50), 500);
});

test("the field case lands where the encoder went looking", () => {
  // The measured session: 171.338 s into a 23:41 episode of 541 MB, and the
  // read that blocked was at 63 MB.
  const at = resumeByteOffset(541 * 1024 * 1024, 23 * 60 + 41, 171.338);
  const megabytes = at / (1024 * 1024);
  assert.ok(megabytes > 60 && megabytes < 68, `landed at ${megabytes.toFixed(1)}MB`);
});

test("a position past the end reads the end, rather than past it", () => {
  const length = 1000;
  const at = resumeByteOffset(length, 100, 10_000);
  assert.equal(at, length - 1);
});

test("nothing is known, nothing is guessed", () => {
  assert.equal(resumeByteOffset(0, 100, 50), 0, "no file length");
  assert.equal(resumeByteOffset(1000, 0, 50), 0, "no duration — the container did not declare one");
  assert.equal(resumeByteOffset(1000, 100, 0), 0, "the viewer is at the beginning, where the edges already are");
});
