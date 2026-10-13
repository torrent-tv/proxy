import test from "node:test";
import assert from "node:assert/strict";
import { coalescedZones, deadlineOfMapZone, levelOfMapZone, priorityOfMapZone, withoutRepeatedZones } from "../../services/torrent/map-zones.js";
import { compareBands } from "../../services/torrent/download/bands.js";
import { Urgency } from "../../services/torrent/demand/Urgency.js";

// Arithmetic only; no torrent.
//
// A map names the same bytes in many zones (an AVI picture's declarations and
// indexes, once per segment: torrent-tv/meta#166). Each piece is fetched in the
// band of the best zone holding it, so only that zone may be sent.

function numbers(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The band each byte position is fetched in: the best of the zones that hold it. */
function bandsByByte(zones, now) {
  const bands = new Map();
  for (const zone of zones) {
    const band = { urgency: levelOfMapZone(zone), priority: priorityOfMapZone(zone), deadlineAt: deadlineOfMapZone(zone, now) };
    for (let at = zone.byteStart; at <= zone.byteEnd; at++) {
      const previous = bands.get(at);
      if (!previous || compareBands(band, previous) < 0) bands.set(at, band);
    }
  }
  return bands;
}

test("leaving out repeats of the same bytes changes no byte's band", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const random = numbers(seed);
    const now = 1_000_000;
    const shared = Array.from({ length: 4 }, () => {
      const start = Math.floor(random() * 200);
      return [start, start + Math.floor(random() * 20)];
    });
    const zones = [];
    for (let segment = 0; segment < 40; segment++) {
      const flags = { urgent: random() < 0.3, deferred: random() < 0.2, behind: random() < 0.1 };
      const priority = 1 + Math.floor(random() * 120);
      const timing = random() < 0.2 ? { withinSeconds: random() * 30 } : random() < 0.1 ? {} : { deadlineAt: now + random() * 30000 };
      const own = 300 + segment * 10;
      for (const [byteStart, byteEnd] of [...shared.filter(() => random() < 0.8), [own, own + 9]]) {
        zones.push({ byteStart, byteEnd, priority, ...flags, ...timing });
      }
    }
    const kept = withoutRepeatedZones(zones, now);
    assert.ok(kept.length < zones.length, `seed ${seed}: repeats are left out`);
    assert.equal(new Set(kept.map(zone => `${zone.byteStart}:${zone.byteEnd}`)).size, kept.length, `seed ${seed}: one zone per range`);
    assert.deepEqual(bandsByByte(kept, now), bandsByByte(zones, now), `seed ${seed}`);
  }
});

test("a zone's level is read from its own words before its number", () => {
  assert.equal(levelOfMapZone({ priority: 100, behind: true }), Urgency.BEHIND);
  assert.equal(levelOfMapZone({ priority: 100, behind: false, deferred: true }), Urgency.TAIL);
  assert.equal(levelOfMapZone({ priority: 1, behind: false, deferred: false, urgent: true }), Urgency.NEAR);
  assert.equal(levelOfMapZone({ priority: 100, behind: false, deferred: false, urgent: false }), Urgency.AHEAD);
  assert.equal(priorityOfMapZone({ priority: 250 }), 100);
  assert.equal(priorityOfMapZone({}), 1);
  assert.equal(deadlineOfMapZone({ withinSeconds: 2 }, 1000), 3000);
  assert.equal(deadlineOfMapZone({}, 1000), Number.POSITIVE_INFINITY);
});

test("what the torrent is told is one window per touching stretch of a band, each piece in the band it had", () => {
  // Three segments of one AVI output: each names the header (0-99) and index
  // (100-199) every segment reads, and its own media; then two farther segments
  // of a lower band, and a metadata read (torrent-tv/meta#178).
  const now = 1_000;
  const segment = (index, priority, start, deadlineAt) => [
    { byteStart: 0, byteEnd: 99, priority, urgent: priority === 100, deadlineAt },
    { byteStart: 100, byteEnd: 199, priority, urgent: priority === 100, deadlineAt },
    { byteStart: start, byteEnd: start + 999, priority, urgent: priority === 100, deadlineAt, outputKey: "picture", index }];
  const zones = [...segment(0, 100, 1000, 5_000), ...segment(1, 100, 2000, 9_000), ...segment(2, 99, 3000, 13_000),
    ...segment(3, 99, 4000, 17_000), ...segment(4, 99, 6000, 21_000),
    { byteStart: 9000, byteEnd: 9099, priority: 100, urgent: true, requestId: "read", downloadOnly: true, deadlineAt: 2_000 }];
  const packed = coalescedZones(zones, now);
  const windows = packed.map(zone => [zone.byteStart, zone.byteEnd, priorityOfMapZone(zone), levelOfMapZone(zone), zone.deadlineAt]);
  assert.deepEqual(windows, [
    [9000, 9099, 100, Urgency.NEAR, 2_000],
    // The header and index joined, and the first two segments' media joined.
    [0, 199, 100, Urgency.NEAR, 5_000],
    [1000, 2999, 100, Urgency.NEAR, 5_000],
    // The lower band: touching media joined, a gap left as it is.
    [3000, 4999, 99, Urgency.AHEAD, 13_000],
    [6000, 6999, 99, Urgency.AHEAD, 21_000]]);
  // Every piece is in the band the best zone holding it gave it.
  for (const zone of zones) {
    const window = packed.find(one => one.byteStart <= zone.byteStart && zone.byteEnd <= one.byteEnd);
    const best = zones.filter(other => other.byteStart === zone.byteStart && other.byteEnd === zone.byteEnd)
      .map(other => ({ urgency: levelOfMapZone(other), priority: priorityOfMapZone(other), deadlineAt: deadlineOfMapZone(other, now) }))
      .sort(compareBands)[0];
    assert.equal(priorityOfMapZone(window), best.priority);
    assert.equal(levelOfMapZone(window), best.urgency);
  }
});

/** Each range of a segment's zone as a zone of its own, with the segment's demand. */
function oneZonePerRange(zones) {
  return zones.flatMap(({ ranges, ...demand }) => ranges
    ? ranges.map(([byteStart, byteEnd]) => ({ ...demand, byteStart, byteEnd })) : [demand]);
}

/** A film's map: segments of a picture and a soundtrack, each with its demand and ranges, and a few metadata reads. */
function segmentMap(random) {
  const zones = [];
  for (const outputKey of ["picture", "sound"]) {
    for (let index = 0; index < 1 + Math.floor(random() * 30); index++) {
      const priority = 1 + Math.floor(random() * 5) * 20;
      const ranges = [[0, 49], [50, 99]];
      const own = 100 + Math.floor(random() * 60) * 10;
      if (random() < 0.9) ranges.push([own, own + Math.floor(random() * 3) * 10 + 9]);
      zones.push({ outputKey, index, priority, urgent: random() < 0.3 ? true : undefined, behind: random() < 0.1 ? true : undefined,
        deferred: random() < 0.1 ? true : undefined, deadlineAt: random() < 0.1 ? undefined : Math.floor(random() * 6) * 1000, ranges });
    }
  }
  for (let read = 0; read < Math.floor(random() * 3); read++) {
    const start = Math.floor(random() * 70) * 10;
    zones.push({ byteStart: start, byteEnd: start + 9, priority: 100, urgent: true, requestId: `read-${read}`, downloadOnly: true, deadlineAt: 500 });
  }
  return zones;
}

test("a segment's zone, its demand stated once for all its ranges, is packed as its ranges would be one by one", () => {
  // One zone per segment instead of one per range (r26, torrent-tv/meta#178):
  // the torrent must be told the same windows.
  for (let seed = 1; seed <= 500; seed++) {
    const zones = segmentMap(numbers(seed));
    assert.deepEqual(coalescedZones(zones, 0), coalescedZones(oneZonePerRange(zones), 0), `seed ${seed}`);
  }
});

test("a repeat of the same bytes keeps the best band and the first of equals, read by number", () => {
  // The rule as it was written with a key made of the two numbers.
  const byKey = (zones, now) => {
    const best = new Map();
    zones.forEach((zone, index) => {
      const key = `${zone.byteStart}:${zone.byteEnd}`;
      const band = { urgency: levelOfMapZone(zone), priority: priorityOfMapZone(zone), deadlineAt: deadlineOfMapZone(zone, now) };
      const kept = best.get(key);
      if (!kept || compareBands(band, kept.band) < 0) best.set(key, { index, band });
    });
    return zones.filter((zone, index) => best.get(`${zone.byteStart}:${zone.byteEnd}`).index === index);
  };
  for (let seed = 1; seed <= 500; seed++) {
    const zones = oneZonePerRange(segmentMap(numbers(seed)));
    assert.deepEqual(withoutRepeatedZones(zones, 0), byKey(zones, 0), `seed ${seed}`);
  }
});

test("windows are wanted by the segments' current deadlines, whatever an earlier pass said", () => {
  // The ranges a segment reads are kept from pass to pass and its demand is
  // this pass's: a pass in which the soundtrack is wanted before the picture
  // says so, though the ranges are the same lists as before (review of
  // torrent-tv/meta#178).
  const picture = [[0, 99], [1000, 1999]];
  const sound = [[0, 99], [5000, 5499]];
  const pass = (pictureDeadline, soundDeadline) => coalescedZones([
    { outputKey: "picture", index: 4, priority: 90, deadlineAt: pictureDeadline, ranges: picture },
    { outputKey: "sound", index: 4, priority: 90, deadlineAt: soundDeadline, ranges: sound }], 0);
  const deadlines = packed => packed.map(zone => [zone.byteStart, zone.deadlineAt]);
  assert.deepEqual(deadlines(pass(100, 150)), [[0, 100], [1000, 100], [5000, 150]]);
  assert.deepEqual(deadlines(pass(500, 250)), [[0, 250], [1000, 500], [5000, 250]]);
});
