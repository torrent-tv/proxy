import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { demandFor, reconcileAll, forgetTorrent, downloadForecastOf, forecastSettled, onForecastFailure } from "../../services/torrent/download/registry.js";

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

/** Ask for the forecast, then let the one worked out beside the answer finish. */
async function settled(torrent, options) {
  downloadForecastOf(torrent, options);
  await forecastSettled();
  return downloadForecastOf(torrent, options);
}

/** A wire bringing piece 1 whole in one second. */
function queueOn(torrent) {
  torrent.wires.push({ downloadSpeed: () => 16384, requests: [{ piece: 1, offset: 0, length: 16384 }] });
}

test("a report is answered at once, the forecast following on the next one", async t => {
  // Awaited afresh on every report, the forecast held a waiting viewer's
  // answer 3-11.6 s on a busy Home Assistant (r51, torrent-tv/meta#178).
  const entry = source(t);
  queueOn(entry.torrent);
  state(entry.register, 1);
  assert.equal(downloadForecastOf(entry.torrent), null, "no forecast yet is no forecast, not a wait");
  const forecast = await settled(entry.torrent);
  assert.ok(forecast.arrivals.get(1) > forecast.measuredAt);
});

test("a missing piece whose forecast time has passed is unknown, not held", async t => {
  const entry = source(t);
  queueOn(entry.torrent);
  state(entry.register, 1);
  const { measuredAt, arrivals } = await settled(entry.torrent);
  const due = arrivals.get(1);
  assert.equal(downloadForecastOf(entry.torrent, { now: due - 1 }).arrivals.get(1), due);
  // Its peer now brings it in a minute: the forecast begun on the overdue piece says so.
  entry.torrent.wires[0].downloadSpeed = () => 16384 / 60;
  assert.equal(downloadForecastOf(entry.torrent, { now: due + 1 }).arrivals.get(1), null,
    "its peer stopped and nothing changed; it did not come");
  await forecastSettled();
  const again = downloadForecastOf(entry.torrent, { now: due + 2 });
  assert.ok(again.arrivals.get(1) > due + 50_000, "a piece that did not come has the forecast worked out again");
  entry.held.add(1);
  assert.equal(downloadForecastOf(entry.torrent, { now: measuredAt + 5 }).arrivals.get(1), measuredAt + 5,
    "a piece held now is available now, whatever was forecast");
});

test("a forecast made before the map changed or a piece was withdrawn does not describe the torrent", async t => {
  const entry = source(t);
  queueOn(entry.torrent);
  state(entry.register, 1);
  await settled(entry.torrent);
  state(entry.register, 2);
  assert.equal(downloadForecastOf(entry.torrent), null, "a changed map");
  assert.equal((await settled(entry.torrent)).arrivals.size, 2, "the next forecast follows the new map");
  entry.torrent.emit("piece-withdrawn", 0);
  assert.equal(downloadForecastOf(entry.torrent), null, "a withdrawn piece");
  assert.ok(await settled(entry.torrent));
});

test("a forecast whose map changes while it is worked out is not kept", async t => {
  const entry = source(t);
  state(entry.register, 1);
  downloadForecastOf(entry.torrent);
  state(entry.register, 2);
  await forecastSettled();
  assert.equal(downloadForecastOf(entry.torrent), null);
  await forecastSettled();
  assert.equal(downloadForecastOf(entry.torrent).arrivals.size, 2);
});

test("a failed forecast is said, leaves no rejection, and the next report begins another", async t => {
  const entry = source(t);
  state(entry.register, 1);
  const files = entry.torrent.files;
  let failing = true;
  Object.defineProperty(entry.torrent, "files", { configurable: true,
    get() { if (failing) throw new Error("forecast failure"); return files; } });
  const said = [];
  onForecastFailure(error => said.push(error.message));
  t.after(() => onForecastFailure(() => {}));
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  assert.equal(downloadForecastOf(entry.torrent), null);
  await forecastSettled();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.deepEqual(said, ["forecast failure"]);
  failing = false;
  assert.ok(await settled(entry.torrent), "a later report is answered with a forecast");
});
