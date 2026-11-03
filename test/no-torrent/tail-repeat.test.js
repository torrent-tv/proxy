/**
 * @file Late-tail policy and WebTorrent adapter against fake torrents only.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Piece from "torrent-piece";

import { TailRepeat } from "../../services/torrent/download/TailRepeat.js";
import { WebTorrentTailRepeatAdapter } from "../../services/torrent/worker/WebTorrentTailRepeatAdapter.js";
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
function tail(one, index, holder, missing, askedAt = null) {
  const piece = one.pieces[index];
  for (let block = 0; block < BLOCKS; block += 1) {
    assert.equal(piece.reserve(), block);
    if (missing.includes(block)) {
      const request = { piece: index, offset: block * BLOCK, length: BLOCK };
      if (askedAt !== null) request.askedAt = askedAt;
      holder.requests.push(request);
    } else piece.set(block, new Uint8Array(BLOCK), holder);
  }
}

function repeat(one, requiredPieces, options = {}) {
  const pending = [];
  const wakes = [];
  const lines = [];
  const adapter = new WebTorrentTailRepeatAdapter(one);
  const subject = new TailRepeat({ adapter, requiredPieces, schedule: (work) => pending.push(work),
    wake: (work, ms) => { wakes.push({ work, ms }); return wakes.length; }, clear() {},
    log: (line) => lines.push(line), ...options });
  return {
    subject, adapter, pending, wakes, lines,
    run() { while (pending.length) pending.shift()(); }
  };
}

test("the urgent tail is repeated once to a second peer and never to a third", () => {
  const slow = wire("slow", { speed: 1_000 }), fast = wire("fast"), other = wire("other", { speed: 50_000 });
  const one = torrent([slow, fast, other]);
  tail(one, 0, slow, [126, 127]);
  const state = repeat(one, () => [{ from: 0, to: 0 }]);
  state.run();
  assert.deepEqual(fast.requests.map(request => request.offset / BLOCK).sort(), [126, 127]);
  assert.equal(state.subject.totals.duplicated, 2);
  for (let look = 0; look < 5; look += 1) { state.subject.poke(); state.run(); }
  assert.equal(other.requests.length, 0, "two copies in flight are the existing limit");
  state.subject.dispose();
});

test("a full peer queue is passed over and its freed reservation is restored", () => {
  const slow = wire("slow", { speed: 1_000 }), full = wire("full", { queue: 0 }), spare = wire("spare", { speed: 50_000 });
  const one = torrent([slow, full, spare]);
  tail(one, 1, slow, [127]);
  const state = repeat(one, () => [{ from: 1, to: 1 }]);
  state.run();
  assert.deepEqual(spare.requests, [{ piece: 1, offset: 127 * BLOCK, length: BLOCK }]);
  assert.equal(one.pieces[1].reserve(), -1, "no freed reservation is left for an uncounted copy");
  state.subject.dispose();
});

test("when every alternative queue refuses, the original reservation remains accounted for", () => {
  const slow = wire("slow", { speed: 1_000 }), full = wire("full", { queue: 0 });
  const one = torrent([slow, full]);
  tail(one, 1, slow, [127]);
  const state = repeat(one, () => [{ from: 1, to: 1 }]);
  state.run();
  assert.deepEqual(full.requests, []);
  assert.equal(one.pieces[1].reserve(), -1, "the refused ask returned its reservation to the piece");
  state.subject.dispose();
});

test("long tails, unrequested blocks and pieces outside requiredPieces stay with the picker", () => {
  const slow = wire("slow", { speed: 1_000 }), fast = wire("fast");
  const one = torrent([slow, fast]);
  tail(one, 0, slow, Array.from({ length: 17 }, (_, at) => 111 + at));
  tail(one, 1, slow, [127]);
  const piece = one.pieces[2];
  for (let block = 0; block < BLOCKS - 1; block += 1) piece.set(piece.reserve(), new Uint8Array(BLOCK), slow);
  const state = repeat(one, () => [{ from: 0, to: 0 }]);
  state.run();
  assert.equal(fast.requests.length, 0, "only a selected required piece can be repeated");
  state.subject.dispose();
});

test("events are coalesced, only the current urgent class is repeated, and completion is counted", () => {
  const slow = wire("slow", { speed: 1_000 }), fast = wire("fast");
  const one = torrent([slow]);
  tail(one, 0, slow, [127]);
  tail(one, 1, slow, [127]);
  let required = [{ from: 1, to: 1 }];
  const state = repeat(one, () => required);
  state.run();
  assert.deepEqual(state.wakes.map(({ ms }) => ms), [1000]);

  one.wires.push(fast);
  one.emit("wire", fast);
  slow.emit("have", 3);
  slow.emit("unchoke");
  assert.equal(state.pending.length, 1, "several events in one turn are one look");
  state.run();
  assert.deepEqual(fast.requests, [{ piece: 1, offset: 127 * BLOCK, length: BLOCK }]);
  assert.equal(state.subject.totals.duplicated, 1);

  one.pieces[1].set(127, new Uint8Array(BLOCK), fast);
  one.bitfield.set(1);
  slow.emit("piece", 1, 127 * BLOCK);
  assert.equal(state.subject.totals.lateBlocks, 1);
  const firstArrival = one.pieces[1]._buffer[127];
  one.pieces[1].set(127, new Uint8Array(BLOCK).fill(7), slow);
  assert.equal(one.pieces[1]._buffer[127], firstArrival, "a duplicate block cannot overwrite the first arrival");

  required = [];
  state.subject.poke();
  state.run();
  assert.equal(fast.requests.length, 1, "withdrawal prevents later repeats");
  state.subject.dispose();
  slow.emit("piece", 0, 0);
  assert.equal(state.pending.length, 0, "dispose removes event listeners");
});

test("the selected pieces are the urgent first class and none while it is conditional", () => {
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

test("no repeat happens before a request is one queue old, then it is tried at that boundary", () => {
  const slow = wire("slow", { speed: 1_000 }), fast = wire("fast");
  const one = torrent([slow, fast]);
  tail(one, 1, slow, [127], 10_000);
  let now = 10_400;
  const state = repeat(one, () => [{ from: 1, to: 1 }], { now: () => now });
  state.run();
  assert.equal(fast.requests.length, 0);
  assert.deepEqual(state.wakes.map(({ ms }) => ms), [600]);
  now = 11_000;
  state.wakes[0].work();
  state.run();
  assert.equal(fast.requests.length, 1);
  state.subject.dispose();
});

test("withdrawal before an already scheduled look and disposal after it suppress both", () => {
  const slow = wire("slow", { speed: 1_000 }), fast = wire("fast");
  const one = torrent([slow, fast]);
  tail(one, 0, slow, [127]);
  let required = [{ from: 0, to: 0 }];
  const state = repeat(one, () => required);
  required = [];
  state.run();
  assert.equal(fast.requests.length, 0, "the map is read when work runs");

  required = [{ from: 0, to: 0 }];
  state.subject.poke();
  state.subject.dispose();
  state.run();
  assert.equal(fast.requests.length, 0, "disposed work cannot issue a repeat");
});

test("missing private APIs fall back to ordinary picking with one bounded diagnostic", () => {
  const lines = [];
  const adapter = new WebTorrentTailRepeatAdapter({ pieces: [{ _buffer: [], _chunks: 1 }], wires: [] });
  const state = new TailRepeat({ adapter, requiredPieces: () => [{ from: 0, to: 0 }],
    schedule: (work) => work(), log: (line) => lines.push(line) });
  state.poke();
  state.poke();
  assert.deepEqual(lines, ["tail: bounded repeat unavailable; using WebTorrent's ordinary picker"]);
  state.dispose();
});
