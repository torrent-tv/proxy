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
import { decideUploadLimit, torrentsForUploadPolicy } from "../services/torrent-pool.js";
import { demandFor, forgetTorrent } from "../services/download/registry.js";
import { Urgency } from "../services/demand/index.js";

/**
 * A torrent whose metadata has arrived and which nothing is wanted of.
 *
 * The files matter: a torrent with no list of files cannot be stated about at
 * all, and is wanted for that reason alone — it is still being fetched.
 *
 * @param {string} name
 * @returns {object}
 */
function quiet(name) {
  return { name, files: [{ offset: 0, length: 1_000, name }] };
}

/**
 * The same, with something stated for it — which is what "somebody wants this"
 * means now that nothing counts readers.
 *
 * @param {string} name
 * @returns {object}
 */
function wanted(name) {
  const torrent = quiet(name);
  demandFor(torrent).register.state({
    claimant: "priority-map:0:0",
    fileIndex: 0,
    byteStart: 0,
    byteEnd: 999,
    urgency: Urgency.NEAR
  });
  return torrent;
}

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

test("a torrent nothing is wanted of still reaches the policy while it is in a hurry", () => {
  // The moment that matters: a torrent has just been added and its head and
  // tail are being fetched for the codec probe. Nothing is stated for it yet,
  // and the selection only ever kept torrents something was — which is where
  // the gap was.
  const hurrying = quiet("film.mkv");
  hurrying.hurryUntil = NOW + 20_000;
  const idle = quiet("other.mkv");
  const watched = wanted("watched.mkv");
  try {
    assert.deepEqual(
      torrentsForUploadPolicy([hurrying, idle], NOW),
      [hurrying],
      "a torrent nothing is stated for yet was ignored"
    );

    assert.deepEqual(
      torrentsForUploadPolicy([{ ...hurrying, hurryUntil: NOW - 1 }, idle], NOW),
      [],
      "and stops counting once the rush is over"
    );

    assert.deepEqual(
      torrentsForUploadPolicy([watched], NOW),
      [watched],
      "a torrent somebody wants something of still counts, hurry or not"
    );
  } finally {
    forgetTorrent(hurrying);
    forgetTorrent(idle);
    forgetTorrent(watched);
  }
});

test("a torrent nobody is reading is not treated as starving", () => {
  // The encoder is suspended once it is far enough ahead, and while it is
  // suspended nothing is requested — so the download reads zero without anyone
  // waiting. Measured before this guard: four cycles of 512 -> 50 KB/s in three
  // minutes, every one of them reported as `earn unchoke ... down=0KB/s`.
  const idleButChoked = {
    name: "film.mkv",
    isWanted: false,
    wires: [
      { amInterested: true, peerChoking: true },
      { amInterested: true, peerChoking: true }
    ],
    downloadSpeed: 0,
    done: false
  };
  assert.equal(decideUploadLimit([idleButChoked], { now: NOW }).bytesPerSec, 50 * 1024);

  const waiting = { ...idleButChoked, isWanted: true };
  assert.equal(
    decideUploadLimit([waiting], { now: NOW }).bytesPerSec,
    512 * 1024,
    "a reader that IS waiting must still earn unchoke slots"
  );
});

test("a torrent short of nothing is not worth uploading for", () => {
  // Field 2026-09-11: the file being watched was complete, its windows all
  // present, and the proxy went on offering 512 KB/s to 596 peers for
  // forty-eight minutes — reading a 4 MB piece off the disk for every 16 KB it
  // sent. Upload is bought with reciprocity, and reciprocity is only worth
  // buying while somebody is still short of bytes.
  const complete = {
    name: "watched to the end",
    isWanted: true,
    hasUnmetDemand: false,
    done: false,
    downloadSpeed: 0,
    wires: [
      { amInterested: true, peerChoking: true },
      { amInterested: true, peerChoking: true },
      { amInterested: true, peerChoking: true }
    ]
  };
  const decided = decideUploadLimit([complete]);
  assert.equal(decided.bytesPerSec, 8 * 1024, "a complete torrent is given the idle floor");
  assert.match(decided.reason, /buys nothing/);

  // And a torrent that IS short of something still earns its unchoke.
  const short = { ...complete, hasUnmetDemand: true };
  assert.ok(decideUploadLimit([short]).bytesPerSec > 8 * 1024, "a starving torrent still buys reciprocity");
});
