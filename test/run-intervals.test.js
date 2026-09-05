/**
 * @file How far a run may work, and who decides it.
 *
 * These cases used to be asked of `planRunInterval`, a second authority inside
 * the session manager that answered by its own rules: it walked the whole track
 * for the first free number, MOVED the start there, and counted every live run
 * as claiming up to `head + look-ahead`. It contradicted the plan directly, and
 * the two together produced the field oscillation of 2026-09-05 — the plan
 * commanded a start at #46, this moved it to #78, the plan killed the run for
 * standing outside the window it had asked for, and the same start was
 * commanded again, 350-700ms per cycle, no segment ever produced, the viewer's
 * picture stopped for 125 seconds.
 *
 * It is gone. WHERE a run starts is the plan's decision and nothing moves it;
 * HOW FAR it may work is a fact of the one coverage map, and that is what these
 * cases now ask. The map is the same object the plan reads, so there is no
 * second set of rules for the two to disagree about.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CoverageMap } from "../services/encode/CoverageMap.js";

/** A stand-in for a run: the map identifies one by being it. */
function run(name) {
  return { name };
}

test("with nothing made, a run gets everything from where it was asked", () => {
  const coverage = new CoverageMap({ segmentCount: 100 });

  assert.equal(coverage.freeRunFrom(0), 100, "the whole track is free");
  assert.equal(coverage.firstGapFrom(0), 0);
});

test("a run stops before material that is already made", () => {
  const coverage = new CoverageMap({ segmentCount: 100 });
  coverage.markReadyAll([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

  assert.equal(coverage.freeRunFrom(0), 10, "0..9, and it stops where 10 begins");
});

test("a run stops before a stretch another live run was given", () => {
  const coverage = new CoverageMap({ segmentCount: 100 });
  const other = run("other");
  coverage.claim(other, 40, 60);

  assert.equal(coverage.freeRunFrom(0), 40, "0..39, and the other run's claim begins at 40");
  assert.equal(coverage.firstGapFrom(45), 61, "the first thing nobody holds after it");
});

test("a run's own claim does not hold it back", () => {
  const coverage = new CoverageMap({ segmentCount: 100 });
  const mine = run("mine");
  coverage.claim(mine, 40, 60);

  assert.equal(
    coverage.freeRunFrom(40, mine),
    60,
    "asked by the run that holds it, the stretch is its own to work through"
  );
});

test("a run that has ended holds nothing back", () => {
  const coverage = new CoverageMap({ segmentCount: 100 });
  const dead = run("dead");
  coverage.claim(dead, 40, 60);
  coverage.release(dead);

  assert.equal(coverage.freeRunFrom(0), 100, "what it did not finish is free again");
});

test("what a dead run DID finish stays made", () => {
  const coverage = new CoverageMap({ segmentCount: 100 });
  const dead = run("dead");
  coverage.claim(dead, 40, 60);
  coverage.markReadyAll([40, 41, 42]);
  coverage.release(dead);

  assert.equal(coverage.firstGapFrom(40), 43, "a closed file is closed whoever made it");
});

test("nothing left to make is answered with nothing", () => {
  const coverage = new CoverageMap({ segmentCount: 5 });
  coverage.markReadyAll([0, 1, 2, 3, 4]);

  assert.equal(coverage.firstGapFrom(0), null, "and a run started here would only repeat somebody's work");
});

test("a run without an end does not take the film away from a viewer further in", () => {
  // The case that used to need a second authority's `head + look-ahead` guess.
  // A run's claim is now the stretch the plan GAVE it, so a viewer opening the
  // same film in the middle finds their own position free.
  const coverage = new CoverageMap({ segmentCount: 1000 });
  const first = run("first");
  coverage.claim(first, 0, 499);

  assert.equal(coverage.firstGapFrom(500), 500, "the second viewer's own position is free");
  assert.equal(coverage.freeRunFrom(500), 500, "and everything from there to the end");
});
