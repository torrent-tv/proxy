import test from "node:test";
import assert from "node:assert/strict";
import { queueIsShort, SelectionLimit } from "../../services/torrent/download/SelectionLimit.js";

// Fakes for a torrent's connections and its map; no torrent client.

const PIECE = 1024 * 1024;

function wire({ choking = false, requests = 0, speed = 0, has = [], reqq = undefined, downloaded = 0 } = {}) {
  return { peerChoking: choking, requests: Array.from({ length: requests }, () => ({})), downloadSpeed: () => speed,
    peerPieces: { get: piece => has.includes(piece) }, peerExtendedHandshake: reqq ? { reqq } : undefined, downloaded };
}

function fixture({ wires, wanted = [[0, 9]], held = [], stated = [] }) {
  const torrent = { files: [{ offset: 0, length: 10 * PIECE }], pieceLength: PIECE, downloaded: 0, wires,
    bitfield: { get: piece => held.includes(piece) } };
  const register = { windows: () => wanted.map(([from, to]) => ({ fileIndex: 0, byteStart: from * PIECE, byteEnd: (to + 1) * PIECE - 1 })) };
  let now = 0;
  const limit = new SelectionLimit({ torrent, register, selection: { statedRanges: () => stated }, now: () => now });
  return { torrent, limit, at: ms => { now = ms; } };
}

test("a queue is short below half a second of the connection's speed, as WebTorrent refills it", () => {
  // 2 + ceil(0.5 s × 320 KiB/s / 16 KiB) = 12 blocks.
  assert.equal(queueIsShort(wire({ requests: 11, speed: 320 * 1024 })), true);
  assert.equal(queueIsShort(wire({ requests: 12, speed: 320 * 1024 })), false);
  // At most what the peer accepts.
  assert.equal(queueIsShort(wire({ requests: 5, speed: 320 * 1024, reqq: 5 })), false);
});

test("a peer with a piece the map wants outside the selection, and room in its queue, is held back by us", () => {
  const peer = wire({ has: [5] });
  const { torrent, limit, at } = fixture({ wires: [peer], stated: [{ from: 0, to: 1 }] });
  limit.sample();
  assert.equal(limit.heldBack, 1);
  at(1000); torrent.downloaded = 500_000;
  limit.sample();
  assert.deepEqual(limit.totals(), { at: 1000, bytes: 500_000, ms: 1000, freeBytes: 0, freeMs: 0, heldBackMs: 1000 });
});

test("what the swarm itself withholds is not our doing, and is measured", () => {
  // Choking us; holding only pieces the selection states; holding nothing the
  // map wants; its queue full.
  const wires = [wire({ choking: true, has: [5] }), wire({ has: [0] }), wire({ has: [] }),
    wire({ has: [5], requests: 40, speed: 320 * 1024 })];
  const { torrent, limit, at } = fixture({ wires, stated: [{ from: 0, to: 1 }] });
  limit.sample();
  assert.equal(limit.heldBack, 0);
  at(2000); torrent.downloaded = 4_000_000;
  limit.sample();
  assert.equal(limit.totals().freeMs, 2000);
  assert.equal(limit.totals().freeBytes, 4_000_000);
});

test("a piece already here, or stated, is not one we held back", () => {
  const { limit } = fixture({ wires: [wire({ has: [3, 4] })], held: [3], stated: [{ from: 4, to: 4 }] });
  limit.sample();
  assert.equal(limit.heldBack, 0);
});

test("a connection's capacity is what it carried with its queue kept full", () => {
  const peer = wire({ requests: 40, speed: 320 * 1024, downloaded: 0 });
  const { limit, at } = fixture({ wires: [peer] });
  limit.sample();
  assert.equal(limit.capacityOf(peer), null);
  at(2000); peer.downloaded = 1_000_000;
  limit.sample();
  assert.equal(limit.capacityOf(peer), 500_000);
  // A stretch it was short in does not replace it.
  peer.requests = [];
  at(3000); peer.downloaded = 1_010_000;
  limit.sample();
  assert.equal(limit.capacityOf(peer), 500_000);
});
