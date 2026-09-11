/**
 * @file A proxy that needs nothing from a swarm is not in that swarm.
 *
 * WebTorrent enforces `maxConns` only on peers it dials (`_drain`), while
 * `_addIncomingPeer` checks that the torrent is neither destroyed nor paused
 * and registers the peer. A proxy with its port mapped is reachable, so
 * connections arrive and are never turned away — field 2026-09-11: 249
 * connected at the start of one viewing, 596 at the end, 15 862 more queued, on
 * a file that had been complete for three quarters of an hour, each connection
 * served by reading a 4 MB piece off the disk for every 16 KB sent.
 *
 * The rule is not a limit on connections. While anybody is reading, every
 * connection is worth keeping: the one that has delivered nothing yet may
 * deliver next. It is about a torrent nobody is reading at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { TorrentPool } from "../services/torrent-pool.js";
import { demandFor, forgetTorrent } from "../services/download/registry.js";

/**
 * A torrent that records what was done to it. Only the surface the rule
 * touches: `paused` is the library's own flag, and the peers are what the pause
 * does not close by itself.
 *
 * @param {number} peerCount
 * @returns {object}
 */
function torrentWith(peerCount) {
  const peers = new Map();
  for (let index = 0; index < peerCount; index += 1) {
    peers.set(String(index), {
      wire: { downloaded: 0 },
      destroy() {
        peers.delete(String(index));
      }
    });
  }
  return {
    infoHash: "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0",
    files: [{ length: 1024 }],
    paused: false,
    wires: [...peers.values()].map((peer) => peer.wire),
    _peers: peers,
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    }
  };
}

/**
 * @param {object} torrent
 * @returns {TorrentPool}
 */
function poolWith(torrent) {
  const pool = Object.create(TorrentPool.prototype);
  pool.torrents = new Map([["source", torrent]]);
  pool.fileUsageByTorrent = new WeakMap();
  return pool;
}

test("a torrent nobody is reading is let go of, and its data is not", () => {
  const torrent = torrentWith(6);
  const pool = poolWith(torrent);
  try {
    pool.followTheReaders(torrent);

    assert.equal(torrent.paused, true, "the swarm was not left");
    assert.equal(torrent._peers.size, 0, "the connections the pause does not close were not let go");
  } finally {
    forgetTorrent(torrent);
  }
});

test("a torrent somebody is reading keeps every connection it has", () => {
  const torrent = torrentWith(6);
  const pool = poolWith(torrent);
  pool.fileUsageByTorrent.set(torrent, new Map([[0, 1]]));
  try {
    pool.followTheReaders(torrent);

    assert.equal(torrent.paused, false, "a torrent being read was taken out of its swarm");
    assert.equal(torrent._peers.size, 6, "connections were closed while somebody was reading");
  } finally {
    forgetTorrent(torrent);
  }
});

test("a stated window keeps the swarm even with no file held", () => {
  // The register is what the download layer states; a reader that has declared
  // a window but not yet taken a file hold is still a reader.
  const torrent = torrentWith(2);
  const pool = poolWith(torrent);
  demandFor(torrent).register.state({
    claimant: "read-1",
    fileIndex: 0,
    byteStart: 0,
    byteEnd: 1023,
    urgency: 0
  });
  try {
    pool.followTheReaders(torrent);
    assert.equal(torrent.paused, false, "a declared window did not count as somebody reading");
  } finally {
    forgetTorrent(torrent);
  }
});

test("the swarm is rejoined when a reader comes back", () => {
  const torrent = torrentWith(3);
  const pool = poolWith(torrent);
  try {
    pool.followTheReaders(torrent);
    assert.equal(torrent.paused, true);

    pool.fileUsageByTorrent.set(torrent, new Map([[0, 1]]));
    pool.followTheReaders(torrent);
    assert.equal(torrent.paused, false, "the next reader was left with a torrent that fetches nothing");
  } finally {
    forgetTorrent(torrent);
  }
});
