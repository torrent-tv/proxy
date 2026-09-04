/**
 * @file The three states of a segment number, and the two questions that decide
 * where an encoder goes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CoverageMap } from "../services/encode/CoverageMap.js";

/**
 * A stand-in for a run.
 *
 * The map files a claim under the run ITSELF: a run has no name, and needs
 * none — what identifies it is that it is itself, and what identifies it in a
 * line is the stretch it was given, which no other live run of one output can
 * hold.
 *
 * @returns {object}
 */
function aRun() {
  return {};
}

test("a number nobody has made and nobody is making is free", () => {
  const map = new CoverageMap({ segmentCount: 10 });
  assert.equal(map.stateOf(3), "free");
  assert.equal(map.firstGapFrom(0), 0);
});

test("a closed file is ready whoever made it", () => {
  const map = new CoverageMap({ segmentCount: 10 });
  map.markReady(0);
  map.markReady(1);
  assert.equal(map.stateOf(1), "ready");
  assert.equal(map.firstGapFrom(0), 2);
});

test("a run claims a stretch, and the gap search skips it", () => {
  // The claim is an interval and not a head, which is the whole reason two runs
  // can work on one output: the second is sent past what the first will reach.
  const map = new CoverageMap({ segmentCount: 100 });
  const runA = aRun();
  map.claim(runA, 0, 40);
  assert.equal(map.stateOf(20), "making");
  assert.equal(map.makerOf(20), runA);
  assert.equal(map.firstGapFrom(0), 41);
});

test("a run that ends gives back what it did not finish, and keeps what it did", () => {
  const map = new CoverageMap({ segmentCount: 100 });
  const runA = aRun();
  map.claim(runA, 0, 40);
  map.markReady(0);
  map.markReady(1);
  map.release(runA);
  assert.equal(map.stateOf(0), "ready", "a closed file survives its maker");
  assert.equal(map.stateOf(2), "free", "the rest of the stretch is free again");
  assert.equal(map.firstGapFrom(0), 2);
});

test("a run with no end claims everything ahead of it", () => {
  // Which is what every run was before ends existed, and is why a second run
  // could never be placed.
  const map = new CoverageMap({ segmentCount: 100 });
  const runA = aRun();
  map.claim(runA, 10, Number.POSITIVE_INFINITY);
  assert.equal(map.firstGapFrom(10), null);
  assert.equal(map.firstGapFrom(0), 0, "behind it is still free");
});

test("claiming again replaces the earlier claim rather than adding to it", () => {
  // A run moved forward past ready material states its new stretch; if the two
  // accumulated, the ground it has left would stay unavailable for ever.
  const map = new CoverageMap({ segmentCount: 100 });
  const runA = aRun();
  map.claim(runA, 0, 20);
  map.claim(runA, 50, 70);
  assert.equal(map.stateOf(10), "free");
  assert.equal(map.stateOf(60), "making");
});

test("the covered stretch ahead is measured, which is what prices a move", () => {
  const map = new CoverageMap({ segmentCount: 100 });
  const runA = aRun();
  const runB = aRun();
  for (let index = 10; index <= 24; index += 1) {
    map.markReady(index);
  }
  map.claim(runB, 25, 30);
  // Ready 10..24 then another run's 25..30, so fifteen plus six.
  assert.equal(map.coveredRunFrom(10, runA), 21);
  assert.equal(map.firstGapFrom(10), 31);
});

test("a run's own claim is not counted as somebody else's coverage", () => {
  // Otherwise a run would read its own stretch as a reason to move off it.
  const map = new CoverageMap({ segmentCount: 100 });
  const runA = aRun();
  map.claim(runA, 10, 30);
  assert.equal(map.coveredRunFrom(10, runA), 0);
});

test("nothing free ahead answers null rather than a number past the end", () => {
  const map = new CoverageMap({ segmentCount: 5 });
  map.markReadyAll([0, 1, 2, 3, 4]);
  assert.equal(map.firstGapFrom(0), null);
});

test("a file that has gone stops being ready", () => {
  const map = new CoverageMap({ segmentCount: 10 });
  map.markReady(4);
  map.markGone(4);
  assert.equal(map.stateOf(4), "free");
});

test("a run's own claim does not hide the gap it is trying to move into", () => {
  // Found by the plan's own checks: a run that had claimed the rest of the film
  // — which is what every run did before ends existed — could find no gap
  // anywhere, so it was stopped instead of moved.
  const map = new CoverageMap({ segmentCount: 100 });
  const runA = aRun();
  map.claim(runA, 0, 99);
  map.markReadyAll([10, 11, 12]);
  assert.equal(map.firstGapFrom(10, 90), null, "to anybody else its ground is taken");
  assert.equal(map.firstGapFrom(10, 90, runA), 13, "to itself the ground beyond is a gap");
});

test("the free stretch ahead is measured, which is what gives a run its end", () => {
  // A run handed the whole rest of the film would drive through the stretch
  // another run is making. Handed the free stretch, it stops where the covered
  // material begins.
  const map = new CoverageMap({ segmentCount: 100 });
  const runB = aRun();
  map.claim(runB, 30, 60);
  assert.equal(map.freeRunFrom(10), 20, "free from 10 up to 29");
  map.markReady(15);
  assert.equal(map.freeRunFrom(10), 5, "a ready segment ends the free stretch too");
  assert.equal(map.freeRunFrom(15), 0, "a number that is not free has no free stretch");
});

test("a run's own claim does not end its own free stretch", () => {
  const map = new CoverageMap({ segmentCount: 100 });
  const runA = aRun();
  map.claim(runA, 10, 40);
  assert.equal(map.freeRunFrom(10, runA), 90, "its own ground is still its to fill");
  assert.equal(map.freeRunFrom(10), 0, "to anybody else it is taken");
});

test("with the length unknown, a gap search needs its own bound", () => {
  const map = new CoverageMap();
  assert.equal(map.firstGapFrom(0), null, "no length and no bound answers nothing");
  assert.equal(map.firstGapFrom(0, 3), 0);
});
