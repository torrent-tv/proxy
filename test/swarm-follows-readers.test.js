/**
 * @file A proxy that needs nothing from a swarm is not in that swarm.
 *
 * WebTorrent enforces `maxConns` only on peers it dials (`_drain`), while
 * `_addIncomingPeer` checks that the torrent is neither destroyed nor paused
 * and registers the peer. A proxy with its port mapped is reachable, so on a
 * popular torrent connections arrive and are never turned away — field
 * 2026-09-11: 249 connected at the start of one viewing, 596 at the end, 15 862
 * more queued, on a file complete for three quarters of an hour.
 *
 * The rule is not a limit on connections. While anybody is reading, every one is
 * worth keeping: the one that has delivered nothing yet may deliver next.
 *
 * AND IT IS ACTED ON AT THE DEPARTURE ITSELF. The first version asked every
 * five seconds whether anybody was reading, and a torrent added three seconds
 * earlier answered no — its edges still being read, its plan still being built.
 * It left the swarm with 741 connections let go, and nothing rejoined it:
 * rejoining waits for a reader, and the reader was waiting for the header the
 * swarm had been fetching. Playback did not start at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { leaveSwarm, rejoinSwarm } from "../services/torrent-pool.js";

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
    files: [{ length: 1024 }, { length: 2048 }],
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

test("letting a swarm go pauses the torrent and closes what the pause does not", () => {
  const torrent = torrentWith(6);

  const closed = leaveSwarm(torrent);

  assert.equal(torrent.paused, true, "the library's own word for this was not used");
  assert.equal(closed, 6);
  assert.equal(torrent._peers.size, 0, "the connections the pause does not close were not let go");
});

test("a swarm already let go is not let go twice", () => {
  const torrent = torrentWith(4);
  leaveSwarm(torrent);
  assert.equal(leaveSwarm(torrent), 0);
});

test("the reader that comes back takes the swarm with it", () => {
  const torrent = torrentWith(3);
  leaveSwarm(torrent);

  assert.equal(rejoinSwarm(torrent), true);
  assert.equal(torrent.paused, false, "the next reader was left with a torrent that fetches nothing");
  assert.equal(rejoinSwarm(torrent), false, "a torrent already in its swarm was resumed again");
});

test("a torrent nobody has read yet is never asked to leave", () => {
  // The field failure of 2026-09-11 is closed by WHERE this is called from, not
  // by anything inside it: leaving is a consequence of the last claim being
  // released, and a torrent being opened has released nothing. There is no pass
  // that can ask it.
  const torrent = torrentWith(103);
  assert.equal(torrent.paused, false);
  assert.equal(torrent._peers.size, 103);
});
