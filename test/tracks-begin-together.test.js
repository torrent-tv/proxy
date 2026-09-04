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
import { SourceFile } from "../services/source/SourceFile.js";
import { startRunOn } from "./helpers/encode-run.js";
import { Timeline } from "../services/output/Timeline.js";
import test from "node:test";

import { HlsSessionManager } from "../services/hls-session-manager.js";
import { ENCODE_RUN_STATE, INITIAL_RUN_STATE } from "../services/encode/encode-run-state.js";

const BOUNDARIES = [0, 4, 8, 12, 16, 20];

/**
 * A film's family: the picture, and a soundtrack rendition of it. Both runs
 * begin at boundary #2, which the container's table puts at 8 s.
 *
 * @returns {{ manager: HlsSessionManager, picture: object, sound: object }}
 */
function familyAtBoundaryTwo() {
  // ONE table for the film. Where it is cut is a fact about the FILE, so the
  // picture and its soundtrack hold the same array rather than a copy each.
  const boundaries = [...BOUNDARIES];
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const picture = {
    id: "picture",
    state: "ready",
    timeline: new Timeline({ boundaries: boundaries, cutGrid: "uniform" }),
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "film.mkv" }),
    audioRenditionSessions: new Map([[1, "sound"]]),
    runs: new Set(),
    pendingRun: null,
    indexCheck: null
  };
  const sound = {
    id: "sound",
    state: "ready",
    audioOnly: true,
    baseSessionId: "picture",
    timeline: new Timeline({ boundaries: boundaries, cutGrid: "uniform" }),
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "film.mkv" }),
    runs: new Set(),
    pendingRun: null,
    indexCheck: null
  };
  startRunOn(picture, { from: 2 });
  startRunOn(sound, { from: 2 });
  manager.sessionsById.set("picture", picture);
  manager.sessionsById.set("sound", sound);

  return { manager, picture, sound };
}

test("a soundtrack follows the picture to the instant the picture really began", () => {
  const { manager, picture, sound } = familyAtBoundaryTwo();
  const runBefore = [...sound.runs][0];

  manager.correctBoundaryFromSegment(picture, 2, 10.5);

  assert.deepEqual(
    picture.timeline.boundaries,
    [0, 4, 10.5, 12, 16, 20],
    "the family's table must hold what the file itself said"
  );
  assert.equal(
    sound.timeline.boundaries[2],
    10.5,
    "and every member's table with it — one film, one table, nothing to keep in step"
  );
  // A NEW run, not a seek. A seek decides by index, finds the soundtrack
  // already begins at #2 and answers "already within the running encode" —
  // true about the index, false about the instant. The first version of this
  // fix did exactly that and moved nothing.
  //
  // The attempt is the evidence because it is what a run start claims before
  // it awaits anything: the assertion then holds without the test needing a
  // filesystem, a process, or a guess about how many ticks to wait for one.
  assert.ok(
    sound.pendingRun,
    "the soundtrack's run must be started again, at the corrected time"
  );
  assert.equal(sound.pendingRun.startIndex, 2);
  assert.equal([...sound.runs][0], runBefore, "and the run in force is only replaced once one is built");
});

test("a correction the table already holds moves nobody", () => {
  const { manager, picture, sound } = familyAtBoundaryTwo();
  const before = [...sound.timeline.boundaries];
  // Within the tolerance: the reading agrees with the table, so there is
  // nothing to correct and nothing to move. This is what makes the repositioning
  // converge instead of repeating on every produced segment.
  manager.correctBoundaryFromSegment(picture, 2, 8.1);
  assert.deepEqual(sound.timeline.boundaries, before);
});

test("a member that is not running is left alone", () => {
  const { manager, picture, sound } = familyAtBoundaryTwo();
  // A rung the viewer switched away from has no process. Moving it would start
  // an encoder for nobody — the failure that put three ffmpeg runs on one file.
  const soundRun = [...sound.runs][0];
  soundRun.stop("the viewer switched away");
  // A stopped run is no longer live, so nothing of this session begins at #2
  // any more — which is what "left alone" means here.
  manager.correctBoundaryFromSegment(picture, 2, 10.5);
  assert.equal(sound.pendingRun, null, "a stopped member is not started again for nobody");
  assert.equal(soundRun.from, 2, "a stopped member keeps its place and its silence");
  assert.equal(soundRun.state, ENCODE_RUN_STATE.STOPPED);
  assert.notEqual(INITIAL_RUN_STATE, ENCODE_RUN_STATE.STOPPED);
});

test("a soundtrack does not move the grid the picture is cut on", () => {
  const { manager, picture, sound } = familyAtBoundaryTwo();
  const pictureBefore = [...picture.timeline.boundaries];
  const soundBefore = [...sound.timeline.boundaries];

  // The sound reports where IT began, which is where it was asked to begin, to
  // within one audio frame. The picture's own boundary is a keyframe of the
  // file and can be seconds away from that — both readings correct, about
  // different things.
  //
  // Field 2026-08-20: boundary #521 of one film was corrected 2086.084 →
  // 2084.082 by the picture and 2084.082 → 2086.033 by the sound 1.6 s later,
  // 1.951 s apart, each overwriting the other for as long as the film ran. The
  // table never converged, so the guard that stops a correction the table
  // already holds never fired.
  manager.correctBoundaryFromSegment(sound, 2, 10.5);

  assert.deepEqual(
    picture.timeline.boundaries,
    pictureBefore,
    "the grid is the picture's cut list and a soundtrack may not move it"
  );
  assert.deepEqual(sound.timeline.boundaries, soundBefore);
  assert.equal(picture.pendingRun, null, "and nothing is restarted on a soundtrack's say-so");
});
