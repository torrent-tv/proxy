/**
 * @file One infohash, two sources: what happens when the second add is refused.
 *
 * The same film arrives as a magnet and as a `.torrent`. WebTorrent refuses the
 * second add — one infohash, one torrent — and the pool then has to decide what
 * to hand back. Adopting the one already there is right when it is ready, and
 * wrong when it is not: a magnet whose swarm has not answered has no file list,
 * so everything bound to it is answered 404.
 *
 * Measured 2026-08-15 on the addon host: a magnet with no reachable trackers
 * was added first and never became ready; the same film's own `.torrent`, which
 * carries the file list, the piece hashes and the trackers, then joined that
 * empty torrent instead of replacing it. `/stream` answered 404, the encoder
 * died on its first read, and the film stayed unplayable until the proxy was
 * restarted — one bad magnet poisoning every later attempt at that infohash.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { duplicateAddDecision } from "../services/torrent-pool.js";

test("a ready torrent is adopted, whatever the new source carries", () => {
  assert.equal(
    duplicateAddDecision({ existingIsReady: true, incomingHasMetadata: true }),
    "adopt",
    "one swarm per infohash: a second copy would download the same pieces twice"
  );
  assert.equal(
    duplicateAddDecision({ existingIsReady: true, incomingHasMetadata: false }),
    "adopt"
  );
});

test("an unready torrent is replaced when this add brings the metadata", () => {
  assert.equal(
    duplicateAddDecision({ existingIsReady: false, incomingHasMetadata: true }),
    "replace",
    "the .torrent holds what the swarm was being asked for; waiting for it is waiting for nothing"
  );
});

test("two magnets wait, because neither has anything the other lacks", () => {
  assert.equal(
    duplicateAddDecision({ existingIsReady: false, incomingHasMetadata: false }),
    "wait",
    "replacing here would only restart the same search, and the caller's own bound answers"
  );
});
