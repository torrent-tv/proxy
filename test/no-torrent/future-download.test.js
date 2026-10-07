import test from "node:test";
import assert from "node:assert/strict";
import { DemandRegister } from "../../services/torrent/demand/DemandRegister.js";
import { futureDownload } from "../../services/torrent/download/FutureDownload.js";

const BLOCK = 16384;
function state() {
  const wire = { requests: [], downloadSpeed: () => BLOCK };
  const torrent = { ready: true, pieceLength: 2 * BLOCK, files: [{ offset: 0, length: 6 * BLOCK }],
    pieces: Array.from({ length: 3 }, () => ({ length: 2 * BLOCK, missing: 2 * BLOCK })), wires: [wire],
    bitfield: { get: () => false }, _request: () => assert.fail("a forecast cannot issue requests") };
  const register = new DemandRegister();
  register.state({ claimant: "viewer", fileIndex: 0, byteStart: 0, byteEnd: 6 * BLOCK - 1, priority: 100, urgency: 0 });
  return { torrent, register, wire };
}
async function forecast(entry, options = {}) {
  return (await futureDownload([entry], { now: 500, findStore: () => null, ...options })).get(entry.torrent);
}

test("unrequested and partially queued pieces retain unknown arrival", async () => {
  const entry = state();
  entry.wire.requests.push({ piece: 1, offset: 0, length: BLOCK });
  assert.deepEqual([...((await forecast(entry)).arrivals.values())], [null, null, null]);
});

test("complete peer queues determine arrival without changing requests or piece state", async () => {
  const entry = state();
  entry.wire.requests.push({ piece: 2, offset: 0, length: 2 * BLOCK },
    { piece: 1, offset: 0, length: BLOCK }, { piece: 1, offset: BLOCK, length: BLOCK });
  const before = structuredClone(entry.wire.requests);
  assert.deepEqual([...((await forecast(entry)).arrivals)], [[0, null], [1, 4500], [2, 2500]]);
  assert.deepEqual(entry.wire.requests, before);
  assert.equal(entry.torrent.pieces[1].missing, 2 * BLOCK);
});

test("duplicate blocks use their earliest arrival without double counting", async () => {
  const entry = state();
  entry.wire.requests.push({ piece: 1, offset: 0, length: 2 * BLOCK });
  entry.torrent.wires.push({ requests: [{ piece: 1, offset: 0, length: BLOCK }], downloadSpeed: () => 10 * BLOCK });
  assert.equal((await forecast(entry)).arrivals.get(1), 2500);
});

test("received blocks need no future request but all missing blocks must be queued", async () => {
  const entry = state();
  entry.torrent.pieces[1] = { length: 2 * BLOCK, missing: BLOCK, _buffer: [Buffer.alloc(BLOCK), null] };
  entry.wire.requests.push({ piece: 1, offset: BLOCK, length: BLOCK });
  assert.equal((await forecast(entry)).arrivals.get(1), 1500);
});

test("unknown rates, incomplete facts and malformed requests cannot establish arrival", async () => {
  const entry = state();
  entry.wire.requests.push({ piece: 1, offset: 1, length: 2 * BLOCK - 1 });
  assert.equal((await forecast(entry)).arrivals.get(1), null);
  entry.wire.requests = [{ piece: 1, offset: 0, length: 2 * BLOCK }];
  entry.wire.downloadSpeed = () => 0;
  assert.equal((await forecast(entry)).arrivals.get(1), null);
  entry.wire.downloadSpeed = () => BLOCK;
  entry.torrent.pieces[1].missing = BLOCK;
  assert.equal((await forecast(entry)).arrivals.get(1), null);
});

test("the store overrides a stale bitfield after withdrawal", async () => {
  const entry = state();
  entry.torrent.bitfield.get = () => true;
  assert.equal((await forecast(entry)).arrivals.get(1), 500);
  assert.equal((await forecast(entry, { findStore: () => ({ locationOf: () => "missing" }) })).arrivals.get(1), null);
});

test("a changed map invalidates a forecast without modifying protocol state", async () => {
  const entry = state();
  let checks = 0;
  const result = await futureDownload([entry], { isCurrent: () => ++checks === 1 });
  assert.equal(result.size, 0);
  assert.equal(entry.wire.requests.length, 0);
});

test("unrequested pieces share the measured completion of their public selection band", async () => {
  const entry = state();
  entry.wire.peerPieces = { get: () => true };
  const result = await forecast(entry);
  assert.deepEqual([...result.arrivals.values()], [6500, 6500, 6500]);
  assert.deepEqual(entry.wire.requests, []);
});

test("global bands do not spend the same measured supply concurrently", async () => {
  const first = state();
  const second = state();
  for (const entry of [first, second]) entry.wire.peerPieces = { get: () => true };
  second.register.state({ claimant: "viewer", fileIndex: 0, byteStart: 0,
    byteEnd: 6 * BLOCK - 1, priority: 10, urgency: 0 });
  const result = await futureDownload([second, first], { now: 500, findStore: () => null });
  assert.deepEqual([...result.get(first.torrent).arrivals.values()], [6500, 6500, 6500]);
  assert.deepEqual([...result.get(second.torrent).arrivals.values()], [12500, 12500, 12500]);
});

test("an unadvertised piece prevents a band estimate while observed queues remain usable", async () => {
  const entry = state();
  entry.wire.peerPieces = { get: index => index !== 0 };
  entry.wire.requests.push({ piece: 1, offset: 0, length: 2 * BLOCK });
  assert.deepEqual([...((await forecast(entry)).arrivals.values())], [null, 2500, null]);
});

test("equal priorities preserve required times instead of pricing the whole film as one band", async () => {
  const entry = state();
  entry.wire.peerPieces = { get: () => true };
  entry.register.clear();
  for (let piece = 0; piece < 3; piece++) entry.register.state({ claimant: `part:${piece}`,
    fileIndex: 0, byteStart: piece * 2 * BLOCK, byteEnd: (piece + 1) * 2 * BLOCK - 1,
    urgency: 0, priority: 100, deadlineAt: 1000 + piece * 10000 });
  assert.deepEqual([...((await forecast(entry)).arrivals.values())], [2500, 4500, 6500]);
});
