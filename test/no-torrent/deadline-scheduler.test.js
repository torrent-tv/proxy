import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DeadlineScheduler, dispatchDownloadCandidates, downloadCandidates, peerRequestCapacity } from "../../services/torrent/download/DeadlineScheduler.js";
import { DemandRegister } from "../../services/torrent/demand/DemandRegister.js";
import { Urgency } from "../../services/torrent/demand/Urgency.js";
import { demandFor, reconcileAll, forgetTorrent, forecastDownloads } from "../../services/torrent/download/registry.js";

function entry({ speed = 0, maximum = 2, order = [] } = {}) {
  const requested = new Set();
  const wire = { requests: [], peerChoking: false, peerPieces: { get: () => true },
    downloadSpeed: () => speed, peerExtendedHandshake: { reqq: maximum },
    cancel(piece, offset, length) { this.requests = this.requests.filter(one => !(one.piece === piece && one.offset === offset && one.length === length)); requested.delete(piece); } };
  const torrent = { ready: true, pieceLength: 16384, files: [{ offset: 0, length: 10 * 16384 }], wires: [wire],
    bitfield: { get: () => false }, _updateWire() {},
    _request(peer, piece) {
      if (requested.has(piece)) return false;
      requested.add(piece);
      peer.requests.push({ piece, offset: 0, length: 16384 });
      order.push(piece);
      return true;
    } };
  return { torrent, register: new DemandRegister(), wire };
}

test("selection publication schedules once after the complete map, then peer updates remain immediate", t => {
  const count = 1000;
  const order = [];
  const one = entry({ order });
  const torrent = one.torrent;
  torrent.files[0].length = count * torrent.pieceLength;
  torrent._selections = { _items: [] };
  torrent._select = (from, to, priority) => {
    torrent._selections._items.push({ from, to, priority });
    torrent._updateWire();
  };
  torrent._deselect = () => {};
  const request = torrent._request;
  torrent._request = (...args) => {
    assert.equal(torrent._selections._items.length, count,
      "peer requests must observe the complete selection publication");
    return request(...args);
  };
  const held = demandFor(torrent);
  t.after(() => forgetTorrent(torrent));
  for (let piece = 0; piece < count; piece++) {
    state(held.register, piece, { deadlineAt: count - piece });
  }
  reconcileAll();
  assert.deepEqual(order, [999, 998]);
  one.wire.requests.length = 0;
  torrent._updateWire();
  assert.deepEqual(order, [999, 998, 997, 996]);
});
function state(register, piece, { deadlineAt = Infinity, priority = 1, urgency = Urgency.NEAR, order = 0 } = {}) {
  register.state({ claimant: `map:${piece}`, fileIndex: 0, byteStart: piece * 16384, byteEnd: piece * 16384 + 16383, urgency, deadlineAt, priority, order });
}

test("a full peer queue stops a large map pass without measuring each candidate again", () => {
  const one = entry();
  let measurements = 0;
  one.wire.downloadSpeed = () => { measurements++; return 0; };
  const candidates = Array.from({ length: 618 }, (_, piece) => ({
    torrent: one.torrent, piece, deadlineAt: Infinity, priority: 1, order: 0
  }));
  assert.equal(dispatchDownloadCandidates(candidates, 0).requested, 2);
  assert.equal(measurements, 1, "one peer rate reading per synchronous pass");
});

test("choked peers do not keep a pass running after the usable queues fill", () => {
  const one = entry();
  const choked = { destroyed: false, peerChoking: true,
    get requests() { throw new Error("a choked peer has no usable request slots"); } };
  one.torrent.wires.push(choked);
  const candidates = Array.from({ length: 618 }, (_, piece) => ({
    torrent: one.torrent, piece, deadlineAt: Infinity, priority: 1, order: 0
  }));
  assert.equal(dispatchDownloadCandidates(candidates, 0).requested, 2);
});

test("peer passes compile unchanged byte demand once but observe every storage arrival and withdrawal", () => {
  const one = entry();
  for (let index = 0; index < 1000; index++) one.register.state({
    claimant: `packet:${index}`, fileIndex: 0, byteStart: index, byteEnd: index,
    urgency: Urgency.NEAR, priority: 100, deadlineAt: index
  });
  let scans = 0, reads = 0, present = false;
  const windows = one.register.windows.bind(one.register);
  one.register.windows = () => { scans++; return windows(); };
  const store = () => ({ locationOf() { reads++; return present ? "memory" : "missing"; } });
  assert.deepEqual(downloadCandidates([one], store).map(candidate => candidate.piece), [0]);
  assert.equal(reads, 1, "all packet windows on one piece need one availability read");
  present = true;
  assert.deepEqual(downloadCandidates([one], store), []);
  present = false;
  assert.deepEqual(downloadCandidates([one], store).map(candidate => candidate.piece), [0]);
  assert.equal(scans, 1, "peer changes do not reread an unchanged map");
  assert.equal(reads, 3, "storage availability is never cached");
  state(one.register, 2, { deadlineAt: -1 });
  assert.deepEqual(downloadCandidates([one], store).map(candidate => candidate.piece), [2, 0]);
  assert.equal(scans, 2, "new map demand replaces the compiled ordering");
  one.register.clear();
  assert.deepEqual(downloadCandidates([one], store), []);
});

test("preparation without deadlines follows the viewer list rather than physical piece order", () => {
  const order = [];
  const one = entry({ order });
  state(one.register, 0, { order: 2 });
  state(one.register, 5, { order: 0 });
  state(one.register, 3, { order: 1 });
  const scheduler = new DeadlineScheduler({ entries: () => [one], findStore: () => null });
  scheduler.reconcile(0);
  assert.deepEqual(order, [5, 3]);
});

test("peer slots match the library formula and the advertised request limit", () => {
  const { torrent, wire } = entry({ speed: 65536, maximum: 100 });
  assert.equal(peerRequestCapacity(torrent, wire), 6);
  wire.peerExtendedHandshake.reqq = 3;
  assert.equal(peerRequestCapacity(torrent, wire), 3);
});

test("deadline and priority fill real free slots without urgency bands", () => {
  const order = [];
  const one = entry({ order });
  state(one.register, 0, { deadlineAt: 500, priority: 100 });
  state(one.register, 2, { deadlineAt: 100, priority: 1, urgency: Urgency.TAIL });
  state(one.register, 1, { deadlineAt: 100, priority: 80 });
  const scheduler = new DeadlineScheduler({ entries: () => [one], findStore: () => null });
  assert.deepEqual(scheduler.reconcile(0), { requested: 2, reassigned: 0 });
  assert.deepEqual(order, [1, 2]);
});

test("pieces removed from storage remain eligible despite a stale bitfield", () => {
  const one = entry();
  one.torrent.bitfield.get = () => true;
  state(one.register, 1);
  const scheduler = new DeadlineScheduler({ entries: () => [one], findStore: () => ({ locationOf: () => "missing" }) });
  assert.equal(scheduler.reconcile(0).requested, 1);
});

test("a faster peer takes a block whose old queue misses its deadline", () => {
  const one = entry({ speed: 16384, maximum: 10 });
  state(one.register, 1, { deadlineAt: 100 });
  one.torrent._request(one.wire, 1);
  const fast = { ...one.wire, requests: [], downloadSpeed: () => 163840 };
  one.torrent.wires.push(fast);
  const scheduler = new DeadlineScheduler({ entries: () => [one], findStore: () => null });
  assert.deepEqual(scheduler.reconcile(0), { requested: 1, reassigned: 1 });
  assert.equal(one.wire.requests.length, 0);
  assert.equal(fast.requests[0].piece, 1);
});

test("an unknown peer rate cannot prove its pending request will miss a deadline", () => {
  const one = entry({ speed: 0, maximum: 10 });
  state(one.register, 1, { deadlineAt: 100 });
  one.torrent._request(one.wire, 1);
  one.torrent.wires.push({ ...one.wire, requests: [], downloadSpeed: () => 163840 });
  const scheduler = new DeadlineScheduler({ entries: () => [one], findStore: () => null });
  assert.deepEqual(scheduler.reconcile(0), { requested: 0, reassigned: 0 });
  assert.equal(one.wire.requests[0].piece, 1);
});

test("changing rates cannot repeatedly move a pending block to a later arrival", () => {
  const one = entry({ speed: 16384, maximum: 10 });
  state(one.register, 1, { deadlineAt: 100 });
  one.torrent._request(one.wire, 1);
  const fast = { ...one.wire, requests: [], downloadSpeed: () => 163840 };
  one.torrent.wires.push(fast);
  const scheduler = new DeadlineScheduler({ entries: () => [one], findStore: () => null });
  assert.equal(scheduler.reconcile(0).reassigned, 1);
  fast.downloadSpeed = () => 16384;
  one.wire.downloadSpeed = () => 163840;
  for (let now = 200; now <= 2000; now += 200) {
    assert.equal(scheduler.reconcile(now).reassigned, 0);
    assert.equal(fast.requests[0].piece, 1);
  }
  // The protocol timeout releases the reservation and a fresh request can use
  // the faster peer without inheriting the obsolete request's estimate.
  fast.cancel(1, 0, 16384);
  assert.equal(scheduler.reconcile(2100).requested, 1);
  assert.equal(one.wire.requests[0].piece, 1);
});

test("registry schedules its real-shaped torrent and restores its callback on removal", () => {
  const one = entry();
  const original = one.torrent._updateWire;
  const registered = demandFor(one.torrent);
  state(registered.register, 1, { urgency: Urgency.TAIL });
  try {
    reconcileAll();
    assert.equal(one.wire.requests[0].piece, 1);
    assert.notEqual(one.torrent._updateWire, original);
  } finally { forgetTorrent(one.torrent); }
  assert.equal(one.torrent._updateWire, original);
  assert.equal(one.wire.requests.length, 0);
});

test("withdrawing a held piece schedules it immediately and removal clears byte listeners", () => {
  const one = entry({ speed: 16384 });
  Object.setPrototypeOf(one.torrent, EventEmitter.prototype);
  EventEmitter.call(one.torrent);
  let held = true;
  one.torrent.bitfield.get = () => held;
  const registered = demandFor(one.torrent);
  state(registered.register, 1);
  try {
    reconcileAll();
    assert.equal(one.wire.requests.length, 0);
    held = false;
    one.torrent.emit("piece-withdrawn", 1);
    assert.equal(one.wire.requests[0].piece, 1);
  } finally { forgetTorrent(one.torrent); }
  assert.equal(one.torrent.listenerCount("verified"), 0);
  assert.equal(one.torrent.listenerCount("piece-withdrawn"), 0);
});

test("changed map demand cannot return an obsolete future snapshot", async () => {
  const one = entry({ speed: 16384 });
  one.torrent.pieces = Array.from({ length: 10 }, () => ({ length: 16384, missing: 16384 }));
  const registered = demandFor(one.torrent);
  try {
    state(registered.register, 1);
    const pending = forecastDownloads();
    state(registered.register, 2);
    assert.equal((await pending).has(one.torrent), false);
    const current = await forecastDownloads();
    assert.equal(current.get(one.torrent).arrivals.size, 2);
  } finally { forgetTorrent(one.torrent); }
});

test("storage withdrawal invalidates a future snapshot even when priorities are unchanged", async () => {
  const one = entry({ speed: 16384 });
  Object.setPrototypeOf(one.torrent, EventEmitter.prototype);
  EventEmitter.call(one.torrent);
  one.torrent.pieces = Array.from({ length: 10 }, () => ({ length: 16384, missing: 16384 }));
  const registered = demandFor(one.torrent);
  try {
    state(registered.register, 1);
    const pending = forecastDownloads();
    one.torrent.emit("piece-withdrawn", 1);
    assert.equal((await pending).has(one.torrent), false);
  } finally { forgetTorrent(one.torrent); }
});
