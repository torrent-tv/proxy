import { setImmediate as nextTurn } from "node:timers/promises";
import { piecesOf } from "../demand/pieces.js";
import { pieceStoreOf } from "../piece-store-of.js";
import { compareBands } from "./bands.js";

const BLOCK_BYTES = 16 * 1024;

/** Estimate completion from observed queues and the public selection bands.
 * The native picker takes a band's pieces from its first up (the `sequential`
 * strategy), so an unqueued piece arrives after the band's pieces before it.
 * A piece whose every missing block is asked for arrives when its queues say,
 * and is not the band's to share out. A supplier is a peer that can be asked
 * for the piece now. Pieces without a measured supplier remain unknown. No
 * requests are changed.
 * Times are conditional on the measured rate and successful verification.
 */
export async function futureDownload(entries, { now = Date.now(), findStore = pieceStoreOf, isCurrent = () => true } = {}) {
  if (!isCurrent()) return new Map();
  const forecasts = new Map();
  const pending = [];
  let steps = 0;
  for (const { torrent, register, limit = null } of entries) {
    if (torrent.destroyed || torrent.ready === false) continue;
    const wanted = new Map();
    for (const window of register.windows()) {
      const file = torrent.files?.[window.fileIndex];
      if (!file) continue;
      const range = piecesOf({ fileOffset: file.offset, byteStart: window.byteStart,
        byteEnd: Math.min(window.byteEnd, file.length - 1), pieceLength: torrent.pieceLength });
      if (!range) continue;
      for (let piece = range.from; piece <= range.to; piece++) {
        const previous = wanted.get(piece);
        if (!previous || compareBands(window, previous) < 0) {
          wanted.set(piece, { urgency: window.urgency, priority: window.priority, deadlineAt: window.deadlineAt });
        }
        if (++steps % 256 === 0) {
          await nextTurn();
          if (!isCurrent()) return new Map();
        }
      }
    }
    const queued = new Map();
    for (const wire of torrent.wires ?? []) {
      if (wire.destroyed) continue;
      const speed = Number(wire.downloadSpeed?.());
      if (!Number.isFinite(speed) || speed <= 0) continue;
      let bytes = 0;
      for (const request of wire.requests ?? []) {
        if (!Number.isSafeInteger(request.length) || request.length <= 0) continue;
        bytes += request.length;
        const piece = torrent.pieces?.[request.piece];
        if (!wanted.has(request.piece) || !piece || !Number.isSafeInteger(request.offset) ||
            request.offset < 0 || request.offset % BLOCK_BYTES !== 0 ||
            request.offset + request.length > piece.length ||
            ((request.offset + request.length) % BLOCK_BYTES !== 0 && request.offset + request.length !== piece.length)) continue;
        let blocks = queued.get(request.piece);
        if (!blocks) queued.set(request.piece, blocks = new Map());
        const at = now + bytes / speed * 1000;
        for (let block = request.offset / BLOCK_BYTES; block * BLOCK_BYTES < request.offset + request.length; block++) {
          blocks.set(block, Math.min(blocks.get(block) ?? Infinity, at));
        }
      }
    }
    const store = findStore(torrent);
    const arrivals = new Map();
    for (const [index, band] of wanted) {
      const present = store?.locationOf ? store.locationOf(index) !== "missing" : torrent.bitfield?.get(index);
      if (present) {
        arrivals.set(index, now);
        continue;
      }
      const piece = torrent.pieces?.[index];
      let at = now;
      if (!piece || !Number.isSafeInteger(piece.length) || piece.length <= 0 ||
          (piece.missing !== piece.length && !Array.isArray(piece._buffer))) at = null;
      else for (let block = 0; block * BLOCK_BYTES < piece.length; block++) {
        const length = Math.min(BLOCK_BYTES, piece.length - block * BLOCK_BYTES);
        if (piece._buffer?.[block]?.length === length) continue;
        const arrival = queued.get(index)?.get(block);
        if (!Number.isFinite(arrival)) { at = null; break; }
        at = Math.max(at, arrival);
      }
      arrivals.set(index, at);
      // EVERY MISSING BLOCK ASKED FOR: the queues holding them say when it
      // arrives. Each block is reserved to the wire it was asked of, so a faster
      // peer elsewhere does not bring it sooner, and its bytes are not the
      // band's to share out (torrent-tv/meta#178 review, WebTorrent 2.8.5
      // `_request`, torrent.js:1758).
      if (at !== null) {
        if (++steps % 256 === 0) {
          await nextTurn();
          if (!isCurrent()) return new Map();
        }
        continue;
      }
      const remaining = piece?.missing;
      const holders = [];
      for (const wire of torrent.wires ?? []) {
        // Only a peer that can be asked for it now: one choking us is asked for
        // nothing outside the pieces it allows, whatever it carried before.
        if (wire.destroyed || !wire.peerPieces?.get(index) || !mayAsk(wire, index)) continue;
        // What it carried with its queue kept full, where it has been seen so:
        // its speed while our selection gave it little measures our asking
        // (`SelectionLimit`, torrent-tv/meta#178).
        const rate = Number(limit?.capacityOf?.(wire) ?? wire.downloadSpeed?.());
        if (Number.isFinite(rate) && rate > 0) holders.push({ wire, rate });
      }
      pending.push({ arrivals, index, ...band, holders, remaining:
        Number.isSafeInteger(remaining) && remaining > 0 && remaining <= piece.length && holders.length > 0
          ? remaining : null });
      if (++steps % 256 === 0) {
        await nextTurn();
        if (!isCurrent()) return new Map();
      }
    }
    forecasts.set(torrent, { measuredAt: now, arrivals });
  }
  // WITHIN A BAND, IN THE ORDER THE PIECES COME. The picker walks each
  // selection from its first piece up (WebTorrent 2.8.5's default `sequential`
  // strategy, which this proxy keeps), so a piece of a band arrives once those
  // before it have. Charged the whole band's end instead, a band of many
  // segments — the map states one per stretch of a level since 2.97.27 — would
  // put its nearest piece at its farthest piece's time (torrent-tv/meta#178).
  //
  // AND IN PARALLEL WHERE THE PEERS DIFFER. A piece is brought by the peers
  // holding it, each from when it has brought what was asked of it before, and
  // no sooner than the measured supply of every peer that holds a piece still
  // to come carries all the bytes ahead of it. Summed one piece after another
  // at its own holders' speed, a two-hour film whose far pieces each had a few
  // unchoked holders was forecast to arrive in 127 838 s at 2.33 MB/s, and a
  // seek was held for 39 s on it (r49, torrent-tv/meta#178). One holder for
  // every piece gives the sum it was; a piece nobody can be asked for still
  // leaves every piece after it unknown.
  pending.sort((left, right) => compareBands(left, right) || left.index - right.index);
  const supply = new Map();
  for (const { holders } of pending) for (const { wire, rate } of holders) supply.set(wire, rate);
  const total = [...supply.values()].reduce((sum, rate) => sum + rate, 0);
  const freeAt = new Map();
  let ahead = 0;
  let known = true;
  for (const { arrivals, index, holders, remaining } of pending) {
    if (!known || remaining === null || !(total > 0)) {
      known = false;
      continue;
    }
    ahead += remaining;
    const finish = Math.max(sharedFinish(holders, freeAt, remaining, now), now + ahead / total * 1000);
    for (const { wire } of holders) freeAt.set(wire, Math.max(freeAt.get(wire) ?? now, finish));
    arrivals.set(index, finish);
  }
  return isCurrent() ? forecasts : new Map();
}

/**
 * When peers bringing `bytes` together finish: each starts when it is free
 * and brings at its own rate, so the finish is where their combined bytes
 * reach `bytes` (the earliest of them working alone at first, more joining as
 * they come free).
 *
 * @param {Array<{ wire: object, rate: number }>} holders - Bytes per second.
 * @param {Map<object, number>} freeAt - Milliseconds.
 * @param {number} bytes
 * @param {number} now - Milliseconds.
 * @returns {number} Milliseconds.
 */
function sharedFinish(holders, freeAt, bytes, now) {
  const starts = holders.map(({ wire, rate }) => ({ at: Math.max(now, freeAt.get(wire) ?? now), rate }))
    .sort((left, right) => left.at - right.at);
  let rate = 0;
  let weighted = 0;
  for (let index = 0; index < starts.length; index++) {
    rate += starts[index].rate;
    weighted += starts[index].rate * starts[index].at;
    const finish = (bytes * 1000 + weighted) / rate;
    if (index === starts.length - 1 || finish <= starts[index + 1].at) return finish;
  }
  return now;
}

/**
 * Whether this peer can be asked for this piece now: it is not choking us, or
 * it allows this piece while it does (BEP 6, WebTorrent 2.8.5 `_updateWire`).
 *
 * @param {{ peerChoking?: boolean, hasFast?: boolean, peerAllowedFastSet?: number[] }} wire
 * @param {number} index
 * @returns {boolean}
 */
function mayAsk(wire, index) {
  if (wire.peerChoking !== true) return true;
  return wire.hasFast === true && Array.isArray(wire.peerAllowedFastSet) && wire.peerAllowedFastSet.includes(index);
}
