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
 * AND IT IS ASKED OF WHAT HAS BEEN STATED, never of a count of readers. The
 * first version asked every five seconds whether anybody was READING, and a
 * torrent added three seconds earlier answered no — its edges still being read,
 * its plan still being built. It left the swarm with 741 connections let go,
 * and nothing rejoined it: rejoining waited for a reader, and the reader was
 * waiting for the header the swarm had been fetching. Playback did not start at
 * all.
 *
 * The question now is whether anything is WANTED of it, which the priority map,
 * the ends of an open file and a stopped read all answer — and which is true
 * from the moment a torrent is opened.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  isWanted,
  leaveSwarm,
  rejoinSwarm,
  stateFileEdges,
  swarmDecisionFor
} from "../services/torrent-pool.js";
import { demandFor, forgetTorrent } from "../services/download/registry.js";
import { Urgency } from "../services/demand/index.js";

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

test("a torrent whose metadata has not arrived is wanted, whatever is stated", () => {
  // THE FIELD FAILURE OF 2026-09-11, as a question rather than as a mechanism.
  // A torrent being added has no list of files, so nothing can name a byte of
  // it — and it is being fetched precisely because somebody asked for it.
  const torrent = torrentWith(103);
  torrent.files = [];
  assert.equal(isWanted(torrent), true);
});

test("a torrent with files and nothing stated for them is wanted by nobody", () => {
  const torrent = torrentWith(4);
  try {
    assert.equal(isWanted(torrent), false);
  } finally {
    forgetTorrent(torrent);
  }
});

test("anything stated makes it wanted, and the last withdrawal ends that", () => {
  const torrent = torrentWith(4);
  try {
    // The ends of a file being opened, which is the first thing said about a
    // torrent anybody has picked and the reason it stays in its swarm through
    // the seconds when nothing else can say anything about it.
    stateFileEdges(torrent, 0, Urgency.TAIL);
    assert.equal(isWanted(torrent), true);

    const { register } = demandFor(torrent);
    register.withdraw("file-edges:0:head");
    assert.equal(isWanted(torrent), true, "one end of it is still wanted");
    register.withdraw("file-edges:0:tail");
    assert.equal(isWanted(torrent), false);
  } finally {
    forgetTorrent(torrent);
  }
});

test("a torrent that has been destroyed is wanted by nobody", () => {
  const torrent = torrentWith(1);
  torrent.destroyed = true;
  assert.equal(isWanted(torrent), false);
});

test("a torrent something is wanted of keeps its swarm and is off the clock", () => {
  assert.deepEqual(
    swarmDecisionFor({ wanted: true, everWanted: true }),
    { swarm: "take", onTheClock: false }
  );
  assert.deepEqual(
    swarmDecisionFor({ wanted: true, everWanted: false }),
    { swarm: "take", onTheClock: false }
  );
});

test("a swarm is let go on a DEPARTURE, never on a beginning", () => {
  // The whole of the 2.83.1 failure in one line: a torrent that has never been
  // wanted is one being opened — its metadata has just landed, the file list is
  // on its way to the person choosing, and nothing has had a chance to state
  // anything about it yet. Taking its swarm away there destroyed 741
  // connections it needed a minute later.
  assert.deepEqual(
    swarmDecisionFor({ wanted: false, everWanted: false }),
    { swarm: "leave alone", onTheClock: true }
  );
  assert.deepEqual(
    swarmDecisionFor({ wanted: false, everWanted: true }),
    { swarm: "let go", onTheClock: true }
  );
});

test("whatever happens to the swarm, an unwanted torrent is on the idle clock", () => {
  // Including the one nobody has ever wanted: a file list fetched and never
  // played used to be held for the life of the process, because the only thing
  // that started the clock was a reader letting go.
  for (const everWanted of [true, false]) {
    assert.equal(swarmDecisionFor({ wanted: false, everWanted }).onTheClock, true);
  }
});
