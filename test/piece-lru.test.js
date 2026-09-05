/**
 * @file Recency and pinning for resident pieces.
 *
 * The pinning cases matter more than the ordering ones: proxy 2.9.71 removed a
 * torrent's data while a reader was mid-read, and every later read hung. Here
 * that is meant to be impossible by construction, so it is worth stating in
 * tests rather than trusting to eviction order.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PieceLru } from "../services/piece-store/piece-lru.js";

test("evicts the least recently used piece", () => {
  const lru = new PieceLru(3);
  lru.touch(1);
  lru.touch(2);
  lru.touch(3);

  assert.equal(lru.evictionCandidate(), 1);
});

test("using a piece again moves it out of the firing line", () => {
  const lru = new PieceLru(3);
  lru.touch(1);
  lru.touch(2);
  lru.touch(3);
  lru.touch(1);

  assert.equal(lru.evictionCandidate(), 2);
});

test("a pinned piece is never offered for eviction", () => {
  const lru = new PieceLru(3);
  lru.touch(1);
  lru.touch(2);
  lru.touch(3);
  lru.pin(1);

  assert.equal(lru.evictionCandidate(), 2, "the pinned piece was offered up");
});

test("pins nest, so one reader leaving does not expose the piece", () => {
  const lru = new PieceLru(2);
  lru.touch(1);
  lru.touch(2);

  // Two sessions reading the same piece — the union-window case.
  lru.pin(1);
  lru.pin(1);
  lru.unpin(1);

  assert.ok(lru.isPinned(1), "the piece stopped being held while a reader still had it");
  assert.equal(lru.evictionCandidate(), 2);

  lru.unpin(1);
  assert.equal(lru.isPinned(1), false);
});

test("reports no candidate rather than evicting a piece in use", () => {
  const lru = new PieceLru(2);
  lru.touch(1);
  lru.touch(2);
  lru.pin(1);
  lru.pin(2);

  assert.equal(
    lru.evictionCandidate(),
    null,
    "with every piece held, the caller must wait — not have memory taken from under it"
  );
});

test("unpinning something that was never pinned is harmless", () => {
  const lru = new PieceLru(2);
  lru.touch(1);
  lru.unpin(1);
  lru.unpin(1);

  assert.equal(lru.isPinned(1), false);
  assert.equal(lru.evictionCandidate(), 1);
});

test("removal takes a piece out of the ordering", () => {
  const lru = new PieceLru(3);
  lru.touch(1);
  lru.touch(2);
  lru.remove(1);

  assert.equal(lru.has(1), false);
  assert.equal(lru.evictionCandidate(), 2);
  assert.equal(lru.size, 1);
});

test("fullness follows capacity", () => {
  const lru = new PieceLru(2);
  assert.equal(lru.isFull(), false);
  lru.touch(1);
  lru.touch(2);
  assert.equal(lru.isFull(), true);
  lru.remove(1);
  assert.equal(lru.isFull(), false);
});

test("a nonsensical capacity is refused at construction", () => {
  assert.throws(() => new PieceLru(0), /positive integer/);
  assert.throws(() => new PieceLru(-1), /positive integer/);
  assert.throws(() => new PieceLru(1.5), /positive integer/);
});

test("a declared window is the last thing evicted, not the first", () => {
  const lru = new PieceLru(4);
  // Oldest first: 10 was touched longest ago, so plain recency would take it.
  for (const index of [10, 11, 12, 13]) {
    lru.touch(index);
  }
  lru.protect("reader-a", 10, 11);

  assert.equal(
    lru.evictionCandidate(),
    12,
    "recency alone would have taken 10; the reader said it is about to read it"
  );
});

test("protection yields when everything resident is protected", () => {
  // The case the store cannot survive if protection were absolute: at its
  // smallest budget only two pieces are resident, and both belong to a window.
  const lru = new PieceLru(2);
  lru.touch(4);
  lru.touch(5);
  lru.protect("reader-a", 4, 5);

  assert.equal(lru.evictionCandidate(), 4, "a full store must still be able to admit a piece");
});

test("a pin is never overruled, protected or not", () => {
  const lru = new PieceLru(2);
  lru.touch(7);
  lru.touch(8);
  lru.pin(7);
  lru.protect("reader-a", 7, 8);

  assert.equal(lru.evictionCandidate(), 8, "the piece being read now must stay");
  lru.pin(8);
  assert.equal(lru.evictionCandidate(), null, "nothing may be taken from under a reader");
});

test("windows of several readers add up, and leaving takes only your own", () => {
  const lru = new PieceLru(6);
  for (const index of [20, 21, 22, 23, 24, 25]) {
    lru.touch(index);
  }
  lru.protect("reader-a", 20, 21);
  lru.protect("reader-b", 22, 23);
  assert.equal(lru.evictionCandidate(), 24);

  lru.unprotect("reader-b");
  assert.equal(lru.evictionCandidate(), 22, "b's window is free once b has gone");
  assert.equal(lru.protectedCount, 1);
});

test("a reader moving its window replaces it instead of accumulating", () => {
  const lru = new PieceLru(4);
  for (const index of [30, 31, 32, 33]) {
    lru.touch(index);
  }
  lru.protect("reader-a", 30, 31);
  lru.protect("reader-a", 32, 33);

  assert.equal(lru.evictionCandidate(), 30, "the pieces already read are free again");
  assert.equal(lru.protectedCount, 1);
});

test("the capacity follows the store's live allowance", () => {
  const lru = new PieceLru(4);
  for (const index of [40, 41]) {
    lru.touch(index);
  }
  assert.equal(lru.isFull(), false, "two of four is not full");

  // The store's allowance moves with the machine's free memory, and the LRU is
  // told. Before this it kept the capacity it was built with for ever, so
  // `isFull` answered against a number that had stopped being the limit.
  lru.setCapacity(2);
  assert.equal(lru.capacity, 2);
  assert.equal(lru.isFull(), true, "two of two is full");

  lru.setCapacity(0);
  assert.equal(lru.capacity, 2, "a capacity below one is refused, not obeyed");
});

test("the demand is the union of the readers' windows, not their sum", () => {
  const lru = new PieceLru(88);
  // Two readers of one file — picture and sound — overlap by construction.
  // Summing them would say the store is short when it is not.
  lru.protect("video", 100, 149);
  lru.protect("audio", 130, 179);

  const demand = lru.demand();
  assert.equal(demand.readers, 2);
  assert.equal(demand.unionPieces, 80, "100..179 is eighty pieces, not a hundred");
  assert.equal(demand.widestPieces, 50);
  assert.equal(demand.capacity, 88);

  lru.protect("second-viewer", 900, 979);
  assert.equal(lru.demand().unionPieces, 160, "windows that do not touch add up");

  lru.unprotect("second-viewer");
  lru.unprotect("audio");
  lru.unprotect("video");
  assert.deepEqual(
    lru.demand(),
    { readers: 0, unionPieces: 0, widestPieces: 0, capacity: 88 },
    "no reader asking for anything is not the same as asking for one piece"
  );
});

test("an eviction says whether it had to take a piece a reader declared", () => {
  const lru = new PieceLru(3);
  lru.touch(10);
  lru.touch(11);
  lru.touch(12);
  lru.protect("video", 11, 12);

  const spare = lru.evictionChoice();
  assert.equal(spare.index, 10, "the piece outside every window goes first");
  assert.equal(spare.protectionYielded, false);
  assert.equal(spare.distance, 1, "one piece away from the window at 11");

  // Nothing spare left: both survivors are inside the declared window.
  lru.remove(10);
  const forced = lru.evictionChoice();
  assert.equal(forced.index, 11);
  assert.equal(forced.protectionYielded, true, "the store is holding less than it is asked to");
  assert.equal(forced.distance, 0, "inside a window");

  assert.equal(lru.evictionCandidate(), 11, "the older answer is the same choice");
});

test("with nothing declared there is no distance to report", () => {
  const lru = new PieceLru(2);
  lru.touch(7);
  const choice = lru.evictionChoice();
  assert.equal(choice.index, 7);
  assert.equal(choice.distance, -1, "-1 is absence, and 0 would read as inside a window");

  lru.pin(7);
  assert.deepEqual(
    lru.evictionChoice(),
    { index: null, protectionYielded: false, distance: -1 },
    "a pinned piece is never a candidate, and says so without a distance"
  );
});

test("the least wanted piece goes, however recently it was touched", () => {
  // Field 2026-09-05: fifteen reads declared fifteen windows on a store holding
  // sixteen pieces, and with everything resident declared, eviction fell back
  // to recency — 392 of 780 evictions took a piece a reader had said it wanted.
  // Recency cannot separate them; the priority map's number can.
  const lru = new PieceLru(3);
  for (const index of [10, 20, 30]) {
    lru.touch(index);
  }
  // 10 is the stalest, and the map wants it most: it is where a viewer is.
  lru.protect("map:blocked", 10, 10, 0);
  lru.protect("map:ahead", 20, 20, 2);
  lru.protect("map:tail", 30, 30, 3);

  const choice = lru.evictionChoice();
  assert.equal(choice.index, 30, "eviction took the piece the map wants most");
  assert.equal(choice.protectionYielded, true, "every resident piece was wanted, and it said so");
});

test("recency decides only between pieces the map wants equally", () => {
  const lru = new PieceLru(3);
  for (const index of [10, 20, 30]) {
    lru.touch(index);
  }
  lru.protect("map:blocked", 10, 10, 0);
  lru.protect("map:ahead", 20, 30, 2);

  // 20 and 30 sit in one zone, so the stalest of the two goes.
  assert.equal(lru.evictionCandidate(), 20);
  lru.touch(20);
  assert.equal(lru.evictionCandidate(), 30);
});

test("a piece no zone covers goes before any piece a zone covers", () => {
  const lru = new PieceLru(4);
  for (const index of [10, 20, 30, 40]) {
    lru.touch(index);
  }
  // Only the last-touched piece is outside every zone — and it still goes
  // first, because nobody has said they will read it.
  lru.protect("map:tail", 10, 30, 4);

  const choice = lru.evictionChoice();
  assert.equal(choice.index, 40);
  assert.equal(choice.protectionYielded, false, "nothing the map wanted was taken");
});

test("a claimant that states no number cannot displace one that did", () => {
  const lru = new PieceLru(2);
  lru.touch(10);
  lru.touch(20);
  lru.protect("map:tail", 10, 10, 4);
  lru.protect("nameless", 20, 20);

  assert.equal(
    lru.evictionCandidate(),
    20,
    "a range with no stated number was treated as more wanted than the map's own"
  );
});
