/**
 * @file What an encoder run reads: the input of `EncodeInputResolution#resolve`
 * and the soundtrack walk of `#stretchCopied` (torrent-tv/meta#275, step 5 of
 * #270). The real segment-reading functions and a real `SegmentSourceRanges`
 * run over a fake orchestrator whose answers are keyed by
 * `${fileIndex}:${statement}`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EncodeInputResolution } from "../../services/encode/EncodeInputResolution.js";
import { SegmentSourceRanges } from "../../services/media/SegmentSourceRanges.js";
import { selectTracks, readingInterval, trackFor } from "../../services/media/segment-reading.js";
import { Timeline } from "../../services/encode/output/Timeline.js";

const videoTrack = { type: "video", trackNumber: 1, declaredIndex: 0 };
const soundA = { type: "audio", trackNumber: 2, declaredIndex: 0 };
const soundB = { type: "audio", trackNumber: 3, declaredIndex: 3 };

const makeOutput = (overrides = {}) => ({
  outputKey: "src:out",
  file: { sourceKey: "src" },
  spec: { video: { fileIndex: 0, encode: false }, audio: { fileIndex: 1, trackIndex: 0, transcode: true } },
  timeline: new Timeline({ boundaries: [0, 4, 8, 12], cutGrid: "keyframe" }),
  segmentFormat: { supportsOriginalInput: true },
  ...overrides
});

/**
 * @param {object} [options] answers by `${fileIndex}:${statement}`, replacing the defaults.
 * @returns {{ resolution: EncodeInputResolution, asked: string[], paramsSeen: object[], logs: string[], warns: string[] }}
 */
function setup({ answers = {}, container, outputs = [], declared, now } = {}) {
  const asked = [], paramsSeen = [], logs = [], warns = [];
  const fileContainer = container ?? { readSourceRanges: async () => ({}) };
  const defaults = {
    "0:tracks": { kind: "result", value: [videoTrack, soundA, soundB] },
    "1:tracks": { kind: "result", value: [soundA] },
    "0:media-info": { kind: "result", value: { startTimeSeconds: 1.5 } },
    "1:media-info": { kind: "result", value: { startTimeSeconds: 0 } },
    "0:source-navigation": { kind: "result", value: true },
    "1:source-navigation": { kind: "result", value: true },
    "0:source-ranges": { kind: "result", value: { kind: "result", ranges: [[0, 9]], from: 0, to: 4 } },
    "1:source-ranges": { kind: "result", value: { kind: "result", ranges: [[10, 19]], from: 0, to: 4 } },
    "0:packets": { kind: "result", value: { inputFor: () => ({ kind: "result", ranges: [[0, 4]] }) } },
    "1:packets": { kind: "result", value: { inputFor: () => ({ kind: "result", ranges: [[5, 9]] }) } }
  };
  const table = { ...defaults, ...answers };
  const orchestrator = {
    known: () => fileContainer,
    inspect: async (params, statement) => {
      asked.push(`${params.fileIndex}:${statement}`);
      paramsSeen.push(params);
      return table[`${params.fileIndex}:${statement}`];
    }
  };
  const resolution = new EncodeInputResolution({
    paramsFor: async request => ({ ...request }),
    sourceRanges: new SegmentSourceRanges({ orchestrator }),
    selectTracks, readingInterval, trackFor,
    declaredTracks: declared ?? (() => [videoTrack, soundA, soundB]),
    known: () => fileContainer,
    outputs: () => outputs,
    log: line => logs.push(line), warn: line => warns.push(line),
    ...(now ? { now } : {})
  });
  return { resolution, asked, paramsSeen, logs, warns };
}

test("an interval past the grid is terminal and no port is called", async () => {
  let called = 0;
  const resolution = new EncodeInputResolution({
    paramsFor: async () => { called++; return {}; },
    sourceRanges: { tracksOf: async () => { called++; } }, selectTracks, readingInterval, trackFor,
    declaredTracks: () => undefined, known: () => null, outputs: () => [], log: () => {}, warn: () => {}
  });
  assert.deepEqual(await resolution.resolve(makeOutput(), 0, 3), { kind: "terminal", reason: "output-interval-not-declared" });
  assert.equal(called, 0);
});

test("the published grid wins over the boundaries", async () => {
  const { resolution } = setup();
  const output = makeOutput({ timeline: { published: [0, 4], boundaries: [0, 4, 8, 12], sourceInterval: () => ({ from: 0, to: 4 }) } });
  assert.deepEqual(await resolution.resolve(output, 0, 1), { kind: "terminal", reason: "output-interval-not-declared" });
});

test("two files: every read of file 0 comes before the first read of file 1", async () => {
  const { resolution, asked } = setup();
  const answer = await resolution.resolve(makeOutput(), 0, 1);
  assert.equal(answer.kind, "result");
  const lastOfFile0 = Math.max(...asked.map((entry, index) => entry.startsWith("0:") ? index : -1));
  assert.ok(asked.indexOf("1:tracks") > asked.indexOf("0:source-navigation"));
  assert.ok(lastOfFile0 >= 0 && asked.indexOf("1:source-ranges") > lastOfFile0);
  assert.deepEqual(answer.sources.map(source => source.fileIndex), [0, 1]);
});

test("optional arguments leave the params bare", async () => {
  const { resolution, paramsSeen } = setup();
  await resolution.resolve(makeOutput(), 0, 1);
  const params = paramsSeen[0];
  assert.equal(params.requestId, undefined);
  assert.equal(params.readPriority, null);
  assert.equal(params.signal, null);
  assert.equal("isCurrent" in params, false);
  assert.equal("walkAccount" in params, false);
  assert.equal("onTimed" in params, false);
});

test("missing params are needs-source", async () => {
  const resolution = new EncodeInputResolution({
    paramsFor: async () => null, sourceRanges: {}, selectTracks, readingInterval, trackFor,
    declaredTracks: () => undefined, known: () => null, outputs: () => [], log: () => {}, warn: () => {}
  });
  assert.deepEqual(await resolution.resolve(makeOutput(), 0, 1), { kind: "needs-source" });
});

test("an answer that is not a result is returned as the same object", async () => {
  const needsRanges = { kind: "needs-ranges", ranges: [[0, 9]] };
  const { resolution } = setup({ answers: { "0:media-info": needsRanges } });
  assert.equal(await resolution.resolve(makeOutput(), 0, 1), needsRanges);
});

test("a container with no index yet is needs-index", async () => {
  const { resolution } = setup({ container: {} });
  assert.deepEqual(await resolution.resolve(makeOutput(), 0, 1), { kind: "needs-index", reason: "packet-index-not-yet-available" });
});

test("an absent soundtrack is terminal and media-info is never read", async () => {
  const { resolution, asked } = setup({ answers: { "1:tracks": { kind: "result", value: [] } } });
  const output = makeOutput();
  assert.deepEqual(await resolution.resolve(output, 0, 1), { kind: "terminal", reason: "selected-track-is-absent" });
  assert.equal(asked.includes("1:media-info"), false);
});

test("the stated interval is the source interval shifted by the start time, with the track and mode", async () => {
  const output = makeOutput({ spec: { video: { fileIndex: 0, encode: false } } });
  const { resolution, paramsSeen } = setup();
  await resolution.resolve(output, 1, 2);
  assert.deepEqual(paramsSeen[0].packetInterval, {
    ...output.timeline.sourceInterval(1, 2, 1.5), trackIds: [1], modes: { 1: "copy" }
  });
});

test("timing is told and the walk account is shared", async () => {
  const { resolution, paramsSeen } = setup();
  const timing = { reads: 0, queuedMs: 0, readMs: 0, readsByStatement: {} };
  await resolution.resolve(makeOutput(), 0, 1, timing);
  const params = paramsSeen[0];
  assert.deepEqual(timing.walk, { lockMs: 0, reads: 0, bytes: 0 });
  assert.equal(params.walkAccount, timing.walk);
  params.onTimed("packets", 5, 7);
  assert.deepEqual({ reads: timing.reads, queuedMs: timing.queuedMs, readMs: timing.readMs }, { reads: 1, queuedMs: 5, readMs: 7 });
  assert.deepEqual(timing.readsByStatement.packets, { queuedMs: 5, readMs: 7 });
});

test("the run's isCurrent and signal reach every params object", async () => {
  const { resolution, paramsSeen } = setup();
  const isCurrent = () => true, signal = new AbortController().signal;
  await resolution.resolve(makeOutput(), 0, 1, null, isCurrent, signal);
  for (const params of paramsSeen) {
    assert.equal(params.isCurrent, isCurrent);
    assert.equal(params.signal, signal);
  }
});

test("every file navigable: original input, source-ranges and no packets", async () => {
  const { resolution, asked } = setup();
  const answer = await resolution.resolve(makeOutput(), 0, 1);
  assert.equal(answer.kind, "result");
  assert.ok(asked.includes("0:source-ranges") && asked.includes("1:source-ranges"));
  assert.equal(asked.includes("0:packets") || asked.includes("1:packets"), false);
  assert.equal(answer.sources[0].input.original, true);
  assert.equal(answer.sources[0].timeShiftSeconds, 1.5);
});

test("one file not navigable: both are read from packets", async () => {
  const { resolution, asked } = setup({ answers: { "1:source-navigation": { kind: "result", value: false } } });
  const answer = await resolution.resolve(makeOutput(), 0, 1);
  assert.equal(answer.kind, "result");
  assert.ok(asked.includes("0:packets") && asked.includes("1:packets"));
  assert.equal(asked.includes("0:source-ranges"), false);
  for (const source of answer.sources) assert.equal("original" in source.input, false);
});

test("a format that refuses original input reads packets", async () => {
  const { resolution, asked } = setup();
  await resolution.resolve(makeOutput({ segmentFormat: { supportsOriginalInput: false } }), 0, 1);
  assert.ok(asked.includes("0:packets") && asked.includes("1:packets"));
  assert.equal(asked.some(entry => entry.endsWith(":source-ranges")), false);
});

test("packets refused memory returns that answer object", async () => {
  const refusal = { kind: "needs-memory", bytes: 64 };
  const { resolution } = setup({ answers: { "0:packets": refusal }, });
  const answer = await resolution.resolve(makeOutput({ segmentFormat: { supportsOriginalInput: false } }), 0, 1);
  assert.equal(answer.kind, "needs-memory");
  assert.equal(answer.bytes, 64);
});

test("the ffmpeg selection index is the declared index, else the choice's, else 0", async () => {
  const output = makeOutput({ spec: { video: { fileIndex: 0, encode: false }, audio: { fileIndex: 0, trackIndex: 1, transcode: false } } });
  const { resolution } = setup({ answers: { "0:tracks": { kind: "result", value: [{ ...videoTrack, declaredIndex: undefined }, soundA, soundB] } } });
  const answer = await resolution.resolve(output, 0, 1);
  const selections = answer.sources[0].input.selections;
  assert.deepEqual(selections.map(selection => [selection.track.type, selection.index]), [["video", 0], ["audio", 3]]);
});

test("an original source is keyed and shifted", async () => {
  const { resolution } = setup();
  const answer = await resolution.resolve(makeOutput(), 0, 1);
  assert.equal(answer.sources[0].sourceKey, "src");
  assert.equal(answer.sources[1].fileIndex, 1);
  assert.equal(answer.sources[1].timeShiftSeconds, 0);
});

// ---- stretchCopied ----

function copyOf(overrides = {}) {
  let released = 0;
  const input = {
    sources: [{ sourceKey: "src", fileIndex: 0, input: { from: 0, to: 4, ranges: [[0, 99]], selections: [{ track: videoTrack }] } }],
    read: (_fileIndex, start, end) => ({ end, bytes: Buffer.alloc(end - start + 1) }),
    retain: () => () => { released++; },
    ...overrides
  };
  return { input, released: () => released };
}

const soundOutput = (trackIndex = 1) => ({ spec: { audio: { fileIndex: 0, trackIndex } }, file: { sourceKey: "src" } });
const pictureOutput = { outputKey: "src:pic", spec: { video: { fileIndex: 0 } }, file: { sourceKey: "src" } };

test("the soundtrack is walked from the picture's copy", async () => {
  const walked = [];
  const container = { learnPackets: async (interval, read, holdsUntil) => { walked.push({ interval, read, holdsUntil }); return "walked"; } };
  let clock = 1000;
  const { resolution, logs } = setup({ container, outputs: [pictureOutput, soundOutput(1)], now: () => (clock += 25) });
  const { input, released } = copyOf();
  resolution.stretchCopied(makeOutput(), 0, 1, input);
  assert.deepEqual(walked[0].interval, { from: 0, to: 4, trackIds: [soundB.trackNumber] });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(logs[0], /walked from its copy in \d+ms$/);
  assert.match(logs[0], /^encode input #0\.\.#1 of src:out: soundtrack packets of track\(s\) 3 over 0\.000-4\.000s walked/);
  assert.equal(released(), 1);
});

test("a soundtrack the selections already carry is not walked", () => {
  let learned = 0;
  const container = { learnPackets: async () => { learned++; return "walked"; } };
  const { resolution } = setup({ container, outputs: [soundOutput(1)] });
  const { input } = copyOf();
  input.sources[0].input.selections.push({ track: soundB });
  resolution.stretchCopied(makeOutput(), 0, 1, input);
  assert.equal(learned, 0);
});

test("a container that cannot learn packets is skipped", () => {
  const { resolution } = setup({ container: {}, outputs: [soundOutput(1)] });
  const { input, released } = copyOf();
  resolution.stretchCopied(makeOutput(), 0, 1, input);
  assert.equal(released(), 0);
});

test("a source whose tracks are not declared yet is skipped", () => {
  let learned = 0;
  const container = { learnPackets: async () => { learned++; return "walked"; } };
  const { resolution } = setup({ container, outputs: [soundOutput(1)], declared: () => undefined });
  resolution.stretchCopied(makeOutput(), 0, 1, copyOf().input);
  assert.equal(learned, 0);
});

test("an unfinite or decreasing interval is skipped", () => {
  let learned = 0;
  const container = { learnPackets: async () => { learned++; return "walked"; } };
  const { resolution } = setup({ container, outputs: [soundOutput(1)] });
  const { input } = copyOf();
  input.sources[0].input.to = 0;
  resolution.stretchCopied(makeOutput(), 0, 1, input);
  assert.equal(learned, 0);
});

test("bytes the copy does not hold whole read as null", () => {
  const reads = [];
  const container = { learnPackets: async (_interval, read) => { reads.push(read); return "walked"; } };
  const { resolution } = setup({ container, outputs: [soundOutput(1)] });
  const whole = copyOf();
  resolution.stretchCopied(makeOutput(), 0, 1, whole.input);
  assert.equal(reads[0](0, 9).length, 10);
  const short = copyOf({ read: () => ({ end: 3, bytes: Buffer.alloc(4) }) });
  resolution.stretchCopied(makeOutput(), 0, 1, short.input);
  assert.equal(reads[1](0, 9), null);
  const pending = copyOf({ read: () => Promise.resolve({ end: 9, bytes: Buffer.alloc(10) }) });
  resolution.stretchCopied(makeOutput(), 0, 1, pending.input);
  assert.equal(reads[2](0, 9), null);
});

test("where the copy ends", () => {
  const held = [];
  const container = { learnPackets: async (_interval, _read, holdsUntil) => { held.push(holdsUntil); return "walked"; } };
  const { resolution } = setup({ container, outputs: [soundOutput(1)] });
  resolution.stretchCopied(makeOutput(), 0, 1, copyOf().input);
  assert.equal(held[0](50), 100);
  assert.equal(held[0](150), null);
  resolution.stretchCopied(makeOutput(), 0, 1, copyOf({ heldUntil: (fileIndex, start) => start + fileIndex + 7 }).input);
  assert.equal(held[1](50), 57);
});

test("a failed walk is warned about and the input is released", async () => {
  const container = { learnPackets: async () => { throw new Error("boom"); } };
  const { resolution, warns, logs } = setup({ container, outputs: [soundOutput(1)] });
  const { input, released } = copyOf();
  resolution.stretchCopied(makeOutput(), 0, 1, input);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(warns[0], /walking the soundtrack from its copy failed: boom$/);
  assert.equal(logs.length, 0);
  assert.equal(released(), 1);
});

test("an incomplete walk says why", async () => {
  const container = { learnPackets: async () => "memory" };
  const { resolution, logs } = setup({ container, outputs: [soundOutput(1)] });
  resolution.stretchCopied(makeOutput(), 0, 1, copyOf().input);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(logs[0], /not all walked \(memory refused\) from its copy in \d+ms$/);
});
