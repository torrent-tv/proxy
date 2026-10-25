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
import { EncodeRun } from "../../services/encode/EncodeRun.js";
import { ENCODE_EXIT } from "../../services/encode/encode-exit.js";
import { SoftwareEncoder } from "../../services/encode/SoftwareEncoder.js";
import { fakeProcess, silentLogger } from "./helpers/encode-run.js";

/**
 * A process that does nothing until the test says what became of it.
 */
class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.stdin = new EventEmitter();
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

test("an input error between writes is observed without losing the decoder failure", () => {
  const { run, process, lines, ends } = makeRun();
  run.lastError = "invalid decoder data";
  assert.doesNotThrow(() => process.stdin.emit("error", new Error("write EPIPE")));
  assert.equal(run.lastError, "invalid decoder data");
  assert.ok(lines.some(([level, line]) => level === "warn" && line.includes("write EPIPE")));
  process.exitWith(1);
  assert.equal(ends.length, 1);
});

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

test("a suspended run that is stopped is continued first, so it can act on SIGTERM", () => {
  // Field 2026-10-11: the stop moved the state off SUSPENDED before asking for
  // SIGCONT, which is sent only from SUSPENDED, so the process stayed stopped
  // with its input admitted until the proxy itself was restarted.
  const { run, process, ends } = makeRun();
  assert.equal(run.pause("nothing is waiting for it"), true);
  run.stop("nobody is watching this output");
  assert.deepEqual(process.signals, ["SIGSTOP", "SIGCONT", "SIGTERM"]);
  process.exitWith(null, "SIGTERM");
  assert.equal(ends[0].ending, ENCODE_EXIT.STOPPED);
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

test("its speed is film made over its own working time, including for a one-piece run", () => {
  const clock = { at: 1000 };
  const process_ = new FakeProcess();
  process_.stdout = new EventEmitter();
  process_.stdio = [null, process_.stdout, null, new EventEmitter()];
  const readings = [];
  const closedPairs = [];
  const run = new EncodeRun({
    address: "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy",
    encoder: new SoftwareEncoder(),
    from: 0,
    to: 9,
    buildArgs: () => [],
    spawn: () => process_,
    logger: { info() {}, warn() {} },
    now: () => clock.at,
    publishesAlone: true,
    onSpeedMeasured: (reading) => readings.push(reading),
    onClosed: (name, following) => { closedPairs.push([name, following]); return name; }
  });
  assert.equal(run.speedX, 0, "nothing measured yet");
  const report = (seconds) => process_.stdout.emit("data", `out_time_ms=${seconds * 1_000_000}\n`);
  const closed = (name) => process_.stdio[3].emit("data", `${name}\n`);
  // The input waits for the swarm for 30 s; that is not the run's work.
  run.inputWaitBegins();
  clock.at += 30_000;
  report(0.5);
  run.inputWaitEnds();
  clock.at += 1000;
  report(4);
  closed("a");
  assert.equal(run.speedX, 3.5, "3.5 s of film over 1 s of work, excluding the input wait");
  assert.deepEqual(closedPairs, [["a", null]], "a completed piece is published on its own");
  assert.deepEqual(readings, [{ speed: 3.5, at: 32_000 }], "told once, with when");
});

test("one positive progress report measures a one-piece run after its input wait", () => {
  const clock = { at: 1000 };
  const process_ = new FakeProcess();
  process_.stdout = new EventEmitter();
  process_.stdio = [null, process_.stdout, null, new EventEmitter()];
  const readings = [];
  const closed = [];
  const run = new EncodeRun({
    address: "torrent:abc:fmt=fmp4:grid=kf@0:audio-only:a=0/aac",
    encoder: new SoftwareEncoder(), from: 0, to: 0,
    buildArgs: () => [], spawn: () => process_, logger: { info() {}, warn() {} },
    now: () => clock.at, publishesAlone: true,
    onSpeedMeasured: reading => readings.push(reading),
    onClosed: name => { closed.push(name); return name; }
  });
  const report = seconds => process_.stdout.emit("data", `out_time_ms=${seconds * 1_000_000}\n`);
  run.inputWaitBegins();
  clock.at += 30_000;
  process_.stdio[3].emit("data", "segment-00000.mp4\n");
  run.inputWaitEnds();
  clock.at += 2000;
  report(4);
  assert.equal(run.speedX, 2, "4 s of film over 2 s of active encoder work");
  assert.deepEqual(closed, ["segment-00000.mp4"]);
  assert.deepEqual(readings, [{ speed: 2, at: 33_000 }]);
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
    onClosed: (name, _following, timing) => { closed.push({ name, timing }); return name; }
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

test("a trailing packet file outside the admitted run cannot fail its completed interval", () => {
  const process_ = new FakeProcess();
  process_.stdio = [null, null, null, new EventEmitter()];
  const closed = [], ends = [];
  const run = new EncodeRun({
    address: "audio", encoder: new SoftwareEncoder(), from: 118, to: 118,
    buildArgs: () => [], spawn: () => process_, logger: silentLogger,
    indexOfName: name => Number(name.match(/(\d+)\.mp4$/)[1]),
    onClosed: (name, following) => {
      closed.push([name, following]);
      if (name.endsWith("00119.mp4")) throw new Error("piece 119 was not admitted");
      return name;
    },
    onEnded: ended => ends.push(ended)
  });
  process_.stdio[3].emit("data", "making-0-00118.mp4,854.464,875.285\nmaking-0-00119.mp4,875.285,875.307\n");
  process_.exitWith(0);
  assert.equal(run.reached, 118);
  assert.deepEqual(closed, [["making-0-00118.mp4", "making-0-00119.mp4"]]);
  assert.equal(ends[0].ending, ENCODE_EXIT.COMPLETE);
  assert.deepEqual(process_.signals, []);
});

test("a refused publication stops its claim and ends as a publication failure", () => {
  const process_ = new FakeProcess();
  process_.stdio = [null, null, null, new EventEmitter()];
  const ends = [];
  const run = new EncodeRun({
    address: "audio", encoder: new SoftwareEncoder(), from: 13, to: 14,
    buildArgs: () => [], spawn: () => process_, logger: { info() {}, warn() {} },
    onClosed: () => { throw Object.assign(new Error("piece 13 is incomplete"), { code: "ERR_INCOMPLETE_MEDIA" }); },
    onEnded: ended => ends.push(ended)
  });
  process_.stdio[3].emit("data", "making-0-00013.mp4,71.55,71.56\nmaking-0-00014.mp4,71.56,91.8\n");
  assert.deepEqual(process_.signals, ["SIGTERM"]);
  process_.exitWith(0);
  assert.equal(run.isAlive, false);
  assert.equal(ends[0].ending, ENCODE_EXIT.PUBLICATION_FAILED);
  assert.equal(ends[0].because, "piece 13 is incomplete");
  assert.equal(ends[0].publicationCode, "ERR_INCOMPLETE_MEDIA");
});

test("a run whose process never started is not signalled, because pid 0 is our own process group", () => {
  // Node reports a failed start (ENOENT) on a later turn; until then the child's
  // process id is 0, and a signal sent to it is `kill(0, …)` — every process in
  // our group, the proxy included. Measured 2026-10-03 under `node --test`.
  const child = fakeProcess({ pid: null });
  const run = new EncodeRun({
    address: "torrent:abc:video-only:v=0/copy",
    encoder: { name: "libx264", kind: "software" },
    from: 0,
    to: 4,
    buildArgs: () => [],
    spawn: () => child,
    logger: silentLogger,
    because: "a test asked for it"
  });
  run.stop("the viewer left");
  assert.deepEqual(child.signals, [], "a process that did not start was sent a signal");
});

test("a piece closed before a stop is published with the file the stop flushed, which is kept as a tail", () => {
  // torrent-tv/meta#178: the file flushed after a stop begins with the next
  // keyframe; it says where that keyframe's leading pictures end the piece
  // before, and it holds those pictures for the run that starts there.
  const process_ = new FakeProcess();
  process_.stdio = [null, null, null, new EventEmitter()];
  const closed = [], tails = [], ends = [];
  const run = new EncodeRun({
    address: "picture", encoder: new SoftwareEncoder(), from: 20, to: 30,
    buildArgs: () => [], spawn: () => process_, logger: silentLogger,
    indexOfName: name => Number(name.match(/(\d+)\.mp4$/)[1]),
    onClosed: (name, following) => { closed.push([name, following]); return name; },
    onTail: name => tails.push(name),
    onEnded: ended => ends.push(ended)
  });
  process_.stdio[3].emit("data", "making-0-00020.mp4,200,210\nmaking-0-00021.mp4,210,220\n");
  assert.deepEqual(closed, [["making-0-00020.mp4", "making-0-00021.mp4"]]);
  run.stop("the viewer moved away");
  assert.equal(closed.length, 1, "the piece waits for the file the stop flushes");
  process_.stdio[3].emit("data", "making-0-00022.mp4,220,223.5\n");
  assert.deepEqual(closed[1], ["making-0-00021.mp4", "making-0-00022.mp4"]);
  assert.deepEqual(tails, ["making-0-00022.mp4"]);
  process_.exitWith(255);
  assert.equal(ends[0].ending, ENCODE_EXIT.STOPPED);
});

test("a piece closed before a stop that cannot be proved whole is left unpublished, and the run ends as stopped", () => {
  const process_ = new FakeProcess();
  process_.stdio = [null, null, null, new EventEmitter()];
  const ends = [];
  let calls = 0;
  const run = new EncodeRun({
    address: "picture", encoder: new SoftwareEncoder(), from: 20, to: 30,
    buildArgs: () => [], spawn: () => process_, logger: silentLogger,
    indexOfName: name => Number(name.match(/(\d+)\.mp4$/)[1]),
    onClosed: (name) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error(`${name} is short`), { code: "ERR_INCOMPLETE_MEDIA" });
      return name;
    },
    onEnded: ended => ends.push(ended)
  });
  process_.stdio[3].emit("data", "making-0-00020.mp4,200,210\nmaking-0-00021.mp4,210,220\n");
  run.stop("the viewer moved away");
  // No flushed file is named before the exit: the piece is judged without one.
  process_.exitWith(255);
  assert.equal(calls, 2);
  assert.equal(ends[0].ending, ENCODE_EXIT.STOPPED, "a refusal at a stop is not a publication failure");
});

test("the file a run closes past its last cut is handed over as a tail and not published", () => {
  const process_ = new FakeProcess();
  process_.stdio = [null, null, null, new EventEmitter()];
  const closed = [], tails = [];
  new EncodeRun({
    address: "picture", encoder: new SoftwareEncoder(), from: 7, to: 7,
    buildArgs: () => [], spawn: () => process_, logger: silentLogger,
    indexOfName: name => Number(name.match(/(\d+)\.mp4$/)[1]),
    onClosed: (name, following) => { closed.push([name, following]); return name; },
    onTail: name => tails.push(name)
  });
  process_.stdio[3].emit("data", "making-0-00007.mp4,0,73.99\nmaking-0-00008.mp4,74.283,74.657\n");
  assert.deepEqual(closed, [["making-0-00007.mp4", "making-0-00008.mp4"]]);
  assert.deepEqual(tails, ["making-0-00008.mp4"]);
});

test("a piece that needs nothing after it is published on its own line once proved whole, and only once", () => {
  const process_ = new FakeProcess();
  process_.stdio = [null, null, null, new EventEmitter()];
  const calls = [];
  // The field case of 2026-10-12: the AVI's run from #27 after a seek back to
  // 100 s; #27 is proved whole by its own bytes, #28 is not yet.
  const provedOnItsOwn = new Set(["making-27-00027.mp4"]);
  const run = new EncodeRun({
    address: "video", encoder: new SoftwareEncoder(), from: 27, to: 30,
    buildArgs: () => [], spawn: () => process_, logger: silentLogger, publishesAlone: true,
    indexOfName: name => Number(name.match(/(\d+)\.mp4$/)[1]),
    onClosed: (name, following, _timing, { tentative = false } = {}) => {
      calls.push([name, following, tentative]);
      return tentative && !provedOnItsOwn.has(name) ? null : name;
    }
  });
  process_.stdio[3].emit("data", "making-27-00027.mp4,108.000000,112.000000\n");
  assert.deepEqual(run.produced, [27], "published on its own line");
  process_.stdio[3].emit("data", "making-27-00028.mp4,112.000000,116.000000\n");
  assert.deepEqual(run.produced, [27], "#28 is not proved on its own and waits");
  process_.stdio[3].emit("data", "making-27-00029.mp4,116.000000,120.000000\n");
  assert.deepEqual(run.produced, [27, 28], "the file after it publishes #28");
  assert.deepEqual(calls.slice(0, 4), [
    ["making-27-00027.mp4", null, true],
    ["making-27-00028.mp4", null, true],
    ["making-27-00028.mp4", "making-27-00029.mp4", false],
    ["making-27-00029.mp4", null, true]
  ]);
  assert.equal(calls.filter(([name]) => name === "making-27-00027.mp4").length, 1, "#27 is never published again");
});

test("a run whose pieces take material from the next file still waits for it", () => {
  const process_ = new FakeProcess();
  process_.stdio = [null, null, null, new EventEmitter()];
  const calls = [];
  const run = new EncodeRun({
    address: "muxed", encoder: new SoftwareEncoder(), from: 5, to: 6,
    buildArgs: () => [], spawn: () => process_, logger: silentLogger,
    indexOfName: name => Number(name.match(/(\d+)\.mp4$/)[1]),
    onClosed: (name, following, _timing, options) => { calls.push([name, following, options?.tentative ?? false]); return name; }
  });
  process_.stdio[3].emit("data", "making-5-00005.mp4,40.0,50.0\n");
  assert.deepEqual(run.produced, []);
  process_.stdio[3].emit("data", "making-5-00006.mp4,50.0,60.0\n");
  assert.deepEqual(calls, [["making-5-00005.mp4", "making-5-00006.mp4", false]]);
});

test("a stop ordered while an exited run publishes its last piece leaves the ending complete", () => {
  // Field 2026-10-23, Drifters 04 on Home Assistant: the run on #205 exited
  // with code 0, its last piece was published from the exit, the plan asked
  // again at once, found nothing left ahead of the run and stopped it. The
  // ending then took an edge the state table does not have ("STOPPED +
  // EXITED_COMPLETE — no such edge; ignored"), and the stop's age at the exit
  // was kept as what a kill costs on this host (torrent-tv/meta#117).
  const process_ = new FakeProcess();
  process_.stdio = [null, null, null, new EventEmitter()];
  const lines = [], ends = [];
  const run = new EncodeRun({
    address: "picture", encoder: new SoftwareEncoder(), from: 205, to: 205,
    buildArgs: () => [], spawn: () => process_,
    logger: { info: line => lines.push(line), warn: line => lines.push(line) },
    indexOfName: name => Number(name.match(/(\d+)\.mp4$/)[1]),
    onClosed: name => name,
    onProduced: () => run.stop("the film is no worse off without it"),
    onEnded: ended => ends.push(ended)
  });
  process_.stdio[3].emit("data", "making-0-00205.mp4,1409.326,1421.5\n");
  process_.exitWith(0);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].ending, ENCODE_EXIT.COMPLETE);
  assert.equal(ends[0].dyingMs, null, "a run that exited by itself did not die on command");
  assert.deepEqual(process_.signals, [], "nothing is signalled after the process exited");
  assert.ok(!lines.some(line => /no such edge/.test(line)), lines.join("\n"));
});
