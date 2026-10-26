import test from "node:test";
import assert from "node:assert/strict";
import { DownloadMaps } from "../../services/viewer/DownloadMaps.js";

import { MediaReadRequests } from "../../services/media/MediaReadRequests.js";
import { coalescedZones } from "../../services/torrent/map-zones.js";

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

test("an active encode input reprices each of its missing metadata reads", async () => {
  let published;
  const maps = new DownloadMaps({ publish: map => { published = map; } });
  const address = { sourceKey: "source", fileIndex: 0 };
  for (const [statement, start] of [["tracks:encode:out:2", 10], ["media-info:encode:out:2", 30]]) {
    await maps.metadata({ ...address, statement, scope: "preparation", priority: 95, urgent: false, deadlineAt: 17_000,
      result: { kind: "needs-ranges", requestId: "encode:out:2", ranges: [[start, start + 9]] } });
  }
  await maps.repriceRequest("encode:out:2", { priority: 100, urgent: true, deadlineAt: 12_000 });
  assert.deepEqual(published.zones.map(zone => [zone.priority, zone.urgent, zone.deadlineAt]), [
    [100, true, 12_000], [100, true, 12_000]
  ]);
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
  release();
  await moving;
  assert.deepEqual(sent.at(-1).zones.map(zone => zone.byteStart), [200, 1200]);
});

test("a pass states what it has resolved before it works out a lower zone", async () => {
  // Field 2026-10-12: the first pass over a cold two-hour AVI took 14.6 s and
  // was published only at its end; the swarm fetched nothing for 17.5 s while
  // the encoder waited for its next piece (torrent-tv/meta#178).
  const sent = [];
  let release = () => {}, reached = () => {};
  const atLast = () => new Promise(resolve => { reached = resolve; });
  const worked = [];
  const maps = new DownloadMaps({ publish: async map => sent.push(map), resolvePlayback: async map => {
    const converted = [];
    for (const [at, zone] of map.zones.entries()) {
      map.workingOut(zone.priority, converted);
      await new Promise(resolve => setImmediate(resolve));
      worked.push(sent.length);
      if (at === map.zones.length - 1) {
        reached();
        await new Promise(resolve => { release = resolve; });
      }
      converted.push({ ...zone, outputKey: "out", index: zone.from, byteStart: zone.from * 100, byteEnd: zone.to * 100 - 1 });
    }
    return converted;
  } });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 40 };
  const zones = [{ from: 0, to: 10, priority: 100 }, { from: 10, to: 20, priority: 100 },
    { from: 20, to: 30, priority: 99 }, { from: 30, to: 40, priority: 98 }];
  let last = atLast();
  const passing = maps.playback({ ...file, zones });
  await last;
  assert.deepEqual(worked, [0, 0, 1, 2], "nothing before the first zone; one map as each lower priority is reached");
  assert.deepEqual(sent.at(-1).zones.map(zone => zone.byteStart), [0, 1000, 2000],
    "the swarm has the higher zones while the lowest is worked out");
  release();
  await passing;
  assert.deepEqual(sent.at(-1).zones.map(zone => zone.byteStart), [0, 1000, 2000, 3000]);

  // Worked out again under a newer map, a segment is stated once: by its new
  // reading where the pass has reached it, by the retained one where not.
  last = atLast();
  const again = maps.playback({ ...file, zones: zones.map(zone => ({ ...zone, priority: zone.priority - 1 })) });
  await last;
  const stated = [[0, 99], [1000, 99], [2000, 98], [3000, 97]];
  assert.deepEqual(sent.at(-1).zones.map(zone => [zone.byteStart, zone.priority]), stated);
  release();
  await again;
  assert.deepEqual(sent.at(-1).zones.map(zone => [zone.byteStart, zone.priority]), stated);
});

test("a pass's zones are worked out only when a lower priority is stated", async () => {
  // Built before every zone, they made the pass quadratic: a cold AVI's start
  // forecast waited 71 s for a pass that had taken 12 s (torrent-tv/meta#178).
  let asked = 0;
  const maps = new DownloadMaps({ publish: async () => {}, resolvePlayback: async map => {
    const converted = [];
    for (const zone of map.zones) {
      map.workingOut(zone.priority, () => { asked++; return converted; });
      converted.push({ ...zone, outputKey: "out", index: zone.from, byteStart: zone.from * 100, byteEnd: zone.to * 100 - 1 });
    }
    return converted;
  } });
  const zones = Array.from({ length: 50 }, (_, at) => ({ from: at * 10, to: at * 10 + 10, priority: at < 25 ? 100 : 99 }));
  await maps.playback({ sourceKey: "source", fileIndex: 0, durationSeconds: 500, zones });
  assert.equal(asked, 2, "once for the first zone, once where the priority drops");
});

test("a read that changes nothing in the map does not send it again, and does not wait for it", async () => {
  const sent = [];
  let deliver;
  const maps = new DownloadMaps({ publish: map => { sent.push(map); return new Promise(resolve => { deliver = resolve; }); } });
  const request = { sourceKey: "source", fileIndex: 0, statement: "tracks" };
  const first = maps.metadata({ ...request, result: { kind: "needs-ranges", ranges: [[100, 699]] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  let answered = false;
  void maps.metadata({ sourceKey: "source", fileIndex: 0, statement: "media-info", result: { kind: "result", value: {} } })
    .then(() => { answered = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(answered, true, "a read whose answer changes no zone is not held behind a delivery");
  assert.equal(sent.length, 1);
  deliver();
  await first;
});

test("deadlines worked out again on a later clock are not a change, a new order of deadlines is", async () => {
  const sent = [];
  const maps = new DownloadMaps({ publish: map => { sent.push(map); } });
  const zone = (byteStart, deadlineAt) => ({ byteStart, byteEnd: byteStart + 9, priority: 100, deadlineAt });
  await maps.native({ sourceKey: "source", fileIndex: 0, zones: [zone(0, 1_000), zone(10, 2_000)] });
  await maps.native({ sourceKey: "source", fileIndex: 0, zones: [zone(0, 1_400), zone(10, 2_400)] });
  assert.equal(sent.length, 1, "every deadline moved by the same amount");
  await maps.native({ sourceKey: "source", fileIndex: 0, zones: [zone(0, 3_000), zone(10, 2_400)] });
  assert.equal(sent.length, 2, "the second zone is now needed first");
  await maps.native({ sourceKey: "source", fileIndex: 0, zones: [zone(0, 3_000), zone(20, 2_400)] });
  assert.equal(sent.length, 3, "other bytes");
});

test("a publication that failed is sent again by the same map", async () => {
  let attempts = 0;
  const maps = new DownloadMaps({ publish: () => {
    attempts += 1;
    if (attempts === 1) throw new Error("the torrent thread is gone");
  } });
  const zones = [{ byteStart: 0, byteEnd: 9, priority: 100, deadlineAt: 1_000 }];
  await assert.rejects(maps.native({ sourceKey: "source", fileIndex: 0, zones }));
  await maps.native({ sourceKey: "source", fileIndex: 0, zones });
  assert.equal(attempts, 2);
});

test("what the publications of a file cost is said once a minute", async () => {
  const lines = [];
  const clock = { at: 0 };
  const maps = new DownloadMaps({ log: line => lines.push(line), now: () => clock.at, publish: () => {
    clock.at += 30;
    return { appliedMs: 12 };
  } });
  const zones = deadlineAt => [{ byteStart: 0, byteEnd: 9, priority: 100, deadlineAt },
    { byteStart: 10, byteEnd: 19, priority: 99, deadlineAt: 5_000 - deadlineAt }];
  await maps.native({ sourceKey: "source", fileIndex: 0, zones: zones(1_000) });
  await maps.native({ sourceKey: "source", fileIndex: 0, zones: zones(1_000) });
  assert.equal(lines.length, 0);
  clock.at = 60_000;
  await maps.native({ sourceKey: "source", fileIndex: 0, zones: zones(4_000) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /source:0: 2 sent and 1 unchanged not sent in 60\.0s; zones median 2 max 2; delivered median 30ms max 30ms \(60ms in all\), applied in the torrent thread median 12ms max 12ms \(24ms in all\)/);
});

test("a map the torrent thread could not apply is sent again even when nothing changed", async () => {
  const replies = [{ appliedMs: null }, { appliedMs: 3 }];
  let sent = 0;
  const maps = new DownloadMaps({ publish: () => replies[sent++] });
  const zones = [{ byteStart: 0, byteEnd: 9, priority: 100, deadlineAt: 1_000 }];
  await maps.native({ sourceKey: "source", fileIndex: 0, zones });
  await maps.native({ sourceKey: "source", fileIndex: 0, zones });
  await maps.native({ sourceKey: "source", fileIndex: 0, zones });
  assert.equal(sent, 2, "sent again after the torrent was not there, and not a third time once applied");
});

test("a statement that changes nothing builds no map (torrent-tv/meta#178)", async () => {
  let built = 0;
  const maps = new DownloadMaps({ publish: () => ({ appliedMs: 1 }), clock: () => { built += 1; return 0; } });
  const request = { sourceKey: "source", fileIndex: 0, statement: "packets:92" };
  await maps.metadata({ ...request, result: { kind: "needs-ranges", ranges: [[100, 699]], requestId: "r" } });
  const afterFirst = built;
  await maps.metadata({ ...request, result: { kind: "needs-ranges", ranges: [[100, 699]], requestId: "r" } });
  for (let index = 0; index < 50; index++) await maps.metadata({ ...request, result: { kind: "needs-memory", bytes: 31_522_816 } });
  await maps.metadata({ sourceKey: "source", fileIndex: 0, statement: "media-info", result: { kind: "result", value: {} } });
  assert.equal(built, afterFirst, "neither the same ranges, a refusal of memory nor a result with no demand built a map");
  await maps.metadata({ ...request, result: { kind: "needs-ranges", ranges: [[100, 799]], requestId: "r" } });
  assert.ok(built > afterFirst, "another range bound is another demand");
});

test("an unchanged statement still sends a map the torrent thread did not apply, or that failed", async () => {
  const replies = [{ appliedMs: null }, { appliedMs: 2 }];
  let sent = 0;
  const maps = new DownloadMaps({ publish: () => replies[sent++] });
  const request = { sourceKey: "source", fileIndex: 0, statement: "packets" };
  await maps.metadata({ ...request, result: { kind: "needs-ranges", ranges: [[0, 9]] } });
  await maps.metadata({ ...request, result: { kind: "needs-memory", bytes: 600 } });
  assert.equal(sent, 2, "the map not applied is sent again by the next statement, unchanged as it is");
  await maps.metadata({ ...request, result: { kind: "needs-memory", bytes: 600 } });
  assert.equal(sent, 2, "and not again once applied");

  let attempts = 0;
  const failing = new DownloadMaps({ publish: () => { if (++attempts === 1) throw new Error("the torrent thread is gone"); } });
  await assert.rejects(failing.metadata({ ...request, result: { kind: "needs-ranges", ranges: [[0, 9]] } }));
  await failing.metadata({ ...request, result: { kind: "needs-ranges", ranges: [[0, 9]] } });
  assert.equal(attempts, 2, "a failed publication is sent again by the same statement");
});

test("a demand that differs only in a field the publication does not carry is still a change", async () => {
  let built = 0;
  const maps = new DownloadMaps({ publish: () => ({ appliedMs: 1 }), clock: () => { built += 1; return 0; } });
  const request = { sourceKey: "source", fileIndex: 0, statement: "tracks", result: { kind: "needs-ranges", ranges: [[0, 9]] } };
  await maps.metadata({ ...request, scope: "preparation" });
  const afterFirst = built;
  await maps.metadata({ ...request, scope: "playback" });
  assert.ok(built > afterFirst, "the scope decides what forget keeps, so it is recorded");
  const afterScope = built;
  await maps.metadata({ ...request, scope: "playback", deadlineAt: 5_000 });
  assert.ok(built > afterScope, "another deadline is another demand");
});

test("what a map sends and compares is packed: one window per touching stretch of a band", async () => {
  // Ten thousand zones were built, compared and copied every few seconds of
  // playback; the torrent acts on bands alone (torrent-tv/meta#178).
  const sent = [];
  const maps = new DownloadMaps({ publish: async map => sent.push(map), pack: zones => coalescedZones(zones, 0),
    resolvePlayback: async map => map.zones.map(zone => ({ ...zone, outputKey: "out", index: zone.from,
      byteStart: zone.from * 100, byteEnd: zone.to * 100 - 1 })) });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 40 };
  await maps.playback({ ...file, zones: [{ from: 0, to: 10, priority: 100, urgent: true }, { from: 10, to: 20, priority: 100, urgent: true },
    { from: 20, to: 30, priority: 99 }] });
  assert.deepEqual(sent.at(-1).zones.map(zone => [zone.byteStart, zone.byteEnd, zone.priority]), [[0, 1999, 100], [2000, 2999, 99]]);
  // Each segment still states the bytes it reads.
  // A pass that changes nothing the torrent acts on sends nothing.
  await maps.playback({ ...file, zones: [{ from: 0, to: 10, priority: 100, urgent: true }, { from: 10, to: 20, priority: 100, urgent: true },
    { from: 20, to: 30, priority: 99 }] });
  assert.equal(sent.length, 1);
});

test("a metadata statement adds its ranges to the packed playback zones without packing them again", async () => {
  // A statement used to pack every zone of the film again: 27 s of the main
  // thread in fifteen minutes on Home Assistant (r22, torrent-tv/meta#178).
  const sent = [];
  let packed = 0;
  const maps = new DownloadMaps({ publish: async map => sent.push(map), pack: zones => { packed += 1; return coalescedZones(zones, 0); },
    resolvePlayback: async map => map.zones.map(zone => ({ ...zone, outputKey: "out", index: zone.from,
      byteStart: zone.from * 100, byteEnd: zone.to * 100 - 1 })) });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 40 };
  await maps.playback({ ...file, zones: [{ from: 0, to: 10, priority: 100, urgent: true, deadlineAt: 5_000 },
    { from: 10, to: 20, priority: 99, deadlineAt: 15_000 }] });
  const afterPlayback = packed;
  await maps.metadata({ ...file, statement: "packets:a", result: { kind: "needs-ranges", ranges: [[5000, 5099]], requestId: "a" } });
  await maps.metadata({ ...file, statement: "packets:b", result: { kind: "needs-ranges", ranges: [[6000, 6099]], requestId: "b" } });
  assert.equal(packed, afterPlayback, "the playback zones are not packed again for a statement");
  assert.deepEqual(sent.at(-1).zones.map(zone => [zone.byteStart, zone.byteEnd, zone.requestId ?? null]),
    [[0, 999, null], [1000, 1999, null], [5000, 5099, "a"], [6000, 6099, "b"]]);
  // The packed zones are not the ones the statements were added to.
  await maps.withdrawMetadata("source", 0, "packets:a");
  assert.deepEqual(sent.at(-1).zones.map(zone => zone.requestId ?? null), [null, null, "b"]);
  // New playback zones are packed again.
  await maps.playback({ ...file, zones: [{ from: 0, to: 10, priority: 100, urgent: true, deadlineAt: 5_000 }] });
  assert.ok(packed > afterPlayback);
  assert.deepEqual(sent.at(-1).zones.map(zone => [zone.byteStart, zone.byteEnd, zone.requestId ?? null]), [[0, 999, null], [6000, 6099, "b"]]);
});

test("native zones wanted within some seconds are packed again on each publication", async () => {
  // Packing turns "within N seconds" into an instant on its own clock.
  let packed = 0;
  const maps = new DownloadMaps({ publish: async () => undefined, pack: zones => { packed += 1; return coalescedZones(zones); } });
  await maps.native({ sourceKey: "source", fileIndex: 0, zones: [{ byteStart: 0, byteEnd: 99, priority: 100, urgent: true, withinSeconds: 4 }] });
  await maps.metadata({ sourceKey: "source", fileIndex: 0, statement: "packets", result: { kind: "needs-ranges", ranges: [[500, 599]], requestId: "r" } });
  assert.equal(packed, 2);
});

test("a pass that hands back the zones it resolved before is not packed again", async () => {
  // A resolver that hands back the zones it resolved before — the projection
  // in server.js hands back its windows while nothing in them has changed
  // (torrent-tv/meta#178).
  let packed = 0;
  const resolved = [{ from: 0, to: 10, priority: 100, urgent: true, deadlineAt: 5_000, outputKey: "out", index: 0, byteStart: 0, byteEnd: 999 }];
  const maps = new DownloadMaps({ publish: async () => undefined, pack: zones => { packed += 1; return coalescedZones(zones, 0); },
    resolvePlayback: async () => resolved });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 40 };
  const zones = [{ from: 0, to: 10, priority: 100, urgent: true, deadlineAt: 5_000 }];
  await maps.playback({ ...file, zones });
  const once = packed;
  await maps.playback({ ...file, zones: [{ ...zones[0] }] });
  assert.equal(packed, once);
});

test("a pass whose zones only moved their deadlines leaves the packed zones standing for the statements made meanwhile", async () => {
  // Set anew on every pass, the zones were a new list each time and every
  // metadata statement during the pass packed the film again (r24,
  // torrent-tv/meta#178).
  let packed = 0;
  let release = null;
  const sent = [];
  const maps = new DownloadMaps({ publish: async map => sent.push(map), pack: zones => { packed += 1; return coalescedZones(zones, 0); },
    resolvePlayback: async map => {
      if (release) await new Promise(resolve => { const go = release; release = null; go(resolve); });
      return map.zones.map(zone => ({ ...zone, outputKey: "out", index: zone.from, byteStart: zone.from * 100, byteEnd: zone.to * 100 - 1 }));
    } });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 30 };
  await maps.playback({ ...file, zones: [{ from: 0, to: 10, priority: 100, urgent: true, deadlineAt: 5_000 }] });
  const before = packed;
  let finish = null;
  release = resolve => { finish = resolve; };
  const moving = maps.playback({ ...file, zones: [{ from: 0, to: 10, priority: 100, urgent: true, deadlineAt: 6_000 }] });
  await new Promise(resolve => setImmediate(resolve));
  await maps.metadata({ ...file, statement: "packets", result: { kind: "needs-ranges", ranges: [[5000, 5099]], requestId: "r" } });
  assert.equal(packed, before, "the statement is added to the packed zones as they stand");
  finish();
  await moving;
  // A zone withdrawn is still said at once.
  release = resolve => { finish = resolve; };
  const away = maps.playback({ ...file, zones: [{ from: 20, to: 30, priority: 100, urgent: true, deadlineAt: 9_000 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!sent.at(-1).zones.some(zone => zone.byteStart === 0), "the zone nobody wants any more is not stated in the meantime");
  finish();
  await away;
});

test("a paused viewer's map moves only its deadlines, and the torrent is told the current order", async () => {
  // A pass gives one zone per segment, its demand stated once for the ranges
  // the segment reads (r26, torrent-tv/meta#178). A pause can keep every
  // priority and move the deadlines; the soundtrack then comes before the
  // picture, and both the windows and their order say so.
  const sent = [];
  const picture = [[0, 99], [1000, 1999]];
  const sound = [[0, 99], [5000, 5499]];
  const maps = new DownloadMaps({ publish: async map => sent.push(map), pack: zones => coalescedZones(zones, 0),
    resolvePlayback: async map => map.zones.flatMap(zone => [
      { outputKey: "picture", index: 0, from: zone.from, to: zone.to, priority: zone.priority, deadlineAt: zone.deadlineAt,
        downloadInterval: { from: zone.from, to: zone.to }, ranges: picture },
      { outputKey: "sound", index: 0, from: zone.from, to: zone.to, priority: zone.priority, deadlineAt: zone.soundDeadlineAt,
        downloadInterval: { from: zone.from, to: zone.to }, ranges: sound }]) });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 10 };
  await maps.playback({ ...file, zones: [{ from: 0, to: 10, priority: 90, deadlineAt: 100, soundDeadlineAt: 150 }] });
  const windows = () => sent.at(-1).zones.map(zone => [zone.byteStart, zone.byteEnd, zone.priority, zone.deadlineAt]);
  assert.deepEqual(windows(), [[0, 99, 90, 100], [1000, 1999, 90, 100], [5000, 5499, 90, 150]]);
  const before = sent.length;
  await maps.playback({ ...file, zones: [{ from: 0, to: 10, priority: 90, deadlineAt: 500, soundDeadlineAt: 250 }] });
  assert.equal(sent.length, before + 1, "the new order is sent");
  assert.deepEqual(windows(), [[0, 99, 90, 250], [1000, 1999, 90, 500], [5000, 5499, 90, 250]]);
});

test("a segment whose map zone moved its bounds keeps its bytes stated, and is stated in the new band when worked out", async () => {
  // The viewer moving on re-cuts the map zones while a segment reads the same
  // bytes: in the meantime its zone stands, all its ranges with it, and the
  // pass states it with the zone it belongs to now (review of
  // torrent-tv/meta#178).
  const sent = [];
  let release = null;
  const ranges = [[0, 99], [1000, 1999]];
  const maps = new DownloadMaps({ publish: async map => sent.push(map), pack: zones => coalescedZones(zones, 0),
    resolvePlayback: async map => {
      if (release) await new Promise(resolve => { const go = release; release = null; go(resolve); });
      const zone = map.zones[0];
      return [{ outputKey: "picture", index: 3, from: 6, to: 8, priority: zone.priority, urgent: zone.urgent, deadlineAt: zone.deadlineAt,
        downloadInterval: { from: zone.from, to: zone.to }, ranges }];
    } });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 20 };
  await maps.playback({ ...file, zones: [{ from: 0, to: 10, priority: 90, deadlineAt: 1_000 }] });
  const stated = () => sent.at(-1).zones.map(zone => [zone.byteStart, zone.byteEnd, zone.priority]);
  assert.deepEqual(stated(), [[0, 99, 90], [1000, 1999, 90]]);
  let finish = null;
  release = resolve => { finish = resolve; };
  const moving = maps.playback({ ...file, zones: [{ from: 2, to: 12, priority: 95, deadlineAt: 2_000 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.at(-1).zones.map(zone => [zone.byteStart, zone.byteEnd]), [[0, 99], [1000, 1999]],
    "the segment's bytes are still stated while the pass is under way");
  finish();
  await moving;
  assert.deepEqual(stated(), [[0, 99, 95], [1000, 1999, 95]]);
});

test("windows a resolver keeps current stand as they are until it states them again", async () => {
  // The projection of a file's segments (`PlaybackProjection`) brings its
  // windows to each map itself, so a new map neither withdraws nor reprices
  // them meanwhile, an early statement is not doubled with the windows stated
  // before, and windows already packed are not packed again
  // (torrent-tv/meta#178).
  const sent = [];
  let packed = 0;
  let release = null;
  let windows = [{ byteStart: 0, byteEnd: 999, priority: 100, urgent: true, deadlineAt: 5_000, standing: true }];
  const maps = new DownloadMaps({ publish: async map => sent.push(map), pack: zones => { packed += 1; return coalescedZones(zones, 0); },
    resolvePlayback: async map => {
      if (release) await new Promise(resolve => { const go = release; release = null; go(resolve); });
      map.workingOut(100, () => windows);
      return windows;
    } });
  const file = { sourceKey: "source", fileIndex: 0, durationSeconds: 30 };
  await maps.playback({ ...file, zones: [{ from: 0, to: 10, priority: 100, urgent: true, deadlineAt: 5_000 }] });
  assert.equal(packed, 0, "windows packed by their resolver are not packed again");
  let finish = null;
  release = resolve => { finish = resolve; };
  // A seek far away: the windows stand while the pass is under way.
  const moving = maps.playback({ ...file, zones: [{ from: 20, to: 30, priority: 100, urgent: true, deadlineAt: 9_000 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.at(-1).zones.map(zone => zone.byteStart), [0]);
  windows = [{ byteStart: 2000, byteEnd: 2999, priority: 100, urgent: true, deadlineAt: 9_000, standing: true }];
  const before = sent.length;
  finish();
  await moving;
  assert.ok(sent.length > before);
  for (const map of sent.slice(before)) {
    assert.deepEqual(map.zones.map(zone => zone.byteStart), [2000], "the early statement is not doubled with the windows before");
  }
  assert.deepEqual(sent.at(-1).zones.map(zone => zone.byteStart), [2000], "the windows stated now, not with the ones before");
  assert.equal(packed, 0);
});

test("playback map resolution reports a paired P4 span on success and failure", async () => {
  const events = [];
  const successful = new DownloadMaps({ publish() {}, observeWait: (...args) => events.push(args),
    resolvePlayback: async map => map.zones });
  await successful.playback({ sourceKey: "source", fileIndex: 2, durationSeconds: 10,
    zones: [{ from: 0, to: 1, priority: 0 }] });
  assert.deepEqual(events.map(([, , fields]) => fields.phase), ["begin", "end"]);
  assert.equal(events[0][2].process, "P4");
  assert.equal(events[1][2].outcome, "ok");
  assert.ok(events[1][2].durationMs >= 0);

  events.length = 0;
  const failed = new DownloadMaps({ publish() {}, observeWait: (...args) => events.push(args),
    resolvePlayback: async () => { throw new Error("read failed"); } });
  await assert.rejects(failed.playback({ sourceKey: "source", fileIndex: 2, durationSeconds: 10,
    zones: [{ from: 0, to: 1, priority: 0 }] }), /read failed/);
  assert.deepEqual(events.map(([, , fields]) => fields.phase), ["begin", "end"]);
  assert.equal(events[1][2].outcome, "error");
});

test("a file's own read is published only while a present viewer holds the file", async () => {
  // Home Assistant 2026-10-26 (torrent-tv/meta#239): the plan's header reads of
  // a film whose swarm gave nothing stayed stated at a stopped viewer's urgency
  // after the viewer had moved to another film, and held the swarm's first
  // class for every torrent on the proxy.
  const holders = new Map([["dead", [0]], ["live", []]]);
  const published = new Map();
  const lines = [];
  const maps = new DownloadMaps({
    publish: map => { published.set(map.sourceKey, map); },
    log: line => lines.push(line),
    fileWanted: (sourceKey, fileIndex) => (holders.get(sourceKey) ?? []).includes(fileIndex)
  });
  const header = { sourceKey: "dead", fileIndex: 0, statement: "tracks", owner: "file",
    result: { kind: "needs-ranges", ranges: [[0, 15]], requestId: "torrent:dead:0:tracks" } };
  await maps.metadata(header);
  await maps.metadata({ ...header, statement: "keyframes", result: { kind: "needs-ranges", ranges: [[9000, 9999]], requestId: "torrent:dead:0:keyframes" } });
  assert.deepEqual(published.get("dead").zones.map(zone => [zone.byteStart, zone.byteEnd, zone.priority, zone.urgent]),
    [[0, 15, 100, true], [9000, 9999, 100, true]], "a read the file made is stated at once while its viewer holds it");

  // The viewer moves to the other film.
  holders.set("dead", []);
  holders.set("live", [3]);
  await maps.viewersChanged();
  assert.deepEqual(published.get("dead").zones, [], "nobody holds the file: its own reads are withdrawn from the swarm");
  assert.match(lines.at(-1), /dead:0: 2 read\(s\) of the file itself withheld — no present viewer holds the file \[tracks, keyframes\]/);

  // A read that answers again while nobody holds the file is kept, not sent.
  await maps.metadata({ ...header, result: { kind: "needs-ranges", ranges: [[0, 31]], requestId: "torrent:dead:0:tracks" } });
  assert.deepEqual(published.get("dead").zones, [], "restated while unheld, it is still not sent");

  // And comes back without being read again when a viewer holds the file.
  holders.set("dead", [0]);
  await maps.viewersChanged();
  assert.deepEqual(published.get("dead").zones.map(zone => [zone.byteStart, zone.byteEnd]), [[0, 31], [9000, 9999]]);
});

test("a viewer's own demand and a preparation read are not withheld with the file's reads", async () => {
  let held = true;
  let published;
  const maps = new DownloadMaps({ publish: map => { published = map; }, fileWanted: () => held });
  await maps.metadata({ sourceKey: "s", fileIndex: 1, statement: "tracks", owner: "file",
    result: { kind: "needs-ranges", ranges: [[0, 15]] } });
  await maps.metadata({ sourceKey: "s", fileIndex: 1, statement: "packets:prepare", scope: "preparation", priority: 10, urgent: false,
    result: { kind: "needs-ranges", ranges: [[100, 199]] } });
  held = false;
  await maps.viewersChanged();
  assert.deepEqual(published.zones.map(zone => [zone.byteStart, zone.byteEnd]), [[100, 199]],
    "preparation has its own owner and is withdrawn by it, not by this rule");
});
