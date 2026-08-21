/**
 * @file The line describing a swarm answers the question it is asked.
 *
 * It could not. `routes/api/sources/stats/get.js` printed `peers=N` beside
 * `wires=?`, which reads as two quantities of which one is unknown — while
 * WebTorrent's `numPeers` IS `wires.length` (`lib/torrent.js:254`, the same in
 * 2.8.5 and 3.0.21), so the first was the connection count and the second was a
 * field that has never printed anything, because the torrent lives on a worker
 * thread where that property does not exist.
 *
 * What was missing is the other half: how many peers the client HOLDS but is
 * not connected to, and what the tracker said the swarm has. Measured
 * 2026-08-21 on `JUFD665.mp4`, the tracker answered `seeders=5` at 13:40:30 and
 * the first wire arrived at 13:44:47 — 4 min 17 s in which the stats line
 * repeated unchanged every two seconds while the answer ("offered, not
 * connected") was already in the process.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bestAnnounce, describeSwarmReach, secondsToFirstPeer } from "../services/torrent-pool.js";

test("connected and known are separate numbers", () => {
  const torrent = { wires: [{}, {}], _peersLength: 7, _numQueued: 4 };
  assert.deepEqual(describeSwarmReach(torrent), {
    connectedPeers: 2,
    knownPeers: 7,
    queuedPeers: 4
  });
});

test("offered but not connected is distinguishable from nobody offered", () => {
  // The two shapes the field produced. They need opposite investigations, and
  // one line has to tell them apart.
  const offeredNotConnected = describeSwarmReach({ wires: [], _peersLength: 5, _numQueued: 5 });
  const nobodyOffered = describeSwarmReach({ wires: [], _peersLength: 0, _numQueued: 0 });
  assert.equal(offeredNotConnected.connectedPeers, 0);
  assert.equal(nobodyOffered.connectedPeers, 0);
  assert.notEqual(offeredNotConnected.knownPeers, nobodyOffered.knownPeers);
});

test("internals that are gone say nothing rather than breaking the poll", () => {
  // `_peersLength` and `_numQueued` are not WebTorrent's published interface.
  // The browser polls this every two seconds, so a version that drops them must
  // cost the field and not the answer.
  assert.deepEqual(describeSwarmReach({ wires: [{}] }), {
    connectedPeers: 1,
    knownPeers: null,
    queuedPeers: null
  });
  assert.deepEqual(describeSwarmReach({}), {
    connectedPeers: 0,
    knownPeers: null,
    queuedPeers: null
  });
  assert.deepEqual(describeSwarmReach(null), {
    connectedPeers: 0,
    knownPeers: null,
    queuedPeers: null
  });
  const throwing = {
    wires: [],
    get _peersLength() {
      throw new Error("destroyed");
    }
  };
  assert.deepEqual(describeSwarmReach(throwing), {
    connectedPeers: 0,
    knownPeers: null,
    queuedPeers: null
  });
});

test("the wait for a first peer is a measured quantity", () => {
  // The field case: added 13:40:30.357, first wire 13:44:47.123.
  assert.equal(secondsToFirstPeer(1000, 258_766), 257.766);
  assert.equal(secondsToFirstPeer(1000, 1000), 0);
});

test("no peer yet is not a duration", () => {
  assert.equal(secondsToFirstPeer(1000, null), null);
  assert.equal(secondsToFirstPeer(null, 2000), null);
  // A clock that went backwards is not a negative wait; it is no reading.
  assert.equal(secondsToFirstPeer(2000, 1000), null);
});

test("the best tracker answer wins, not the most recent", () => {
  // A live tracker says 500, a dead one answers 0 two seconds later. Keeping
  // the last would print "nobody offered" about a swarm of five hundred, which
  // inverts the one distinction this figure is carried for.
  const answers = [
    { seeders: 500, leechers: 40 },
    { seeders: 0, leechers: 0 }
  ];
  assert.deepEqual(bestAnnounce(answers), { seeders: 500, leechers: 40, trackers: 2 });
});

test("trackers that answered are counted even when none knew anything", () => {
  assert.deepEqual(bestAnnounce([{ seeders: null, leechers: null }]), {
    seeders: null,
    leechers: null,
    trackers: 1
  });
  // No tracker has answered at all — a different state from "answered, knows
  // nobody", and the line says so.
  assert.deepEqual(bestAnnounce([]), { seeders: null, leechers: null, trackers: 0 });
  assert.deepEqual(bestAnnounce(null), { seeders: null, leechers: null, trackers: 0 });
});

test("leechers travel with the seeder count they were reported beside", () => {
  const answers = [
    { seeders: 2, leechers: 99 },
    { seeders: 7, leechers: 3 }
  ];
  assert.equal(bestAnnounce(answers).leechers, 3);
  // Including when the winning answer gave no leecher count: carrying the
  // previous tracker's figure forward would present two trackers' numbers as
  // one reading.
  assert.deepEqual(bestAnnounce([{ seeders: 2, leechers: 99 }, { seeders: 7, leechers: null }]), {
    seeders: 7,
    leechers: null,
    trackers: 2
  });
});
