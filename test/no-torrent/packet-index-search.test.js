import test from "node:test";
import assert from "node:assert/strict";
import { PacketIndex } from "../../services/media/container/PacketIndex.js";
import { PacketRecords } from "../../services/media/container/PacketRecords.js";

// No file, no torrent: packet facts only.
//
// An interval of records in time order is found by search rather than by
// reading every record (torrent-tv/meta#166: a two-hour soundtrack read in full
// for each of two thousand intervals stopped the proxy's main thread). The
// search must choose exactly what the rule chooses over every record.

/** A generator of the same numbers on every run. */
function numbers(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The packets the rule selects, read from every record: those that start before `to` and start at `from` or reach past it. */
function selectedByRule(packets, from, to) {
  return packets.map((packet, index) => ({ packet, index }))
    .filter(({ packet }) => packet.pts < to && (packet.pts >= from || packet.pts + packet.duration > from))
    .map(({ index }) => index);
}

test("an audio interval is found by search and holds exactly the packets the rule selects", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const random = numbers(seed);
    const index = new PacketIndex();
    index.declareTrack(1, { type: "audio", codecId: "ac3" });
    const packets = [];
    let pts = random() * 2;
    for (let at = 0; at < 400; at++) {
      // Gaps, equal times, and now and then a packet far longer than the rest.
      const duration = random() < 0.03 ? 1 + random() * 5 : random() * 0.05;
      packets.push({ pts, duration, keyframe: true, ranges: [[at * 10, at * 10 + 9]] });
      index.append(1, packets.at(-1));
      pts += random() < 0.1 ? 0 : random() * 0.06;
    }
    index.complete(1);
    for (let probe = 0; probe < 60; probe++) {
      const from = random() * pts;
      const to = from + 0.01 + random() * 3;
      const expected = selectedByRule(packets, from, to);
      const input = index.inputFor({ trackId: 1, from, to, mode: "copy" });
      if (!expected.length) {
        assert.notEqual(input.kind, "result", `seed ${seed}: [${from}, ${to}) holds nothing`);
        continue;
      }
      assert.equal(input.kind, "result", `seed ${seed}: [${from}, ${to})`);
      assert.deepEqual(input.packets.map(packet => packet.ranges[0][0] / 10),
        Array.from({ length: expected.at(-1) - expected[0] + 1 }, (_, offset) => expected[0] + offset),
        `seed ${seed}: [${from}, ${to})`);
    }
  }
});

test("records whose times go back use block bounds and retain exact interval inputs", () => {
  const records = new PacketRecords();
  for (const pts of [0, 1, 2]) records.push({ pts, duration: 1, ranges: [[0, 0]] });
  assert.equal(records.ptsAscending, true);
  assert.equal(records.firstAtOrAfter(1.5), 2);
  records.push({ pts: 1.5, duration: 4, ranges: [[0, 0]] });
  assert.equal(records.ptsAscending, false);
  assert.throws(() => records.firstAtOrAfter(1), /cannot be searched/);
  assert.equal(records.longestDuration, 4);
  // Removing the record that went back restores the order of what is left.
  records.length = 3;
  assert.equal(records.ptsAscending, true);
  records.push({ pts: 3, duration: 1, ranges: [[0, 0]] });
  assert.equal(records.ptsAscending, true);
  records.setDuration(0, 9);
  assert.equal(records.longestDuration, 9, "a longer duration set later widens the search");

  const index = new PacketIndex();
  index.declareTrack(1, { type: "audio", codecId: "ac3" });
  for (const pts of [0, 2, 1, 3]) index.append(1, { pts, duration: 0.5, keyframe: true, ranges: [[pts * 10, pts * 10 + 9]] });
  index.complete(1);
  const input = index.inputFor({ trackId: 1, from: 0.9, to: 1.6, mode: "copy" });
  assert.deepEqual(input.packets.map(packet => packet.pts), [1], "reordered records retain decode order");
});

test("time bounds remain a safe superset after duration changes and truncation", () => {
  const records = new PacketRecords();
  for (let group = 0; group < 1000; group++) {
    for (const offset of [0, 3, 1, 2]) {
      records.push({ pts: group * 4 + offset, duration: 0.5, ranges: [[records.length, records.length]] });
    }
  }
  records.setDuration(4, 5);
  const actual = [];
  records.forEachInTimeRange(3.5, 8, index => actual.push(index));
  const expected = Array.from({ length: records.length }, (_, index) => index)
    .filter(index => records.ptsAt(index) < 8 &&
      (records.ptsAt(index) >= 3.5 || records.ptsAt(index) + records.durationAt(index) > 3.5));
  assert.deepEqual(actual, expected);
  assert.equal(records.someAtTime(7, index => records.ptsAt(index) === 7), true);

  records.length = 2500;
  const afterTruncate = [];
  records.forEachInTimeRange(2490, 2500, index => afterTruncate.push(index));
  const afterExpected = Array.from({ length: records.length }, (_, index) => index)
    .filter(index => records.ptsAt(index) < 2500 &&
      (records.ptsAt(index) >= 2490 || records.ptsAt(index) + records.durationAt(index) > 2490));
  assert.deepEqual(afterTruncate, afterExpected);
  const removed = [];
  records.forEachInTimeRange(2500, 2504, index => removed.push(index));
  assert.deepEqual(removed, []);
});

test("a narrow interval reads fewer timestamp entries than the reordered table contains", () => {
  const records = new PacketRecords();
  const order = [0, 3, 1, 2];
  for (let group = 0; group < 3000; group++) {
    for (const offset of order) {
      records.push({ pts: (group * 4 + offset) / 24, duration: 1 / 24, keyframe: true,
        ranges: [[records.length, records.length]] });
    }
  }
  const index = new PacketIndex();
  index.declareTrack(1, { type: "audio" });
  index.sharePackets(1, records);
  index.complete(1);
  index.boundsOf(1);
  const ordered = Array.from({ length: records.length }, (_, position) => records.ptsAt(position));
  let reads = 0;
  const ptsAt = records.ptsAt.bind(records);
  records.ptsAt = position => { reads++; return ptsAt(position); };

  const from = 6000 / 24, to = 6010 / 24;
  const result = index.inputFor({ trackId: 1, from, to, mode: "copy" });
  const selected = ordered.flatMap((pts, position) =>
    pts < to && (pts >= from || pts + records.durationAt(position) > from) ? [position] : []);
  assert.equal(result.kind, "result");
  assert.deepEqual(result.packets.map(packet => packet.pts),
    ordered.slice(selected[0], selected.at(-1) + 1));
  assert.ok(reads < records.length, `${reads} timestamp reads for ${records.length} records`);
});
