/**
 * @file One finite stretch per original-input run (torrent-tv/meta#158).
 *
 * An original-input run copies the bytes of a stretch of segments before it
 * starts, and FFmpeg opens the file once for the whole stretch instead of once
 * per segment. What is checked: how the stretch is chosen (presence, the copy
 * time against the open, memory, the plan's bound), what it claims, the
 * command for it, the failure identity of a stretch, and real pieces cut from a
 * stretch of a generated file. Nothing here reaches a torrent: storage is a
 * fake, and the media is generated and served over loopback.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import ffmpegBin from "ffmpeg-static";
import { EncodeInputs } from "../../services/encode/EncodeInputs.js";
import { InputFailures } from "../../services/encode/InputFailures.js";
import { admitOriginalInput } from "../../services/encode/OriginalInput.js";
import { buildOriginalCommand } from "../../services/encode/source-command.js";
import { handleEncodeInputGet } from "../../routes/encode-input/get.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { judgePiece } from "../../services/encode/piece-completeness.js";
import { presentationSegment } from "../../services/encode/segment-formats/presentation-segment.js";
import { EncodeRun } from "../../services/encode/EncodeRun.js";
import { SoftwareEncoder } from "../../services/encode/SoftwareEncoder.js";
import { EncodeOrchestrator } from "../../services/encode/EncodeOrchestrator.js";
import { RunCosts } from "../../services/encode/run-costs.js";

// A file whose segment k is the ten bytes at 10k, and whose header and index
// are ten bytes at 1000 that every stretch needs once. A stretch of n segments
// therefore holds 10 + 10n bytes.
const HEADER = [1000, 1009];
const bytesOf = (from, to) => 10 + 10 * (to - from + 1);
const resolve = async (_output, from, to) => ({ kind: "result", sources: [{ sourceKey: "film", fileIndex: 0, timeShiftSeconds: 0,
  input: { original: true, from, fileLength: 2000, ranges: [[from * 10, to * 10 + 9], HEADER],
    selections: [{ track: { type: "video" }, index: 0 }] } }] });

/**
 * EncodeInputs over that file. The copy moves one byte per millisecond on a
 * clock the read itself advances, so the measured copy rate is exact.
 */
function inputsOver({ held = () => [[0, 999], HEADER], allowance = () => 10_000, capacity = () => null, urgent = () => true } = {}) {
  const clock = { at: 0 };
  const announced = [];
  const costs = new RunCosts();
  const inputs = new EncodeInputs({
    openOf: (asked) => costs.openOf(asked.outputKey),
    resolve,
    heldRanges: async () => held(),
    readRanges: async (_source, ranges) => {
      const buffers = ranges.map(([start, end]) => Buffer.alloc(end - start + 1));
      clock.at += buffers.reduce((sum, buffer) => sum + buffer.length, 0);
      return buffers;
    },
    reviseBudget: async () => inputs.allow(allowance()),
    capacity, urgent, now: () => clock.at,
    changed: (_output, result) => announced.push(result), failed: (_output, error) => { throw error; }
  });
  inputs.costs = costs;
  return { inputs, announced };
}

const output = { outputKey: "picture" };

/** Prepare, wait, and take what is ready. */
async function admitted(inputs, from, to) {
  assert.equal(inputs.take(output, from, to), null, "preparation is never synchronous");
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  return inputs.take(output, from, to);
}

/** One measured copy and one measured open: 1 byte/ms and 0.1 s, so 100 bytes. */
async function measured(inputs) {
  const first = await admitted(inputs, 0, 0);
  first.release();
  inputs.costs.noteOpen(output.outputKey, 0.1);
  assert.equal(inputs.stretchBytesFor(output), 100);
}

test("before a copy and an open are measured, a run gets one piece", async () => {
  const { inputs } = inputsOver();
  assert.equal(inputs.stretchBytesFor(output), null);
  const input = await admitted(inputs, 0, 50);
  assert.deepEqual([input.from, input.to, input.bytes], [0, 0, bytesOf(0, 0)]);
  input.release();
  inputs.costs.noteOpen(output.outputKey, 0.1);
  assert.equal(inputs.stretchBytesFor(output), 100, "the one-piece copy measured the rate");
});

test("the stretch copies no longer than an open, and ends at the first missing byte or the plan's bound", async () => {
  let held = [[0, 59], HEADER];
  const { inputs } = inputsOver({ held: () => held });
  await measured(inputs);
  let input = await admitted(inputs, 0, 50);
  assert.deepEqual([input.from, input.to], [0, 5], "segment 6 has no bytes yet");
  assert.ok(input.copyMs > 0);
  input.release();
  held = [[0, 999], HEADER];
  input = await admitted(inputs, 0, 50);
  assert.deepEqual([input.from, input.to, input.bytes], [0, 8, 100], "100 bytes copy in one open's time");
  input.release();
  input = await admitted(inputs, 0, 3);
  assert.deepEqual([input.from, input.to], [0, 3], "never past the plan's bound");
  input.release();
  assert.equal(inputs.held(), 0);
});

test("a stretch larger than the allowance runs as its longest admitted prefix", async () => {
  const { inputs } = inputsOver({ allowance: () => 50 });
  await measured(inputs);
  const input = await admitted(inputs, 0, 50);
  assert.deepEqual([input.from, input.to, input.bytes], [0, 3, 50]);
  input.release();
});

test("too little memory for one piece waits with only that piece's need, and a memory change starts it", async () => {
  let allowance = 10_000;
  const { inputs } = inputsOver({ allowance: () => allowance });
  await measured(inputs);
  allowance = 15;
  assert.equal(await admitted(inputs, 0, 50), null);
  assert.equal(inputs.required(), bytesOf(0, 0), "the larger stretch leaves no required claim");
  assert.equal(inputs.wanted(), bytesOf(0, 0));
  allowance = 10_000;
  inputs.memoryChanged();
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  const input = inputs.take(output, 0, 50);
  assert.deepEqual([input.from, input.to], [0, 8]);
  input.release();
  assert.equal(inputs.required(), 0);
});

test("room taken by another output while a stretch is being shortened shortens it again, not a wait", async () => {
  // The picture is sized for 150 bytes and the soundtrack for 50; 130 are
  // allowed. The picture finds 150 too much and looks for a shorter end; while
  // it looks, the soundtrack takes its 50; the 130 bytes it settled on no
  // longer fit, and it settles on the 80 that are left.
  let gates = null;
  const clock = { at: 0 };
  const costs = new RunCosts();
  const inputs = new EncodeInputs({
    openOf: (asked) => costs.openOf(asked.outputKey),
    resolve, heldRanges: async () => [[0, 999], HEADER], now: () => clock.at,
    readRanges: async (_source, ranges) => {
      const buffers = ranges.map(([start, end]) => Buffer.alloc(end - start + 1));
      clock.at += buffers.reduce((sum, buffer) => sum + buffer.length, 0);
      return buffers;
    },
    reviseBudget: () => {
      inputs.allow(130);
      if (!gates) return Promise.resolve();
      return new Promise(resolve_ => gates.push(resolve_));
    },
    changed: () => {}, failed: (_output, error) => { throw error; }
  });
  inputs.costs = costs;
  await measured(inputs);
  const soundtrack = { outputKey: "soundtrack" };
  inputs.costs.noteOpen(output.outputKey, 0.15);
  inputs.costs.noteOpen(output.outputKey, 0.15);
  inputs.costs.noteOpen(soundtrack.outputKey, 0.05);
  assert.equal(inputs.stretchBytesFor(output), 150);
  gates = [];
  assert.equal(inputs.take(output, 0, 50), null);
  assert.equal(inputs.take(soundtrack, 0, 50), null);
  for (let turn = 0; turn < 10 && gates.length < 2; turn++) await setImmediate();
  assert.equal(gates.length, 2, "both are sized and wait for the budget");
  // The soundtrack's shorter search reaches the budget first; the picture is
  // let through first, so its search for a shorter end is under way when the
  // soundtrack takes its room.
  gates[1]();
  gates[0]();
  for (let turn = 0; turn < 20; turn++) await setImmediate();
  const picture = inputs.take(output, 0, 50), sound = inputs.take(soundtrack, 0, 50);
  assert.deepEqual([sound?.to, picture?.to], [3, 6], "50 bytes for the soundtrack, the 80 left for the picture");
  assert.equal(inputs.held(), 130);
  picture.release();
  sound.release();
});

test("a stretch over the policy capacity is shortened, and only one piece over it is terminal", async () => {
  let capacity = 50, urgent = true;
  const { inputs, announced } = inputsOver({ capacity: () => capacity, urgent: () => urgent });
  await measured(inputs);
  const input = await admitted(inputs, 0, 50);
  assert.deepEqual([input.from, input.to], [0, 3], "a prefix fits, so nothing is terminal");
  input.release();
  assert.equal(inputs.failureOf(output), null);
  capacity = 15;
  urgent = false;
  assert.equal(await admitted(inputs, 5, 50), null);
  assert.equal(inputs.failureOf(output), null, "not urgent: it waits");
  urgent = true;
  inputs.retain(output, [{ from: 5, to: 50 }]);
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  assert.equal(inputs.failureOf(output)?.reason, "source-input-exceeds-memory-capacity");
  assert.equal(announced.at(-1).bytes, bytesOf(5, 5), "the terminal answer names the one-piece minimum");
});

test("a copy reaching past a bound the plan has since narrowed runs over its prefix, without a second copy", async () => {
  const { inputs } = inputsOver();
  await measured(inputs);
  assert.equal(inputs.take(output, 0, 50), null);
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  assert.equal(inputs.held(), 100);
  const copies = inputs.held();
  const input = inputs.take(output, 0, 4);
  assert.deepEqual([input.from, input.to], [0, 4], "the prepared 0..8 holds 0..4 whole");
  assert.equal(inputs.held(), copies, "kept until the run ends, not copied again");
  input.release();
  assert.equal(inputs.held(), 0);
});

test("a held copy whose start no live run ends before and no start is placed at goes back", async () => {
  const { inputs } = inputsOver();
  await measured(inputs);
  assert.equal(inputs.take(output, 10, 50), null);
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  assert.ok(inputs.held() > 0);
  inputs.retain(output, [{ from: 0, to: 2000 }], new Set([10]));
  assert.ok(inputs.held() > 0, "a live run ends at #9: kept");
  inputs.retain(output, [{ from: 0, to: 2000 }], new Set([40]));
  assert.equal(inputs.held(), 0, "after a seek to #40 it is given back, though the map still covers it");
});

test("an output that has not opened is sized by the host's startup reading, and says so", async () => {
  const lines = [];
  const costs = new RunCosts();
  costs.noteStartup({ firstByteWaitSec: 0.05, killCostSec: 0 });
  let at = 0;
  const inputs = new EncodeInputs({ resolve, openOf: (asked) => costs.openOf(asked.outputKey),
    heldRanges: async () => [[0, 999], HEADER],
    readRanges: async (_source, ranges) => { const buffers = ranges.map(([start, end]) => Buffer.alloc(end - start + 1)); at += buffers.reduce((sum, one) => sum + one.length, 0); return buffers; },
    reviseBudget: async () => inputs.allow(10_000), now: () => at, log: (line) => lines.push(line),
    changed: () => {}, failed: (_output, error) => { throw error; } });
  const first = await admitted(inputs, 0, 50);
  assert.deepEqual([first.from, first.to], [0, 0], "no copy rate yet: one piece");
  first.release();
  const second = await admitted(inputs, 1, 50);
  assert.deepEqual([second.from, second.to], [1, 4], "rate x the startup open: 50 bytes, four pieces");
  assert.ok(lines.some((line) => line.includes("sized by the host's startup open")));
  second.release();
});

test("the copy time is the reads alone", async () => {
  const sources = (await resolve(output, 0, 2)).sources;
  let at = 0;
  const input = await admitOriginalInput({ sources, now: () => at,
    reserve: async () => { at += 1000; return () => {}; },
    readRanges: async (_source, ranges) => { at += 7; return ranges.map(([start, end]) => Buffer.alloc(end - start + 1)); } });
  assert.equal(await input.whole, true);
  // Two reads: the header first, then the stretch, which goes on after the answer.
  assert.equal(input.copyMs, 14, "the wait for memory is not copying");
  input.release();
});

test("a stretch claims what its input reaches, and gives the rest back when it ends", () => {
  const address = "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy";
  const processes = new Map();
  const made = new EncodeOrchestrator({
    maxRunsFor: () => 1, segmentSeconds: 4, killCostSec: 0, firstByteWaitSec: 0.12,
    refetchSecPerFilmSecond: () => 0.25, startingSpeedFor: () => 2, now: () => 1000,
    logger: { info() {}, warn() {} },
    makeRun: ({ address: on, from }) => {
      const process_ = new EventEmitter();
      Object.assign(process_, { pid: 1, stdout: new EventEmitter(), kill(signal) { this.emit("close", null, signal); } });
      process_.stdio = [null, process_.stdout, null, new EventEmitter()];
      // As `EncodeRuns` builds an original-input run: its end is its input's.
      const run = new EncodeRun({ address: on, encoder: new SoftwareEncoder(), from, to: from + 2,
        buildArgs: () => [], spawn: () => process_, logger: { info() {}, warn() {} }, now: () => 1000,
        onEnded: (ended) => made.noteEnded(ended) });
      run.originalInput = { from, to: from + 2 };
      processes.set(run, process_);
      return run;
    }
  });
  made.setSegmentCount(address, 1000);
  made.notePriorityMap(address, [{ from: 10, to: 100, priority: 1, withinSeconds: 0 }]);
  made.reconcile();
  const [run] = made.runsOn(address);
  assert.deepEqual([run.from, run.to], [10, 12]);
  const coverage = made.coverageOf(address);
  assert.equal(coverage.stateOf(12), "making");
  assert.notEqual(coverage.stateOf(13), "making", "the plan's longer bound is not claimed");
  processes.get(run).emit("close", 0, null);
  assert.notEqual(coverage.stateOf(11), "making", "what it did not make is free again");
});

test("a failure inside a stretch is refused only while the commanded stretch is the same", () => {
  const failures = new InputFailures();
  const parameters = { outputKey: "picture", encoder: "libx264" };
  const input = { fingerprint: "same padded bytes" };
  const keyOf = (from, to) => failures.key(input, { ...parameters, interval: [from, to] });
  // A run over #10..#14 completed #10 and #11 and failed at its head, #12.
  failures.note("picture", 12, keyOf(10, 14), "short");
  assert.equal(failures.failure("picture", 12, keyOf(12, 14)), null, "the retry at the head is a new stretch");
  failures.note("picture", 12, keyOf(12, 14), "short");
  assert.equal(failures.failure("picture", 12, keyOf(12, 14)), "short", "the same stretch failing again is refused");
  assert.notEqual(keyOf(10, 14), keyOf(10, 12), "equal bytes, different stretch, different key");
});

test("a stretch's command cuts at every boundary inside it, ends at its end and numbers from its start", () => {
  const grid = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60];
  const picture = { sourceKey: "film", fileIndex: 0, timeShiftSeconds: 0.5,
    input: { original: true, from: 40.5, fileLength: 100, ranges: [[0, 99]], selections: [{ track: { type: "video" }, index: 0 }] } };
  const sound = { sourceKey: "film", fileIndex: 1, timeShiftSeconds: 0.25,
    input: { original: true, from: 40.25, fileLength: 100, ranges: [[0, 99]], selections: [{ track: { type: "audio" }, index: 2 }] } };
  const base = { admittedInput: { sources: [picture, sound], runTag: "10r7" }, inputToken: 7, baseUrl: "http://127.0.0.1:9090",
    timeline: { published: grid, cutGrid: "keyframe" }, startIndex: 10, endIndex: 12, audioOnly: false,
    transcodeAudio: true, output: {}, videoEncoder: { buildVideoArgs: () => ["-c:v", "libx264"] },
    segmentFormat: fmp4Format, segmentDurationSec: 4 };
  const argument = (args, name) => args[args.indexOf(name) + 1];

  const copied = buildOriginalCommand({ ...base, transcodeVideo: false, audioSeparate: false }).args;
  assert.equal(argument(copied, "-segment_times"), "4,8,12", "interior boundaries and the end, from the stretch's start");
  assert.equal(argument(copied, "-to"), "52.5", "the end on the picture file's own clock");
  assert.equal(argument(copied, "-segment_start_number"), "10");
  assert.ok(copied.includes("cache:http://127.0.0.1:9090/encode-input/7/0"));
  assert.ok(copied.includes("cache:http://127.0.0.1:9090/encode-input/7/1"), "the separate soundtrack file is a second input");
  assert.ok(copied.includes("1:a:2?"));
  assert.ok(copied.at(-1).includes("10r7"));

  const encoded = buildOriginalCommand({ ...base, transcodeVideo: true, audioSeparate: true }).args;
  assert.equal(argument(encoded, "-t"), "12", "a re-encode's end is a length from the stretch's start");
  assert.equal(argument(encoded, "-segment_start_number"), "10");
  assert.ok(encoded.includes("-an"), "a soundtrack served separately is not mapped");

  assert.throws(() => buildOriginalCommand({ ...base, transcodeVideo: false, audioSeparate: false, endIndex: 20 }),
    /finite published interval/, "a stretch past the published table is refused");
});

// Generated media over loopback HTTP only; no torrent imports.
for (const [label, startIndex, endIndex, seconds] of [["before the film's end", 1, 3, 12.2], ["to the film's end", 4, 5, 12]]) {
  test(`a stretch ${label} publishes every piece of it whole`, async () => {
    const cut = 2;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv158-stretch-"));
    let input, server;
    try {
      const file = path.join(directory, "input.mkv");
      const generated = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25",
        "-t", String(seconds), "-c:v", "libx264", "-bf", "2", "-g", "50", file], { encoding: "utf8", windowsHide: true });
      assert.equal(generated.status, 0, generated.stderr);
      const bytes = await fs.readFile(file);
      const grid = Array.from({ length: 7 }, (_, index) => index * cut);
      input = await admitOriginalInput({ sources: [{ sourceKey: "generated", fileIndex: 0, timeShiftSeconds: 0,
        input: { original: true, from: startIndex * cut, fileLength: bytes.length, ranges: [[0, bytes.length - 1]],
          selections: [{ track: { type: "video", reorderDepth: 2 }, index: 0 }] } }],
        reserve: async () => () => {}, readRanges: async () => [bytes] });
      input.runTag = "stretch";
      server = http.createServer((req, res) => {
        req.params = { token: "1", fileIndex: "0" }; req.raw = req;
        const reply = { raw: res, hijack() { return this; }, code(status) { res.statusCode = status; return this; },
          header(name, value) { res.setHeader(name, value); return this; },
          send(body) { res.end(Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined); return this; } };
        handleEncodeInputGet(req, reply, { inputOf: () => input });
      });
      await new Promise(resolve_ => server.listen(0, "127.0.0.1", resolve_));
      const command = buildOriginalCommand({ admittedInput: input, inputToken: 1,
        baseUrl: `http://127.0.0.1:${server.address().port}`, startIndex, endIndex,
        timeline: { published: grid, cutGrid: "keyframe" }, keyframes: { times: grid },
        audioOnly: false, audioSeparate: true, transcodeAudio: false, transcodeVideo: false,
        output: {}, videoEncoder: {}, segmentFormat: fmp4Format, segmentDurationSec: cut });
      const child = spawn(ffmpegBin, command.args, { cwd: directory, stdio: ["ignore", "ignore", "pipe", "pipe"], windowsHide: true });
      let diagnostics = "", named = "";
      child.stderr.on("data", chunk => diagnostics += chunk);
      child.stdio[3].on("data", chunk => named += chunk);
      const timeout = setTimeout(() => child.kill(), 60000);
      const code = await new Promise((resolve_, reject) => { child.once("error", reject); child.once("close", resolve_); });
      clearTimeout(timeout);
      assert.equal(code, 0, diagnostics);
      assert.equal(diagnostics.trim(), "");
      const nameOf = index => `making-stretch-${String(index).padStart(5, "0")}.mp4`;
      for (let index = startIndex; index <= endIndex; index++) {
        assert.ok(named.includes(nameOf(index)), `piece ${index} is named on the closing channel`);
        const raw = await fs.readFile(path.join(directory, nameOf(index)));
        const following = await fs.readFile(path.join(directory, nameOf(index + 1))).catch(error => {
          if (error.code === "ENOENT") return null; throw error;
        });
        const interval = { from: grid[index], to: grid[index + 1], requiredKinds: ["vide"] };
        const coverage = fmp4Format.readMediaRanges(presentationSegment(raw, following, interval));
        const judged = judgePiece(fmp4Format, coverage, undefined, interval);
        assert.equal(judged.whole, true, `piece ${index}: ${JSON.stringify(judged)}`);
        assert.equal(coverage.tracks[0].ranges[0].start, BigInt(Math.round(grid[index] * Number(coverage.tracks[0].timescale))),
          `piece ${index} begins at its published time`);
      }
      assert.equal(named.includes(nameOf(startIndex - 1)), false, "nothing before the stretch is made");
    } finally {
      if (server) await new Promise(resolve_ => server.close(resolve_));
      input?.release();
      const absolute = path.resolve(directory), temporary = path.resolve(os.tmpdir());
      assert.ok(absolute.startsWith(`${temporary}${path.sep}`) && path.basename(absolute).startsWith("ttv158-stretch-"));
      await fs.rm(absolute, { recursive: true, force: true });
    }
  });
}

test("the line that says an input is ready says where its preparation spent its time", async () => {
  const lines = [];
  const clock = { at: 0 };
  const costs = new RunCosts();
  const inputs = new EncodeInputs({
    openOf: (asked) => costs.openOf(asked.outputKey),
    // Each statement of an interval reports one read of the file that waited
    // 7 ms behind an earlier read and took 3 ms; the clock moves by both.
    resolve: async (out, from, to, timing) => {
      if (timing) {
        timing.reads += 1;
        timing.queuedMs += 7;
        timing.readMs += 3;
      }
      clock.at += 10;
      return resolve(out, from, to);
    },
    heldRanges: async () => [[0, 999], HEADER],
    readRanges: async (_source, ranges) => ranges.map(([start, end]) => Buffer.alloc(end - start + 1)),
    reviseBudget: async () => {
      clock.at += 1;
      inputs.allow(10_000);
    },
    changed: () => {},
    failed: (_output, error) => { throw error; },
    log: line => lines.push(line),
    now: () => clock.at
  });
  inputs.costs = costs;
  const input = await admitted(inputs, 0, 50);
  input.release();
  const ready = lines.find(line => line.includes(": ready #0..#0"));
  assert.match(ready, /asked 11ms ago over 1 attempt\(s\): 1 resolution\(s\) 10ms \(1 file read\(s\): queued 7ms, reading 3ms\), held ranges 0ms, budget 1ms$/);
});

test("an input read from the keyframe before holds the piece it is for, even before a stretch is sized", async () => {
  const { inputs } = inputsOver();
  assert.equal(inputs.stretchBytesFor(output), null, "nothing measured: a run gets the least it can run with");
  assert.equal(inputs.take(output, 4, 50, 5), null);
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  const input = inputs.take(output, 4, 50, 5);
  assert.deepEqual([input.from, input.to], [4, 5], "#4 alone would not make #5");
  input.release();
});

test("an input waiting for its bytes is tried again when some of them arrive, not at every piece of the file", async () => {
  // A seek's input was prepared 28 times in 8.5 s, once for every piece the
  // torrent verified anywhere in the file, each try asking the torrent thread
  // which ranges it holds (r34, torrent-tv/meta#178).
  let held = [HEADER];
  let asked = 0;
  const { inputs } = inputsOver({ held: () => { asked += 1; return held; } });
  assert.equal(await admitted(inputs, 0, 0), null, "segment 0 has no bytes yet");
  const before = asked;
  inputs.bytesChanged({ sourceKey: "film", ranges: [{ fileIndex: 0, start: 500, end: 509 }] });
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  assert.equal(inputs.take(output, 0, 0), null);
  assert.equal(asked, before, "bytes it does not wait for wake nothing, and the plan's next look does not try it again");
  held = [[0, 9], HEADER];
  inputs.bytesChanged({ sourceKey: "film", ranges: [{ fileIndex: 0, start: 0, end: 9 }] });
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  const input = inputs.take(output, 0, 0);
  assert.deepEqual([input?.from, input?.to], [0, 0], "its own bytes start it");
  input.release();
});

test("bytes arriving while an input is being tried start another try only when it waits for them", async () => {
  // Bytes of the file came while a try was asking the torrent thread which
  // ranges it holds (344 ms in r36), and every one of them made it try again
  // when it answered (review of torrent-tv/meta#178).
  let answer = null;
  let asked = 0;
  const { inputs } = inputsOver({ held: () => { asked += 1; return new Promise(resolve => { answer = resolve; }); } });
  const settle = async () => { for (let turn = 0; turn < 5; turn++) await setImmediate(); };
  assert.equal(inputs.take(output, 0, 0), null);
  await settle();
  inputs.bytesChanged({ sourceKey: "film", ranges: [{ fileIndex: 0, start: 500, end: 509 }] });
  answer([HEADER]);
  await settle();
  assert.equal(asked, 1, "bytes it does not wait for start no second try");
  assert.equal(inputs.take(output, 0, 0), null);
  await settle();
  assert.equal(asked, 1, "nor does the plan's next look");

  inputs.bytesChanged({ sourceKey: "film", ranges: [{ fileIndex: 0, start: 0, end: 9 }] });
  await settle();
  assert.equal(asked, 2, "its own bytes try it");
  inputs.bytesChanged({ sourceKey: "film", ranges: [{ fileIndex: 0, start: 0, end: 9 }] });
  answer([HEADER]);
  await settle();
  assert.equal(asked, 3, "its own bytes during a try start another after it");
  inputs.bytesChanged();
  answer([HEADER]);
  await settle();
  assert.equal(asked, 4, "an event naming nothing during a try starts another");
  answer([[0, 9], HEADER]);
  await settle();
  const input = inputs.take(output, 0, 0);
  assert.deepEqual([input?.from, input?.to], [0, 0]);
  input.release();
});

test("an event that names no bytes tries every waiting input again", async () => {
  let held = [HEADER];
  const { inputs } = inputsOver({ held: () => held });
  assert.equal(await admitted(inputs, 0, 0), null);
  held = [[0, 9], HEADER];
  inputs.bytesChanged();
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  const input = inputs.take(output, 0, 0);
  assert.deepEqual([input?.from, input?.to], [0, 0]);
  input.release();
});
