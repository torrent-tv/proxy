/**
 * @file When a run asks for the input of the run after it (torrent-tv/meta#178).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { nextInputAtFirstPiece } from "../../services/encode/next-input.js";

test("the next input waits for the first piece when the rest of the run leaves the time to prepare it", () => {
  // 104 s of film after the first piece at 2.4x is 43 s; an input of this
  // output was ready 0.5 s after it was asked for.
  assert.equal(nextInputAtFirstPiece({ preparedInMs: 500, speed: 2.4, restSeconds: 104 }), true);
});

test("it is asked at once when preparing takes longer than the rest of the run, or nothing is known", () => {
  // 4 s of film after the first piece at 1.07x is 3.7 s; the last input took 3.96 s.
  assert.equal(nextInputAtFirstPiece({ preparedInMs: 3960, speed: 1.07, restSeconds: 4 }), false);
  assert.equal(nextInputAtFirstPiece({ preparedInMs: 500, speed: 2.4, restSeconds: 0 }), false, "a run of one piece: its first is its last");
  assert.equal(nextInputAtFirstPiece({ preparedInMs: null, speed: 2.4, restSeconds: 104 }), false, "no input prepared yet");
  assert.equal(nextInputAtFirstPiece({ preparedInMs: 500, speed: 0, restSeconds: 104 }), false, "no speed known");
});
