/**
 * @file Uploading generously at the two moments a viewer is waiting.
 *
 * BitTorrent peers serve those who serve them: each re-ranks its takers about
 * every 10 s and opens a few slots to whoever uploaded most, plus one at
 * random. Uploading a token 8-50 KB/s means being picked at random, one slot
 * per cycle. Measured 2026-08-04 on a session with 96 peers already connected:
 * 64 KB/s after 2 s, 1.6 MB/s after 4 s, 4.8 MB/s after 8 s — and the 16 MB the
 * codec probe needs took 8.36 s of the 11.46 s before playback began.
 *
 * The reciprocity boost could not help: it waits for the download to be all but
 * dead (below 200 KB/s) with peers visibly choking us, which a ramp is not. In
 * that session it first moved the limit 13.3 s after the torrent was added, and
 * reached the generous rate at 43.7 s — both after the wait they were meant to
 * shorten.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { decideUploadLimit } from "../services/torrent-pool.js";

const NOW = 1_000_000;
const healthy = (extra = {}) => ({
  name: "film.mkv",
  wires: [{ amInterested: true, peerChoking: false }],
  downloadSpeed: 5 * 1024 * 1024,
  done: false,
  ...extra
});

test("a torrent in a hurry gets the generous rate even while downloading well", () => {
  const decision = decideUploadLimit([healthy({ hurryUntil: NOW + 10_000 })], { now: NOW });
  assert.equal(decision.bytesPerSec, 512 * 1024);
  assert.match(decision.reason, /in a hurry/);
});

test("the hurry expires on its own", () => {
  const decision = decideUploadLimit([healthy({ hurryUntil: NOW - 1 })], { now: NOW });
  assert.equal(decision.bytesPerSec, 50 * 1024, "back to the token upload once the rush is over");
});

test("a finished torrent is never in a hurry", () => {
  // Nothing left to download, so there is nothing to buy with the upload — and
  // seeding is what we deliberately avoid.
  const decision = decideUploadLimit([healthy({ hurryUntil: NOW + 10_000, done: true })], { now: NOW });
  assert.equal(decision.bytesPerSec, 50 * 1024);
});

test("nothing being watched still means near-silence", () => {
  assert.equal(decideUploadLimit([], { now: NOW }).bytesPerSec, 8 * 1024);
});

test("the reciprocity boost still works when no hurry is on", () => {
  const starving = {
    name: "film.mkv",
    wires: [
      { amInterested: true, peerChoking: true },
      { amInterested: true, peerChoking: true }
    ],
    downloadSpeed: 10 * 1024,
    done: false
  };
  const decision = decideUploadLimit([starving], { now: NOW });
  assert.equal(decision.bytesPerSec, 512 * 1024);
  assert.match(decision.reason, /earn unchoke/);
});
