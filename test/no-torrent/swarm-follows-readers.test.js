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
  noteAfterRejoin,
  rejoinSwarm,
  rememberSwarmAddresses,
  swarmDecisionFor
} from "../../services/torrent/torrent-pool.js";
import { demandFor, forgetTorrent } from "../../services/torrent/download/registry.js";
import { Urgency } from "../../services/torrent/demand/index.js";

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

test("returning demand restores the HTTP seeds closed at the previous withdrawal", () => {
  const torrent = torrentWith(0);
  torrent.urlList = ["https://seed.example/files/"];
  const added = [];
  torrent.addWebSeed = url => { added.push(url); torrent._peers.set(url, { destroy() { torrent._peers.delete(url); } }); };
  torrent.addWebSeed(torrent.urlList[0]);
  leaveSwarm(torrent);
  added.length = 0;
  rejoinSwarm(torrent);
  assert.deepEqual(added, torrent.urlList);
  rejoinSwarm(torrent);
  assert.equal(added.length, 1, "an already resumed source must not duplicate its HTTP seed");
});

test("resuming respects disabled HTTP seeds and existing seed connections", () => {
  const torrent = torrentWith(0);
  torrent.paused = true;
  torrent.urlList = ["https://seed.example/files/"];
  torrent.client = { enableWebSeeds: false };
  const added = [];
  torrent.addWebSeed = url => added.push(url);
  rejoinSwarm(torrent);
  assert.deepEqual(added, []);
  torrent.paused = true;
  torrent.client.enableWebSeeds = true;
  torrent._peers.set(torrent.urlList[0], {});
  rejoinSwarm(torrent);
  assert.deepEqual(added, []);
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
    const { register } = demandFor(torrent);
    register.state({ claimant: "metadata:head", fileIndex: 0, byteStart: 0, byteEnd: 0, urgency: Urgency.TAIL });
    register.state({ claimant: "metadata:tail", fileIndex: 0, byteStart: 3, byteEnd: 3, urgency: Urgency.TAIL });
    assert.equal(isWanted(torrent), true);

    register.withdraw("metadata:head");
    assert.equal(isWanted(torrent), true, "one end of it is still wanted");
    register.withdraw("metadata:tail");
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

/**
 * A torrent whose peers carry what WebTorrent 2.8.5 gives them — a type, an
 * address and, once connected, a wire — and which records `addPeer` and a DHT
 * lookup instead of dialling or querying anybody.
 *
 * @param {Array<{ addr: string, type: string, wire?: boolean }>} specs
 * @param {{ maxConns?: number, dht?: boolean }} [options]
 * @returns {object}
 */
function torrentWithPeers(specs, { maxConns = 55, dht = true } = {}) {
  const torrent = torrentWith(0);
  torrent.client = { maxConns };
  torrent.added = [];
  torrent.lookups = [];
  torrent.announced = 0;
  const place = (spec) => {
    torrent._peers.set(spec.addr, {
      type: spec.type,
      addr: spec.addr,
      wire: spec.wire ? {} : null,
      destroy() {
        torrent._peers.delete(spec.addr);
      }
    });
  };
  for (const spec of specs) place(spec);
  torrent.place = place;
  torrent.addPeer = (addr, source) => {
    torrent.added.push({ addr, source });
    if (torrent._peers.has(addr)) return false;
    place({ addr, type: "tcpOutgoing" });
    return true;
  };
  torrent.discovery = {
    tracker: { update() { torrent.announced += 1; } },
    dht: dht ? { lookup(infoHash, callback) { torrent.lookups.push({ infoHash, callback }); } } : null
  };
  return torrent;
}

test("the addresses kept at a departure are the dialled ones, connected first, within the dial limit", () => {
  const torrent = torrentWithPeers([
    { addr: "10.0.0.1:6881", type: "tcpOutgoing" },
    { addr: "10.0.0.2:6881", type: "utpOutgoing", wire: true },
    { addr: "10.0.0.3:51234", type: "tcpIncoming", wire: true },
    { addr: "10.0.0.4:6881", type: "tcpOutgoing", wire: true },
    { addr: "https://seed.example/files/", type: "webSeed" },
    { addr: "10.0.0.5:6881", type: "utpOutgoing" }
  ], { maxConns: 3 });

  assert.equal(rememberSwarmAddresses(torrent), 3);
  leaveSwarm(torrent);
  rejoinSwarm(torrent);

  // An incoming peer's port is the one its side connected from, and a web seed
  // is restored by its own URL; neither is an address to dial.
  assert.deepEqual(torrent.added.map(({ addr }) => addr), ["10.0.0.2:6881", "10.0.0.4:6881", "10.0.0.1:6881"]);
  assert.ok(torrent.added.every(({ source }) => source === "rejoin"));
});

test("a rejoin hands every kept address back and keeps them for the next one", () => {
  const torrent = torrentWithPeers([
    { addr: "10.0.0.1:6881", type: "tcpOutgoing", wire: true },
    { addr: "10.0.0.2:6881", type: "tcpOutgoing" }
  ]);
  leaveSwarm(torrent);
  assert.equal(torrent._peers.size, 0);

  rejoinSwarm(torrent);
  assert.deepEqual(torrent.added.map(({ addr }) => addr), ["10.0.0.1:6881", "10.0.0.2:6881"]);

  // Nobody answered, so the library dropped the candidates, and the torrent
  // left again with no peer at all: the field case of 08:44:19, a departure
  // 71 ms after the rejoin.
  for (const peer of [...torrent._peers.values()]) peer.destroy();
  leaveSwarm(torrent);
  torrent.added.length = 0;
  rejoinSwarm(torrent);
  assert.deepEqual(torrent.added.map(({ addr }) => addr), ["10.0.0.1:6881", "10.0.0.2:6881"],
    "an empty departure erased the addresses the next reader needed");
});

test("a later departure puts what is connected now first and keeps the earlier addresses after it", () => {
  const torrent = torrentWithPeers([{ addr: "10.0.0.1:6881", type: "tcpOutgoing", wire: true }], { maxConns: 3 });
  leaveSwarm(torrent);
  rejoinSwarm(torrent);
  for (const peer of [...torrent._peers.values()]) peer.destroy();
  torrent.place({ addr: "10.0.0.7:6881", type: "tcpOutgoing" });
  torrent.place({ addr: "10.0.0.8:6881", type: "utpOutgoing", wire: true });
  torrent.place({ addr: "10.0.0.1:6881", type: "tcpOutgoing" });
  leaveSwarm(torrent);
  torrent.added.length = 0;
  rejoinSwarm(torrent);
  assert.deepEqual(torrent.added.map(({ addr }) => addr), ["10.0.0.8:6881", "10.0.0.7:6881", "10.0.0.1:6881"]);
});

test("a rejoin asks the DHT once at a time and leaves the trackers on their own schedule", () => {
  const torrent = torrentWithPeers([{ addr: "10.0.0.1:6881", type: "tcpOutgoing", wire: true }]);
  leaveSwarm(torrent);
  rejoinSwarm(torrent);
  assert.equal(torrent.lookups.length, 1);
  assert.equal(torrent.lookups[0].infoHash, torrent.infoHash);

  leaveSwarm(torrent);
  rejoinSwarm(torrent);
  assert.equal(torrent.lookups.length, 1, "a second lookup was started while the first was running");

  // The answer ends it, a failed one too, and the next rejoin asks again.
  torrent.lookups[0].callback(new Error("dht is destroyed"));
  leaveSwarm(torrent);
  rejoinSwarm(torrent);
  assert.equal(torrent.lookups.length, 2);
  torrent.lookups[1].callback(null, 8);
  leaveSwarm(torrent);
  rejoinSwarm(torrent);
  assert.equal(torrent.lookups.length, 3);

  assert.equal(torrent.announced, 0, "a tracker was announced to outside its own interval");
});

test("a private torrent, with no DHT and no discovery, rejoins on its kept addresses alone", () => {
  const torrent = torrentWithPeers([{ addr: "10.0.0.1:6881", type: "tcpOutgoing", wire: true }], { dht: false });
  leaveSwarm(torrent);
  assert.equal(rejoinSwarm(torrent), true);
  assert.equal(torrent.paused, false);
  assert.deepEqual(torrent.added.map(({ addr }) => addr), ["10.0.0.1:6881"]);

  const bare = torrentWith(2);
  leaveSwarm(bare);
  assert.equal(rejoinSwarm(bare), true, "a torrent without addPeer or discovery could not rejoin");
  assert.equal(bare.paused, false);
});

test("a torrent held whole dials nobody and asks the DHT for nobody when a reader rejoins it", () => {
  const torrent = torrentWithPeers([{ addr: "10.0.0.1:6881", type: "tcpOutgoing", wire: true }]);
  leaveSwarm(torrent);
  torrent.progress = 1;
  assert.equal(rejoinSwarm(torrent), true);
  assert.equal(torrent.paused, false);
  assert.deepEqual(torrent.added, []);
  assert.equal(torrent.lookups.length, 0);

  // The addresses are still kept for a rejoin that has something to fetch.
  torrent.progress = 0.4;
  leaveSwarm(torrent);
  rejoinSwarm(torrent);
  assert.deepEqual(torrent.added.map(({ addr }) => addr), ["10.0.0.1:6881"]);
});

test("a lookup that throws does not stay marked as running", () => {
  const torrent = torrentWithPeers([]);
  let calls = 0;
  torrent.discovery.dht.lookup = () => {
    calls += 1;
    throw new Error("not bound");
  };
  leaveSwarm(torrent);
  rejoinSwarm(torrent);
  leaveSwarm(torrent);
  rejoinSwarm(torrent);
  assert.equal(calls, 2);
});

test("the first peer and the first data after a rejoin are noted once each, and again after the next rejoin", () => {
  const torrent = torrentWithPeers([]);
  assert.equal(noteAfterRejoin(torrent, "peer"), false, "a torrent that never rejoined had something noted");
  leaveSwarm(torrent);
  rejoinSwarm(torrent);
  assert.equal(noteAfterRejoin(torrent, "peer"), true);
  assert.equal(noteAfterRejoin(torrent, "peer"), false);
  assert.equal(noteAfterRejoin(torrent, "data"), true);
  assert.equal(noteAfterRejoin(torrent, "data"), false);
  leaveSwarm(torrent);
  rejoinSwarm(torrent);
  assert.equal(noteAfterRejoin(torrent, "data"), true);
});
