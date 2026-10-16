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

test("an observed queue gives its piece's arrival beside pieces left unknown", async () => {
  const entry = state();
  entry.wire.peerPieces = { get: index => index !== 0 };
  entry.wire.requests.push({ piece: 1, offset: 0, length: 2 * BLOCK });
  assert.deepEqual([...((await forecast(entry)).arrivals.values())], [null, 2500, null]);
});

test("a piece queued on a slow wire keeps its queue's time; one nobody was asked for is the start forecast's", async () => {
  // Its blocks are reserved to the slow wire: the fast one cannot bring them
  // sooner (torrent-tv/meta#178 review). A piece not asked for is brought by
  // the start forecast at the source's measured service. A second estimate
  // here, shared out by the holders' own speeds, came back on the polls where
  // the forecast answered 21 846 s and 160 774 s while the torrent carried
  // 3.5-5.5 MB/s (r78, r79, torrent-tv/meta#185).
  const entry = state();
  entry.wire.downloadSpeed = () => BLOCK / 2;
  entry.wire.peerPieces = { get: index => index === 0 };
  entry.wire.requests.push({ piece: 0, offset: 0, length: 2 * BLOCK });
  entry.torrent.wires.push({ requests: [], downloadSpeed: () => 10 * BLOCK, peerPieces: { get: () => true } });
  assert.deepEqual([...(await forecast(entry)).arrivals], [[0, 4500], [1, null], [2, null]]);
});
