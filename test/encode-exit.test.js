/**
 * @file The four things an ffmpeg exit can mean, by their field cases.
 *
 * Each test names the release the classification cost. None of them needs a
 * process: what went wrong in every case was the reading of the exit, not the
 * handling of it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ENCODE_EXIT, classifyEncodeExit } from "../services/encode/encode-exit.js";

test("the predecessor a seek kills says nothing about the session", () => {
  // The handler decides "is this exit mine" by comparing against the session's
  // current process — and during a restart that field still names the process
  // being killed, because the replacement is spawned afterwards. So a SIGKILLed
  // predecessor passed the check and was read as the session's own run dying:
  // a spurious "failed" that a segment request landing in that window is
  // answered 500 for, and on a hardware host a permanent downgrade to libx264.
  assert.equal(
    classifyEncodeExit({ superseded: true, code: null, inputUnavailable: false }),
    ENCODE_EXIT.IGNORED
  );
  // Including when it looks like a clean finish.
  assert.equal(classifyEncodeExit({ superseded: true, code: 0 }), ENCODE_EXIT.IGNORED);
});

test("exit 0 short of the last segment is a failure, not a finished file", () => {
  // 2.9.104. A run that had made 188 segments of 624 reported itself complete,
  // the player consumed what was on disk and froze on the first segment nobody
  // was making.
  assert.equal(
    classifyEncodeExit({ code: 0, producedThrough: 188, lastSegmentIndex: 623 }),
    ENCODE_EXIT.SHORT
  );
  assert.equal(
    classifyEncodeExit({ code: 0, producedThrough: 623, lastSegmentIndex: 623 }),
    ENCODE_EXIT.COMPLETE
  );
});

test("exit 0 is complete when there is nothing to check it against", () => {
  // No published last segment, or nothing readable on disk: the claim cannot be
  // contradicted, so it stands. Guessing "short" here would fail every session
  // whose directory could not be read.
  assert.equal(classifyEncodeExit({ code: 0, producedThrough: null, lastSegmentIndex: 623 }), ENCODE_EXIT.COMPLETE);
  assert.equal(classifyEncodeExit({ code: 0, producedThrough: 12, lastSegmentIndex: null }), ENCODE_EXIT.COMPLETE);
});

test("data that went away is recoverable, and is not an encoder fault", () => {
  // Field 2026-08-06: a torrent evicted mid-seek took the film with it, the run
  // died on `File 0 not found`, and the session answered 500 from then on while
  // the swarm was there and the data would have come back in seconds.
  assert.equal(
    classifyEncodeExit({ code: 1, inputUnavailable: true }),
    ENCODE_EXIT.INPUT_LOST
  );
  // And the distinction is what keeps a working hardware encoder: the caller
  // downgrades to software on FAILED, so an input that vanished must not
  // arrive there.
  assert.notEqual(classifyEncodeExit({ code: 1, inputUnavailable: true }), ENCODE_EXIT.FAILED);
});

test("anything else is a failure of this target", () => {
  assert.equal(classifyEncodeExit({ code: 1, inputUnavailable: false }), ENCODE_EXIT.FAILED);
  assert.equal(classifyEncodeExit({ code: null, inputUnavailable: false }), ENCODE_EXIT.FAILED);
});

test("every combination answers, and no input produces undefined", () => {
  for (const superseded of [true, false]) {
    for (const code of [0, 1, null]) {
      for (const producedThrough of [null, 0, 10]) {
        for (const lastSegmentIndex of [null, 0, 10]) {
          for (const inputUnavailable of [true, false]) {
            const answer = classifyEncodeExit({
              superseded,
              code,
              producedThrough,
              lastSegmentIndex,
              inputUnavailable
            });
            assert.ok(
              Object.values(ENCODE_EXIT).includes(answer),
              `answered ${String(answer)} for ${JSON.stringify({ superseded, code, producedThrough, lastSegmentIndex, inputUnavailable })}`
            );
          }
        }
      }
    }
  }
  assert.ok(Object.values(ENCODE_EXIT).includes(classifyEncodeExit()));
});
