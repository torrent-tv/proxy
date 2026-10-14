/**
 * @file The last blocks of a piece somebody waits for, asked of a second peer
 * (torrent-tv/meta#178).
 *
 * Driven against a stub torrent with the real `torrent-piece` and a `_request`
 * that checks what WebTorrent 2.8.5's does, in its order: the piece is not held
 * yet, the wire's queue has room, a block can be reserved.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Piece from "torrent-piece";

import { duplicateTailFor } from "../../services/torrent/worker/fastest-wires.js";
import { TailRepeat } from "../../services/torrent/worker/tail-repeat.js";
import { DemandRegister } from "../../services/torrent/demand/DemandRegister.js";
import { Urgency } from "../../services/torrent/demand/Urgency.js";
import { SwarmSelection } from "../../services/torrent/download/SwarmSelection.js";

const BLOCK = Piece.BLOCK_LENGTH;
const BLOCKS = 128;

function wire(name, { speed = 100_000, queue = 20, pieces = [0, 1, 2, 3] } = {}) {
  const one = new EventEmitter();
  return Object.assign(one, {
    name, requests: [], queue, peerChoking: false, destroyed: false,
    peerPieces: { get: (index) => pieces.includes(index) },
    downloadSpeed: () => speed
  });
}

function torrent(wires) {
  const one = new EventEmitter();
  const held = new Set();
  return Object.assign(one, {
    wires, pieceLength: BLOCKS * BLOCK,
    pieces: [0, 1, 2, 3].map(() => new Piece(BLOCKS * BLOCK)),
    bitfield: { get: (index) => held.has(index), set: (index) => held.add(index) },
    _request(target, index) {
      if (this.bitfield.get(index)) return false;
      if (target.requests.length >= target.queue) return false;
      const block = this.pieces[index].reserve();
      if (block === -1) return false;
      target.requests.push({ piece: index, offset: block * BLOCK, length: BLOCK });
      return true;
    }
  });
}

/** Piece `index` with every block arrived but `missing`, those in flight on `holder`. */
function tail(one, index, holder, missing) {
  const piece = one.pieces[index];
  for (let block = 0; block < BLOCKS; block += 1) {
    assert.equal(piece.reserve(), block);
    if (missing.includes(block)) holder.requests.push({ piece: index, offset: block * BLOCK, length: BLOCK });
    else piece.set(block, new Uint8Array(BLOCK), holder);
  }
}

test("a block held by one slow peer is asked of another, and never of a third however often it is looked at", () => {
  const slow = wire("slow", { speed: 1_000 }), fast = wire("fast"), other = wire("other", { speed: 50_000 });
  const one = torrent([slow, fast, other]);
  tail(one, 0, slow, [126, 127]);
  assert.deepEqual(duplicateTailFor(one, 0), { duplicated: 2, missing: 2, wires: 3, unplaced: 0 });
  assert.deepEqual(fast.requests.map(request => request.offset / BLOCK).sort(), [126, 127], "the fastest peer, which held neither");
  for (let look = 0; look < 5; look += 1) assert.equal(duplicateTailFor(one, 0).duplicated, 0, "two copies in flight are enough");
  assert.equal(other.requests.length, 0);
});

test("a peer with a full queue is passed over, and the block freed for it is taken back", () => {
  const slow = wire("slow", { speed: 1_000 }), full = wire("full", { queue: 0 }), spare = wire("spare", { speed: 50_000 });
  const one = torrent([slow, full, spare]);
  tail(one, 1, slow, [127]);
  assert.equal(duplicateTailFor(one, 1).duplicated, 1);
  assert.deepEqual(spare.requests, [{ piece: 1, offset: 127 * BLOCK, length: BLOCK }]);
  assert.equal(one.pieces[1].reserve(), -1, "no freed block is left for the library to hand out once more");
});

test("nobody else to ask leaves the block unplaced, and a tail too long or a block nobody holds is not asked", () => {
  const slow = wire("slow", { speed: 1_000 });
  const one = torrent([slow]);
  tail(one, 2, slow, [127]);
  assert.deepEqual(duplicateTailFor(one, 2), { duplicated: 0, missing: 1, wires: 1, unplaced: 1 });

  const fast = wire("fast");
  const two = torrent([slow, fast]);
  tail(two, 0, slow, Array.from({ length: 17 }, (_, at) => 111 + at));
  assert.equal(duplicateTailFor(two, 0).duplicated, 0, "17 blocks missing is a piece still arriving");
  const piece = two.pieces[3];
  for (let block = 0; block < BLOCKS - 1; block += 1) piece.set(piece.reserve(), new Uint8Array(BLOCK), slow);
  assert.equal(duplicateTailFor(two, 3).duplicated, 0, "a block nobody was asked for is the library's to ask");
});

test("the tails are looked at on the events that change them, once a turn, and only for the pieces somebody waits for", () => {
  const slow = wire("slow", { speed: 1_000 }), fast = wire("fast");
  const one = torrent([slow]);
  tail(one, 0, slow, [127]);
  tail(one, 1, slow, [127]);
  const pending = [], wakes = [], lines = [];
  let required = [{ from: 1, to: 1 }];
  const repeat = new TailRepeat({ torrent: one, requiredPieces: () => required,
    schedule: (work) => pending.push(work), wake: (work, ms) => { wakes.push({ work, ms }); return wakes.length; }, clear() {},
    log: (line) => lines.push(line) });
  const run = () => { while (pending.length) pending.shift()(); };
  run();
  assert.equal(wakes.length, 1, "no second peer yet: looked at once more after a wire's queue time");
  assert.equal(wakes[0].ms, 1000);

  one.wires.push(fast);
  one.emit("wire", fast);
  slow.emit("have", 3);
  slow.emit("unchoke");
  assert.equal(pending.length, 1, "several events in one turn are one look");
  run();
  assert.deepEqual(fast.requests, [{ piece: 1, offset: 127 * BLOCK, length: BLOCK }], "piece 0 is not waited for, so it is not asked");
  assert.equal(repeat.totals.duplicated, 1);
  assert.match(lines.at(-1), /piece:blocks\/missing 1:1\/1; 1 block copies asked so far/);

  one.pieces[1].set(127, new Uint8Array(BLOCK), fast);
  one.bitfield.set(1);
  slow.emit("piece", 1, 127 * BLOCK);
  slow.emit("have", 1);
  assert.equal(repeat.totals.lateBlocks, 1, "the copy that came second, and not a peer saying it has the piece");

  required = [];
  run();
  repeat.dispose();
  slow.emit("piece", 0, 0);
  assert.equal(pending.length, 0, "nothing is watched once it is disposed");
});

test("the pieces somebody waits for are the urgent first class, and none while it is conditional", () => {
  const stub = { pieceLength: 1024, files: [{ offset: 0, length: 10 * 1024 }], bitfield: { get: () => false },
    _selections: { _items: [] }, select() {}, deselect() {} };
  const register = new DemandRegister();
  const selection = new SwarmSelection({ torrent: stub, register, findStore: () => null });
  register.state({ claimant: "near", fileIndex: 0, byteStart: 0, byteEnd: 3 * 1024 - 1, urgency: Urgency.NEAR, priority: 100 });
  register.state({ claimant: "ahead", fileIndex: 0, byteStart: 5 * 1024, byteEnd: 6 * 1024 - 1, urgency: Urgency.AHEAD, priority: 99 });
  selection.reconcile();
  assert.deepEqual(selection.requiredPieces(), [{ from: 0, to: 2 }]);
  register.withdraw("near");
  register.withdraw("ahead");
  register.state({ claimant: "tail", fileIndex: 0, byteStart: 7 * 1024, byteEnd: 8 * 1024 - 1, urgency: Urgency.TAIL, priority: 1 });
  selection.reconcile({ speculativeAllowed: true });
  assert.deepEqual(selection.requiredPieces(), []);
});

test("a completed piece, or one no peer can give, is left alone", () => {
  assert.deepEqual(duplicateTailFor({ pieces: [null], wires: [wire("any")], _request: () => true }, 0),
    { duplicated: 0, missing: 0, wires: 0, unplaced: 0 });
  const slow = wire("slow", { speed: 1_000 }), lacking = wire("lacking", { pieces: [] });
  const one = torrent([slow, lacking]);
  tail(one, 0, slow, [127]);
  slow.peerChoking = true;
  assert.equal(duplicateTailFor(one, 0).duplicated, 0, "a choking peer and one without the piece cannot be asked");
});
