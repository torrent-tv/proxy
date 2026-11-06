/**
 * @file The source preparation's reads (torrent-tv/meta#280, design.md §6.5
 * A): the `inspect` port and the native map publication, with fake ports.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PreparationReads } from "../../services/server/PreparationReads.js";

const viewer = (id, fileIndex, outputs = 0, position = 0) =>
  ({ id, source: { selectedFileIndex: fileIndex }, outputs: new Set(Array.from({ length: outputs }, (_, i) => i)), positionSeconds: () => position });

function setup({ params = {}, accepts = () => true, viewers = [], answers = {}, nativeZones = ["zone"] } = {}) {
  const calls = { params: null, maps: [], native: [], record: [], inspected: [], result: [], bytes: [], planned: 0, interval: [], nativeIn: [] };
  const preparation = {
    accepts: work => accepts(work),
    demandFor: () => ({ demand: "d" }),
    bytesChanged: (sourceKey, fileIndex) => calls.bytes.push([sourceKey, fileIndex]),
    result: (work, result) => calls.result.push(result),
    urgentReadyFor: () => true
  };
  const container = { readTracks: async () => [{ type: "video", trackNumber: 1 }] };
  const reads = new PreparationReads({
    paramsFor: async () => (params === null ? null : (calls.params = { label: "film.mkv", ...params })),
    containers: {
      inspect: async (given, statement) => {
        calls.inspected.push(statement);
        return answers[statement] ?? { kind: "result", value: statement === "media-info" ? { startTimeSeconds: 1, durationSeconds: 100 } : "answer" };
      },
      containerFor: async () => container
    },
    subtitles: { inspectFile: async () => ({ kind: "result", value: "file" }), inspectPackets: async () => ({ kind: "result", value: "cues" }) },
    fileLengthOf: () => 5000,
    viewersOf: () => viewers,
    segmentSeconds: 6,
    preparationInterval: (role, from, seconds) => { calls.interval.push([role, from, seconds]); return { from, to: from + seconds }; },
    segmentInputs: () => ({ forInterval: interval => ({ kind: "result", ranges: [[interval.from, interval.to]] }) }),
    nativeMaps: {
      packets: async input => { calls.nativeIn.push(["packets", input]); return nativeZones; },
      original: async input => { calls.nativeIn.push(["original", input]); return nativeZones; }
    },
    maps: { metadata: async entry => { calls.maps.push(entry); }, native: async entry => { calls.native.push(entry); } },
    record: (...args) => { calls.record.push(args); return true; },
    planEncodersSoon: () => { calls.planned += 1; }
  });
  return { calls, reads, preparation };
}

const work = (extra = {}) => ({ sourceKey: "src", fileIndex: 0, requestId: "req1", statement: "subtitle-file", role: "subtitle-file", selected: true, ...extra });

test("a work the source has no params for needs the source", async () => {
  const { reads, preparation } = setup({ params: null });
  assert.deepEqual(await reads.inspect(work(), preparation), { kind: "needs-source" });
});

test("a subtitle file is answered by the subtitles", async () => {
  const { reads, preparation } = setup();
  assert.deepEqual(await reads.inspect(work(), preparation), { kind: "result", value: "file" });
});

test("a read of a subtitle file is recorded, published under its statement, and plans the encoders", async () => {
  const { calls, reads, preparation } = setup();
  const one = work();
  await reads.inspect(one, preparation);
  const result = { kind: "result", value: "x" };
  await calls.params.onReadResult("subtitle-file", result, { storage: "s", memory: "m" });
  assert.deepEqual(calls.record, [[calls.params, "subtitle-file", result, "s", "m"]]);
  assert.deepEqual(calls.maps, [{ sourceKey: "src", fileIndex: 0, statement: "subtitle-file:req1", result,
    scope: "preparation", demand: "d" }]);
  assert.deepEqual(calls.result, [result]);
  assert.equal(calls.planned, 1);
});

test("the params say a work is current only while the preparation accepts it", async () => {
  let accepted = true;
  const { calls, reads, preparation } = setup({ accepts: () => accepted });
  await reads.inspect(work(), preparation);
  assert.equal(calls.params.isCurrent(), true);
  accepted = false;
  assert.equal(calls.params.isCurrent(), false);
  await calls.params.onReadResult("subtitle-file", { kind: "result", value: 1 }, {});
  assert.deepEqual([calls.record, calls.maps, calls.result], [[], [], []]);
});

test("a source-ranges result of a selected work states the input ranges and says the bytes changed", async () => {
  const { calls, reads, preparation } = setup({ answers: { "source-navigation": { kind: "result", value: false } } });
  const one = work({ statement: "packets", role: "source-first" });
  await reads.inspect(one, preparation);
  const result = { kind: "result", value: { ranges: [[0, 9]] } };
  await calls.params.onReadResult("source-ranges", result, {});
  assert.deepEqual(one.inputRanges, [[0, 9]]);
  assert.equal(calls.maps[0].statement, "packets:req1:input");
  assert.deepEqual(calls.maps[0].result, { kind: "needs-ranges", ranges: [[0, 9]], requestId: "packets:req1:input" });
  assert.deepEqual(calls.bytes, [["src", 0]]);
  assert.equal(calls.maps.at(-1).statement, "packets:req1");
});

test("a navigation that is not a result is the answer", async () => {
  const { calls, reads, preparation } = setup({ answers: { "source-navigation": { kind: "pending" } } });
  const answer = await reads.inspect(work({ statement: "packets", role: "source-first" }), preparation);
  assert.deepEqual(answer, { kind: "pending" });
  assert.deepEqual(calls.inspected, ["source-navigation"]);
});

test("a packet read asks the media info and sets the interval from the least advanced viewer", async () => {
  const viewers = [viewer("a", 0, 0, 30), viewer("b", 0, 0, 12), viewer("c", 1, 0, 1)];
  const { calls, reads, preparation } = setup({ viewers, answers: { "source-navigation": { kind: "result", value: false } } });
  const answer = await reads.inspect(work({ statement: "packets", role: "source-first" }), preparation);
  assert.deepEqual(answer, { kind: "result", value: "answer" });
  assert.deepEqual(calls.inspected, ["source-navigation", "media-info", "packets"]);
  assert.deepEqual(calls.interval, [["source-first", 13, 6]]);
});

test("a work with no native input publishes nothing", async () => {
  const { calls, reads, preparation } = setup();
  assert.equal(await reads.publishNative(work(), preparation), undefined);
  assert.deepEqual(calls.native, []);
});

test("an original container is converted for the viewers on this file that have no output yet", async () => {
  const { calls, reads, preparation } = setup({ viewers: [viewer("a", 0, 0), viewer("b", 0, 1), viewer("c", 1, 0)] });
  await reads.publishNative(work({ nativeInput: { container: { name: "c" }, durationSeconds: 100 } }), preparation);
  const [kind, input] = calls.nativeIn[0];
  assert.equal(kind, "original");
  assert.deepEqual(input.viewers.map(entry => entry.id), ["a"]);
  assert.equal(input.allowanceSeconds, 6);
  assert.equal(input.durationSeconds, 100);
  assert.equal(input.urgentReadyFor(null), true);
  assert.deepEqual(calls.native, [{ sourceKey: "src", fileIndex: 0, zones: ["zone"] }]);
});

test("an index input is converted by packets", async () => {
  const { calls, reads, preparation } = setup();
  await reads.publishNative(work({ nativeInput: { index: {}, tracks: [] } }), preparation);
  assert.equal(calls.nativeIn[0][0], "packets");
});

test("a work withdrawn while the zones were computed publishes nothing", async () => {
  let accepted = true;
  const { calls, reads, preparation } = setup({ accepts: () => accepted });
  const one = work({ nativeInput: { index: {}, tracks: [] } });
  const pending = reads.publishNative(one, preparation);
  accepted = false;
  await pending;
  assert.deepEqual(calls.native, []);
});
