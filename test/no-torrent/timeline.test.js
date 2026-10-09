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
import { Timeline, Timelines } from "../../services/encode/output/Timeline.js";
import { PacketIndex } from "../../services/media/container/PacketIndex.js";

test("segment demand preserves urgent preparation independently of equal priorities and deadlines", () => {
  const timeline = new Timeline({ boundaries: [0, 4, 8, 12], cutGrid: "uniform" });
  const map = { durationSeconds: 12, priority: new Uint8Array(12).fill(100),
    secondsUntilPlayed: Float64Array.from({ length: 12 }, (_, index) => index),
    behind: new Uint8Array(12), urgent: Uint8Array.from({ length: 12 }, (_, index) => index < 8 ? 1 : 0) };
  assert.deepEqual(timeline.inSegments(map, 3), [
    { from: 0, to: 1, priority: 100, withinSeconds: 0, urgent: true, behind: false },
    { from: 2, to: 2, priority: 100, withinSeconds: 8, urgent: false, behind: false }
  ]);
  map.urgent.fill(0);
  assert.deepEqual(timeline.inSegments(map, 3), [
    { from: 0, to: 2, priority: 100, withinSeconds: 0, urgent: false, behind: false }
  ]);
});

test("packet admission uses exact source cuts rather than rounded playlist boundaries", () => {
  const cuts = [0, 13.5, 605 / 24, 30];
  const timeline = new Timeline({ boundaries: cuts.map(time => Number(time.toFixed(6))),
    sourceTimes: cuts, cutGrid: "keyframe" });
  const index = new PacketIndex();
  index.declareTrack(1, { type: "video" });
  for (let n = 0; n < cuts.length - 1; n++) index.append(1, {
    pts: cuts[n], duration: cuts[n + 1] - cuts[n], keyframe: true, ranges: [[n * 10, n * 10 + 9]]
  });
  index.complete(1);
  assert.equal(index.inputFor({ trackId: 1, from: timeline.publishedStartOf(1),
    to: timeline.publishedStartOf(2), mode: "copy" }).reason, "video-copy-cut-is-not-a-keyframe");
  assert.equal(index.inputFor({ trackId: 1, ...timeline.sourceInterval(1, 1), mode: "copy" }).kind, "result");
  assert.deepEqual(timeline.sourceInterval(1, 1, 2), { from: 15.5, to: cuts[2] + 2 });
  assert.deepEqual(new Timeline({ boundaries: [0, 4, 8], cutGrid: "uniform" }).sourceInterval(1, 1, 2),
    { from: 6, to: 10 });
});

/**
 * @returns {Timeline}
 */
function fourSecondGrid() {
  // Only what is per grid. The container's own keyframe table, how exact it is,
  // which container answered and how long the file runs are facts of the FILE
  // and live on the source file — stating them here stated nothing.
  return new Timeline({
    boundaries: [0, 4, 8, 12, 16],
    cutGrid: "keyframe"
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

test("a timeline nobody holds is dropped", () => {
  const timelines = new Timelines();
  const kept = timelines.get(Timelines.keyFor("torrent:abc", 0, "keyframe"), fourSecondGrid);
  timelines.get(Timelines.keyFor("torrent:xyz", 0, "keyframe"), fourSecondGrid);

  assert.equal(timelines.size, 2);
  assert.equal(timelines.forgetUnused(new Set([kept])), 1);
  assert.equal(timelines.size, 1);
});

test("a copied piece is wanted by the second its end falls in, because a copy runs past its end", () => {
  // MP3 copied out of an AVI on a 4 s grid ended up to 24 ms past each cut, and
  // the player placed the next piece there: a viewer at 8 s asked for the piece
  // ending at 8 s (field 2026-10-09, torrent-tv/meta#159).
  const timeline = new Timeline({ boundaries: [0, 4, 8, 12], cutGrid: "uniform" });
  const map = { durationSeconds: 12, priority: Uint8Array.from({ length: 12 }, (_, second) => second >= 8 ? 100 : 1),
    secondsUntilPlayed: Float64Array.from({ length: 12 }, (_, second) => Math.max(0, second - 8)),
    behind: Uint8Array.from({ length: 12 }, (_, second) => second < 8 ? 1 : 0), urgent: new Uint8Array(12) };
  assert.deepEqual(timeline.inSegments(map, 3), [
    { from: 0, to: 1, priority: 1, withinSeconds: 0, urgent: false, behind: true },
    { from: 2, to: 2, priority: 100, withinSeconds: 0, urgent: false, behind: false }
  ]);
  assert.deepEqual(timeline.inSegments(map, 3, { runsPastEnd: true }), [
    { from: 0, to: 0, priority: 1, withinSeconds: 0, urgent: false, behind: true },
    { from: 1, to: 2, priority: 100, withinSeconds: 0, urgent: false, behind: false }
  ]);
});
