import test from "node:test";
import assert from "node:assert/strict";
import { deadlineOfMapZone, levelOfMapZone, priorityOfMapZone, withoutRepeatedZones } from "../../services/torrent/map-zones.js";
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
