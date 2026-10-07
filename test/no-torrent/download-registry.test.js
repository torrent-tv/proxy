import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { demandFor, reconcileAll, forgetTorrent, forecastDownloads } from "../../services/torrent/download/registry.js";

function source(t) {
  const torrent = new EventEmitter();
  const held = new Set();
  Object.assign(torrent, { ready: true, pieceLength: 16384, files: [{ offset: 0, length: 3 * 16384 }],
    wires: [], pieces: Array.from({ length: 3 }, () => ({ length: 16384, missing: 16384 })),
    bitfield: { get: piece => held.has(piece) }, _selections: { _items: [] },
    _updateWire() {}, _request() { assert.fail("only WebTorrent may request protocol blocks"); },
    select(from, to, priority) { this._selections._items.push({ from, to, priority }); },
    deselect(from, to) { this._selections._items = this._selections._items.filter(one => one.from !== from || one.to !== to); },
    critical() {} });
  const entry = demandFor(torrent);
  t.after(() => forgetTorrent(torrent));
  return { torrent, held, ...entry };
}
function state(register, piece, urgency = 1, priority = 100) {
  register.state({ claimant: `viewer:${piece}`, fileIndex: 0, byteStart: piece * 16384,
    byteEnd: (piece + 1) * 16384 - 1, urgency, priority });
}

test("registration and selection leave WebTorrent's methods unchanged", t => {
  const { torrent, register } = source(t);
  const original = torrent._updateWire;
  state(register, 1);
  reconcileAll();
  assert.equal(torrent._updateWire, original);
  assert.deepEqual(torrent._selections._items, [{ from: 1, to: 1, priority: 1 }]);
  forgetTorrent(torrent);
  assert.equal(torrent._updateWire, original);
  assert.equal(torrent.listenerCount("verified"), 0);
  assert.equal(torrent.listenerCount("piece-withdrawn"), 0);
});

test("urgent demand suppresses another torrent's background until verification", t => {
  const first = source(t), second = source(t);
  state(first.register, 1, 0);
  state(second.register, 2, 3);
  reconcileAll();
  assert.equal(second.torrent._selections._items.length, 0);
  first.held.add(1);
  first.torrent.emit("verified", 1);
  assert.deepEqual(second.torrent._selections._items, [{ from: 2, to: 2, priority: 0 }]);
});

test("withdrawal republishes a satisfied range without a method replacement", t => {
  const entry = source(t);
  state(entry.register, 1);
  entry.held.add(1);
  reconcileAll();
  assert.equal(entry.torrent._selections._items.length, 0);
  entry.held.delete(1);
  entry.torrent.emit("piece-withdrawn", 1);
  assert.deepEqual(entry.torrent._selections._items, [{ from: 1, to: 1, priority: 1 }]);
});

test("changed demand or withdrawn storage invalidates an in-flight forecast", async t => {
  const entry = source(t);
  state(entry.register, 1);
  const changed = forecastDownloads();
  state(entry.register, 2);
  assert.equal((await changed).has(entry.torrent), false);
  const withdrawn = forecastDownloads();
  entry.torrent.emit("piece-withdrawn", 1);
  assert.equal((await withdrawn).has(entry.torrent), false);
  assert.equal((await forecastDownloads()).get(entry.torrent).arrivals.size, 2);
});

test("required times order equal-priority groups across torrents", t => {
  const first = source(t), second = source(t);
  for (const [entry, deadlineAt] of [[first, 10000], [second, 20000]]) entry.register.state({
    claimant: "viewer", fileIndex: 0, byteStart: 16384, byteEnd: 32767,
    urgency: 1, priority: 100, deadlineAt });
  reconcileAll();
  assert.equal(first.torrent._selections._items.length, 1);
  assert.equal(second.torrent._selections._items.length, 0);
  first.held.add(1);
  first.torrent.emit("verified", 1);
  assert.equal(second.torrent._selections._items.length, 1);
});
