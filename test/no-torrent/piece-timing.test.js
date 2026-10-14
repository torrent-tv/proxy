/**
 * @file When each piece was asked of the swarm, and how long its blocks were
 * in flight (torrent-tv/meta#178).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PieceTimings, describePieceTiming } from "../../services/torrent/piece-timing.js";

test("a piece asked early whose last block was held by a slow peer says so", () => {
  const timings = new PieceTimings();
  timings.asked(1, 0, "a", 1_000);
  timings.asked(1, 16_384, "b", 1_000);
  timings.arrived(1, 0, "a", 1_400);
  timings.asked(1, 16_384, "c", 9_000); // the same block asked again of another peer
  timings.arrived(1, 16_384, "c", 14_000);
  const timing = timings.verified(1, 14_010);
  assert.deepEqual(timing, { askedAgoMs: 13_010, asks: 3, peers: 3, slowestMs: 13_000, slowestPeer: "c", lastInFlightMs: 13_000, lastPeer: "c",
    askedAgain: 1, arrivedTwice: 0 });
  assert.match(describePieceTiming(timing), /1 block\(s\) asked again, 0 arrived twice/);
  assert.match(describePieceTiming(timing), /first block asked 13\.0s before, 3 block ask\(s\) to 3 peer\(s\), slowest block 13\.0s in flight from c/);
});

test("a piece asked late arrives quickly once asked", () => {
  const timings = new PieceTimings();
  timings.asked(2, 0, "a", 20_000);
  timings.arrived(2, 0, "a", 20_300);
  assert.equal(timings.verified(2, 20_310).askedAgoMs, 310);
});

test("a block not asked through the record, or a piece never asked, says nothing; a verified piece is forgotten", () => {
  const timings = new PieceTimings();
  timings.arrived(3, 0, "a", 5);
  assert.equal(timings.verified(3, 6), null);
  timings.asked(4, 0, "a", 1);
  timings.verified(4, 2);
  assert.equal(timings.verified(4, 3), null);
  assert.equal(describePieceTiming(null), "");
});

test("a copy of a block that arrives after the first is counted, and does not move the block's time", () => {
  const timings = new PieceTimings();
  timings.asked(5, 0, "slow", 0);
  timings.asked(5, 0, "fast", 3_000);
  timings.arrived(5, 0, "fast", 3_200);
  timings.arrived(5, 0, "slow", 9_000);
  const timing = timings.verified(5, 3_210);
  assert.equal(timing.arrivedTwice, 1);
  assert.equal(timing.lastInFlightMs, 3_200, "in flight from the first ask to the first arrival");
  assert.equal(timing.lastPeer, "fast");
});
