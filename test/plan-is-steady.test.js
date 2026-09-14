/**
 * @file The placement must not move while the facts do not.
 *
 * This is the check the field failure of 2026-09-13 had no equivalent of. Two
 * browsers on one torrent: 77 encoder starts and 141 stops in six minutes
 * against ONE normal end, both viewers frozen — one at 170.8 s with
 * `bufferedAhead=0.1s`, the other at 1673.6 s with an empty buffer — while the
 * swarm delivered 3 MB/s from 129 peers. Nothing was produced because no run
 * lived long enough to close a piece.
 *
 * The plan itself was not at fault and was measured not to be: given a settled
 * map it returns the same arrangement however often it is asked. What moved was
 * its INPUT. A viewer's position had two writers — a seek wrote one field, a
 * segment request wrote another, and the reading preferred whichever was set —
 * so the priority map jumped backwards and forwards by one or two segments
 * several times a second:
 *
 *   19:58:00.283  p100:#9..#10    p100:#160..#162
 *   19:58:00.496  p100:#18..#20   p100:#161..#163
 *   19:58:00.574  p100:#16..#18   p100:#161..#163
 *   19:58:00.696  p100:#16..#18   p100:#160..#162
 *   19:58:01.231  p100:#18..#20   p100:#160..#162
 *
 * So the property to hold is about the whole chain and not about one function:
 * what a viewer states must produce a map that only moves the way film moves,
 * and a plan asked repeatedly against unchanged facts must answer identically.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CoverageMap } from "../services/encode/CoverageMap.js";
import { planEncoders } from "../services/encode/EncodePlan.js";
import { contentionPenalty, penaltiesFrom } from "../services/encode/contention.js";
import { mapForViewer, mergeMaps, runsOf } from "../services/priority/PriorityMap.js";
import { Viewer } from "../services/viewer/Viewer.js";

// Measured on the addon host 2026-09-03: 7.12x alone, 4.18x with a second.
const PENALTIES = penaltiesFrom(7.12, [{ others: 1, speed: 4.18 }]);
const penaltyFor = (others) => contentionPenalty(others, PENALTIES).penalty;

const HOST = {
  contentionPenaltyFor: penaltyFor,
  speedX: 2,
  segmentSeconds: 8,
  killCostSec: 0.5,
  firstByteWaitSec: 1,
  refetchSecPerFilmSecond: 0.25
};

const DURATION = 2896;
const ALLOWANCE = 30;

/**
 * The map two viewers produce, exactly as `PriorityOrchestrator` builds it.
 *
 * @param {Viewer[]} viewers
 * @param {number} now
 * @returns {{ from: number, to: number, priority: number }[]}
 */
function zonesFor(viewers, now) {
  const merged = mergeMaps(
    viewers.map((viewer) =>
      mapForViewer({
        atSeconds: viewer.positionSeconds(now) ?? 0,
        durationSeconds: DURATION,
        allowanceSeconds: ALLOWANCE,
        playing: viewer.wantsFilmNow()
      })
    )
  );
  return runsOf(merged).map((zone) => ({
    from: Math.floor(zone.from / HOST.segmentSeconds),
    to: Math.floor((zone.to - 1) / HOST.segmentSeconds),
    priority: zone.priority
  }));
}

test("a viewer's position only ever moves the way film moves", () => {
  const viewer = new Viewer("one", 1_000_000);
  // Stated the way a page states it: where they are, what they hold, and that
  // the picture is advancing. The cushion is what bounds the extrapolation, so
  // a viewer who has stated none cannot move at all.
  viewer.report(
    { bufferedAheadSec: 120, positionSeconds: 170.8, playing: true, waiting: false },
    1_000_000
  );

  let previous = viewer.positionSeconds(1_000_000);
  for (let tick = 1; tick <= 200; tick += 1) {
    const now = 1_000_000 + tick * 50;
    const seconds = viewer.positionSeconds(now);
    assert.ok(seconds >= previous, `position went backwards at tick ${tick}: ${seconds} < ${previous}`);
    previous = seconds;
  }
  // Fifty ticks of 50 ms is ten seconds of wall clock, and a playing viewer
  // covers ten seconds of film in it.
  assert.ok(Math.abs(previous - (170.8 + 10)) < 0.001, `expected 180.8s, got ${previous}`);
});

test("a segment request does not move a viewer, and a stopped picture does not either", () => {
  const viewer = new Viewer("one", 1_000_000);
  viewer.report(
    { bufferedAheadSec: 120, positionSeconds: 170.8, playing: false, waiting: false },
    1_000_000
  );

  // Whatever else happens, only a statement from the viewer moves them. There
  // is no method here a request could call: `seen` is presence and nothing more.
  viewer.seen(1_000_500);
  viewer.seen(1_001_000);
  assert.equal(viewer.positionSeconds(1_010_000), 170.8);
});

test("the priority map of two viewers is the same whenever it is asked", () => {
  const at = 1_000_000;
  const one = new Viewer("one", at);
  one.report({ bufferedAheadSec: 120, positionSeconds: 170.8, playing: false, waiting: false }, at);
  const two = new Viewer("two", at);
  two.report({ bufferedAheadSec: 120, positionSeconds: 1673.6, playing: false, waiting: false }, at);

  const first = JSON.stringify(zonesFor([one, two], at));
  for (let tick = 1; tick <= 40; tick += 1) {
    // Nothing changes: both pictures are stopped, so no time passes for them.
    assert.equal(JSON.stringify(zonesFor([one, two], at + tick * 100)), first, `map moved at tick ${tick}`);
  }
});

test("two viewers far apart settle on one arrangement and stay on it", () => {
  const at = 1_000_000;
  const one = new Viewer("one", at);
  one.report({ bufferedAheadSec: 120, positionSeconds: 170.8, playing: false, waiting: false }, at);
  const two = new Viewer("two", at);
  two.report({ bufferedAheadSec: 120, positionSeconds: 1673.6, playing: false, waiting: false }, at);

  const coverage = new CoverageMap({ segmentCount: 362 });
  /** @type {{ from: number, to: number, head: number, speedX: number, startedAt: number }[]} */
  let live = [];
  let started = 0;
  let stopped = 0;

  for (let tick = 0; tick < 60; tick += 1) {
    const now = at + tick * 100;
    const actions = planEncoders({
      coverage,
      windows: zonesFor([one, two], now),
      runs: live,
      maxRuns: 2,
      now,
      ...HOST
    });
    for (const action of actions) {
      if (action.type === "start") {
        live.push({ from: action.from, to: action.to, head: action.from, speedX: 2, startedAt: now });
        started += 1;
      } else if (action.type === "stop") {
        live = live.filter((run) => run !== action.run);
        stopped += 1;
      } else if (action.type === "move") {
        live = live.filter((run) => run !== action.run);
        live.push({ from: action.from, to: action.to, head: action.from, speedX: 2, startedAt: now });
        started += 1;
        stopped += 1;
      }
    }
  }

  // One encoder per viewer, placed once. Anything above this is the plan
  // arguing with itself: in the field the same six minutes cost 77 and 141.
  assert.equal(started, 2, `expected two starts, got ${started}`);
  assert.equal(stopped, 0, `expected no stops, got ${stopped}`);
  assert.equal(live.length, 2);
});

test("an encoder keeping ahead of a playing viewer is left alone", () => {
  const at = 1_000_000;
  const one = new Viewer("one", at);
  one.report({ bufferedAheadSec: 120, positionSeconds: 0, playing: true, waiting: false }, at);

  const coverage = new CoverageMap({ segmentCount: 362 });
  const ready = new Set();
  /** @type {{ from: number, to: number, head: number, speedX: number, startedAt: number, made: number }[]} */
  let live = [];
  let moves = 0;
  let starts = 0;

  for (let tick = 0; tick < 120; tick += 1) {
    const now = at + tick * 1000;
    const actions = planEncoders({
      coverage,
      windows: zonesFor([one], now),
      runs: live,
      maxRuns: 1,
      now,
      ...HOST
    });
    for (const action of actions) {
      if (action.type === "start") {
        live.push({ from: action.from, to: action.to, head: action.from, speedX: 2, startedAt: now, made: 0 });
        starts += 1;
      } else if (action.type === "move") {
        live = live.filter((run) => run !== action.run);
        live.push({ from: action.from, to: action.to, head: action.from, speedX: 2, startedAt: now, made: 0 });
        moves += 1;
      } else if (action.type === "stop") {
        live = live.filter((run) => run !== action.run);
      }
    }
    // The encoder works: at 2x, one 8-second piece every four seconds of clock.
    for (const run of live) {
      run.made += 1000 * 2;
      while (run.made >= HOST.segmentSeconds * 1000 && run.head <= run.to) {
        run.made -= HOST.segmentSeconds * 1000;
        ready.add(run.head);
        run.head += 1;
      }
    }
    coverage.setReady(ready);
  }

  // One encoder, placed once, running twice as fast as the viewer plays: it
  // stays in front of them for the whole two minutes, so there is nothing to
  // decide again.
  assert.equal(starts, 1, `expected one start, got ${starts}`);
  assert.equal(moves, 0, `expected no moves, got ${moves}`);
});
