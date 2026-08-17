/**
 * @file Picture and sound must begin their runs at the same real instant.
 *
 * The two branches are asked for the same time and land in different places: a
 * copied picture may only begin at a real keyframe and may not begin before the
 * time asked for, so it moves FORWARD to the next one; a soundtrack has no
 * keyframes and begins exactly where asked. Measured 2026-08-17, the difference
 * was 0.58-2.96 s on one file, and the viewer got sound with no new picture for
 * as long as it lasted.
 *
 * The picture's true start is measured from the piece it produced. This pins
 * that the measurement is carried to the other members of the family.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { HlsSessionManager } from "../services/hls-session-manager.js";
import { ENCODE_RUN_STATE, INITIAL_RUN_STATE } from "../services/encode-run-state.js";

const BOUNDARIES = [0, 4, 8, 12, 16, 20];

/**
 * A film's family: the picture, and a soundtrack rendition of it. Both runs
 * begin at boundary #2, which the container's table puts at 8 s.
 *
 * @returns {{ manager: HlsSessionManager, picture: object, sound: object }}
 */
function familyAtBoundaryTwo() {
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const picture = {
    id: "picture",
    state: "ready",
    runState: ENCODE_RUN_STATE.PRODUCING,
    segmentBoundaries: [...BOUNDARIES],
    encodeStartIndex: 2,
    audioRenditionSessions: new Map([[1, "sound"]]),
    indexCheck: null
  };
  const sound = {
    id: "sound",
    state: "ready",
    runState: ENCODE_RUN_STATE.PRODUCING,
    audioOnly: true,
    baseSessionId: "picture",
    segmentBoundaries: [...BOUNDARIES],
    encodeStartIndex: 2,
    runSerial: 0,
    indexCheck: null
  };
  manager.sessionsById.set("picture", picture);
  manager.sessionsById.set("sound", sound);

  return { manager, picture, sound };
}

test("a soundtrack follows the picture to the instant the picture really began", () => {
  const { manager, picture, sound } = familyAtBoundaryTwo();
  const runsBefore = sound.runSerial;

  manager.correctBoundaryFromSegment(picture, 2, 10.5);

  assert.deepEqual(
    picture.segmentBoundaries,
    [0, 4, 10.5, 12, 16, 20],
    "the family's table must hold what the file itself said"
  );
  assert.equal(
    sound.segmentBoundaries[2],
    10.5,
    "and every member's table with it — one film, one timeline"
  );
  // A NEW run, not a seek. A seek decides by index, finds the soundtrack
  // already begins at #2 and answers "already within the running encode" —
  // true about the index, false about the instant. The first version of this
  // fix did exactly that and moved nothing.
  //
  // `runSerial` is the evidence because it is the first thing a run start
  // writes, before it awaits anything: the assertion then holds without the
  // test needing a filesystem, a process, or a guess about how many ticks to
  // wait for one.
  assert.equal(
    sound.runSerial,
    runsBefore + 1,
    "the soundtrack's run must be started again, at the corrected time"
  );
});

test("a correction the table already holds moves nobody", () => {
  const { manager, picture, sound } = familyAtBoundaryTwo();
  const before = [...sound.segmentBoundaries];
  // Within the tolerance: the reading agrees with the table, so there is
  // nothing to correct and nothing to move. This is what makes the repositioning
  // converge instead of repeating on every produced segment.
  manager.correctBoundaryFromSegment(picture, 2, 8.1);
  assert.deepEqual(sound.segmentBoundaries, before);
});

test("a member that is not running is left alone", () => {
  const { manager, picture, sound } = familyAtBoundaryTwo();
  // A rung the viewer switched away from has no process. Moving it would start
  // an encoder for nobody — the failure that put three ffmpeg runs on one file.
  sound.runState = ENCODE_RUN_STATE.STOPPED;
  manager.correctBoundaryFromSegment(picture, 2, 10.5);
  assert.equal(sound.runSerial, 0, "a stopped member is not started again for nobody");
  assert.equal(sound.encodeStartIndex, 2, "a stopped member keeps its place and its silence");
  assert.equal(sound.runState, ENCODE_RUN_STATE.STOPPED);
  assert.notEqual(INITIAL_RUN_STATE, ENCODE_RUN_STATE.STOPPED);
});
