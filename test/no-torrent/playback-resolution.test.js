import test from "node:test";
import assert from "node:assert/strict";
import { PlaybackResolution } from "../../services/torrent/PlaybackResolution.js";
import { SegmentSourceRanges } from "../../services/media/SegmentSourceRanges.js";
import { segmentReading } from "../../services/media/segment-reading.js";
import { Timeline } from "../../services/encode/output/Timeline.js";

// Fakes and generated values only; no torrent.
//
// What the download map's pass does today (`resolvePlayback`, server.js before
// torrent-tv/meta#270), stated against the interface of `PlaybackResolution`
// (openspec/changes/composition-root-owners, design.md section 3) with a real
// `SegmentSourceRanges` over a fake container orchestrator, the real
// `segmentReading`, a real `Timeline` and the real `PlaybackProjection`. The
// expected values are what the closure answered and wrote to the wait-trace.
//
// Two outputs of `src` are called `src:out-a` and `src:out-b`. The file has a
// picture (track 1) and one soundtrack (track 2) and starts its clock at 2 s,
// so the segments [0, 4), [4, 8), [8, 12) are read from the source at
// [2, 6), [6, 10), [10, 14).

const picture = { type: "video", trackNumber: 1, declaredIndex: 0 };
const sound = { type: "audio", trackNumber: 2, declaredIndex: 0 };
const tracks = [picture, sound];

const result = value => ({ kind: "result", value, requestId: "r" });
const settle = () => new Promise(resolve => setImmediate(resolve));

/** Ranges of a segment read from the packet table: one per track, apart from every other. */
const ownRanges = ({ trackId, from }) => [[from * 1000 + trackId * 10, from * 1000 + trackId * 10 + 99]];

function packetIndex(rangesOf = ownRanges) {
  return { inputFor: ({ trackId, from, to }) => ({ kind: "result", ranges: rangesOf({ trackId, from, to }) }) };
}

/** A container that reads a segment's bytes from its own index, or from a table of packets when it cannot. */
function directContainer({ table = packetIndex(), original = true, wouldWait = false } = {}) {
  return {
    supportsOriginalSourceRanges: async () => original,
    readSourceRanges: async interval => ({ kind: "result", ranges: [[interval.from * 1000, interval.from * 1000 + 99]] }),
    packetTableWouldWait: () => wouldWait,
    readPacketIndex: async () => table
  };
}

/** A container with no index of its own: its segments are read through the orchestrator. */
function packetContainer() {
  return {
    supportsOriginalSourceRanges: async () => false,
    packetTableWouldWait: () => false,
    readPacketIndex: async () => packetIndex()
  };
}

const copyVideo = [{ type: "video", index: 0, mode: "copy" }];

/**
 * @param {object} [options]
 * @param {number[]} [options.boundaries] - The cut grid of every output.
 * @param {object[]} [options.outputs] - `{ source, name, choices, encodeSpeed }`; by default `src:out-a` reading the picture.
 * @param {object} [options.container] - What the orchestrator knows of the file.
 * @param {object} [options.answers] - Answers of the orchestrator by statement, each a value or `(params) => value`.
 * @param {number} [options.pieceLength]
 * @param {number} [options.shift] - Where the file's clock starts.
 * @param {() => () => Promise<void>} [options.turns]
 */
function rig(options = {}) {
  const { boundaries = [0, 4, 8, 12], pieceLength = 16, shift = 2, container = packetContainer(), turns = () => async () => {} } = options;
  const outputs = options.outputs ?? [{ source: "src", name: "out-a", choices: copyVideo }];
  const state = { current: true, wall: 1_000_000, tick: 1000, step: 10, pieceLength };
  const timeline = new Timeline({ boundaries, cutGrid: "keyframe" });
  const played = outputs.map(output => ({ sourceKey: output.source, outputKey: `${output.source}:${output.name}`, timeline,
    choices: output.choices, revision: 0, sizes: () => new Map(), encodeSpeed: output.encodeSpeed, linkMbps: null, target: null }));
  const answers = { tracks: result(tracks), "media-info": result({ startTimeSeconds: shift }), "source-navigation": result(false),
    packets: result(packetIndex()),
    "source-ranges": params => result({ kind: "result", ranges: [[params.packetInterval.from * 10, params.packetInterval.from * 10 + 9]] }),
    ...options.answers };
  const log = { asked: [], requests: [], noted: [], refreshed: [], events: [], lines: [], warnings: [], stated: [], readings: [], playedAsked: [] };
  const hooks = { container, refresh: async () => {} };
  const orchestrator = {
    known: () => hooks.container,
    inspect: async (params, statement) => {
      log.asked.push({ statement, params });
      const answer = answers[statement];
      return typeof answer === "function" ? answer(params) : answer;
    }
  };
  const resolution = new PlaybackResolution({
    paramsFor: async request => {
      log.requests.push(request);
      return hooks.paramsFor ? hooks.paramsFor(request) : { ...request };
    },
    sourceRanges: new SegmentSourceRanges({ orchestrator }),
    segmentReading: (...args) => {
      log.readings.push(args);
      return segmentReading(...args);
    },
    playedOutputsOf: (sourceKey, fileIndex) => {
      log.playedAsked.push([sourceKey, fileIndex]);
      // As the output graph states it: a new `choices` array on every call, the same `timeline`.
      return played.filter(entry => entry.sourceKey === sourceKey).map(({ sourceKey: _, ...entry }) =>
        ({ ...entry, choices: entry.choices.map(choice => ({ ...choice })) }));
    },
    pieceLengthOf: () => state.pieceLength,
    noteSegmentInput: (...args) => { log.noted.push(args); hooks.noted?.(); },
    refresh: (...args) => { log.refreshed.push(args); return hooks.refresh(...args); },
    observeWait: (sourceKey, event, fields) => log.events.push({ sourceKey, event, fields }),
    log: line => log.lines.push(line),
    warn: line => log.warnings.push(line),
    now: () => state.wall,
    clock: () => { const at = state.tick; state.tick += state.step; return at; },
    turns
  });
  const zones = [{ from: 0, to: boundaries.at(-1), priority: 100, urgent: true, deadlineAt: 10_000 }];
  const map = (overrides = {}) => ({ sourceKey: "src", fileIndex: 0, zones, isCurrent: () => state.current,
    workingOut: priority => log.stated.push(priority), ...overrides });
  const ends = () => log.events.map(event => event.fields).filter(fields => fields.phase === "end");
  const begins = () => log.events.map(event => event.fields).filter(fields => fields.phase === "begin");
  /** `out-a#0 resolved packet-index`, in the order the zones were worked out. */
  const outcomes = () => ends().map(fields => `${fields.outputKey.split(":").at(-1)}#${fields.segment} ${fields.outcome} ${fields.method}`);
  const statements = () => log.asked.map(entry => entry.statement);
  return { resolution, map, zones, state, timeline, played, answers, hooks, ...log, ends, begins, outcomes, statements };
}

const FILE_LEVEL = ["tracks", "media-info", "source-navigation"];

// -- the file-level reads come first ----------------------------------------

test("a pass with no zones answers nothing and reads nothing", async () => {
  const r = rig();
  assert.deepEqual(await r.resolution.resolve(r.map({ zones: [] })), []);
  assert.deepEqual(r.requests, []);
  assert.deepEqual(r.statements(), []);
  assert.deepEqual(r.playedAsked, []);
  assert.doesNotThrow(() => r.resolution.clear("never-seen", 3));
});

test("the file's params, tracks and start time are asked in that order, each ending the pass when it is not a result", async () => {
  const cases = [
    ["params are missing", r => { r.hooks.paramsFor = async () => null; }, []],
    ["the tracks need ranges", r => { r.answers.tracks = { kind: "needs-ranges", ranges: [[0, 9]], requestId: "r" }; }, ["tracks"]],
    ["the container names no bytes", r => { r.hooks.container = {}; }, ["tracks"]],
    ["the start time needs memory", r => { r.answers["media-info"] = { kind: "needs-memory", bytes: 9, requestId: "r" }; }, ["tracks", "media-info"]]
  ];
  for (const [label, arrange, asked] of cases) {
    const r = rig();
    arrange(r);
    assert.deepEqual(await r.resolution.resolve(r.map()), [], label);
    assert.deepEqual(r.statements(), asked, label);
    assert.deepEqual(r.playedAsked, [], `${label}: the outputs are not read`);
    assert.deepEqual(r.events, [], label);
  }
});

test("a map replaced while the file is read ends the pass at that step", async () => {
  const cases = [
    ["params", r => { r.hooks.paramsFor = async request => { r.state.current = false; return { ...request }; }; }, [], 0],
    ["tracks", r => { r.answers.tracks = () => { r.state.current = false; return result(tracks); }; }, ["tracks"], 0],
    ["media-info", r => { r.answers["media-info"] = () => { r.state.current = false; return result({ startTimeSeconds: 2 }); }; }, ["tracks", "media-info"], 0],
    ["source-navigation", r => { r.answers["source-navigation"] = () => { r.state.current = false; return result(true); }; }, FILE_LEVEL, 1]
  ];
  for (const [label, arrange, asked, outputsRead] of cases) {
    const r = rig();
    arrange(r);
    assert.deepEqual(await r.resolution.resolve(r.map()), [], label);
    assert.deepEqual(r.statements(), asked, label);
    assert.equal(r.playedAsked.length, outputsRead, `${label}: outputs read`);
    assert.deepEqual(r.events, [], `${label}: no zone was begun`);
    assert.deepEqual(r.lines, [], label);
  }
});

test("zones that end after a pass with zones are resolved again from the record cache", async () => {
  const r = rig();
  const map = r.map();
  assert.equal((await r.resolution.resolve(map)).length, 3);
  assert.equal(r.noted.length, 3);
  const askedBefore = r.asked.length;
  assert.deepEqual(await r.resolution.resolve(r.map({ zones: [] })), []);
  assert.equal(r.asked.length, askedBefore, "nothing is read for a file without zones");
  const windows = await r.resolution.resolve(map);
  assert.equal(windows.length, 3);
  assert.deepEqual(r.outcomes().slice(3), ["out-a#0 resolved segment-record-cache", "out-a#1 resolved segment-record-cache", "out-a#2 resolved segment-record-cache"]);
  assert.equal(r.noted.length, 3, "the table already holds what was noted");
  assert.deepEqual(r.statements().slice(askedBefore), FILE_LEVEL, "only the file-level reads were made again");
});

// -- the direct index and the fallback ---------------------------------------

test("a navigable container with its own index answers every zone by arithmetic", async () => {
  const r = rig({ container: directContainer(), answers: { "source-navigation": result(true) } });
  const windows = await r.resolution.resolve(r.map());
  assert.deepEqual(r.statements(), FILE_LEVEL);
  assert.deepEqual(r.outcomes(), ["out-a#0 resolved direct-source-index", "out-a#1 resolved direct-source-index", "out-a#2 resolved direct-source-index"]);
  assert.deepEqual(r.requests, [{ sourceKey: "src", fileIndex: 0 }], "params are asked for once, for the file");
  assert.deepEqual(r.noted.map(([sourceKey, fileIndex, outputKey, index, joined]) => [sourceKey, fileIndex, outputKey, index, joined]), [
    ["src", 0, "src:out-a", 0, [[2000, 2099]]], ["src", 0, "src:out-a", 1, [[6000, 6099]]], ["src", 0, "src:out-a", 2, [[10000, 10099]]]]);
  assert.deepEqual(r.stated, [100, 100, 100], "what is resolved so far is stated before each zone is worked out");
  const told = { priority: 100, urgent: true, behind: false, deferred: false, standing: true };
  assert.deepEqual(windows, [
    { byteStart: 2000, byteEnd: 2099, ...told, deadlineAt: 10_000 },
    { byteStart: 6000, byteEnd: 6099, ...told, deadlineAt: 14_000 },
    { byteStart: 10_000, byteEnd: 10_099, ...told, deadlineAt: 18_000 }]);
});

test("a container that is not navigable falls back to the packet table", async () => {
  const r = rig();
  const windows = await r.resolution.resolve(r.map());
  assert.deepEqual(r.statements(), [...FILE_LEVEL, "source-navigation", "packets", "source-navigation", "packets", "source-navigation", "packets"]);
  assert.deepEqual(r.outcomes(), ["out-a#0 resolved packet-index", "out-a#1 resolved packet-index", "out-a#2 resolved packet-index"]);
  assert.deepEqual(windows.map(window => [window.byteStart, window.byteEnd]), [[2010, 2109], [6010, 6109], [10_010, 10_109]]);
  assert.deepEqual(r.noted.map(note => note[4]), [[[2010, 2109]], [[6010, 6109]], [[10_010, 10_109]]]);
});

test("a navigable container without its own index falls back to the file's source ranges", async () => {
  const r = rig({ answers: { "source-navigation": result(true) } });
  const windows = await r.resolution.resolve(r.map());
  assert.deepEqual(r.statements(), [...FILE_LEVEL, "source-navigation", "source-ranges", "source-navigation", "source-ranges", "source-navigation", "source-ranges"]);
  assert.deepEqual(r.outcomes(), ["out-a#0 resolved container-source-ranges", "out-a#1 resolved container-source-ranges", "out-a#2 resolved container-source-ranges"]);
  assert.deepEqual(windows.map(window => [window.byteStart, window.byteEnd]), [[20, 29], [60, 69], [100, 109]]);
});

test("a direct index that throws leaves the segment to the fallback", async () => {
  const container = directContainer();
  container.supportsOriginalSourceRanges = async () => { throw new Error("the index is damaged"); };
  const r = rig({ container, answers: { "source-navigation": result(true) } });
  assert.equal((await r.resolution.resolve(r.map())).length, 3);
  assert.deepEqual(r.outcomes(), ["out-a#0 resolved container-source-ranges", "out-a#1 resolved container-source-ranges", "out-a#2 resolved container-source-ranges"]);
});

test("a file whose navigation is not read yet goes on without a direct index, and holds the output at the fallback", async () => {
  const r = rig({ container: directContainer(), answers: { "source-navigation": { kind: "needs-ranges", ranges: [[0, 9]], requestId: "r" } } });
  assert.deepEqual(await r.resolution.resolve(r.map()), []);
  assert.deepEqual(r.outcomes(), ["out-a#0 source-navigation-needs-ranges container-index-fallback",
    "out-a#1 waiting-for-output-input null", "out-a#2 waiting-for-output-input null"]);
  assert.deepEqual(r.stated, [100], "a zone held is not worked out");
});

test("a fallback asks for its segment's own interval, under the zone that owns it", async () => {
  const r = rig({ boundaries: [0, 4, 8, 12, 16], outputs: [{ source: "src", name: "out-a", choices: copyVideo, encodeSpeed: 2 }] });
  await r.resolution.resolve(r.map());
  const asked = r.requests.filter(request => request.packetInterval);
  assert.equal(asked.length, 4);
  assert.deepEqual(asked[2], {
    sourceKey: "src", fileIndex: 0, requestId: "download:src:0:src:out-a:2",
    packetInterval: { from: 10, to: 14, trackIds: [1], modes: { 1: "copy" } },
    demand: { from: 0, to: 16, priority: 100, urgent: true, deadlineAt: 10_000, leadSeconds: 2 } });
  assert.deepEqual(asked[3].packetInterval, { from: 14, to: 18, endsWithSource: true, trackIds: [1], modes: { 1: "copy" } });
  assert.deepEqual(asked.map(request => request.requestId), [0, 1, 2, 3].map(index => `download:src:0:src:out-a:${index}`));
});

test("a file that is gone ends its zones and the pass goes on", async () => {
  const r = rig();
  r.hooks.paramsFor = async request => request.packetInterval ? null : { ...request };
  assert.deepEqual(await r.resolution.resolve(r.map()), []);
  assert.deepEqual(r.outcomes(), ["out-a#0 source-file-unavailable container-index-fallback",
    "out-a#1 source-file-unavailable container-index-fallback", "out-a#2 source-file-unavailable container-index-fallback"]);
});

// -- what holds an output -----------------------------------------------------

test("a packet table still being built holds its output and the map is built again when it settles", async () => {
  let settled;
  const table = new Promise(resolve => { settled = resolve; });
  const container = directContainer({ original: false, wouldWait: true });
  container.readPacketIndex = () => table;
  const r = rig({ container, answers: { "source-navigation": result(true) } });
  assert.deepEqual(await r.resolution.resolve(r.map()), []);
  assert.deepEqual(r.outcomes(), ["out-a#0 source-index-pending direct-source-index",
    "out-a#1 waiting-for-output-input null", "out-a#2 waiting-for-output-input null"]);
  assert.deepEqual(r.refreshed, []);
  settled(undefined);
  await settle();
  assert.deepEqual(r.refreshed, [["src", 0]]);
  assert.deepEqual(r.warnings, []);
});

test("the map is built again once for a container, whichever of its outputs waited", async () => {
  let settled;
  const table = new Promise(resolve => { settled = resolve; });
  const container = directContainer({ original: false, wouldWait: true });
  container.readPacketIndex = () => table;
  const r = rig({ container, answers: { "source-navigation": result(true) },
    outputs: [{ source: "src", name: "out-a", choices: copyVideo }, { source: "src", name: "out-b", choices: copyVideo }] });
  await r.resolution.resolve(r.map());
  assert.deepEqual(r.outcomes(), ["out-a#0 source-index-pending direct-source-index", "out-b#0 source-index-pending direct-source-index",
    "out-a#1 waiting-for-output-input null", "out-b#1 waiting-for-output-input null",
    "out-a#2 waiting-for-output-input null", "out-b#2 waiting-for-output-input null"]);
  settled(undefined);
  await settle();
  assert.deepEqual(r.refreshed, [["src", 0]]);
});

test("a map that cannot be built after a table is a warning, not an error", async () => {
  let settled;
  const table = new Promise(resolve => { settled = resolve; });
  const container = directContainer({ original: false, wouldWait: true });
  container.readPacketIndex = () => table;
  const r = rig({ container, answers: { "source-navigation": result(true) } });
  r.hooks.refresh = async () => { throw new Error("late"); };
  await r.resolution.resolve(r.map());
  settled(undefined);
  await settle();
  assert.deepEqual(r.warnings, ["download map after a packet table: late"]);
});

test("memory refused for one output's packets holds that output only", async () => {
  const r = rig({
    outputs: [{ source: "src", name: "out-a", choices: copyVideo }, { source: "src", name: "out-b", choices: [{ type: "audio", index: 0, mode: "copy" }] }],
    answers: { packets: params => params.packetInterval.trackIds.includes(1) ? { kind: "needs-memory", bytes: 1000, requestId: "r" } : result(packetIndex()) }
  });
  const windows = await r.resolution.resolve(r.map());
  assert.deepEqual(r.outcomes(), ["out-a#0 source-packets-needs-memory container-index-fallback", "out-b#0 resolved packet-index",
    "out-a#1 waiting-for-output-input null", "out-b#1 resolved packet-index",
    "out-a#2 waiting-for-output-input null", "out-b#2 resolved packet-index"]);
  assert.deepEqual(windows.map(window => [window.byteStart, window.byteEnd]), [[2020, 2119], [6020, 6119], [10_020, 10_119]]);
});

test("the answers of the navigation hold an output when they wait for ranges or memory, not for anything else", async () => {
  const cases = [
    ["needs-ranges", { kind: "needs-ranges", ranges: [[0, 9]], requestId: "r" }, true],
    ["needs-memory", { kind: "needs-memory", bytes: 9, requestId: "r" }, true],
    ["terminal", { kind: "terminal", reason: "unreadable", requestId: "r" }, false]
  ];
  for (const [kind, answer, holds] of cases) {
    const r = rig({ answers: { "source-navigation": params => params.packetInterval ? answer : result(false) } });
    await r.resolution.resolve(r.map());
    const expected = holds
      ? [`out-a#0 source-navigation-${kind} container-index-fallback`, "out-a#1 waiting-for-output-input null", "out-a#2 waiting-for-output-input null"]
      : [0, 1, 2].map(index => `out-a#${index} source-navigation-${kind} container-index-fallback`);
    assert.deepEqual(r.outcomes(), expected, kind);
  }
});

test("the answers of the packets and of the segment's input end the zone under their own names", async () => {
  const packets = rig({ answers: { packets: { kind: "needs-ranges", ranges: [[0, 9]], requestId: "r" } } });
  await packets.resolution.resolve(packets.map());
  assert.deepEqual(packets.outcomes(), [0, 1, 2].map(index => `out-a#${index} source-packets-needs-ranges container-index-fallback`),
    "a packet table that needs ranges does not hold the output");

  const input = rig({ answers: { packets: result({ inputFor: () => ({ kind: "needs-ranges", ranges: [[1, 2]] }) }) } });
  await input.resolution.resolve(input.map());
  assert.deepEqual(input.outcomes(), [0, 1, 2].map(index => `out-a#${index} segment-input-needs-ranges container-index-fallback`));
});

test("a track the file does not have ends the zones unread, once", async () => {
  const r = rig({ outputs: [{ source: "src", name: "out-a", choices: [...copyVideo, { type: "audio", index: 3, mode: "copy" }] }] });
  assert.deepEqual(await r.resolution.resolve(r.map()), []);
  assert.deepEqual(r.outcomes(), [0, 1, 2].map(index => `out-a#${index} segment-reading-unavailable null`));
  assert.deepEqual(r.ends()[0], { process: "P4.1", phase: "end", resolutionId: r.ends()[0].resolutionId, sourceId: "src:0", fileIndex: 0,
    outputKey: "src:out-a", segment: 0, priority: 100, startedAt: r.ends()[0].startedAt, endedAt: r.ends()[0].endedAt,
    durationMs: r.ends()[0].endedAt - r.ends()[0].startedAt, outcome: "segment-reading-unavailable", method: null,
    trackCount: null, rangeCount: null, rangeBytes: null });
  const eventsBefore = r.events.length, askedBefore = r.asked.length;
  assert.deepEqual(await r.resolution.resolve(r.map()), []);
  assert.equal(r.events.length, eventsBefore, "the zones are marked unreadable and not listed again");
  assert.deepEqual(r.statements().slice(askedBefore), FILE_LEVEL);
});

// -- the map is replaced ------------------------------------------------------

test("a map replaced while the second zone's ranges are read ends that zone as replaced and stops", async () => {
  let reads = 0;
  const r = rig({ answers: { packets: () => { if (++reads === 2) r.state.current = false; return result(packetIndex()); } } });
  assert.deepEqual(await r.resolution.resolve(r.map()), []);
  assert.deepEqual(r.outcomes(), ["out-a#0 resolved packet-index", "out-a#1 map-replaced container-index-fallback"]);
  assert.equal(r.begins().length, 2, "no later zone was begun");
  assert.deepEqual(r.lines, []);
});

test("a map replaced during a turn returns without a trace event for the zone", async () => {
  const r = rig({ turns: () => async () => { r.state.current = false; } });
  assert.deepEqual(await r.resolution.resolve(r.map()), []);
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.statements(), FILE_LEVEL);
});

test("a map replaced after a zone is resolved returns before the next zone is begun, without a turn", async () => {
  let turned = 0;
  const r = rig({ turns: () => async () => { turned += 1; } });
  r.hooks.noted = () => { r.state.current = false; };
  assert.deepEqual(await r.resolution.resolve(r.map()), []);
  assert.equal(turned, 1);
  assert.deepEqual(r.outcomes(), ["out-a#0 resolved packet-index"]);
  assert.equal(r.begins().length, 1, "the next zone has no event");
});

// -- known segments are not asked again --------------------------------------

test("a second pass over the same map with nothing changed asks nothing", async () => {
  const r = rig();
  const map = r.map();
  const first = await r.resolution.resolve(map);
  const eventsBefore = r.events.length, askedBefore = r.asked.length;
  const second = await r.resolution.resolve(map);
  assert.deepEqual(second, first);
  assert.equal(r.events.length, eventsBefore, "no P4.1 event is written");
  assert.deepEqual(r.statements().slice(askedBefore), FILE_LEVEL);
  assert.equal(r.noted.length, 3);
  assert.equal(r.readings.length, 3, "what a segment reads is worked out once");
});

test("the rate an output has made is read again only when what it has made changes", async () => {
  const r = rig();
  let sized = 0;
  r.played[0].sizes = () => { sized += 1; return new Map([[0, 4000]]); };
  const map = r.map();
  await r.resolution.resolve(map);
  const first = sized;
  await r.resolution.resolve(map);
  assert.equal(sized, first, "the same revision and timeline");
  r.played[0].revision = 1;
  await r.resolution.resolve(map);
  assert.ok(sized > first, "a new revision");
});

test("a second output of the same interval takes the ranges the first one found", async () => {
  const r = rig({ outputs: [{ source: "src", name: "out-a", choices: copyVideo }, { source: "src", name: "out-b", choices: copyVideo }] });
  await r.resolution.resolve(r.map());
  assert.deepEqual(r.outcomes(), ["out-a#0 resolved packet-index", "out-b#0 resolved source-range-cache",
    "out-a#1 resolved packet-index", "out-b#1 resolved source-range-cache",
    "out-a#2 resolved packet-index", "out-b#2 resolved source-range-cache"]);
  assert.equal(r.statements().filter(statement => statement === "packets").length, 3);
  assert.deepEqual(r.noted.map(note => note[2]), ["src:out-a", "src:out-b", "src:out-a", "src:out-b", "src:out-a", "src:out-b"]);
});

test("a source forgotten works its segments out again, and another source does not", async () => {
  const r = rig({ outputs: [{ source: "src", name: "out-a", choices: copyVideo }, { source: "srcB", name: "out-a", choices: copyVideo }] });
  await r.resolution.resolve(r.map());
  await r.resolution.resolve(r.map({ sourceKey: "srcB" }));
  assert.equal(r.readings.length, 6);
  r.resolution.forget("src");
  r.resolution.clear("srcB", 0);
  await r.resolution.resolve(r.map());
  assert.equal(r.readings.length, 9, "src: new records");
  await r.resolution.resolve(r.map({ sourceKey: "srcB" }));
  assert.equal(r.readings.length, 9, "srcB: the records it kept");
});

// -- identity caches ----------------------------------------------------------

test("a new track list object clears the projection and every segment is resolved again", async () => {
  const r = rig();
  const map = r.map();
  await r.resolution.resolve(map);
  r.answers.tracks = result([...tracks]);
  await r.resolution.resolve(map);
  assert.deepEqual(r.outcomes().slice(3), [0, 1, 2].map(index => `out-a#${index} resolved source-range-cache`));
  assert.equal(r.readings.length, 6);
  assert.equal(r.noted.length, 6, "the table is told again what the new records read");
  assert.equal(r.statements().filter(statement => statement === "packets").length, 3, "the bytes themselves are not asked again");
});

test("a new start time clears the projection too", async () => {
  const r = rig();
  const map = r.map();
  await r.resolution.resolve(map);
  r.answers["media-info"] = result({ startTimeSeconds: 3 });
  await r.resolution.resolve(map);
  assert.deepEqual(r.outcomes().slice(3), [0, 1, 2].map(index => `out-a#${index} resolved packet-index`), "other intervals, other ranges");
  assert.equal(r.readings.length, 6);
});

test("a new timeline object, or other choices once the zones are listed again, work a segment's reading out again", async () => {
  const r = rig({ container: directContainer(), answers: { "source-navigation": result(true) } });
  const map = r.map();
  await r.resolution.resolve(map);
  r.played[0].timeline = new Timeline({ boundaries: [0, 4, 8, 12], cutGrid: "keyframe" });
  await r.resolution.resolve(map);
  assert.equal(r.readings.length, 6);
  assert.deepEqual(r.outcomes().slice(3), [0, 1, 2].map(index => `out-a#${index} resolved source-range-cache`));
  r.played[0].choices = [{ type: "video", index: 0, mode: "transcode" }];
  r.resolution.clear("src", 0);
  await r.resolution.resolve(map);
  assert.equal(r.readings.length, 9);
  assert.deepEqual(r.outcomes().slice(6), [0, 1, 2].map(index => `out-a#${index} resolved direct-source-index`), "the choices are part of the key");
});

test("a piece length learned later joins the ranges again and tells the table once more", async () => {
  const r = rig({ pieceLength: Number.NaN });
  const map = r.map();
  await r.resolution.resolve(map);
  assert.equal(r.noted.length, 3);
  r.state.pieceLength = 16;
  await r.resolution.resolve(map);
  assert.equal(r.noted.length, 6);
  assert.deepEqual(r.outcomes().slice(3), [0, 1, 2].map(index => `out-a#${index} resolved segment-record-cache`), "the projection was rebuilt, the records stand");
  assert.equal(r.statements().filter(statement => statement === "packets").length, 3, "the bytes are not asked again");
  assert.deepEqual(r.noted[3][4], r.noted[0][4]);
  assert.notEqual(r.noted[3][4], r.noted[0][4], "joined into a new list");
  await r.resolution.resolve(map);
  assert.equal(r.noted.length, 6, "and once only");
});

test("segments are noted once per record, however often the table is rebuilt", async () => {
  const r = rig();
  const map = r.map();
  await r.resolution.resolve(map);
  r.resolution.clear("src", 0);
  await r.resolution.resolve(map);
  assert.deepEqual(r.outcomes().slice(3), [0, 1, 2].map(index => `out-a#${index} resolved segment-record-cache`));
  assert.equal(r.noted.length, 3);
  assert.equal(r.statements().filter(statement => statement === "packets").length, 3);
});

test("two segments of one output that read equal ranges are both noted and both resolved (2.96.11)", async () => {
  const sameGroup = ({ trackId, from }) => from < 10 ? [[0, 99], [200, 299]] : [[500 + trackId, 599]];
  const r = rig({ answers: { packets: result(packetIndex(sameGroup)) } });
  const map = r.map();
  const windows = await r.resolution.resolve(map);
  assert.deepEqual(r.noted.map(([, , outputKey, index, joined]) => [outputKey, index, joined]), [
    ["src:out-a", 0, [[0, 99], [200, 299]]], ["src:out-a", 1, [[0, 99], [200, 299]]], ["src:out-a", 2, [[501, 599]]]]);
  assert.deepEqual(r.outcomes(), [0, 1, 2].map(index => `out-a#${index} resolved packet-index`));
  assert.deepEqual(windows.map(window => [window.byteStart, window.byteEnd, window.deadlineAt]),
    [[0, 99, 10_000], [200, 299, 10_000], [501, 599, 18_000]]);
  const eventsBefore = r.events.length, askedBefore = r.asked.length;
  assert.deepEqual(await r.resolution.resolve(map), windows);
  assert.equal(r.events.length, eventsBefore, "none of them is listed unresolved again");
  assert.deepEqual(r.statements().slice(askedBefore), FILE_LEVEL);
  assert.equal(r.noted.length, 3);
});

// -- the grid ------------------------------------------------------------------

test("an output whose timeline states no grid is left out, and one with a grid that does not advance is refused", async () => {
  const none = rig();
  none.played[0].timeline = null;
  assert.deepEqual(await none.resolution.resolve(none.map()), []);
  assert.deepEqual(none.events, []);

  const flat = rig();
  flat.played[0].timeline = { published: [0, 4, 4, 8] };
  await assert.rejects(flat.resolution.resolve(flat.map()), { message: "An output segment needs a valid interval." });
});

// -- wait-trace P4.1 -----------------------------------------------------------

test("a resolved zone writes a begin and an end with the fields of the wait-trace", async () => {
  const twoRanges = () => [[0, 99], [200, 299]];
  const r = rig({ answers: { packets: result(packetIndex(twoRanges)) } });
  r.state.tick = 5000;
  await r.resolution.resolve(r.map());
  assert.deepEqual(r.events.slice(0, 2).map(event => [event.sourceKey, event.event]), [["src", "process"], ["src", "process"]]);
  const resolutionId = "0:src:out-a:0:5000.000";
  assert.deepEqual(r.begins()[0], { process: "P4.1", phase: "begin", resolutionId, sourceId: "src:0", fileIndex: 0,
    outputKey: "src:out-a", segment: 0, priority: 100, deadlineAt: 10_000 });
  assert.deepEqual(r.ends()[0], { process: "P4.1", phase: "end", resolutionId, sourceId: "src:0", fileIndex: 0,
    outputKey: "src:out-a", segment: 0, priority: 100, startedAt: 5010, endedAt: 5020, durationMs: 10,
    outcome: "resolved", method: "packet-index", trackCount: 1, rangeCount: 2, rangeBytes: 200,
    trackIds: [1], sourceInterval: { from: 2, to: 6 } });
  assert.deepEqual(r.events.slice(0, 2).map(event => event.fields.phase), ["begin", "end"], "each zone is begun and ended before the next");
});

test("a zone is identified by the pass's start, its file, output and segment", async () => {
  const r = rig({ boundaries: [0, 4, 8, 12, 16] });
  r.state.tick = 1234.5;
  await r.resolution.resolve(r.map());
  const third = r.begins().find(fields => fields.segment === 3);
  assert.equal(third.resolutionId, "0:src:out-a:3:1234.500");
  assert.equal(third.sourceId, "src:0");
  assert.equal(r.ends().find(fields => fields.segment === 3).resolutionId, "0:src:out-a:3:1234.500");
});

test("an error ends its zone as an error and the pass rejects with it", async () => {
  const boom = new Error("boom");
  const r = rig({ answers: { packets: () => { throw boom; } } });
  await assert.rejects(r.resolution.resolve(r.map()), error => error === boom);
  assert.deepEqual(r.outcomes(), ["out-a#0 error container-index-fallback"], "an error that reaches the pass came from the fallback");
  assert.equal(r.ends()[0].error, "boom");
  assert.equal(r.begins().length, 1);
});

// -- the report ----------------------------------------------------------------

test("the passes of a minute are reported once, and counted again afterwards", async () => {
  const r = rig();
  const map = r.map();
  await r.resolution.resolve(map);
  await r.resolution.resolve(map);
  assert.deepEqual(r.lines, [], "within the minute");
  r.state.wall += 61_000;
  await r.resolution.resolve(map);
  assert.deepEqual(r.lines, ["download map passes in 61.0s: 3 map(s), 1 worked out whole, 3 segment(s) worked out again, " +
    "3 segment(s) had their ranges worked out, 9 window(s) told; 90ms from start to result in all, longest 70ms"]);
  r.state.wall += 61_000;
  await r.resolution.resolve(map);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[1], "download map passes in 61.0s: 1 map(s), 0 worked out whole, 0 segment(s) worked out again, " +
    "0 segment(s) had their ranges worked out, 3 window(s) told; 10ms from start to result in all, longest 10ms");
});

test("a pass that is cut short is not counted", async () => {
  const r = rig({ turns: () => async () => { r.state.current = false; } });
  await r.resolution.resolve(r.map());
  r.state.wall += 61_000;
  await r.resolution.resolve(r.map({ zones: [] }));
  assert.deepEqual(r.lines, [], "a pass without zones is not counted either");
});
