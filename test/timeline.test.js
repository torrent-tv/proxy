/**
 * @file Where a file is cut is a fact about the FILE, held once.
 *
 * Every quality step of one film has to be cut at exactly the same times, and
 * every session serving it has to publish the same playlist. That agreement was
 * arranged by COPYING — a table handed to each new session at creation — and it
 * drifted twice in the field: 0.6-2.9 s between two sessions of one film on
 * 2026-08-17, and segments arriving a uniform 2.002 s before the times the
 * playlist named for them on 2026-08-20, four times what a player bridges.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Timeline, Timelines } from "../services/output/Timeline.js";

/**
 * @returns {Timeline}
 */
function fourSecondGrid() {
  return new Timeline({
    boundaries: [0, 4, 8, 12, 16],
    cutGrid: "keyframe",
    totalDurationSeconds: 16,
    keyframeTimes: [0, 4, 8, 12],
    keyframeTolerance: 0.25,
    containerFormat: "matroska"
  });
}

test("the table the player was given does not move when the live one is corrected", () => {
  const timeline = fourSecondGrid();

  // A produced segment says where the file's cut really is. That corrects what
  // a run will cut at; it must never correct what the player was told, because
  // the player places a fragment by the playlist it holds and that text was
  // written once.
  timeline.boundaries[2] = 8.5;

  assert.equal(timeline.liveStartOf(2), 8.5);
  assert.equal(timeline.publishedStartOf(2), 8);
});

test("one file and grid answer with one table, whoever asks", () => {
  const timelines = new Timelines();
  const key = Timelines.keyFor("torrent:abc", 0, "keyframe");

  const first = timelines.get(key, fourSecondGrid);
  const second = timelines.get(key, () => {
    throw new Error("a second table would be the drift this exists to remove");
  });

  assert.equal(second, first);
  // A correction found by one session is seen by every other, because there is
  // nothing to keep in step.
  first.boundaries[1] = 4.5;
  assert.equal(second.liveStartOf(1), 4.5);
});

test("the same file cut two ways is two tables", () => {
  const timelines = new Timelines();
  const onKeyframes = timelines.get(Timelines.keyFor("torrent:abc", 0, "keyframe"), fourSecondGrid);
  const onTheEvenGrid = timelines.get(Timelines.keyFor("torrent:abc", 0, "uniform"), fourSecondGrid);

  assert.notEqual(onTheEvenGrid, onKeyframes);
});

test("which segment holds a moment", () => {
  const timeline = fourSecondGrid();

  assert.equal(timeline.indexForTime(0), 0);
  assert.equal(timeline.indexForTime(3.9), 0);
  assert.equal(timeline.indexForTime(4), 1);
  assert.equal(timeline.indexForTime(15.9), 3);
  assert.equal(timeline.indexForTime(99), 3, "past the end is the last segment, not an error");
});

test("a produced segment that began where the table said is not counted against it", () => {
  const timeline = fourSecondGrid();

  timeline.noteProducedStart(1, 4.1);
  assert.equal(timeline.indexCheck.produced, 1);
  assert.equal(timeline.indexCheck.awayFromGrid, 0, "inside the tolerance the file itself declares");

  timeline.noteProducedStart(2, 12);
  assert.equal(timeline.indexCheck.awayFromGrid, 1);
  assert.equal(timeline.indexCheck.first, 2);
  assert.equal(
    timeline.indexCheck.atAnotherKeyframe,
    1,
    "it began at a keyframe the table names, just not the one for its own number"
  );
});

test("a timeline nobody holds is dropped", () => {
  const timelines = new Timelines();
  const kept = timelines.get(Timelines.keyFor("torrent:abc", 0, "keyframe"), fourSecondGrid);
  timelines.get(Timelines.keyFor("torrent:xyz", 0, "keyframe"), fourSecondGrid);

  assert.equal(timelines.size, 2);
  assert.equal(timelines.forgetUnused(new Set([kept])), 1);
  assert.equal(timelines.size, 1);
});
