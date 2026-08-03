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
