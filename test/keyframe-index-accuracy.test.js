/**
 * @file How well a container's keyframe index describes its own file.
 *
 * The cut times of a copied video ARE its index — ffmpeg can only cut where a
 * keyframe already is — and an index can be wrong: measured 2026-08-06, one
 * claimed a keyframe at 157.99 s where the real ones were 153.82 and 164.247.
 * Whether a re-encoded rung can be cut on that same grid and spliced into the
 * copy depends entirely on how often that happens, so it is counted.
 *
 * No scan is involved and no undownloaded byte is touched: each produced piece
 * states where it truly begins, and it is already read whole in order to be
 * stamped. Only boundaries that were actually produced are counted — the parts
 * somebody watched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { newIndexCheck, noteIndexDeviation } from "../services/hls-session-manager.js";

test("an index that describes its file exactly is reported as such", () => {
  const check = newIndexCheck();

  for (let index = 0; index < 4; index += 1) {
    noteIndexDeviation(check, index, 0);
  }

  assert.equal(check.checked, 4);
  assert.equal(check.disagreed, 0, "nothing disagreed — which is a finding, not silence");
  assert.equal(check.maxDeviationSec, 0);
});

test("a boundary the index placed wrongly is counted, with how far out it was", () => {
  const check = newIndexCheck();

  noteIndexDeviation(check, 0, 0);
  // The measured shape: the playlist said 157.99 s, the file cut at 153.82 s.
  noteIndexDeviation(check, 2, 4.17);
  noteIndexDeviation(check, 3, 0.01);

  assert.equal(check.checked, 3);
  assert.equal(check.disagreed, 1);
  assert.equal(check.firstDisagreementIndex, 2);
  assert.equal(
    check.maxDeviationSec,
    4.17,
    "the size of the error is what decides whether a rung can be cut on this grid"
  );
});

test("a deviation within tolerance is not a disagreement, but still shows in the worst case", () => {
  const check = newIndexCheck();

  noteIndexDeviation(check, 0, 0.2);

  assert.equal(check.disagreed, 0, "rounding in a container's timestamps is not the index being wrong");
  assert.equal(check.maxDeviationSec, 0.2, "and it is still worth knowing how close to the line it ran");
});

test("a segment requested again is not new evidence", () => {
  const check = newIndexCheck();

  noteIndexDeviation(check, 1, 0.9);
  noteIndexDeviation(check, 1, 0.9);
  noteIndexDeviation(check, 1, 0.9);

  assert.equal(check.checked, 1, "a repeat request is the same boundary, counted once");
  assert.equal(check.disagreed, 1);
});
