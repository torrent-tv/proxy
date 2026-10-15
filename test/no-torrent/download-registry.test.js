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

test("the first class spans torrents and withholds lower classes everywhere", t => {
  const first = source(t), second = source(t), third = source(t);
  for (const [entry, deadlineAt] of [[first, 10000], [second, 20000]]) entry.register.state({
    claimant: "viewer", fileIndex: 0, byteStart: 16384, byteEnd: 32767,
    urgency: 1, priority: 100, deadlineAt });
  state(third.register, 2, 2, 40);
  reconcileAll();
  assert.deepEqual(first.torrent._selections._items, [{ from: 1, to: 1, priority: 1 }]);
  assert.deepEqual(second.torrent._selections._items, [{ from: 1, to: 1, priority: 1 }],
    "a later deadline in the first class is not withheld");
  assert.deepEqual(third.torrent._selections._items, []);
  first.held.add(1);
  second.held.add(1);
  first.torrent.emit("verified", 1);
  assert.deepEqual(third.torrent._selections._items, [{ from: 2, to: 2, priority: 1 }]);
});

test("a report is answered with the last finished forecast while a newer one is worked out", async t => {
  // Awaited afresh on every report, the forecast held a waiting viewer's
  // answer 3-11.6 s on a busy Home Assistant (r51, torrent-tv/meta#178).
  const entry = source(t);
  state(entry.register, 1);
  // Each turn lets the forecast worked out beside the answers run.
  const next = async () => { await new Promise(resolve => setImmediate(resolve)); return forecastDownloads(); };
  let first;
  do first = await next(); while (!first.has(entry.torrent));
  state(entry.register, 2);
  const answered = await forecastDownloads();
  assert.equal(answered, first, "the finished forecast answers at once");
  let newer;
  do newer = await next(); while (newer === first);
  assert.equal(newer.get(entry.torrent).arrivals.size, 2, "and the newer one follows the changed map");
  entry.held.add(1);
  entry.torrent.emit("verified", 1);
  let afterArrival;
  do afterArrival = await next(); while (afterArrival === newer);
  assert.ok(afterArrival.has(entry.torrent), "an arrived piece has the forecast worked out again");
});
