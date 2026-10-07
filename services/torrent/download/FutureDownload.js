import { setImmediate as nextTurn } from "node:timers/promises";
import { piecesOf } from "../demand/pieces.js";
import { pieceStoreOf } from "../piece-store-of.js";
import { compareBands } from "./bands.js";

const BLOCK_BYTES = 16 * 1024;

/** Estimate completion from observed queues and the public selection bands.
 * The native picker decides the order within a band, so every unqueued piece
 * uses that band's completion time rather than an invented request order.
 * Pieces without a measured supplier remain unknown. No requests are changed.
 * Times are conditional on the measured rate and successful verification.
 */
export async function futureDownload(entries, { now = Date.now(), findStore = pieceStoreOf, isCurrent = () => true } = {}) {
  if (!isCurrent()) return new Map();
  const forecasts = new Map();
  const pending = [];
  let steps = 0;
  for (const { torrent, register } of entries) {
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
      const remaining = piece?.missing;
      const speed = (torrent.wires ?? []).reduce((sum, wire) => {
        if (wire.destroyed || !wire.peerPieces?.get(index)) return sum;
        const rate = Number(wire.downloadSpeed?.());
        return Number.isFinite(rate) && rate > 0 ? sum + rate : sum;
      }, 0);
      pending.push({ arrivals, index, ...band, seconds:
        Number.isSafeInteger(remaining) && remaining > 0 && remaining <= piece.length && speed > 0
          ? remaining / speed : null });
      if (++steps % 256 === 0) {
        await nextTurn();
        if (!isCurrent()) return new Map();
      }
    }
    forecasts.set(torrent, { measuredAt: now, arrivals });
  }
  pending.sort(compareBands);
  let finish = now;
  for (let start = 0; start < pending.length;) {
    let end = start;
    const first = pending[start];
    while (end < pending.length && compareBands(pending[end], first) === 0) {
      const seconds = pending[end++].seconds;
      finish = finish === null || seconds === null ? null : finish + seconds * 1000;
    }
    for (let i = start; i < end; i++) {
      const { arrivals, index } = pending[i];
      const queuedAt = arrivals.get(index);
      if (finish !== null) arrivals.set(index, queuedAt === null ? finish : Math.min(queuedAt, finish));
    }
    start = end;
  }
  return isCurrent() ? forecasts : new Map();
}
