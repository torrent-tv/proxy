/**
 * @file How long a run took to open its original input (torrent-tv/meta#178).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runOpenOf } from "../../services/encode/run-open.js";

/** The input's waits, on the wall clock, as `OriginalInput.waitedBefore` states them. */
const waitedBeforeOf = waits => until =>
  waits.reduce((sum, wait) => sum + Math.max(0, Math.min(wait.to ?? until, until) - wait.from), 0);

test("the wait for the stretch's copy is left out of the open, taken up to the moment the first piece was named", () => {
  // Spawned at a wall-clock time; FFmpeg's read waited 1.2 s for the copy
  // from 0.4 s after the spawn; the first piece was named 5.87 s after it.
  const startedAt = 1_791_995_000_000;
  const open = runOpenOf({
    firstNamedMs: 5870, firstNamedWallMs: 5870, startedAt,
    waitedBefore: waitedBeforeOf([{ from: startedAt + 400, to: startedAt + 1600 }]),
    pieceSeconds: 4, speed: 1.2
  });
  assert.equal(open.waitedMs, 1200);
  assert.ok(Math.abs(open.openSeconds - (4.67 - 4 / 1.2)) < 1e-9, `opened in ${open.openSeconds}s`);
});

test("a wait still going on when the first piece was named counts up to that moment", () => {
  const startedAt = 1_791_995_000_000;
  const open = runOpenOf({
    firstNamedMs: 3000, firstNamedWallMs: 3000, startedAt,
    waitedBefore: waitedBeforeOf([{ from: startedAt + 1000, to: null }]),
    pieceSeconds: 4, speed: 4
  });
  assert.equal(open.waitedMs, 2000);
  assert.equal(open.openSeconds, 0);
});

test("nothing is stated where a term is unknown, and no wait is assumed without the input's own", () => {
  assert.equal(runOpenOf({ firstNamedMs: null, firstNamedWallMs: null, startedAt: 1, waitedBefore: null, pieceSeconds: 4, speed: 1 }), null);
  assert.equal(runOpenOf({ firstNamedMs: 3000, firstNamedWallMs: 3000, startedAt: 1, waitedBefore: null, pieceSeconds: 4, speed: 0 }), null);
  assert.deepEqual(runOpenOf({ firstNamedMs: 3000, firstNamedWallMs: 3000, startedAt: 1_791_995_000_000, waitedBefore: null, pieceSeconds: 1, speed: 1 }),
    { waitedMs: 0, openSeconds: 2 });
});

test("a piece whose encoding at the measured speed exceeds the time to it is no open, not a zero one", () => {
  // r41, Home Assistant: the first piece named 6283 ms after the spawn, 4 s of
  // film, priced at 0.08x — 50 s of encoding.
  assert.equal(runOpenOf({ firstNamedMs: 6283, firstNamedWallMs: 6283, startedAt: 1_791_995_000_000, waitedBefore: null,
    pieceSeconds: 4, speed: 0.08 }), null);
  const measured = runOpenOf({ firstNamedMs: 6200, firstNamedWallMs: 6200, startedAt: 1_791_995_000_000, waitedBefore: null,
    pieceSeconds: 4, speed: 0.8 });
  assert.ok(Math.abs(measured.openSeconds - 1.2) < 1e-9, "at a measured 0.8x the open is the rest");
});
