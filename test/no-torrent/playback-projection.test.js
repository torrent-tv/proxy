import test from "node:test";
import assert from "node:assert/strict";
import { PlaybackProjection } from "../../services/torrent/PlaybackProjection.js";
import { coalescedZones } from "../../services/torrent/map-zones.js";
import { mapForViewer, mergeMaps, runsOf } from "../../services/viewer/PriorityMap.js";
import { expandToTargetInputs, segmentDemands, sourceDeadline } from "./support/whole-pass.js";

// Arithmetic only; no torrent.
//
// The projection keeps what the torrent is told of a played file and brings it
// up to date by what a new map changes (torrent-tv/meta#178, stage C). Here it
// is held beside the pass it replaces, worked out whole on every map: the
// demands of every segment (`segmentDemands`), their deadlines less making and
// delivery (`sourceDeadline`), the next run's input raised
// (`expandToTargetInputs`) and the ranges packed into windows
// (`coalescedZones`). Every map of every sequence must give the same windows.

function numbers(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A grid of segment starts over `duration` seconds. */
function gridOf(random, duration) {
  const grid = [0];
  while (grid.at(-1) < duration) grid.push(Math.min(duration, grid.at(-1) + 1 + Math.floor(random() * 8)));
  return grid;
}

/**
 * An output's segments' ranges: the two every segment names (an AVI's header
 * and index), and its own, interleaved with the other output's in the file.
 */
function rangesOf(random, grid, lane) {
  return grid.slice(0, -1).map((from, index) => {
    const own = 10_000 + Math.floor(from * 1000) * 2 + lane * 1000;
    const ranges = [[0, 99], [100, 199], [own, own + 500 + Math.floor(random() * 400)]];
    if (random() < 0.1) ranges.push([own + 1000, own + 1100]);
    return index % 13 === 5 ? ranges.slice(2) : ranges;
  });
}

/** The map's zones as `DownloadMaps.playback` hands them on: deadlines as instants. */
function zonesFor(viewers, durationSeconds, allowanceSeconds, now) {
  const maps = viewers.map(viewer => mapForViewer({ atSeconds: viewer.at, durationSeconds, allowanceSeconds,
    playing: viewer.playing, viewerCount: viewers.length, pauseSeconds: viewer.pausedFor, urgentReady: viewer.urgentReady }));
  return runsOf(mergeMaps(maps)).map(zone => Number.isFinite(zone.withinSeconds)
    ? { ...zone, deadlineAt: now + Math.max(0, zone.withinSeconds) * 1000 } : zone);
}

/** The pass the projection replaces, worked out whole. */
function reference(zones, outputs) {
  const converted = [];
  for (const output of outputs) {
    const shaped = { spec: { video: { fileIndex: 0, encode: true } }, timeline: { published: output.grid } };
    for (const demand of segmentDemands(shaped, 0, zones)) {
      if (output.ready.has(demand.index)) continue;
      const deadlineAt = sourceDeadline(demand, { encodeSpeed: output.encodeSpeed,
        outputBytes: output.bytesPerSecond > 0 ? output.bytesPerSecond * (demand.to - demand.from) : null,
        linkMbps: output.linkMbps });
      const ranges = output.known.get(demand.index);
      if (!ranges) continue;
      converted.push({ index: demand.index, from: demand.from, to: demand.to, priority: demand.priority,
        urgent: demand.urgent, behind: demand.behind, deferred: demand.deferred, deadlineAt,
        outputKey: output.outputKey, ranges });
    }
  }
  converted.sort((left, right) => left.deadlineAt - right.deadlineAt || right.priority - left.priority || left.index - right.index);
  const targets = new Map(outputs.map(output => [output.outputKey, output.target]));
  return coalescedZones(expandToTargetInputs(converted, key => targets.get(key) ?? null), 0);
}

/** Windows compared as what the torrent acts on, the deadline to a millionth of a millisecond. */
function sameWindows(projected, expected, label) {
  const key = zone => `${zone.byteStart}-${zone.byteEnd} p${zone.priority} ${zone.urgent ? "u" : ""}${zone.behind ? "b" : ""}${zone.deferred ? "d" : ""}`;
  const left = [...projected].sort((a, b) => key(a).localeCompare(key(b)));
  const right = [...expected].sort((a, b) => key(a).localeCompare(key(b)));
  assert.deepEqual(left.map(key), right.map(key), label);
  left.forEach((zone, index) => {
    const other = right[index];
    if (!Number.isFinite(other.deadlineAt)) assert.equal(zone.deadlineAt, undefined, `${label}: ${key(zone)} has no deadline`);
    else assert.ok(Math.abs(zone.deadlineAt - other.deadlineAt) < 1e-6, `${label}: ${key(zone)} at ${zone.deadlineAt}, not ${other.deadlineAt}`);
  });
}

function scenario(seed, steps) {
  const random = numbers(seed);
  const duration = 60 + Math.floor(random() * 600);
  const allowance = 1 + random() * 30;
  const outputs = [0, 1].slice(0, 1 + Math.floor(random() * 2)).map(lane => {
    const grid = gridOf(random, duration);
    return { outputKey: `out${lane}`, grid, ranges: rangesOf(random, grid, lane), known: new Map(), ready: new Set(),
      revision: 0, encodeSpeed: random() < 0.2 ? undefined : 0.5 + random() * 3,
      bytesPerSecond: random() < 0.3 ? null : 50_000 + random() * 500_000, linkMbps: random() < 0.3 ? null : 2 + random() * 40,
      target: random() < 0.4 ? null : Math.floor(random() * 6000) };
  });
  const viewers = [{ at: random() * duration, playing: true, pausedFor: 0, urgentReady: false }];
  if (random() < 0.25) viewers.push({ at: random() * duration, playing: true, pausedFor: 0, urgentReady: false });
  let now = 1_700_000_000_000;
  const projection = new PlaybackProjection();
  for (let step = 0; step < steps; step++) {
    // The viewer plays on, mostly; sometimes something else happens.
    const roll = random();
    for (const viewer of viewers) {
      if (viewer.playing) viewer.at = Math.min(duration, viewer.at + 1);
      else viewer.pausedFor += 1;
    }
    now += 1000;
    if (roll < 0.04) viewers[0].at = random() * duration;
    else if (roll < 0.07) viewers[0].playing = !viewers[0].playing;
    else if (roll < 0.1) viewers[0].urgentReady = !viewers[0].urgentReady;
    for (const output of outputs) {
      if (random() < 0.15) { output.encodeSpeed = 0.5 + random() * 3; }
      if (random() < 0.05) output.linkMbps = 2 + random() * 40;
      if (random() < 0.1) output.target = Math.floor(random() * 6000);
      if (random() < 0.2) {
        const index = Math.floor(random() * (output.grid.length - 1));
        if (output.ready.has(index)) output.ready.delete(index); else output.ready.add(index);
        output.revision += 1;
      }
    }
    const zones = zonesFor(viewers, duration, allowance, now);
    projection.update({ zones, outputs: outputs.map(output => ({ outputKey: output.outputKey, grid: output.grid,
      encodeSpeed: output.encodeSpeed, bytesPerSecond: output.bytesPerSecond, linkMbps: output.linkMbps,
      readyRevision: output.revision, ready: () => new Map([...output.ready].map(index => [index, 1])), target: output.target })) });
    // Ranges arrive for some of what is still to be worked out, in its order.
    const waiting = projection.unresolved();
    const reference = new Set(waiting.map(demand => `${demand.outputKey}:${demand.index}`));
    for (const output of outputs) {
      for (let index = 0; index + 1 < output.grid.length; index++) {
        if (output.known.has(index)) assert.ok(!reference.has(`${output.outputKey}:${index}`), "a known segment is not waiting");
      }
    }
    for (const demand of waiting.slice(0, 1 + Math.floor(random() * 40))) {
      const output = outputs.find(candidate => candidate.outputKey === demand.outputKey);
      output.known.set(demand.index, output.ranges[demand.index]);
      projection.setRanges(demand.outputKey, demand.index, output.ranges[demand.index]);
    }
    sameWindows(projection.windows(), referenceOf(zones, outputs), `seed ${seed}, step ${step}`);
  }
}

function referenceOf(zones, outputs) {
  return reference(zones, outputs);
}

test("the projection kept from map to map tells the torrent what the whole pass would", () => {
  for (let seed = 1; seed <= 200; seed++) scenario(seed, 40);
});

test("a map that only moved the time base reworks no segment and keeps the windows' order", () => {
  const grid = Array.from({ length: 201 }, (_, index) => index * 4);
  const ranges = grid.slice(0, -1).map((from, index) => [[0, 99], [1000 + index * 100, 1099 + index * 100]]);
  const projection = new PlaybackProjection();
  let now = 1_000_000;
  const output = () => ({ outputKey: "out", grid, encodeSpeed: 1.5, bytesPerSecond: 100_000, linkMbps: 10, readyRevision: 0,
    ready: () => new Map(), target: null });
  const zones = at => zonesFor([{ at, playing: true, pausedFor: 0, urgentReady: false }], 800, 8, now);
  projection.update({ zones: zones(100), outputs: [output()] });
  for (const demand of projection.unresolved()) projection.setRanges("out", demand.index, ranges[demand.index]);
  const first = projection.windows();
  // The clock moves and the position within the same second: the map says
  // nothing new of the film, only its time base moved.
  now += 250;
  projection.update({ zones: zones(100.25), outputs: [output()] });
  assert.equal(projection.lastUpdate.segments, 0, "no segment is worked out again");
  const second = projection.windows();
  assert.deepEqual(second.map(zone => [zone.byteStart, zone.byteEnd, zone.priority, zone.deadlineAt === undefined ? null : zone.deadlineAt - 250]),
    first.map(zone => [zone.byteStart, zone.byteEnd, zone.priority, zone.deadlineAt ?? null]), "every deadline moved with the base");
  // A second of playing on: only what a boundary crossed is worked out again.
  now += 1000;
  projection.update({ zones: zones(101.25), outputs: [output()] });
  assert.equal(projection.lastUpdate.whole, false);
  assert.ok(projection.lastUpdate.segments > 0 && projection.lastUpdate.segments <= 12,
    `a second of playing on reworks the segments a boundary crossed, not ${projection.lastUpdate.segments} of 200`);
});
