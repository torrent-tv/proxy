import test from "node:test";
import assert from "node:assert/strict";
import { DemandRegister } from "../../services/torrent/demand/DemandRegister.js";
import { futureDownload } from "../../services/torrent/download/FutureDownload.js";

const BLOCK = 16384;

test("an obsolete forecast stops at its first cooperative yield", async () => {
  const entry = state();
  entry.torrent.pieceLength = 1024 * BLOCK;
  entry.torrent.files[0].length = entry.torrent.pieceLength;
  entry.torrent.pieces = [{ length: entry.torrent.pieceLength, missing: entry.torrent.pieceLength }];
  entry.register.clear();
  entry.register.state({ claimant: "viewer", fileIndex: 0, byteStart: 0,
    byteEnd: entry.torrent.pieceLength - 1, priority: 100, urgency: 0 });
  entry.torrent.wires.push({ ...entry.wire, requests: [], downloadSpeed: () => 2 * BLOCK });
  let checks = 0;
  const result = await futureDownload([entry], { now: 0, findStore: () => null,
    isCurrent: () => ++checks === 1 });
  assert.equal(result.size, 0);
  assert.equal(checks, 2);
  assert.equal(entry.wire.requests.length, 0);
});
function state() {
  const wire = { requests: [], peerChoking: false, downloadSpeed: () => BLOCK,
    peerPieces: { get: () => true }, peerExtendedHandshake: { reqq: 2 } };
  const torrent = { ready: true, pieceLength: BLOCK, files: [{ offset: 0, length: 3 * BLOCK }],
    pieces: Array.from({ length: 3 }, () => ({ length: BLOCK, missing: BLOCK })), wires: [wire],
    bitfield: { get: () => false }, _request: () => assert.fail("forecast must not invoke a real-shaped torrent request") };
  const register = new DemandRegister();
  for (const [piece, priority] of [[0, 1], [1, 100], [2, 50]]) register.state({ claimant: `viewer:${piece}`, fileIndex: 0,
    byteStart: piece * BLOCK, byteEnd: (piece + 1) * BLOCK - 1, priority, urgency: 0 });
  return { torrent, register, wire };
}

test("future requests share the actual map ordering and retain competing viewers", async () => {
  const entry = state();
  const future = (await futureDownload([entry], { now: 0, findStore: () => null })).get(entry.torrent);
  assert.deepEqual([...future.arrivals], [[1, 1000], [2, 2000], [0, 3000]]);
  assert.equal(entry.wire.requests.length, 0);
  assert.equal(entry.torrent.pieces[1].missing, BLOCK);
});

test("existing queued blocks occupy their peer while the future scheduler fills remaining slots", async () => {
  const entry = state();
  entry.wire.requests.push({ piece: 0, offset: 0, length: BLOCK });
  const future = (await futureDownload([entry], { now: 500, findStore: () => null })).get(entry.torrent);
  assert.deepEqual([...future.arrivals], [[0, 1500], [1, 2500], [2, 3500]]);
  assert.deepEqual(entry.wire.requests, [{ piece: 0, offset: 0, length: BLOCK }]);
});

test("different torrents retain independent peers rather than sharing a fabricated rate", async () => {
  const first = state(), second = state();
  second.wire.downloadSpeed = () => 2 * BLOCK;
  const future = await futureDownload([first, second], { now: 0, findStore: () => null });
  assert.equal(future.get(first.torrent).arrivals.get(1), 1000);
  assert.equal(future.get(second.torrent).arrivals.get(1), 500);
});

test("unknown peer service or unavailable protocol block facts do not produce arrival times", async () => {
  const entry = state();
  entry.wire.downloadSpeed = () => 0;
  assert.deepEqual([...((await futureDownload([entry], { now: 0, findStore: () => null })).get(entry.torrent).arrivals.values())], [null, null, null]);
  entry.wire.downloadSpeed = () => BLOCK;
  entry.torrent.pieces[1] = null;
  assert.equal((await futureDownload([entry], { now: 0, findStore: () => null })).get(entry.torrent).arrivals.get(1), null);
});

test("one-peer FIFO summation agrees with every actual-scheduler block replay", async () => {
  for (const maximum of [1, 2, 8]) for (const queued of [false, true]) {
    const entry = state();
    entry.torrent.pieceLength = 3 * BLOCK;
    entry.torrent.files[0].length = 9 * BLOCK;
    entry.torrent.pieces = Array.from({ length: 3 }, () => ({ length: 3 * BLOCK, missing: 3 * BLOCK }));
    entry.wire.peerExtendedHandshake.reqq = maximum;
    entry.register.clear();
    for (const [piece, priority] of [[0, 1], [1, 100], [2, 50]]) entry.register.state({ claimant: `viewer:${piece}`, fileIndex: 0,
      byteStart: piece * 3 * BLOCK, byteEnd: (piece + 1) * 3 * BLOCK - 1, priority, urgency: 0, deadlineAt: 250 });
    if (queued) entry.wire.requests.push({ piece: 2, offset: 0, length: BLOCK });
    const summed = (await futureDownload([entry], { now: 0, findStore: () => null })).get(entry.torrent);
    const replayed = (await futureDownload([entry], { now: 0, findStore: () => null, replayOnly: true })).get(entry.torrent);
    assert.deepEqual([...summed.arrivals].sort(), [...replayed.arrivals].sort());
  }
});

test("future deadline reassignment leaves the original slow queue untouched", async () => {
  const entry = state();
  entry.register.clear();
  entry.register.state({ claimant: "urgent", fileIndex: 0, byteStart: BLOCK, byteEnd: 2 * BLOCK - 1,
    priority: 100, urgency: 0, deadlineAt: 100 });
  entry.wire.requests.push({ piece: 1, offset: 0, length: BLOCK });
  entry.torrent.wires.push({ ...entry.wire, requests: [], downloadSpeed: () => 10 * BLOCK });
  const result = (await futureDownload([entry], { now: 0, findStore: () => null })).get(entry.torrent);
  assert.equal(result.arrivals.get(1), 100);
  assert.equal(entry.wire.requests.length, 1);
  assert.equal(entry.torrent.wires[1].requests.length, 0);
});
