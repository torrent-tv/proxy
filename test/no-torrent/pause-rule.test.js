/**
 * @file Whether a less urgent encoder runs beside the leading one, from the
 * leader's own per-second readings (torrent-tv/meta#180, phase 4).
 *
 * Runs are plain objects and readings are given, so nothing spawns ffmpeg. The
 * cases are the plan's checks: a need met or not met, a viewer waiting with a
 * slowdown inside or beyond the leader's scatter, a fraction of a core free,
 * work too small to measure, and no alternation under unchanged load.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PauseRule } from "../../services/encode/PauseRule.js";
import { EncodeOrchestrator } from "../../services/encode/EncodeOrchestrator.js";

const BAND = { address: "picture", urgent: false, priority: 99 };

function run(name, { suspended = false } = {}) {
  return { name, isSuspended: suspended, isAlive: true };
}

/**
 * Seconds of `who`, one per entry, from `start` (seconds).
 *
 * @param {PauseRule} rule
 * @param {object} who
 * @param {number} start
 * @param {Array<{ cores: number, speed: number | null, running: object[], waiting?: boolean }>} seconds
 */
function feed(rule, who, start, seconds) {
  seconds.forEach((second, offset) => {
    rule.noteSecond(who, { at: (start + offset) * 1000, cores: second.cores, speed: second.speed }, second.running, second.waiting);
  });
}

const judge = (rule, params) => rule.judge({ band: BAND, address: "sound", remainingFilm: Number.POSITIVE_INFINITY,
  free: null, others: null, running: [], now: 0, ...params });

test("without readings of the leader there is nothing to judge from", () => {
  const rule = new PauseRule();
  const leader = run("L");
  const other = run("r");
  assert.equal(judge(rule, { leader, run: other, need: 1.5 }), null);
});

test("a finite need met with the other run beside it: it keeps running", () => {
  const rule = new PauseRule();
  const leader = run("L");
  const other = run("r");
  feed(rule, leader, 1, [1.9, 2.0, 2.1].map((speed) => ({ cores: 2, speed, running: [leader, other] })));
  const verdict = judge(rule, { leader, run: other, need: 1.5, running: [leader, other], now: 5000 });
  assert.equal(verdict.runs, true);
  assert.match(verdict.because, /made 2\.00x beside it over 3s, needing 1\.50x/);
});

test("a finite need not met beside it: paused", () => {
  const rule = new PauseRule();
  const leader = run("L");
  const other = run("r");
  feed(rule, leader, 1, [1.1, 1.2, 1.0].map((speed) => ({ cores: 2, speed, running: [leader, other] })));
  const verdict = judge(rule, { leader, run: other, need: 1.5, running: [leader, other], now: 5000 });
  assert.equal(verdict.runs, false);
  assert.match(verdict.because, /below the 1\.50x its deadlines need/);
});

test("a viewer waits: a slowdown beyond the leader's scatter pauses, one within it does not", () => {
  const rule = new PauseRule();
  const leader = run("L");
  const other = run("r");
  // Without r: 3.0x with a scatter of 0.1.
  feed(rule, leader, 1, [2.9, 3.0, 3.1, 3.0].map((speed) => ({ cores: 3, speed, running: [leader] })));
  // Beside r: 2.95x, inside the scatter.
  feed(rule, leader, 5, [2.95, 2.9, 3.0].map((speed) => ({ cores: 3, speed, running: [leader, other] })));
  assert.equal(judge(rule, { leader, run: other, need: Number.POSITIVE_INFINITY, running: [leader, other], now: 9000 }).runs, true);

  const slowed = new PauseRule();
  feed(slowed, leader, 1, [2.9, 3.0, 3.1, 3.0].map((speed) => ({ cores: 3, speed, running: [leader] })));
  // Beside r: 2.5x, half a time faster than the scatter allows.
  feed(slowed, leader, 5, [2.5, 2.4, 2.6].map((speed) => ({ cores: 2.5, speed, running: [leader, other] })));
  const verdict = judge(slowed, { leader, run: other, need: Number.POSITIVE_INFINITY, running: [leader, other], now: 9000 });
  assert.equal(verdict.runs, false);
  assert.match(verdict.because, /2\.50x on 2\.50 cores beside it over 3s, 3\.00x \(scatter 0\.05\) on 3\.00 cores \(scatter 0\.00\) without it/);
});

test("a viewer waits: the leader's cores falling beyond their scatter pauses, though its speed scatters too much to show it", () => {
  const rule = new PauseRule();
  const leader = run("L");
  const other = run("r");
  // Per-second speed of a short piece scatters by as much as its median (Home
  // Assistant r78/r79); its cores do not.
  feed(rule, leader, 1, [[0.2, 1.5], [2.0, 1.52], [1.0, 1.48], [1.8, 1.5]].map(([speed, cores]) => ({ cores, speed, running: [leader] })));
  feed(rule, leader, 5, [[0.4, 1.1], [1.6, 1.12], [1.0, 1.08]].map(([speed, cores]) => ({ cores, speed, running: [leader, other] })));
  const verdict = judge(rule, { leader, run: other, need: Number.POSITIVE_INFINITY, running: [leader, other], now: 9000 });
  assert.equal(verdict.runs, false);
  assert.match(verdict.because, /on 1\.10 cores beside it/);
});

test("a viewer waits and the other run has always run beside the leader: the urgency rule, not a guess", () => {
  const rule = new PauseRule();
  const leader = run("L");
  const other = run("r");
  feed(rule, leader, 1, [2.5, 2.4, 2.6].map((speed) => ({ cores: 2, speed, running: [leader, other] })));
  assert.equal(judge(rule, { leader, run: other, need: Number.POSITIVE_INFINITY, running: [leader, other], now: 5000 }), null);
});

test("seconds in which the leader waited for its input are not counted against the other run", () => {
  const rule = new PauseRule();
  const leader = run("L");
  const other = run("r");
  feed(rule, leader, 1, [0.1, 0.2, 0.1].map((speed) => ({ cores: 0.3, speed, running: [leader, other], waiting: true })));
  assert.equal(judge(rule, { leader, run: other, need: 1.5, running: [leader, other], now: 5000 }), null);
});

test("a paused run is tried when a fraction of a core free is more than it draws", () => {
  const rule = new PauseRule();
  const leader = run("L");
  const other = run("r");
  feed(rule, other, 1, [0.3, 0.3, 0.3].map((cores) => ({ cores, speed: 10, running: [leader, other] })));
  other.isSuspended = true;
  feed(rule, leader, 4, [2, 2, 2].map((speed) => ({ cores: 3, speed, running: [leader] })));
  const verdict = judge(rule, { leader, run: other, need: Number.POSITIVE_INFINITY, free: 0.4, running: [leader], now: 8000 });
  assert.equal(verdict.runs, true);
  assert.match(verdict.because, /tried beside the leader: 0\.40 cores are free, more than the 0\.30 cores it draws/);
  // Not more than it draws, and no surplus over a finite need: it waits.
  const tight = judge(rule, { leader, run: other, need: 2, free: 0.2, running: [leader], now: 8000 });
  assert.equal(tight.runs, false);
});

test("a run started beside a measured leader is judged as a try, not paused first and tried a second later", () => {
  // Home Assistant r80: each short soundtrack run the plan started was paused
  // at once by the urgency rule and let go on the next reading.
  const rule = new PauseRule();
  const leader = run("L");
  const started = run("r");
  feed(rule, leader, 1, [2, 2, 2].map((speed) => ({ cores: 3, speed, running: [leader] })));
  const verdict = judge(rule, { leader, run: started, need: Number.POSITIVE_INFINITY, free: 0.13, running: [leader, started], now: 4000 });
  assert.equal(verdict.runs, true);
  assert.match(verdict.because, /tried beside the leader: 0\.13 cores are free/);
  // Once let go, it runs until it has been measured beside the leader.
  const next = judge(rule, { leader, run: started, need: Number.POSITIVE_INFINITY, free: 0, running: [leader, started], now: 5000 });
  assert.equal(next.runs, true);
  assert.match(next.because, /being measured beside the leader/);
  // Where the try condition fails, the pause gives its reason.
  const tight = run("tight");
  const held = judge(rule, { leader, run: tight, need: 2, free: 0, running: [leader, tight], now: 4000 });
  assert.equal(held.runs, false);
  assert.match(held.because, /0\.00 cores are free/);
});

test("work whose whole remaining stretch costs less than the leader's scatter is never paused", () => {
  const rule = new PauseRule();
  const leader = run("L");
  const copy = run("copy");
  // The copy: 0.2 cores at 150x, so 0.0013 CPU-s per second of film.
  feed(rule, copy, 1, [{ cores: 0.2, speed: 150, running: [leader, copy] }]);
  // The leader's cores scatter by 0.1 from second to second.
  feed(rule, leader, 1, [2.9, 3.0, 3.1].map((cores) => ({ cores, speed: 1.2, running: [leader, copy] })));
  const verdict = judge(rule, { leader, run: copy, need: 1.5, remainingFilm: 4, running: [leader, copy], now: 5000 });
  assert.equal(verdict.runs, true);
  assert.match(verdict.because, /less than the leader's scatter/);
});

test("under unchanged load one try and one pause, then no further try until a condition changes", () => {
  const rule = new PauseRule();
  const leader = run("L");
  const other = run("r");
  const third = run("third");
  feed(rule, leader, 1, [3.0, 3.0, 3.0].map((speed) => ({ cores: 3, speed, running: [leader] })));
  feed(rule, other, 1, [{ cores: 0.5, speed: 2, running: [leader, other] }]);
  other.isSuspended = true;
  const params = { leader, run: other, need: Number.POSITIVE_INFINITY, free: 1, others: 0.5 };
  // Tried: one core free, more than its half core.
  assert.equal(judge(rule, { ...params, running: [leader], now: 4000 }).runs, true);
  other.isSuspended = false;
  // Beside it the leader falls beyond its scatter: paused, and remembered.
  feed(rule, leader, 5, [2.0, 2.1, 2.0].map((speed) => ({ cores: 2.5, speed, running: [leader, other] })));
  assert.equal(judge(rule, { ...params, running: [leader, other], now: 8000 }).runs, false);
  other.isSuspended = true;
  // The same load: not tried again, though a core is still free.
  for (let second = 9; second < 20; second += 1) {
    feed(rule, leader, second, [{ cores: 3, speed: 3, running: [leader] }]);
    const verdict = judge(rule, { ...params, running: [leader], now: second * 1000 });
    assert.equal(verdict.runs, false, `second ${second}`);
    assert.match(verdict.because, /nothing it was tried under has changed/);
  }
  // Another run starts beside them: one new try.
  const changed = judge(rule, { ...params, running: [leader, third], now: 21000 });
  assert.equal(changed.runs, true);
  assert.match(changed.because, /the runs running changed since it was paused/);
});

test("a run not started yet is started only where the rule would let it go", () => {
  const rule = new PauseRule();
  const leader = run("L");
  assert.equal(rule.wouldStart({ leader, address: "sound", need: 1, free: 2 }).runs, false, "no readings: held as before");
  feed(rule, leader, 1, [1.5, 1.5, 1.5].map((speed) => ({ cores: 3, speed, running: [leader] })));
  // What the last run on this output drew.
  const before = run("before");
  feed(rule, before, 1, [{ cores: 0.8, speed: 5, running: [before] }]);
  rule.forget(before, "sound");
  assert.equal(rule.wouldStart({ leader, address: "sound", need: 1, free: 0.5 }).runs, true, "the leader has more than it needs");
  assert.equal(rule.wouldStart({ leader, address: "sound", need: 1.5, free: 0.5 }).runs, false, "half a core free, 0.8 drawn");
  assert.equal(rule.wouldStart({ leader, address: "sound", need: 1.5, free: 1 }).runs, true);
});

test("the orchestrator lets a paused soundtrack run beside the picture once the picture's readings allow it", () => {
  const PICTURE = "torrent:abc:fmt=mpegts:grid=even@0:video-only:v=0/enc/libx264/720x400@24/superfast";
  const SOUND = "torrent:abc:fmt=mpegts:grid=even@0:audio-only:a=0/0/copy";
  const free = 2;
  const made = new EncodeOrchestrator({
    maxRunsFor: () => 2, segmentSeconds: 4, startingSpeedFor: () => 1, now: () => 1000,
    logger: { info: () => {}, warn: () => {} }, makeRun: () => null,
    processor: { freeCores: () => free, otherCores: () => 0 }
  });
  const encoder = (head, pid) => ({
    from: head, to: head + 100, head, speedX: 1, isAlive: true, isStopping: false, isSuspended: false, process: { pid }, events: [],
    pause(reason) { this.isSuspended = true; this.events.push(`pause: ${reason}`); return true; },
    resume(reason) { this.isSuspended = false; this.events.push(`resume: ${reason}`); return true; },
    stop() { this.isAlive = false; }, noteProduced() {}
  });
  // The picture is wanted soon, the soundtrack far later.
  made.notePriorityMap(PICTURE, [{ from: 0, to: 200, priority: 100, withinSeconds: 8, urgent: false }]);
  made.notePriorityMap(SOUND, [{ from: 0, to: 2, priority: 100, withinSeconds: 8, urgent: false },
    { from: 3, to: 300, priority: 90, withinSeconds: 60, urgent: false }]);
  const picture = encoder(1, 11);
  const sound = encoder(200, 22);
  made.adopt(PICTURE, picture);
  made.adopt(SOUND, sound);

  made.shareTheMachine();
  assert.equal(sound.isSuspended, true, "nothing measured yet: paused as before");

  // Three seconds of the picture alone, at 2x on three cores.
  for (let second = 1; second <= 3; second += 1) {
    made.noteRunSeconds(new Map([[11, { cores: 3, speed: 2 }]]), second * 1000);
  }
  assert.equal(sound.isSuspended, false, "two cores free: tried beside the picture");
  assert.match(sound.events.at(-1), /runs beside it: tried beside the leader: 2\.00 cores are free/);

  // Beside it the picture keeps 2x, above what its deadlines need: it stays.
  for (let second = 4; second <= 6; second += 1) {
    made.noteRunSeconds(new Map([[11, { cores: 3, speed: 2 }], [22, { cores: 0.3, speed: 40 }]]), second * 1000);
  }
  assert.equal(sound.isSuspended, false);
});

test("the leader is short of the processor only while it makes film on it below its need", () => {
  const rule = new PauseRule();
  const leader = run("L");
  assert.equal(rule.shortfall({ leader, need: 1.5 }), null, "nothing measured");
  feed(rule, leader, 1, [1.1, 1.2].map((speed) => ({ cores: 2, speed, running: [leader] })));
  assert.equal(rule.shortfall({ leader, need: 1.5 }), null, "fewer seconds than a median is taken from");
  feed(rule, leader, 3, [{ cores: 2, speed: 1.3, running: [leader] }]);
  const short = rule.shortfall({ leader, need: 1.5 });
  assert.equal(short.speed.middle, 1.2);
  assert.ok(Math.abs(short.speed.scatter - 0.1) < 1e-9);
  assert.deepEqual([short.need, short.seconds], [1.5, 3]);
  assert.equal(rule.shortfall({ leader, need: 1.1 }), null, "the need is met");
  assert.equal(rule.shortfall({ leader, need: 0 }), null, "nothing is due");
  assert.equal(rule.shortfall({ leader, need: Number.POSITIVE_INFINITY }).need, Number.POSITIVE_INFINITY,
    "a viewer waits: any speed is short");
  feed(rule, leader, 4, [{ cores: 0.3, speed: 0.2, running: [leader], waiting: true }]);
  assert.equal(rule.shortfall({ leader, need: 1.5 }), null, "waiting for its input, the input is what it lacks");
});

test("the orchestrator says the leader is short only in a band a viewer is in, and each time it decides", () => {
  const PICTURE = "torrent:abc:fmt=mpegts:grid=even@0:video-only:v=0/enc/libx264/720x400@24/superfast";
  let told = 0;
  const made = new EncodeOrchestrator({
    maxRunsFor: () => 1, segmentSeconds: 4, startingSpeedFor: () => 1, now: () => 1000,
    logger: { info: () => {}, warn: () => {} }, makeRun: () => null,
    processor: { freeCores: () => 0, otherCores: () => 0 }, shortfallNoted: () => { told += 1; }
  });
  const picture = { from: 1, to: 100, head: 1, speedX: 1, isAlive: true, isStopping: false, isSuspended: false,
    process: { pid: 11 }, pause() { return true; }, resume() { return true; }, stop() {}, noteProduced() {} };
  // Due in 8 s for every piece from #1: a need of 0.5x at the head, above it further on.
  made.notePriorityMap(PICTURE, [{ from: 0, to: 200, priority: 100, withinSeconds: 8, urgent: false }]);
  made.adopt(PICTURE, picture);
  for (let second = 1; second <= 3; second += 1) {
    made.noteRunSeconds(new Map([[11, { cores: 3, speed: 0.4 }]]), second * 1000);
  }
  assert.ok(told >= 3);
  assert.equal(made.processorShortfall(), null, "not in a band a viewer is in");
  made.notePriorityMap(PICTURE, [{ from: 0, to: 200, priority: 100, withinSeconds: 0, urgent: true }]);
  made.shareTheMachine();
  const short = made.processorShortfall();
  assert.equal(short.address, PICTURE);
  assert.equal(short.need, 1, "due as it plays");
  assert.equal(short.speed.middle, 0.4);
  // Made faster than it is due: no longer short.
  for (let second = 4; second <= 8; second += 1) {
    made.noteRunSeconds(new Map([[11, { cores: 3, speed: 2 }]]), second * 1000);
  }
  assert.equal(made.processorShortfall(), null);
});

test("the run a viewer's start waits for by the forecast is short, whatever the map's deadlines say", () => {
  const PICTURE = "torrent:abc:fmt=mpegts:grid=even@0:video-only:v=0/enc/libx264/720x400@24/superfast";
  let told = 0;
  const made = new EncodeOrchestrator({
    maxRunsFor: () => 1, segmentSeconds: 4, startingSpeedFor: () => 1, now: () => 1000,
    logger: { info: () => {}, warn: () => {} }, makeRun: () => null,
    processor: { freeCores: () => 0, otherCores: () => 0 }, shortfallNoted: () => { told += 1; }
  });
  const picture = { from: 1, to: 100, head: 1, speedX: 1, isAlive: true, isStopping: false, isSuspended: false,
    process: { pid: 11 }, pause() { return true; }, resume() { return true; }, stop() {}, noteProduced() {} };
  // Due in 8 s and in no band a viewer is in: the map calls nothing urgent.
  made.notePriorityMap(PICTURE, [{ from: 0, to: 200, priority: 100, withinSeconds: 8, urgent: false }]);
  made.adopt(PICTURE, picture);
  for (let second = 1; second <= 3; second += 1) {
    made.noteRunSeconds(new Map([[11, { cores: 3, speed: 2 }]]), second * 1000);
  }
  assert.equal(made.processorShortfall(), null);
  // The forecast holds a viewer for the production of #2, which this run makes.
  const before = told;
  made.noteViewerWaiting("viewer", { address: PICTURE, index: 2 });
  assert.equal(told, before + 1, "decided again when the wait changes");
  const short = made.processorShortfall();
  assert.equal(short.address, PICTURE);
  assert.equal(short.need, Number.POSITIVE_INFINITY);
  assert.equal(short.waitedFor, 2);
  assert.equal(short.speed.middle, 2);
  made.noteViewerWaiting("viewer", { address: PICTURE, index: 2 });
  assert.equal(told, before + 1, "the same wait decides nothing again");
  // The piece is made: the run is past it, and nothing waits for this run.
  picture.head = 3;
  made.shareTheMachine();
  assert.equal(made.processorShortfall(), null);
  picture.head = 2;
  made.shareTheMachine();
  assert.equal(made.processorShortfall()?.waitedFor, 2);
  // A paused run is not short of the processor: it is not on it.
  picture.isSuspended = true;
  made.shareTheMachine();
  assert.equal(made.processorShortfall(), null);
  picture.isSuspended = false;
  // The viewer starts: the forecast names nothing an encoder makes.
  made.noteViewerWaiting("viewer", null);
  assert.equal(made.processorShortfall(), null);
  // Nobody is coming to the output: what was said about its viewers goes.
  made.noteViewerWaiting("viewer", { address: PICTURE, index: 2 });
  assert.equal(made.processorShortfall()?.waitedFor, 2);
  made.notePriorityMap(PICTURE, []);
  made.shareTheMachine();
  assert.equal(made.processorShortfall(), null);
});
