/**
 * @file What a produced piece reveals, and WHOSE fact it is.
 *
 * One reading is taken — how far a produced piece began from where its grid
 * said it would — and three different facts are drawn from it, which the code
 * that draws them already stated in its own three branches:
 *
 * 1. a COPIED picture can only be cut where a keyframe already is, so a
 *    disagreement says the container's keyframe TABLE describes times the file
 *    does not have. A fact of the FILE;
 * 2. a RE-ENCODED rung was told to put a keyframe at that instant and did not,
 *    so its pieces no longer stand where the stream it accompanies would have
 *    put them. A fact of that OUTPUT;
 * 3. a SOUNDTRACK is cut exactly where it is asked to be, to within an audio
 *    frame, so it says nothing about any keyframe at all — only that the
 *    picture's grid has moved under a run already going. A fact of that OUTPUT.
 *
 * Until 2026-09-15 all three went into ONE tally, and the tally was on the cut
 * table — which is held per (file, grid), so a picture and the soundtrack muxed
 * into the same file shared it. Three consequences, and these checks are about
 * all of them: the file's finding died with a grid it does not belong to, one
 * output's reading of a piece number silenced another's reading of its own, and
 * the summary could not say which of the three facts it was summarising.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Timeline, Timelines } from "../services/output/Timeline.js";
import { Output } from "../services/output/Output.js";
import { KeyframeTable } from "../services/media/container/KeyframeTable.js";

const KEYFRAMES = [0, 4.004, 8.008, 12.012, 16.016];
const TOLERANCE = 0.25;

/**
 * @param {number[]} boundaries
 * @returns {Timeline}
 */
function timelineOver(boundaries) {
  return new Timeline({ boundaries: [...boundaries], cutGrid: "keyframe" });
}

/**
 * @returns {Output}
 */
function anOutput() {
  return new Output({
    encodeWidth: 0,
    encodeHeight: 0,
    outputFps: 25,
    softwarePreset: null,
    applyTonemap: false
  });
}

test("a picture and the soundtrack inside the same file share one cut table, and no longer one tally", () => {
  // Sharing the table is right — it is what makes them cut at the same instants
  // and is the whole reason it is held per file and grid. What must not be
  // shared is what each of them LEARNS, since the two learn different things.
  const tables = new Timelines();
  const key = Timelines.keyFor("torrent:abc", 3, "keyframe");

  const picture = tables.get(key, () => timelineOver(KEYFRAMES));
  const sound = tables.get(key, () => timelineOver(KEYFRAMES));

  assert.equal(sound, picture, "one table, so the cuts cannot drift apart");
  assert.equal(
    Object.keys(picture).some((field) => /check|tally|deviation|landing/i.test(field)),
    false,
    "and nothing on it counts what anybody found, which two outputs would have shared"
  );
});

test("two outputs each keep their own reading of the same piece number", () => {
  // `seen` exists so that a piece asked for twice is not counted twice — right
  // for one producer, and wrong across two. Shared, it dropped whichever of the
  // two finished second, so which reading survived was decided by a race.
  const picture = anOutput();
  const sound = anOutput();

  picture.noteLanding({ index: 7, deviationSec: 0.9, toleranceSec: TOLERANCE });
  sound.noteLanding({ index: 7, deviationSec: 0, toleranceSec: TOLERANCE });

  assert.equal(picture.landing.checked, 1);
  assert.equal(picture.landing.disagreed, 1, "the picture's piece did begin away from its grid");
  assert.equal(sound.landing.checked, 1, "and the sound's reading of its own #7 is not a repeat");
  assert.equal(sound.landing.disagreed, 0, "the sound was cut exactly where it was asked");

  // What `seen` is FOR, which the split must not lose: within one output a
  // piece is produced and served over and over while a viewer is refused it,
  // and the same piece is one reading however many times it is read.
  picture.noteLanding({ index: 7, deviationSec: 0.9, toleranceSec: TOLERANCE });
  picture.noteLanding({ index: 7, deviationSec: 0.9, toleranceSec: TOLERANCE });

  assert.equal(picture.landing.checked, 1, "its own repeat is still the same piece, counted once");
  assert.equal(picture.landing.disagreed, 1);
});

test("only a copy's reading reaches the file's table, and it outlives any one grid", () => {
  // The whole point of moving it: the table is one per FILE, so what a copy
  // showed about it is there for every step and every later session of those
  // bytes — while a tally on a cut table died with the grid, and a grid is not
  // what the reading is about.
  const table = new KeyframeTable().learn({ times: KEYFRAMES, format: "matroska" });

  table.witness({ index: 2, trueStart: 12.012, deviationSec: 4.004, toleranceSec: TOLERANCE });

  assert.equal(table.evidence.checked, 1);
  assert.equal(table.evidence.disagreed, 1);
  assert.equal(
    table.evidence.landedOnAnotherKeyframe,
    1,
    "and the table itself says the piece began at another time it names — the grid was built over a gap"
  );
});

test("each tally answers one question, so a summary of it cannot be a mixture", () => {
  // The distinction the three branches make when they WARN is now kept in what
  // they count, so the summary can restate it — and the summary is what is read
  // when nobody was watching the log live.
  const sound = anOutput();
  const table = new KeyframeTable().learn({ times: KEYFRAMES, format: "matroska" });

  sound.noteLanding({ index: 1, deviationSec: 0.8, toleranceSec: TOLERANCE });

  assert.equal(sound.landing.disagreed, 1, "the sound's grid moved under its run, and that is all it says");
  assert.equal(table.evidence, null, "nothing a soundtrack produced is evidence about the file's keyframes");
});
