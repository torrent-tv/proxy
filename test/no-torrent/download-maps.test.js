import test from "node:test";
import assert from "node:assert/strict";
import { DownloadMaps } from "../../services/viewer/DownloadMaps.js";
import { MediaReadRequests } from "../../services/media/MediaReadRequests.js";

test("a missing allocation cannot withdraw bytes still needed by the same statement", async () => {
  let published;
  const maps = new DownloadMaps({ publish: map => { published = map; } });
  const request = { sourceKey: "source", fileIndex: 0, statement: "tracks" };
  await maps.metadata({ ...request, result: { kind: "needs-ranges", ranges: [[100, 699]] } });
  await maps.metadata({ ...request, result: { kind: "needs-memory", bytes: 600 } });
  assert.deepEqual(published.zones.map(zone => [zone.byteStart, zone.byteEnd]), [[100, 699]]);
  await maps.metadata({ ...request, result: { kind: "result", value: [] } });
  assert.deepEqual(published.zones, []);
});

test("completed packet reads coalesce file refreshes without losing a later completion", async () => {
  let calls = 0, release;
  const blocked = new Promise(resolve => { release = resolve; });
  const maps = new DownloadMaps({ publish() {}, resolvePlayback: async () => {
    if (++calls === 2) await blocked;
    return [];
  } });
  await maps.playback({ sourceKey: "source", fileIndex: 0, durationSeconds: 8,
    zones: [{ from: 0, to: 4, priority: 100 }] });
  const first = maps.refresh("source", 0);
  const repeated = Array.from({ length: 100 }, () => maps.refresh("source", 0));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2, "only one refresh may resolve packets while its predecessor is running");
  release();
  await Promise.all([first, ...repeated]);
  assert.equal(calls, 3, "one following pass observes every completion during the first pass");
});

test("a conversion can stop before reading more intervals after replacement or retirement", async () => {
  const reads = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const maps = new DownloadMaps({ publish() {}, resolvePlayback: async map => {
    reads.push(map);
    if (reads.length === 1) await blocked;
    return [];
  } });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 8 };
  const first = maps.playback({ ...file, zones: [{ from: 0, to: 4, priority: 100 }] });
  assert.equal(reads[0].isCurrent(), true);
  await maps.playback({ ...file, zones: [{ from: 4, to: 8, priority: 100 }] });
  assert.equal(reads[0].isCurrent(), false);
  assert.equal(reads[1].isCurrent(), true);
  maps.retire("source");
  assert.equal(reads[1].isCurrent(), false);
  release();
  await first;
});

test("retiring a file cancels the following coalesced refresh", async () => {
  let calls = 0, release;
  const blocked = new Promise(resolve => { release = resolve; });
  const maps = new DownloadMaps({ publish() {}, resolvePlayback: async () => {
    if (++calls === 2) await blocked;
    return [];
  } });
  await maps.playback({ sourceKey: "source", fileIndex: 0, durationSeconds: 8,
    zones: [{ from: 0, to: 4, priority: 100 }] });
  const first = maps.refresh("source", 0);
  const repeated = maps.refresh("source", 0);
  maps.retire("source");
  release();
  await Promise.all([first, repeated]);
  assert.equal(calls, 2);
  assert.equal(maps.epoch("source", 0), 0);
});

test("native packet demand shares publication with output and preparation demand", async () => {
  let published;
  const maps = new DownloadMaps({ publish: map => { published = map; } });
  const address = { sourceKey: "source", fileIndex: 0 };
  await maps.native({ ...address, zones: [{ byteStart: 17, byteEnd: 81, priority: 100 }] });
  await maps.metadata({ ...address, statement: "raw-file", scope: "preparation", priority: 1,
    result: { kind: "needs-ranges", ranges: [[0, 999]] } });
  assert.deepEqual(published.zones.map(zone => zone.priority), [100, 1]);
  await maps.forget("source", 0, { keepPreparation: true });
  assert.equal(published.zones.length, 2);
  await maps.native({ ...address, zones: [] });
  assert.deepEqual(published.zones.map(zone => zone.priority), [1]);
  await maps.forget("source", 0);
  assert.deepEqual(published.zones, []);
});

test("output withdrawal preserves independently owned preparation demand", async () => {
  let published;
  const maps = new DownloadMaps({ publish: map => { published = map; } });
  const file = { sourceKey: "source", fileIndex: 0 };
  await maps.metadata({ ...file, statement: "tracks:preparation", scope: "preparation", urgent: false,
    deadlineAt: Infinity, result: { kind: "needs-ranges", ranges: [[0, 9]] } });
  await maps.metadata({ ...file, statement: "packets:output", result: { kind: "needs-ranges", ranges: [[100, 199]] } });
  await maps.forget("source", 0, { keepPreparation: true });
  assert.deepEqual(published.zones.map(zone => [zone.byteStart, zone.byteEnd]), [[0, 9]]);
  await maps.repriceMetadata("source", 0, "tracks:preparation", { priority: 100, urgent: true, deadlineAt: 0 });
  assert.equal(published.zones[0].urgent, true);
  assert.equal(published.zones[0].deadlineAt, 0);
  await maps.withdrawMetadata("source", 0, "tracks:preparation");
  assert.deepEqual(published.zones, []);
});

test("complete segment bytes remain published while their map interval is repriced", async () => {
  const sent = [];
  let release;
  let calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const maps = new DownloadMaps({ publish: map => sent.push(map), resolvePlayback: async map => {
    if (++calls === 2) await blocked;
    return [{ from: 4, to: 8, downloadInterval: { from: 0, to: 6 },
      priority: map.zones[0].priority, deadlineAt: map.zones[0].deadlineAt + 2000,
      leadSeconds: 2, byteStart: 10, byteEnd: 20 }];
  } });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 8 };
  await maps.playback({ ...file, zones: [{ from: 0, to: 6, priority: 100, deadlineAt: 5000 }] });
  const pending = maps.playback({ ...file, zones: [{ from: 0, to: 6, priority: 10, deadlineAt: 15000 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.at(-1).zones.length, 1);
  assert.equal(sent.at(-1).zones[0].to, 8);
  assert.equal(sent.at(-1).zones[0].priority, 10);
  assert.equal(sent.at(-1).zones[0].deadlineAt, 17000);
  release();
  await pending;
});

test("forecast input addresses come from published segment demand without starting a read", async () => {
  const maps = new DownloadMaps({ publish: () => {}, resolvePlayback: async () => [
    { from: 0, to: 4, outputKey: "picture", index: 2, byteStart: 100, byteEnd: 107 }
  ] });
  await maps.playback({ sourceKey: "source", fileIndex: 7, durationSeconds: 4,
    zones: [{ from: 0, to: 4, priority: 100 }] });
  assert.deepEqual(maps.inputsForOutput("source", "picture", 2), [
    { sourceId: "source:7", ranges: [{ start: 100, end: 108 }] }
  ]);
  assert.equal(maps.inputsForOutput("source", "another", 2), null);
});

test("forecast lookups do not scan every packet range again and discard withdrawn addresses", async () => {
  let reads = 0;
  const ranges = Array.from({ length: 1000 }, (_, index) => ({
    from: 0, to: 4, index: index % 10, byteStart: index * 10, byteEnd: index * 10 + 7,
    get outputKey() { reads++; return "picture"; }
  }));
  const maps = new DownloadMaps({ publish() {}, resolvePlayback: async () => ranges });
  await maps.playback({ sourceKey: "source", fileIndex: 0, durationSeconds: 4,
    zones: [{ from: 0, to: 4, priority: 100 }] });
  reads = 0;
  for (let index = 0; index < 10; index++) {
    assert.equal(maps.inputsForOutput("source", "picture", index)[0].ranges.length, 100);
  }
  assert.equal(reads, 0, "a published map must be indexed once instead of scanned for each segment forecast");
  await maps.forget("source", 0);
  assert.equal(maps.inputsForOutput("source", "picture", 0), null);
});

test("metadata deadlines include preparation time after a paused map is repriced", async () => {
  let published;
  const maps = new DownloadMaps({ publish: map => { published = map; }, resolvePlayback: async () => [] });
  const address = { sourceKey: "source", fileIndex: 0, durationSeconds: 10 };
  const interval = { from: 0, to: 1 };
  await maps.playback({ ...address, zones: [{ ...interval, priority: 100, deadlineAt: 5000 }] });
  await maps.metadata({ ...address, statement: "packets", interval, leadSeconds: 2,
    result: { kind: "needs-ranges", ranges: [[10, 20]] } });
  assert.equal(published.zones[0].deadlineAt, 3000);
  await maps.playback({ ...address, zones: [{ ...interval, priority: 10, deadlineAt: 15000 }] });
  assert.equal(published.zones[0].deadlineAt, 13000);
  assert.equal(published.zones[0].priority, 10);
});

test("packet interval requests remain independent when stored bytes change", async () => {
  const requested = [];
  const reads = new MediaReadRequests({ read: async (params, statement) => {
    requested.push(params.requestId);
    reads.record(params, statement, { kind: "result" });
  } });
  for (const requestId of ["segment-1", "segment-2"]) {
    reads.record({ sourceKey: "source", fileIndex: 0, requestId }, "packets",
      { kind: "needs-ranges", ranges: [[10, 20]] });
  }
  reads.bytesChanged("source", 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requested.sort(), ["segment-1", "segment-2"]);
});

test("speculative index reads retain their own priority and deadline", async () => {
  let published;
  const maps = new DownloadMaps({ publish: map => { published = map; } });
  await maps.metadata({ sourceKey: "source", fileIndex: 0, statement: "packets",
    priority: 12, urgent: false, deadlineAt: 1234,
    result: { kind: "needs-ranges", ranges: [[10, 20]], requestId: "future" } });
  assert.deepEqual(published.zones, [{ byteStart: 10, byteEnd: 20, priority: 12,
    urgent: false, downloadOnly: true, requestId: "future", deadlineAt: 1234 }]);
});

test("a withdrawn interval removes its metadata and rejects a late missing-byte result", async () => {
  let published;
  const maps = new DownloadMaps({ publish: map => { published = map; }, resolvePlayback: async () => [] });
  const address = { sourceKey: "source", fileIndex: 0, durationSeconds: 10 };
  const interval = { from: 0, to: 1 };
  await maps.playback({ ...address, zones: [interval] });
  const missing = { ...address, statement: "packets:old", interval,
    result: { kind: "needs-ranges", ranges: [[10, 20]] } };
  await maps.metadata(missing);
  assert.equal(published.zones.length, 1);
  await maps.playback({ ...address, zones: [{ from: 5, to: 6 }] });
  assert.deepEqual(published.zones, []);
  await maps.metadata(missing);
  assert.deepEqual(published.zones, []);
});

test("late interval metadata uses the viewer's latest pause priority", async () => {
  let published;
  const maps = new DownloadMaps({ publish: map => { published = map; }, resolvePlayback: async () => [] });
  const address = { sourceKey: "source", fileIndex: 0, durationSeconds: 10 };
  const interval = { from: 0, to: 1 };
  await maps.playback({ ...address, zones: [{ ...interval, priority: 100, urgent: true, deadlineAt: 0 }] });
  await maps.playback({ ...address, zones: [{ ...interval, priority: 12, urgent: false, deadlineAt: 1234 }] });
  await maps.metadata({ ...address, statement: "packets:old", interval, priority: 100, urgent: true, deadlineAt: 0,
    result: { kind: "needs-ranges", ranges: [[10, 20]] } });
  assert.equal(published.zones[0].priority, 12);
  assert.equal(published.zones[0].urgent, false);
  assert.equal(published.zones[0].deadlineAt, 1234);
  await maps.playback({ ...address, zones: [{ ...interval, priority: 8, urgent: false, deadlineAt: 2000 }] });
  assert.equal(published.zones[0].priority, 8);
  assert.equal(published.zones[0].deadlineAt, 2000);
});

test("metadata demand survives playback changes and disappears after a result", async () => {
  const sent = [];
  const maps = new DownloadMaps({ publish: async map => sent.push(map) });
  const file = { sourceKey: "source", fileIndex: 0 };
  await maps.metadata({ ...file, statement: "tracks", result: { kind: "needs-ranges", ranges: [[10, 29]], requestId: "read" } });
  await maps.playback({ ...file, durationSeconds: 20, zones: [{ from: 0, to: 5, priority: 100 }] });
  assert.equal(sent[1].zones.length, 2);
  assert.deepEqual(sent[1].zones[1], { byteStart: 10, byteEnd: 29, priority: 100, urgent: true, downloadOnly: true, requestId: "read", deadlineAt: 0 });
  await maps.metadata({ ...file, statement: "tracks", result: { kind: "result", value: [] } });
  assert.equal(sent[2].zones.length, 1);
});

test("forget cancels unfinished conversion before immediate reuse", async () => {
  const sent = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const maps = new DownloadMaps({ publish: async map => { if (!sent.length) await blocked; sent.push(map); } });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 20 };
  const first = maps.playback({ ...file, zones: [{ from: 0, to: 1 }] });
  const forgotten = maps.forget("source", 0);
  const reused = maps.playback({ ...file, zones: [{ from: 10, to: 11 }] });
  release();
  await Promise.all([first, forgotten, reused]);
  assert.deepEqual(sent.map(map => map.zones), [[], [{ from: 10, to: 11 }]]);
});

test("source retirement removes maps and prevents late conversion from reaching a new source lifetime", async () => {
  const sent = [];
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const entering = new Promise(resolve => { entered = resolve; });
  const maps = new DownloadMaps({ publish: async map => sent.push(map), resolvePlayback: async map => {
    if (map.zones[0].from === 0) { entered(); await blocked; }
    return map.zones;
  } });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 20 };
  const old = maps.playback({ ...file, zones: [{ from: 0, to: 1 }] });
  await entering;
  const epoch = maps.epoch("source", 0);
  maps.retire("source");
  assert.equal(maps.wantsInterval("source", 0, { from: 0, to: 1 }), false);
  await maps.playback({ ...file, zones: [{ from: 10, to: 11 }] });
  assert.notEqual(maps.epoch("source", 0), epoch);
  release();
  await old;
  assert.deepEqual(sent.map(map => map.zones), [[{ from: 10, to: 11 }]]);
});

test("source retirement cancels map publications still waiting in the local queue", async () => {
  const sent = [];
  const maps = new DownloadMaps({ publish: async map => sent.push(map) });
  const pending = maps.metadata({ sourceKey: "source", fileIndex: 0, statement: "tracks",
    result: { kind: "needs-ranges", ranges: [[10, 20]] } });
  maps.retire("source");
  await pending;
  assert.deepEqual(sent, []);
});

test("an old asynchronous byte conversion cannot overwrite a newer playback map", async () => {
  const sent = [];
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const maps = new DownloadMaps({ publish: async map => sent.push(map), resolvePlayback: async map => {
    if (map.zones[0].from === 0) await delayed;
    return map.zones;
  } });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 20 };
  const old = maps.playback({ ...file, zones: [{ from: 0, to: 1 }] });
  await maps.playback({ ...file, zones: [{ from: 10, to: 11 }] });
  release();
  await old;
  assert.deepEqual(sent.map(map => map.zones), [[{ from: 10, to: 11 }]]);
});

test("seeking withdraws previous source bytes before the new index conversion finishes", async () => {
  const sent = [];
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const maps = new DownloadMaps({ publish: async map => sent.push(map), resolvePlayback: async map => {
    if (map.zones[0].from === 10) await delayed;
    return map.zones.map(zone => ({ ...zone, byteStart: zone.from * 100, byteEnd: zone.to * 100 - 1 }));
  } });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 20 };
  await maps.playback({ ...file, zones: [{ from: 0, to: 1 }] });
  const seeking = maps.playback({ ...file, zones: [{ from: 10, to: 11 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.at(-1).zones, []);
  release();
  await seeking;
  assert.equal(sent.at(-1).zones[0].byteStart, 1000);
});

test("metadata retries only on byte changes and stops after completion", async () => {
  const params = { sourceKey: "source", fileIndex: 0 };
  let calls = 0;
  const reads = new MediaReadRequests({ read: async () => { calls++; reads.record(params, "tracks", { kind: "result" }); } });
  reads.record(params, "tracks", { kind: "needs-ranges" });
  assert.equal(calls, 0);
  reads.bytesChanged("other", 0);
  assert.equal(calls, 0);
  reads.bytesChanged("source", 0);
  await Promise.resolve();
  reads.bytesChanged("source", 0);
  assert.equal(calls, 1);
});

test("bytes arriving during a read cannot leave its missing-range result waiting", async () => {
  const params = { sourceKey: "source", fileIndex: 0 };
  let calls = 0;
  const reads = new MediaReadRequests({ read: async () => { calls++; reads.record(params, "tracks", { kind: "result" }); } });
  const before = reads.revision("source", 0);
  reads.bytesChanged("source", 0);
  reads.record(params, "tracks", { kind: "needs-ranges" }, before);
  await Promise.resolve();
  assert.equal(calls, 1);
});

test("a viewer moving on keeps the resolved zones until the re-cut map is resolved", async () => {
  // Field 2026-10-07: every advance re-cut the zones, none kept its exact
  // interval, and the interim publication was empty — the swarm was let go and
  // the encoder lost its resolved input every few seconds.
  const sent = [];
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const maps = new DownloadMaps({ publish: async map => sent.push(map), resolvePlayback: async map => {
    if (map.zones[0].from === 2) await delayed;
    return map.zones.map(zone => ({ ...zone, outputKey: "out", index: zone.from, byteStart: zone.from * 100, byteEnd: zone.to * 100 - 1 }));
  } });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 30 };
  await maps.playback({ ...file, zones: [{ from: 0, to: 10, priority: 100 }, { from: 10, to: 20, priority: 99 }] });
  const moving = maps.playback({ ...file, zones: [{ from: 2, to: 12, priority: 100 }, { from: 12, to: 22, priority: 99 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.at(-1).zones.map(zone => zone.byteStart), [0, 1000], "the interim map still states the film being watched");
  assert.deepEqual(maps.inputsForOutput("source", "out", 10), [{ sourceId: "source:0", ranges: [{ start: 1000, end: 2000 }] }]);
  release();
  await moving;
  assert.deepEqual(sent.at(-1).zones.map(zone => zone.byteStart), [200, 1200]);
});
