/**
 * @file MediaReadParams makes the parameters of a media read and tracks the
 * metadata demand of an encode input for as long as its signal lives.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MediaReadParams } from "../../services/server/MediaReadParams.js";
import { settle } from "./helpers/wait.js";


const rig = (over = {}) => {
  const seen = { notes: [], stated: [], withdrawn: [], refreshed: 0, warned: [], observed: [],
    learned: [], recorded: [], probed: [], packets: [], readHeld: [] };
  const state = { wanted: true, finished: true, epoch: 7, file: null };
  state.file = { length: 1000, name: "film.mkv", offset: 64, portionBytes: 16,
    readHeld: async (start, end) => { seen.readHeld.push([start, end]); return { start, end }; },
    noteVideo: (hasVideo) => seen.notes.push(hasVideo) };
  const maps = { epoch: () => state.epoch, wantsInterval: () => state.wanted,
    metadata: async (entry) => { seen.stated.push(entry); },
    withdrawMetadata: async (sourceKey, fileIndex, statement) => { seen.withdrawn.push(statement); },
    refresh: async () => { seen.refreshed++; if (over.refreshFails) throw new Error("boom"); } };
  const reads = { revision: () => 3, memoryRevision: () => 5,
    record: (params, statement, result) => { seen.recorded.push([params, statement, result]); return state.finished; } };
  const owner = new MediaReadParams({
    heldFile: () => state.file,
    packetMemory: (sourceKey, fileIndex) => ({ memoryOf: `${sourceKey}:${fileIndex}` }),
    readProbe: async (request) => {
      seen.probed.push(request);
      return request.probe({ requestId: "r1", signal: "probe-signal" });
    },
    probePackets: async (request) => { seen.packets.push(request); return "packets"; },
    baseUrl: () => "http://127.0.0.1:9000",
    observeWait: (sourceKey, event, fields) => seen.observed.push({ sourceKey, event, ...fields }),
    reads,
    maps,
    learnKeyframes: (params, table) => seen.learned.push([params, table]),
    formatOf: () => "avi",
    warn: (line) => seen.warned.push(line)
  });
  return { owner, seen, state };
};

const revision = { storage: 3, memory: 5, demand: 7 };

// An AbortSignal-like that counts listeners.
const signalOf = () => {
  const controller = new AbortController();
  const listeners = [];
  const add = controller.signal.addEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, listener, options) => {
    if (type === "abort") listeners.push(listener);
    return add(type, listener, options);
  };
  return { controller, signal: controller.signal, listeners };
};

test("no file: null, and nothing registered on the signal", async () => {
  const { owner, state } = rig();
  state.file = null;
  const { signal, listeners } = signalOf();
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0, signal,
    readPriority: { requestId: "enc-1", rank: 40 } });
  assert.equal(params, null);
  assert.equal(listeners.length, 0);
});

test("the parameters are those the reads used before, in order", async () => {
  const { owner } = rig();
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0, demand: { from: 4, to: 8 }, zones: [] });
  assert.deepEqual(Object.keys(params), ["sourceKey", "fileIndex", "requestId", "signal", "packetInterval",
    "readPriority", "packetMemory", "downloadInterval", "readRange", "fileSize", "probe", "label", "fileOffset",
    "onObserved", "onTracks", "onReadStart", "onReadResult", "portionBytes"]);
  assert.deepEqual(params.downloadInterval, { from: 4, to: 8 });
  assert.equal(params.fileSize, 1000);
  assert.equal(params.label, "film.mkv");
  assert.equal(params.fileOffset, 64);
  assert.equal(params.portionBytes, 16);
  assert.equal("zones" in params, false);
});

test("a read past the end is cut", async () => {
  const { owner, seen } = rig();
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0 });
  await params.readRange(900, 5000);
  assert.deepEqual(seen.readHeld, [[900, 999]]);
});

test("the probe reads the proxy's own media route with a string url", async () => {
  const { owner, seen } = rig();
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0 });
  const onRecord = () => {};
  await params.probe("keyframes", onRecord);
  assert.equal(seen.probed[0].statement, "ffprobe:keyframes");
  assert.equal(typeof seen.packets[0].url, "string");
  assert.equal(seen.packets[0].url, "http://127.0.0.1:9000/media?sourceKey=src&fileIndex=0&readId=r1");
  assert.equal(seen.packets[0].statement, "keyframes");
  assert.equal(seen.packets[0].signal, "probe-signal");
  assert.equal(seen.packets[0].onRecord, onRecord);
});

test("observed keyframes: begin then end on P5", async () => {
  const { owner, seen } = rig();
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0, requestId: "q" });
  params.onObserved({ statement: "keyframes", askedAt: 1, endedAt: 3 });
  assert.equal(seen.observed.length, 2);
  assert.equal(seen.observed[0].event, "process");
  assert.equal(seen.observed[0].process, "P5");
  assert.equal(seen.observed[0].phase, "begin");
  assert.equal(seen.observed[0].at, 1);
  assert.equal(seen.observed[0].requestId, "q");
  assert.equal(seen.observed[1].phase, "end");
  assert.equal(seen.observed[1].at, 3);
  assert.equal(seen.observed[1].startedAt, 1);
  assert.equal(seen.observed[1].endedAt, 3);
});

test("the other processes are X1 and P2", async () => {
  const { owner, seen } = rig();
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0 });
  params.onObserved({ statement: "ffprobe:keyframes", askedAt: 1, endedAt: 2 });
  params.onObserved({ statement: "tracks", askedAt: 1, endedAt: 2 });
  assert.deepEqual(seen.observed.filter((e) => e.phase === "begin").map((e) => e.process), ["X1", "P2"]);
});

test("tracks state whether the file has a picture", async () => {
  const { owner, seen } = rig();
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0 });
  params.onTracks([{ type: "audio" }]);
  params.onTracks([{ type: "audio" }, { type: "video" }]);
  assert.deepEqual(seen.notes, [false, true]);
});

test("the read revision", async () => {
  const { owner } = rig();
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0 });
  assert.deepEqual(params.onReadStart(), { storage: 3, memory: 5, demand: 7 });
});

test("an older demand: nothing recorded or stated", async () => {
  const { owner, seen, state } = rig();
  state.epoch = 8;
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0 });
  await params.onReadResult("tracks", { kind: "result" }, revision);
  assert.equal(seen.recorded.length, 0);
  assert.equal(seen.stated.length, 0);
});

test("an interval no longer wanted: nothing recorded or stated", async () => {
  const { owner, seen, state } = rig();
  state.wanted = false;
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0, demand: { from: 4, to: 8 } });
  await params.onReadResult("tracks", { kind: "result" }, revision);
  assert.equal(seen.recorded.length, 0);
  assert.equal(seen.stated.length, 0);
});

test("keyframes are learned from the params object, with the container format", async () => {
  const { owner, seen } = rig();
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0 });
  await params.onReadResult("keyframes", { kind: "result", value: { times: [0, 2], tolerance: 0.1 } }, revision);
  assert.equal(seen.learned[0][0], params);
  assert.deepEqual(seen.learned[0][1], { times: [0, 2], tolerance: 0.1, format: "avi" });
  assert.equal(seen.recorded.length, 1);
});

test("a finished read refreshes once; needs-ranges does not", async () => {
  const { owner, seen } = rig();
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0 });
  await params.onReadResult("tracks", { kind: "needs-ranges" }, revision);
  assert.equal(seen.refreshed, 0);
  await params.onReadResult("tracks", { kind: "result" }, revision);
  assert.equal(seen.refreshed, 1);
});

test("a refresh that rejects is warned about, not thrown", async () => {
  const { owner, seen } = rig({ refreshFails: true });
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 2 });
  await params.onReadResult("tracks", { kind: "result" }, revision);
  await settle();
  assert.deepEqual(seen.warned, ["download map source=src file=2 metadata refresh failed: boom"]);
});

test("chapters passive withdrawal", async () => {
  const { owner, seen } = rig();
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0 });
  await params.onReadResult("chapters", { kind: "result", passive: true }, revision);
  assert.deepEqual(seen.withdrawn, ["chapters"]);
  assert.equal(seen.stated.length, 0);
});

test("a file's own read is owned by the file", async () => {
  const { owner, seen } = rig();
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0 });
  await params.onReadResult("tracks", { kind: "result" }, revision);
  assert.equal(seen.stated[0].owner, "file");
  assert.equal("scope" in seen.stated[0], false);
  assert.equal(seen.stated[0].statement, "tracks");
});

test("a viewer's interval", async () => {
  const { owner, seen } = rig();
  const demand = { from: 4, to: 8, priority: 70, urgent: true, deadlineAt: 5000 };
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0, demand });
  await params.onReadResult("tracks", { kind: "result" }, revision);
  const entry = seen.stated[0];
  assert.equal(entry.priority, 70);
  assert.equal(entry.urgent, true);
  assert.equal(entry.deadlineAt, 5000);
  assert.equal(entry.interval, demand);
  assert.equal(entry.leadSeconds, 0);
  assert.equal("owner" in entry, false);
});

test("an encode input read", async () => {
  const { owner, seen } = rig();
  const readPriority = { requestId: "enc-1", rank: 40, urgent: true, deadlineAt: Number.NaN };
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0, requestId: "enc-1", readPriority });
  await params.onReadResult("packets", { kind: "result" }, revision);
  const entry = seen.stated[0];
  assert.equal(entry.statement, "packets:enc-1");
  assert.equal(entry.priority, 40);
  assert.equal(entry.urgent, true);
  assert.equal(entry.deadlineAt, Number.POSITIVE_INFINITY);
  assert.equal(entry.scope, "preparation");
  assert.equal("owner" in entry, false);
});

test("chapters of the file", async () => {
  const { owner, seen } = rig();
  const params = await owner.paramsFor({ sourceKey: "src", fileIndex: 0 });
  await params.onReadResult("chapters", { kind: "result" }, revision);
  const entry = seen.stated[0];
  assert.equal(entry.priority, 1);
  assert.equal(entry.urgent, false);
  assert.equal(entry.deadlineAt, null);
  assert.equal(entry.owner, "file");
});

const encodeRead = async (owner, signal, requestId = "enc-1", fileIndex = 0) =>
  owner.paramsFor({ sourceKey: "src", fileIndex, requestId, signal, readPriority: { requestId, rank: 40 } });

test("demand withdrawn on abort, once", async () => {
  const { owner, seen } = rig();
  const { controller, signal } = signalOf();
  const params = await encodeRead(owner, signal);
  await params.onReadResult("packets", { kind: "needs-ranges" }, revision);
  controller.abort();
  controller.abort();
  await settle();
  assert.deepEqual(seen.withdrawn, ["packets:enc-1"]);
});

test("needs-ranges tracked and then released by a result", async () => {
  const { owner, seen } = rig();
  const { controller, signal } = signalOf();
  const params = await encodeRead(owner, signal);
  await params.onReadResult("packets", { kind: "needs-ranges" }, revision);
  await params.onReadResult("packets", { kind: "result" }, revision);
  controller.abort();
  await settle();
  assert.deepEqual(seen.withdrawn, []);
});

test("one tracker per signal and file", async () => {
  const { owner, seen } = rig();
  const { controller, signal, listeners } = signalOf();
  const first = await encodeRead(owner, signal);
  const second = await encodeRead(owner, signal);
  await first.onReadResult("packets", { kind: "needs-ranges" }, revision);
  await second.onReadResult("tracks", { kind: "needs-ranges" }, revision);
  assert.equal(listeners.length, 1);
  controller.abort();
  await settle();
  assert.deepEqual(seen.withdrawn.sort(), ["packets:enc-1", "tracks:enc-1"]);
});

test("an aborted signal: no listener, nothing withdrawn", async () => {
  const { owner, seen } = rig();
  const { controller, signal, listeners } = signalOf();
  controller.abort();
  await encodeRead(owner, signal);
  await settle();
  assert.equal(listeners.length, 0);
  assert.deepEqual(seen.withdrawn, []);
});

test("without a request id there is no listener", async () => {
  const { owner } = rig();
  const { signal, listeners } = signalOf();
  await owner.paramsFor({ sourceKey: "src", fileIndex: 0, signal });
  assert.equal(listeners.length, 0);
});
