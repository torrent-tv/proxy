/**
 * @file What the download is told when the priority map changes.
 *
 * The map states seconds of film against a number. This is the one place those
 * seconds become bytes, and the one place the map's own scale — as many bands
 * as the film needs — is fitted onto the five levels the register has. Both
 * were written on 2026-09-05 to replace the windows the reads themselves used
 * to declare: fifteen reads on one file were fifteen windows on a piece store
 * holding sixteen pieces, and half of all evictions then took a piece a reader
 * had said it wanted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { TorrentPool } from "../services/torrent-pool.js";
import { demandFor, forgetTorrent } from "../services/download/registry.js";
import { Urgency } from "../services/demand/index.js";
import { mapForViewer } from "../services/priority/PriorityMap.js";

/** A torrent that is nothing but one file of a known length. */
function torrentOf({ length = 1_000_000, offset = 0 } = {}) {
  return {
    infoHash: `hash-${Math.random().toString(36).slice(2)}`,
    pieceLength: 1024,
    files: [{ offset, length, name: "film.mkv" }],
    _selections: { _items: [] },
    _select() {},
    _deselect() {},
    critical() {}
  };
}

/** The pool's method under test, called without building a pool. */
const applyPriorityMap = TorrentPool.prototype.applyPriorityMap;

test("seconds of film become bytes of the file", () => {
  const torrent = torrentOf({ length: 1000 });
  try {
    applyPriorityMap.call(null, torrent, 0, [
      { from: 0, to: 100, priority: 5 },
      { from: 100, to: 200, priority: 3 }
    ], 200);

    const { register } = demandFor(torrent);
    const stated = register.windows().filter((one) => String(one.claimant).startsWith("priority-map:"));
    assert.equal(stated.length, 2);
    const first = stated.find((one) => one.byteStart === 0);
    assert.equal(first.byteEnd, 499, "half the film is half the file");
    const second = stated.find((one) => one.byteStart === 500);
    assert.equal(second.byteEnd, 999, "the last byte of the file, not one past it");
  } finally {
    forgetTorrent(torrent);
  }
});

test("a zone is stated at the level it means, not at the level of its position", () => {
  const torrent = torrentOf();
  try {
    // A viewer 300 s into a 3000 s film: one band behind them that nobody is
    // approaching, then bands of decreasing urgency ahead.
    const zones = mapForViewer({
      atSeconds: 300,
      durationSeconds: 3000,
      allowanceSeconds: 10
    });
    assert.ok(zones.length > 5, "the map should be finer than the register's levels");

    applyPriorityMap.call(null, torrent, 0, zones, 3000);
    const { register } = demandFor(torrent);
    const stated = register.windows().filter((one) => String(one.claimant).startsWith("priority-map:"));

    const near = stated.filter((one) => one.urgency === Urgency.NEAR);
    assert.equal(near.length, 1, "exactly one band is where the viewer is");
    assert.equal(near[0].byteStart, Math.floor((300 / 3000) * 1_000_000));

    const behind = stated.filter((one) => one.urgency === Urgency.BEHIND);
    assert.equal(behind.length, 1, "what nobody is approaching is the one thing wanted last");
    assert.equal(behind[0].byteStart, 0, "and it is the stretch behind the viewer");

    assert.ok(
      stated.some((one) => one.urgency === Urgency.AHEAD),
      "the lead being built was stated at no level of its own"
    );
    assert.ok(
      stated.every((one) => one.urgency !== Urgency.BLOCKED),
      "the map claimed BLOCKED, which only a reader stopped on those bytes may say"
    );
  } finally {
    forgetTorrent(torrent);
  }
});

test("a viewer who has stopped the picture makes the whole film wanted last", () => {
  const torrent = torrentOf();
  try {
    const zones = mapForViewer({
      atSeconds: 300,
      durationSeconds: 3000,
      allowanceSeconds: 10,
      playing: false
    });
    applyPriorityMap.call(null, torrent, 0, zones, 3000);

    const { register } = demandFor(torrent);
    const stated = register.windows().filter((one) => String(one.claimant).startsWith("priority-map:"));
    assert.equal(stated.length, 1, "a viewer going nowhere makes one band of the whole film");
    // Wanted last ABSOLUTELY, not relative to this film's own map. The two
    // speculative levels are withheld across every torrent at once while
    // anything urgent is missing anywhere, so this has to lose to a film
    // somebody is actually watching — and judged against itself alone it would
    // be the most urgent thing there is.
    assert.equal(stated[0].urgency, Urgency.BEHIND);
  } finally {
    forgetTorrent(torrent);
  }
});

test("a map with fewer bands than the last one leaves nothing stated behind", () => {
  const torrent = torrentOf();
  try {
    applyPriorityMap.call(null, torrent, 0, [
      { from: 0, to: 100, priority: 5 },
      { from: 100, to: 200, priority: 4 },
      { from: 200, to: 300, priority: 3 }
    ], 300);
    const { register } = demandFor(torrent);
    assert.equal(
      register.windows().filter((one) => String(one.claimant).startsWith("priority-map:")).length,
      3
    );

    applyPriorityMap.call(null, torrent, 0, [{ from: 0, to: 300, priority: 5 }], 300);
    assert.equal(
      register.windows().filter((one) => String(one.claimant).startsWith("priority-map:")).length,
      1,
      "bands the map no longer has went on being asked for"
    );
  } finally {
    forgetTorrent(torrent);
  }
});

test("a file of unknown length or duration is not guessed at", () => {
  const torrent = torrentOf();
  try {
    applyPriorityMap.call(null, torrent, 0, [{ from: 0, to: 100, priority: 5 }], 0);
    applyPriorityMap.call(null, torrent, 7, [{ from: 0, to: 100, priority: 5 }], 300);
    const { register } = demandFor(torrent);
    assert.equal(
      register.windows().filter((one) => String(one.claimant).startsWith("priority-map:")).length,
      0
    );
  } finally {
    forgetTorrent(torrent);
  }
});
