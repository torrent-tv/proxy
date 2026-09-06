/**
 * @file The placement model under one, two and three viewers, each of them
 * playing, seeking and paused.
 *
 * THE MODEL, restated so a failure here can be read against it:
 *
 * - each segment number carries a deadline `D(x)`, the seconds until somebody
 *   needs it. A viewer moving forward covers a second of film in a second, so
 *   `D(x)` is the distance to them. `Infinity` where nobody is coming;
 * - an encoder placed at `a` delivers `a + j` at `(j + 1) / r`, `r` segments per
 *   second. The same expression answers "when would the one already placed get
 *   here";
 * - a number is late when it arrives after its deadline. Placement is first-fit
 *   left to right: give it to an encoder that arrives in time, else open one
 *   exactly there.
 *
 * Three behaviours of the map follow from that and are checked here rather than
 * assumed. A peak MOVES FORWARD on its own, because the deadline is a distance
 * and the distance shrinks as the viewer watches. It JUMPS on a seek. It
 * FLATTENS on a pause, because a viewer who is not moving has no time by which
 * anything must exist.
 *
 * Nothing here spawns ffmpeg, touches a disk or reads a clock. That is the layer
 * check, made executable: this layer is exercised with plain values alone.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EncodeRun } from "../services/encode/EncodeRun.js";
import { SoftwareEncoder } from "../services/encode/SoftwareEncoder.js";
import { EncodeOrchestrator } from "../services/orchestrators/EncodeOrchestrator.js";
import { mapForViewer, mergeMaps } from "../services/priority/PriorityMap.js";

const PICTURE = "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy";
const SEGMENT_SECONDS = 4;
const FILM_SECONDS = 4000;
const SEGMENTS = FILM_SECONDS / SEGMENT_SECONDS;

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 1;
  }

  kill(signal) {
    this.emit("exit", null, signal);
  }
}

/** @param {{ maxRuns?: number }} [options] */
function orchestrator({ maxRuns = 3 } = {}) {
  /** @type {EncodeOrchestrator} */
  let made;
  const build = ({ address, from, to }) => new EncodeRun({
    address,
    encoder: new SoftwareEncoder(),
    from,
    to,
    buildArgs: () => ["-i", "in", "out"],
    spawn: () => new FakeProcess(),
    logger: { info() {}, warn() {} },
    now: () => 1000,
    onEnded: (ended) => made.noteEnded(ended)
  });
  made = new EncodeOrchestrator({
    maxRunsFor: () => maxRuns,
    segmentSeconds: SEGMENT_SECONDS,
    restartCostSec: 0.12,
    // A swarm with room for several encoders. The figure is the measured cost
    // of fetching a second of film again, in seconds of swarm time; at 0.25 one
    // encoder at 6x already takes one and a half swarms, so the budget would be
    // one process and the placement would have nothing to place — which is a
    // real limit, checked in its own test below, and not the subject of these.
    refetchSecPerFilmSecond: () => 0.02,
    now: () => 1000,
    logger: { info() {}, warn() {} },
    makeRun: build
  });
  made.setSegmentCount(PICTURE, SEGMENTS);
  /** Who is watching, by name. The map is rebuilt from all of them on change. */
  const watching = new Map();
  const watches = (who, { atSeconds, playing = true }) => {
    watching.set(who, { atSeconds, playing });
    stateMap(made, watching);
  };
  const leaves = (who) => {
    watching.delete(who);
    stateMap(made, watching);
  };
  return { made, build, watches, leaves };
}

/**
 * Everybody watching, as ONE map, the way the product builds it.
 *
 * A viewer's own map is in seconds of film; the maps of all of them are merged
 * into one, and only then converted into an output's own numbering. Doing it
 * here rather than stating windows by hand is the point: the pause and the seek
 * are the MAP's behaviour, and a test that stated windows directly would be
 * checking its own arithmetic.
 *
 * @param {EncodeOrchestrator} made
 * @param {Map<string, { atSeconds: number, playing: boolean }>} watching
 */
function stateMap(made, watching) {
  const zones = mergeMaps(
    [...watching.values()].map((viewer) => mapForViewer({
      atSeconds: viewer.atSeconds,
      durationSeconds: FILM_SECONDS,
      allowanceSeconds: 8,
      playing: viewer.playing
    }))
  );
  made.notePriorityMap(PICTURE, zones.map((zone) => ({
    from: Math.floor(zone.from / SEGMENT_SECONDS),
    to: Math.max(
      Math.floor(zone.from / SEGMENT_SECONDS),
      Math.ceil(zone.to / SEGMENT_SECONDS) - 1
    ),
    priority: zone.priority,
    withinSeconds: zone.withinSeconds
  })));
}

/** @param {EncodeOrchestrator} made */
function placements(made) {
  return made.runsOn(PICTURE).map((run) => run.from).sort((left, right) => left - right);
}

/**
 * Every live encoder's stretch, so that "they never share a number" can be
 * asserted as the consequence it is rather than trusted.
 *
 * @param {EncodeOrchestrator} made
 */
function assertNoOverlap(made) {
  const spans = made.runsOn(PICTURE)
    .map((run) => [run.from, run.to < run.from ? Number.POSITIVE_INFINITY : run.to])
    .sort((left, right) => left[0] - right[0]);
  for (let index = 0; index < spans.length - 1; index += 1) {
    assert.ok(
      spans[index][1] < spans[index + 1][0],
      `#${spans[index][0]}..#${spans[index][1]} overlaps #${spans[index + 1][0]}`
    );
  }
}

// ---------------------------------------------------------------- one viewer

test("one viewer playing: one encoder, exactly where they are", () => {
  const { made, watches, leaves } = orchestrator();
  watches("one", { atSeconds: 400 });
  made.reconcile();
  assert.deepEqual(placements(made), [100], "at their own position, 400s / 4s");
  assertNoOverlap(made);
});

test("one viewer playing: the encoder keeping up buys no second one", () => {
  // The peak moves forward on its own as they watch, and an encoder that stays
  // in front of it is never late. This is the case that must NOT spend a
  // process, and the one the old head-as-a-barrier rule got wrong.
  const { made, watches, leaves } = orchestrator();
  watches("one", { atSeconds: 400 });
  made.reconcile();
  const [run] = made.runsOn(PICTURE);
  run.noteSpeed(6);
  for (let index = 100; index < 130; index += 1) {
    made.noteProduced(PICTURE, index);
  }
  watches("one", { atSeconds: 480 });
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 1, "still one encoder");
  assertNoOverlap(made);
});

test("one viewer seeking far ahead: an encoder is placed there", () => {
  const { made, watches, leaves } = orchestrator();
  watches("one", { atSeconds: 400 });
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(6);
  made.noteProduced(PICTURE, 100);

  // The peak JUMPS. Nothing about the old place is wanted now.
  watches("one", { atSeconds: 3000 });
  made.reconcile();

  assert.ok(placements(made).includes(750), "an encoder where they landed, 3000s / 4s");
  assertNoOverlap(made);
});

test("one viewer paused: nothing is late, so no encoder is added", () => {
  // A paused viewer states the whole film at one undifferentiated rank and no
  // time by which any of it must exist. The encoder already working goes on
  // encoding the track; nothing justifies a second process.
  const { made, watches, leaves } = orchestrator();
  watches("one", { atSeconds: 400 });
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(1);
  made.noteProduced(PICTURE, 100);

  watches("one", { atSeconds: 404, playing: false });
  made.reconcile();

  assert.equal(made.runsOn(PICTURE).length, 1, "one encoder, and only one");
  assertNoOverlap(made);
});

test("one viewer paused states no deadline anywhere", () => {
  // The map's own answer, checked directly, because every placement decision
  // below rests on it.
  const zones = mapForViewer({
    atSeconds: 400,
    durationSeconds: FILM_SECONDS,
    allowanceSeconds: 8,
    playing: false
  });
  assert.ok(zones.length > 0, "a paused viewer still wants the film");
  for (const zone of zones) {
    assert.equal(zone.withinSeconds, Number.POSITIVE_INFINITY,
      "but no second of it has a time by which it must exist");
  }
});

// --------------------------------------------------------------- two viewers

test("two viewers close together share one encoder", () => {
  // Film both of them want is made once. This is what merging the map is for,
  // and it must survive the deadline being carried alongside the rank.
  const { made, watches, leaves } = orchestrator();
  watches("one", { atSeconds: 400 });
  watches("two", { atSeconds: 408 });
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 1, "one encoder for the pair");
  assertNoOverlap(made);
});

test("two viewers far apart get an encoder each", () => {
  const { made, watches, leaves } = orchestrator();
  watches("one", { atSeconds: 400 });
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(6);
  made.noteProduced(PICTURE, 100);

  watches("two", { atSeconds: 3000 });
  made.reconcile();

  const where = placements(made);
  assert.equal(where.length, 2, "one each");
  assert.ok(where.includes(750), "the far one is served where they stand");
  assertNoOverlap(made);
});

test("two viewers: one seeking does not take the other's encoder", () => {
  const { made, watches, leaves } = orchestrator();
  watches("one", { atSeconds: 400 });
  made.reconcile();
  // A speed has to be measured before a second encoder can be justified: how
  // long one takes to reach a number is the whole comparison. Real life
  // measures it from the first run; a test that stated both viewers before any
  // run existed would be asking the plan to buy a process on no evidence.
  made.runsOn(PICTURE)[0].noteSpeed(6);
  made.noteProduced(PICTURE, 100);
  watches("two", { atSeconds: 3000 });
  made.reconcile();
  for (const run of made.runsOn(PICTURE)) {
    run.noteSpeed(6);
  }
  assert.equal(made.runsOn(PICTURE).length, 2, "one each to begin with");

  // The far one seeks somewhere else entirely.
  watches("two", { atSeconds: 2000 });
  made.reconcile();

  // Asked of the coverage, not of a run's first number: a run whose road was
  // shortened begins again at its own head, so "is this viewer served" is a
  // question about the map and never about where a process happens to start.
  const coverage = made.coverageOf(PICTURE);
  assert.equal(coverage.stateOf(105), "making", "the one who did not move is still served");
  assert.ok(placements(made).includes(500), "and the one who moved is served where they landed");
  assertNoOverlap(made);
});

test("two viewers: one pausing leaves the other served", () => {
  const { made, watches, leaves } = orchestrator();
  watches("one", { atSeconds: 400 });
  watches("two", { atSeconds: 3000 });
  made.reconcile();
  for (const run of made.runsOn(PICTURE)) {
    run.noteSpeed(1);
  }

  watches("two", { atSeconds: 3000, playing: false });
  made.reconcile();

  assert.equal(made.coverageOf(PICTURE).stateOf(105), "making",
    "the one still watching keeps their encoder");
  assertNoOverlap(made);
});

test("two viewers: the one who leaves takes nothing from the one who stays", () => {
  const { made, watches, leaves } = orchestrator();
  watches("one", { atSeconds: 400 });
  watches("two", { atSeconds: 3000 });
  made.reconcile();
  for (const run of made.runsOn(PICTURE)) {
    run.noteSpeed(1);
  }

  leaves("two");
  made.reconcile();

  assert.equal(made.coverageOf(PICTURE).stateOf(105), "making",
    "the one who stayed is still served");
  assertNoOverlap(made);
});

// ------------------------------------------------------------- three viewers

test("three viewers far apart get an encoder each when the machine affords it", () => {
  const { made, watches, leaves } = orchestrator({ maxRuns: 3 });
  watches("one", { atSeconds: 400 });
  watches("two", { atSeconds: 2000 });
  watches("three", { atSeconds: 3600 });
  made.reconcile();
  for (const run of made.runsOn(PICTURE)) {
    run.noteSpeed(6);
  }
  made.reconcile();

  const where = placements(made);
  assert.equal(where.length, 3, "three encoders for three places");
  assert.deepEqual(where, [100, 500, 900], "each exactly where somebody stands");
  assertNoOverlap(made);
});

test("three viewers, a machine that affords two: the budget binds, not the map", () => {
  // The number of encoders is the smaller of what the map asks and what the
  // machine can hold. Which two are served follows from the order the work is
  // taken in; what must not happen is a third process on a host that cannot
  // hold it, or two processes writing one number.
  const { made, watches, leaves } = orchestrator({ maxRuns: 2 });
  watches("one", { atSeconds: 400 });
  watches("two", { atSeconds: 2000 });
  watches("three", { atSeconds: 3600 });
  made.reconcile();
  for (const run of made.runsOn(PICTURE)) {
    run.noteSpeed(1);
  }
  made.reconcile();

  assert.ok(made.runsOn(PICTURE).length <= 2, "never more than the machine affords");
  assert.ok(made.runsOn(PICTURE).length >= 1, "and never nothing while people wait");
  assertNoOverlap(made);
});

test("three viewers: one seeks onto another, and the two of them share", () => {
  const { made, watches, leaves } = orchestrator({ maxRuns: 3 });
  watches("one", { atSeconds: 400 });
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(6);
  made.noteProduced(PICTURE, 100);
  watches("two", { atSeconds: 2000 });
  watches("three", { atSeconds: 3600 });
  made.reconcile();
  for (const run of made.runsOn(PICTURE)) {
    run.noteSpeed(6);
  }
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 3);

  // The third joins the second. Two peaks where there were three.
  watches("three", { atSeconds: 2008 });
  made.reconcile();

  assert.ok(made.runsOn(PICTURE).length <= 3, "no process is added by people converging");
  assertNoOverlap(made);
});

test("three viewers: all paused, and no encoder is added for any of them", () => {
  const { made, watches, leaves } = orchestrator({ maxRuns: 3 });
  watches("one", { atSeconds: 400 });
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(1);
  const before = made.runsOn(PICTURE).length;

  watches("one", { atSeconds: 400, playing: false });
  watches("two", { atSeconds: 2000, playing: false });
  watches("three", { atSeconds: 3600, playing: false });
  made.reconcile();

  assert.equal(made.runsOn(PICTURE).length, before,
    "nobody is coming anywhere, so nothing can be late and nothing is bought");
  assertNoOverlap(made);
});

test("the plan is a function of the state: the same state twice gives the same answer", () => {
  // What stops a moving map from becoming a thrash: the decision is arithmetic
  // over the state, so a pass that finds nothing changed changes nothing.
  const { made, watches, leaves } = orchestrator({ maxRuns: 3 });
  watches("one", { atSeconds: 400 });
  watches("two", { atSeconds: 2000 });
  made.reconcile();
  for (const run of made.runsOn(PICTURE)) {
    run.noteSpeed(1);
  }
  made.reconcile();
  const first = placements(made);
  made.reconcile();
  made.reconcile();
  assert.deepEqual(placements(made), first, "three more passes moved nothing");
});

// ---------------------------------------------------------------- the edge

test("exactly realtime arrives exactly on time, and no second encoder is bought", () => {
  // The knife edge, and it lands on "in time" by construction: the deadline of
  // a number is the distance to it, and an encoder at 1.0x covers that distance
  // in exactly that time. So the arithmetic says nothing is late and nothing is
  // bought. Worth pinning, because the formula this model replaced said
  // something quite different — `speed / (1 - speed)` divides by zero here and
  // claims the encoder stays ahead FOR EVER, which is the same answer arrived
  // at by nonsense.
  const { made, watches, leaves } = orchestrator({ maxRuns: 3 });
  watches("one", { atSeconds: 400 });
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(1);
  made.noteProduced(PICTURE, 100);
  made.reconcile();

  assert.equal(made.runsOn(PICTURE).length, 1, "just in time everywhere, so one is enough");
  assertNoOverlap(made);
});

test("below realtime, the far part cannot be reached and another encoder is placed", () => {
  // The side of the edge that matters. An encoder slower than realtime loses
  // ground on the viewer every second, so somewhere ahead of it the arrival
  // passes the deadline — and there the model places another.
  const { made, watches, leaves } = orchestrator({ maxRuns: 3 });
  watches("one", { atSeconds: 400 });
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(0.5);
  made.noteProduced(PICTURE, 100);
  made.reconcile();

  assert.ok(made.runsOn(PICTURE).length > 1,
    "what it cannot reach in time is given to somebody who can");
  assertNoOverlap(made);
});

test("two viewers arriving together on a cold output get one encoder, then are measured", () => {
  // Nothing has measured how fast this machine encodes, so how long one encoder
  // would take to reach the second viewer is not a known quantity. Buying a
  // process on that is buying it on no evidence, which is refused; one is placed
  // and the speed it reports is what justifies the next.
  const { made, watches, leaves } = orchestrator({ maxRuns: 3 });
  watches("one", { atSeconds: 400 });
  watches("two", { atSeconds: 3000 });
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 1, "one, until something is measured");

  made.runsOn(PICTURE)[0].noteSpeed(6);
  made.noteProduced(PICTURE, 100);
  made.reconcile();
  assert.equal(made.runsOn(PICTURE).length, 2, "and now the far one is served too");
  assertNoOverlap(made);
});

test("an encoder comfortably faster than realtime is left to do the whole stretch", () => {
  const { made, watches, leaves } = orchestrator({ maxRuns: 3 });
  watches("one", { atSeconds: 400 });
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(6);
  made.noteProduced(PICTURE, 100);
  made.reconcile();

  assert.equal(made.runsOn(PICTURE).length, 1, "one encoder is enough and one is bought");
  assertNoOverlap(made);
});

test("a swarm that feeds one encoder moves it to whoever is late, rather than serving nobody", () => {
  // The budget binds. The one encoder there is stands where nothing is due —
  // the viewer left — so it is moved to the soonest number that IS due. Without
  // this the viewer who seeked was served by nobody at all: the run kept its
  // road because nothing covered what lay in front of IT.
  const { made, watches, leaves } = orchestrator({ maxRuns: 3 });
  watches("one", { atSeconds: 400 });
  made.reconcile();
  const [run] = made.runsOn(PICTURE);
  // 6x against a swarm charging 0.25 s per second of film: one encoder already
  // takes one and a half of what is delivered, so the budget is one.
  run.noteSpeed(6);
  made.refetchSecPerFilmSecond = () => 0.25;
  made.noteProduced(PICTURE, 100);

  watches("one", { atSeconds: 3000 });
  made.reconcile();

  assert.equal(made.runsOn(PICTURE).length, 1, "still one, because that is what the swarm feeds");
  assert.deepEqual(placements(made), [750], "and it is where the viewer now stands");
  assertNoOverlap(made);
});

// ------------------------------------------------------- seeking BACKWARD

test("one viewer seeking back into film that exists is served from it, with no encoder", () => {
  // The case the whole layer was built for. Everything behind them has been
  // made, so nothing is late anywhere they are going, and the score says the
  // cheapest arrangement is the one that changes nothing. A restart here is the
  // 647-second stall of 2026-09-06 in miniature.
  const { made, watches } = orchestrator();
  watches("one", { atSeconds: 400 });
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(6);
  for (let index = 100; index <= 160; index += 1) {
    made.noteProduced(PICTURE, index);
  }
  const before = made.runsOn(PICTURE).length;

  watches("one", { atSeconds: 440 });
  made.reconcile();

  assert.equal(made.runsOn(PICTURE).length, before, "no process is bought for film that exists");
  assertNoOverlap(made);
});

test("one viewer seeking back into film nobody has gets an encoder there", () => {
  // Behind them is not the same as made. Where the film was never encoded, going
  // back is exactly as bare as going forward, and the arithmetic is the same one.
  const { made, watches } = orchestrator();
  watches("one", { atSeconds: 3000 });
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(6);
  made.noteProduced(PICTURE, 750);

  watches("one", { atSeconds: 400 });
  made.reconcile();

  const coverage = made.coverageOf(PICTURE);
  assert.equal(coverage.stateOf(100), "making", "somebody is making where they landed");
  assertNoOverlap(made);
});

test("two viewers: one seeks back onto film the other already had made", () => {
  const { made, watches } = orchestrator({ maxRuns: 3 });
  watches("one", { atSeconds: 400 });
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(6);
  for (let index = 100; index <= 200; index += 1) {
    made.noteProduced(PICTURE, index);
  }
  watches("two", { atSeconds: 3000 });
  made.reconcile();
  for (const run of made.runsOn(PICTURE)) {
    run.noteSpeed(6);
  }
  const before = made.runsOn(PICTURE).length;

  // The far one comes back to where the first one has already been.
  watches("two", { atSeconds: 500 });
  made.reconcile();

  assert.ok(made.runsOn(PICTURE).length <= before,
    "coming back onto made film buys nobody an encoder");
  assertNoOverlap(made);
});

test("three viewers: one forward, one back, one paused", () => {
  // All three motions at once, which is the state a real proxy is in most of the
  // time. What must hold is what always must: never two encoders on one number,
  // never more than the machine affords, and somebody making what the moving
  // viewers are about to need.
  const { made, watches } = orchestrator({ maxRuns: 3 });
  watches("one", { atSeconds: 400 });
  watches("two", { atSeconds: 2000 });
  watches("three", { atSeconds: 3600 });
  made.reconcile();
  for (const run of made.runsOn(PICTURE)) {
    run.noteSpeed(6);
  }
  made.reconcile();

  watches("one", { atSeconds: 800 });
  watches("two", { atSeconds: 1200 });
  watches("three", { atSeconds: 3600, playing: false });
  made.reconcile();

  assert.ok(made.runsOn(PICTURE).length <= 3, "never more than the machine holds");
  assertNoOverlap(made);
  const coverage = made.coverageOf(PICTURE);
  assert.equal(coverage.stateOf(200), "making", "the one who went forward is served");
  assert.equal(coverage.stateOf(300), "making", "and so is the one who came back");
});

test("a viewer scrubbing back and forth does not accumulate encoders", () => {
  // A person dragging the time bar states a new position every few hundred
  // milliseconds, and each of those is a state the plan answers. What must hold
  // is that the answers do not pile up: an encoder bought for a place the viewer
  // passed through is not still running when they have gone back.
  //
  // Not that the arrangement is identical to the one before the scrub — the
  // model does not promise that and nothing here should claim it. What it
  // promises is that no arrangement costs more than it is worth.
  const { made, watches } = orchestrator({ maxRuns: 3 });
  watches("one", { atSeconds: 400 });
  made.reconcile();
  made.runsOn(PICTURE)[0].noteSpeed(6);
  made.noteProduced(PICTURE, 100);
  made.reconcile();
  const settled = placements(made);

  watches("one", { atSeconds: 2000 });
  made.reconcile();
  for (const run of made.runsOn(PICTURE)) {
    run.noteSpeed(6);
  }
  watches("one", { atSeconds: 404 });
  made.reconcile();
  watches("one", { atSeconds: 400 });
  made.reconcile();
  made.reconcile();

  assert.ok(made.runsOn(PICTURE).length <= Math.max(1, settled.length),
    "no more encoders than before the scrub");
  assert.equal(made.coverageOf(PICTURE).stateOf(105), "making", "and the viewer is served");
  assertNoOverlap(made);
});
