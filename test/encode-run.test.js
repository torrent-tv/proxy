/**
 * @file One encoder's lifetime: the stretch it was given, where it got to, and
 * whether its ending was the normal one.
 *
 * The process is injected, so none of this needs ffmpeg. What is checked is the
 * accounting the user asked for on 2026-09-04: exactly one ending is normal,
 * every other one says why, and none of them goes unrecorded.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EncodeRun } from "../services/encode/EncodeRun.js";
import { ENCODE_EXIT } from "../services/encode/encode-exit.js";
import { SoftwareEncoder } from "../services/encode/SoftwareEncoder.js";

/**
 * A process that does nothing until the test says what became of it.
 */
class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
  }

  exitWith(code, signal = null) {
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

/**
 * @param {Partial<{from:number,to:number}>} [span]
 */
function makeRun(span = {}) {
  const lines = [];
  const ends = [];
  const process_ = new FakeProcess();
  const run = new EncodeRun({
    address: "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/enc/libx264/854x480@24/veryfast/none/vbv=-",
    encoder: new SoftwareEncoder(),
    from: span.from ?? 10,
    to: span.to ?? 14,
    buildArgs: () => ["-i", "in", "out"],
    spawn: () => process_,
    logger: {
      info: (line) => lines.push(["info", line]),
      warn: (line) => lines.push(["warn", line])
    },
    now: () => 1000,
    onEnded: (ended) => ends.push(ended),
    because: "nobody is making #10 and a viewer is waiting for it"
  });
  return { run, process: process_, lines, ends };
}

test("a start says why it is starting and with what", () => {
  // The argument list alone cannot say whether this was a first open, a seek, a
  // quality step or a move off covered material — and with several runs at once
  // that is the only way to tell one start from another.
  const { lines } = makeRun();
  const [level, line] = lines[0];
  assert.equal(level, "info");
  // A run is named by what it produces: the stretch it was given, on the output
  // it makes segments of. No other live run of that output can hold it.
  assert.match(line, /encode-run #10\.\.#14 of torrent:abc:/);
  assert.match(line, /nobody is making #10/);
  assert.match(line, /ffmpeg -i in out/);
});

test("its head is the next number it will make, and moves as it makes them", () => {
  const { run } = makeRun();
  assert.equal(run.head, 10);
  run.noteProduced(10);
  run.noteProduced(11);
  assert.equal(run.head, 12);
  assert.equal(run.reached, 11);
});

test("reaching the end of its stretch and exiting is the one normal ending", () => {
  const { run, process, ends, lines } = makeRun({ from: 10, to: 12 });
  for (const index of [10, 11, 12]) {
    run.noteProduced(index);
  }
  process.exitWith(0, null);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].ending, ENCODE_EXIT.COMPLETE);
  assert.equal(ends[0].normal, true);
  assert.equal(lines.at(-1)[0], "info", "a normal ending is not a warning");
});

test("exiting cleanly short of its stretch is abnormal and says where it stopped", () => {
  // ffmpeg exits zero both at the end of a file and when its input stops
  // producing bytes; over a torrent the two look identical to it.
  const { run, process, ends } = makeRun({ from: 10, to: 14 });
  run.noteProduced(10);
  run.noteProduced(11);
  process.exitWith(0, null);
  assert.equal(ends[0].ending, ENCODE_EXIT.SHORT);
  assert.equal(ends[0].normal, false);
  assert.equal(ends[0].reached, 11);
  assert.match(ends[0].because, /#11 of #14/);
});

test("a non-zero exit is a failure carrying its code", () => {
  const { process, ends, lines } = makeRun();
  process.exitWith(255, null);
  assert.equal(ends[0].ending, ENCODE_EXIT.FAILED);
  assert.equal(ends[0].code, 255);
  assert.equal(lines.at(-1)[0], "warn");
});

test("our own kill is abnormal too, and carries the reason we gave", () => {
  // Hiding it among the normal endings would make a count of abnormal endings
  // useless, which is the whole point of counting them.
  const { run, process, ends } = makeRun();
  run.stop("moved past 20 segments that are already made");
  assert.deepEqual(process.signals, ["SIGTERM"]);
  process.exitWith(null, "SIGTERM");
  assert.equal(ends[0].ending, ENCODE_EXIT.STOPPED);
  assert.equal(ends[0].normal, false);
  assert.match(ends[0].because, /already made/);
});

test("an ending reports the stretch, how far it got and how long it lived", () => {
  const { run, process, ends } = makeRun({ from: 10, to: 14 });
  run.noteProduced(10);
  process.exitWith(1, null);
  const ended = ends[0];
  assert.equal(ended.from, 10);
  assert.equal(ended.to, 14);
  assert.equal(ended.reached, 10);
  assert.equal(ended.livedMs, 0, "the clock is injected, so this is exact");
  assert.equal(ended.address.includes("854x480"), true);
});

test("a process that could not be started ends like any other failure", () => {
  const { process, ends } = makeRun();
  process.emit("error", new Error("ENOENT"));
  assert.equal(ends[0].ending, ENCODE_EXIT.FAILED);
  assert.match(ends[0].because, /ENOENT/);
});

test("its speed is film made between closed pieces over its own working time", () => {
  const clock = { at: 1000 };
  const process_ = new FakeProcess();
  process_.stdout = new EventEmitter();
  process_.stdio = [null, process_.stdout, null, new EventEmitter()];
  const readings = [];
  const run = new EncodeRun({
    address: "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy",
    encoder: new SoftwareEncoder(),
    from: 0,
    to: 9,
    buildArgs: () => [],
    spawn: () => process_,
    logger: { info() {}, warn() {} },
    now: () => clock.at,
    onSpeedMeasured: (reading) => readings.push(reading)
  });
  assert.equal(run.speedX, 0, "nothing measured yet");
  const report = (seconds) => process_.stdout.emit("data", `out_time_ms=${seconds * 1_000_000}\n`);
  const closed = (name) => process_.stdio[3].emit("data", `${name}\n`);
  report(0);
  closed("a");
  clock.at += 1000;
  report(4);
  closed("b"); // "a" is published: the reckoning starts here
  assert.equal(run.speedX, 0, "one closed piece measures nothing");
  // The input waits for the swarm for 30 s; that is not the run's work.
  run.inputWaitBegins();
  clock.at += 30_000;
  run.inputWaitEnds();
  clock.at += 2000;
  report(12);
  closed("c"); // "b" is published
  assert.equal(run.speedX, 4, "8 s of film over 2 s of work");
  assert.deepEqual(readings, [{ speed: 4, at: 34_000 }], "told once, with when");
});

test("a segment number behind its own start is not its to claim", () => {
  const { run } = makeRun({ from: 10, to: 14 });
  run.noteProduced(4);
  assert.deepEqual(run.produced, []);
});

test("CSV closure times survive split channel chunks and a zero first-entry start", () => {
  const process_ = new FakeProcess();
  process_.stdio = [null, null, null, new EventEmitter()];
  const closed = [];
  const run = new EncodeRun({
    address: "audio", encoder: new SoftwareEncoder(), from: 13, to: 14,
    buildArgs: () => [], spawn: () => process_, logger: { info() {}, warn() {} },
    indexOfName: name => Number(name.match(/(\d+)\.mp4$/)[1]),
    onClosed: (name, timing) => { closed.push({ name, timing }); return name; }
  });
  process_.stdio[3].emit("data", "making-0-00013.mp4,0.000000,81.364");
  process_.stdio[3].emit("data", "000\nmaking-0-00014.mp4,81.364000,91.800000\n");
  process_.exitWith(0);
  assert.equal(run.reached, 14);
  assert.deepEqual(closed.map(({ timing }) => timing), [
    { endMicros: 81_364_000n },
    { endMicros: 91_800_000n }
  ]);
});

test("a refused publication stops its claim and ends as a publication failure", () => {
  const process_ = new FakeProcess();
  process_.stdio = [null, null, null, new EventEmitter()];
  const ends = [];
  const run = new EncodeRun({
    address: "audio", encoder: new SoftwareEncoder(), from: 13, to: 14,
    buildArgs: () => [], spawn: () => process_, logger: { info() {}, warn() {} },
    onClosed: () => { throw new Error("piece 13 is incomplete"); },
    onEnded: ended => ends.push(ended)
  });
  process_.stdio[3].emit("data", "making-0-00013.mp4,71.55,71.56\nmaking-0-00014.mp4,71.56,91.8\n");
  assert.deepEqual(process_.signals, ["SIGTERM"]);
  process_.exitWith(0);
  assert.equal(run.isAlive, false);
  assert.equal(ends[0].ending, ENCODE_EXIT.PUBLICATION_FAILED);
  assert.equal(ends[0].because, "piece 13 is incomplete");
});
