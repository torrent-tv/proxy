/**
 * @file The priority map: one number per second of film.
 *
 * The map is literally a map — an array as long as the film, saying how urgently
 * each second is wanted, and beside it how long until somebody plays it. What is
 * checked here is what the numbers MEAN, since only their order is meaningful:
 * in front of a viewer beats behind them, nearer beats further, and two viewers
 * merge to the more urgent of them.
 *
 * Nothing here spawns anything, reads a disk or looks at a clock: this layer is
 * exercised with plain values alone, which is the layer check made executable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyMap,
  inWorkingOrder,
  isBehindEverybody,
  mapForViewer,
  mergeMaps,
  runsOf
} from "../services/priority/PriorityMap.js";

const FILM = 3600;
const ALLOWANCE = 8;

/**
 * @param {number} atSeconds
 * @param {boolean} [playing]
 */
function viewer(atSeconds, playing = true) {
  return mapForViewer({
    atSeconds,
    durationSeconds: FILM,
    allowanceSeconds: ALLOWANCE,
    playing
  });
}

test("the map is one entry per second of film", () => {
  const map = viewer(600);
  assert.equal(map.durationSeconds, FILM);
  assert.equal(map.priority.length, FILM);
  assert.equal(map.secondsUntilPlayed.length, FILM);
  assert.equal(map.behind.length, FILM);
});

test("the nearer a viewer is to a second, the higher its number", () => {
  // The whole of what a priority means: which of two seconds is wanted first.
  const map = viewer(600);
  assert.ok(map.priority[600] > map.priority[700], "their own second beats one a hundred on");
  assert.ok(map.priority[700] > map.priority[3000], "and that beats one forty minutes on");
});

test("the time is the distance, because a viewer covers a second of film in a second", () => {
  const map = viewer(600);
  assert.equal(map.secondsUntilPlayed[600], 0, "they are there now");
  assert.equal(map.secondsUntilPlayed[660], 60, "a minute of film away is a minute away");
});

test("what is behind a viewer is wanted, and wanted last", () => {
  // Still wanted — a seek back must be cheap — but it yields to everything
  // anybody is walking towards, however far off that is.
  const map = viewer(600);
  assert.equal(map.behind[599], 1);
  assert.equal(map.behind[600], 0);
  assert.ok(isBehindEverybody(map.priority[599]));
  assert.ok(map.priority[599] < map.priority[3599],
    "the last second of the film outranks the second they just watched");
  assert.equal(map.secondsUntilPlayed[599], Number.POSITIVE_INFINITY,
    "nobody is on their way there, so there is no time by which it must exist");
});

test("a viewer who has stopped the picture keeps their position, and loses their times", () => {
  // A pause removes the time, not the direction. Collapsed to one flat value
  // over the whole film, as it was, their position disappeared entirely — and
  // with it the rule that what is in front of them is made first.
  const map = viewer(600, false);
  assert.equal(map.behind[599], 1, "what they have watched is still behind them");
  assert.equal(map.behind[600], 0, "and what they have not is still in front");
  assert.ok(map.priority[600] > map.priority[599], "in front still outranks behind");
  assert.ok(map.priority[600] > map.priority[3000], "and nearer still outranks further");
  for (const second of [599, 600, 3000]) {
    assert.equal(map.secondsUntilPlayed[second], Number.POSITIVE_INFINITY,
      "but nothing has a time, because they are on their way nowhere");
  }
});

test("anybody who is watching outranks anybody who has stopped", () => {
  // An ordering fact rather than a chosen number: somebody watching needs their
  // next second almost at once, while somebody stopped needs theirs at a time
  // nothing here knows.
  const watching = viewer(600);
  const stopped = viewer(3000, false);
  assert.ok(watching.priority[3599] > stopped.priority[3000],
    "the far tail of a watching viewer beats the very next second of a stopped one");
});

test("two viewers merge to the more urgent of them, second by second", () => {
  const merged = mergeMaps([viewer(600), viewer(1800)]);
  assert.equal(merged.priority[1800], merged.priority[600],
    "each of them is at the top of the scale where they stand");
  assert.equal(merged.secondsUntilPlayed[1800], 0, "the nearer time wins");
  assert.equal(merged.behind[599], 1, "behind both of them is behind");
  assert.equal(merged.behind[700], 0, "and in front of ANYBODY is in front");
});

test("the second viewer's position is not buried under the first viewer's distance", () => {
  // The failure this guards: one viewer's far film outranking another viewer's
  // own second, so the second of them is served by nobody.
  const merged = mergeMaps([viewer(600), viewer(1800)]);
  assert.ok(merged.priority[1800] > merged.priority[1799],
    "where the second viewer stands beats the film just before them");
});

test("a film nobody is watching wants nothing", () => {
  const merged = mergeMaps([]);
  assert.equal(merged.durationSeconds, 0);
  assert.deepEqual(runsOf(merged), []);
});

test("the map as stretches says the same thing in fewer numbers", () => {
  const runs = runsOf(viewer(600));
  assert.ok(runs.length > 1 && runs.length < 40, "a handful of stretches, not thousands");
  assert.equal(runs[0].from, 0, "starting at the beginning of the film");
  assert.equal(runs[0].behind, true, "which is behind them");
  assert.equal(runs[runs.length - 1].to, FILM, "and ending at its end");
  for (let index = 0; index < runs.length - 1; index += 1) {
    assert.equal(runs[index].to, runs[index + 1].from, "with no gaps");
  }
});

test("the stretches widen with distance, so any film is a handful of them", () => {
  // Near the viewer the difference between now and ten seconds away decides what
  // is made first; twenty minutes out, one more division changes no decision.
  const ahead = runsOf(viewer(0)).filter((run) => run.behind === false);
  for (let index = 1; index < ahead.length; index += 1) {
    assert.ok(ahead[index].to - ahead[index].from >= ahead[index - 1].to - ahead[index - 1].from,
      "each stretch is at least as wide as the one before it");
  }
  assert.ok(ahead[0].to - ahead[0].from <= ALLOWANCE + 1,
    "and the first is as wide as the measured allowance");
});

test("the working order is most urgent first, earliest film within one priority", () => {
  const ordered = inWorkingOrder(runsOf(viewer(600)));
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const left = ordered[index];
    const right = ordered[index + 1];
    assert.ok(
      left.priority > right.priority || (left.priority === right.priority && left.from < right.from),
      "sorted by priority, then by position"
    );
  }
  assert.equal(ordered[0].from, 600, "and the first of all is where the viewer is stopped");
});

test("a map of no length is a statement, and it says nothing is wanted", () => {
  const map = emptyMap(0);
  assert.equal(map.durationSeconds, 0);
  assert.deepEqual(runsOf(map), []);
});
