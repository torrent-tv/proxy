import { setImmediate as nextTurn } from "node:timers/promises";
import { downloadCandidates, dispatchDownloadCandidates, peerCanServe, peerRequestCapacity, copyRequestArrival } from "./DeadlineScheduler.js";

const BLOCK_BYTES = 16 * 1024;

/** Replay the actual request scheduler against copied protocol state only. */
export async function futureDownload(entries, { now = Date.now(), findStore, replayOnly = false, isCurrent = () => true } = {}) {
  if (!isCurrent()) return new Map();
  const candidates = downloadCandidates(entries, findStore);
  const copies = new Map();
  let clock = now;
  for (const candidate of candidates) {
    const source = candidate.torrent;
    let copy = copies.get(source);
    if (!copy) {
      copy = { pieceLength: source.pieceLength, maxWebConns: source.maxWebConns, states: new Map(), wires: [], arrivals: new Map() };
      copies.set(source, copy);
      for (const peer of source.wires ?? []) {
        if (peer.destroyed || (!peer.requests?.length && peer.peerChoking && !peer.hasFast)) continue;
        const speed = Math.max(0, Number(peer.downloadSpeed?.()) || 0);
        const available = new Set(candidates.filter(one => one.torrent === source && peer.peerPieces?.get(one.piece)).map(one => one.piece));
        if (!available.size && !peer.requests?.length) continue;
        const wire = { type: peer.type, destroyed: peer.destroyed, peerChoking: peer.peerChoking,
          hasFast: peer.hasFast, peerAllowedFastSet: [...(peer.peerAllowedFastSet ?? [])], peerPieces: { get: piece => available.has(piece) },
          peerExtendedHandshake: { reqq: peer.peerExtendedHandshake?.reqq }, downloadSpeed: () => speed,
          requests: (peer.requests ?? []).map(request => copyRequestArrival(request,
            { piece: request.piece, offset: request.offset, length: request.length, remaining: request.length })) };
        wire.cancel = (piece, offset, length) => {
          const index = wire.requests.findIndex(request => request.piece === piece && request.offset === offset && request.length === length);
          if (index < 0) return;
          wire.requests.splice(index, 1);
          const state = copy.states.get(piece);
          for (let block = offset / BLOCK_BYTES; state && block * BLOCK_BYTES < offset + length; block++) {
            state.reserved.delete(block);
            state.cursor = Math.min(state.cursor, block);
          }
        };
        copy.wires.push(wire);
      }
      copy._request = (wire, piece) => {
        const state = copy.states.get(piece);
        if (!state || state.complete) return false;
        let block = state.cursor;
        while (block < state.count && (state.present.has(block) || state.reserved.has(block))) block++;
        if (block === state.count) return false;
        const offset = block * BLOCK_BYTES;
        const length = wire.type === "webSeed" ? state.length - offset : Math.min(BLOCK_BYTES, state.length - offset);
        for (let index = block; index * BLOCK_BYTES < offset + length; index++) state.reserved.add(index);
        state.cursor = Math.ceil((offset + length) / BLOCK_BYTES);
        wire.requests.push({ piece, offset, length, remaining: length });
        return true;
      };
    }
    const piece = source.pieces?.[candidate.piece];
    if (!piece || !Number.isSafeInteger(piece.length) || piece.length <= 0 ||
        (piece.missing !== piece.length && !Array.isArray(piece._buffer))) {
      copy.arrivals.set(candidate.piece, null);
      continue;
    }
    const count = Math.ceil(piece.length / BLOCK_BYTES);
    const present = new Set();
    for (let block = 0; block < count; block++) if (piece._buffer?.[block]) present.add(block);
    const reserved = new Set();
    for (const wire of copy.wires) for (const request of wire.requests) {
      if (request.piece !== candidate.piece) continue;
      for (let block = request.offset / BLOCK_BYTES; block * BLOCK_BYTES < request.offset + request.length; block++) reserved.add(block);
    }
    copy.states.set(candidate.piece, { length: piece.length, count, present, reserved, cursor: 0, complete: false });
  }
  const ordered = candidates.filter(candidate => copies.get(candidate.torrent).states.has(candidate.piece))
    .map(candidate => ({ ...candidate, torrent: copies.get(candidate.torrent) }));
  dispatchDownloadCandidates(ordered, clock);
  const solved = new Set();
  if (!replayOnly) for (const copy of copies.values()) {
    if (copy.wires.length === 1 && !copy.wires[0].destroyed) {
      finishSinglePeer(copy, ordered.filter(candidate => candidate.torrent === copy), now);
      solved.add(copy);
    }
  }
  const replay = ordered.filter(candidate => !solved.has(candidate.torrent));
  const pendingCandidates = new Set(replay);
  const candidateByCopy = new Map();
  for (const candidate of replay) {
    let pieces = candidateByCopy.get(candidate.torrent);
    if (!pieces) candidateByCopy.set(candidate.torrent, pieces = new Map());
    pieces.set(candidate.piece, candidate);
  }
  const wires = [...copies.values()].filter(copy => !solved.has(copy)).flatMap(copy => copy.wires.map(wire => ({ copy, wire })));
  let steps = 0;
  while (pendingCandidates.size) {
    dispatchDownloadCandidates([...pendingCandidates], clock);
    let next = null, delay = Infinity;
    for (const entry of wires) {
      const { wire } = entry;
      if (!wire.requests.length || !(wire.downloadSpeed() > 0)) continue;
      const arrivesIn = wire.requests[0].remaining / wire.downloadSpeed() * 1000;
      if (arrivesIn < delay) { delay = arrivesIn; next = entry; }
    }
    if (!next || !Number.isFinite(delay)) break;
    clock += delay;
    for (const { copy, wire } of wires) {
      const request = wire.requests[0];
      if (!request) continue;
      request.remaining = Math.max(0, request.remaining - delay / 1000 * wire.downloadSpeed());
      if (wire === next.wire) request.remaining = 0;
      if (request.remaining > 0) continue;
      wire.requests.shift();
      const state = copy.states.get(request.piece);
      if (!state || state.complete) continue;
      for (let block = request.offset / BLOCK_BYTES; block * BLOCK_BYTES < request.offset + request.length; block++) {
        state.present.add(block);
        state.reserved.delete(block);
      }
      if (state.present.size === state.count) {
        state.complete = true;
        state.present.clear();
        state.reserved.clear();
        copy.arrivals.set(request.piece, clock);
        pendingCandidates.delete(candidateByCopy.get(copy)?.get(request.piece));
      }
    }
    if (++steps % 256 === 0) {
      await nextTurn();
      if (!isCurrent()) return new Map();
    }
  }
  return new Map([...copies].map(([torrent, copy]) => {
    for (const piece of copy.states.keys()) if (!copy.arrivals.has(piece)) copy.arrivals.set(piece, null);
    return [torrent, { measuredAt: now, arrivals: copy.arrivals }];
  }));
}

/** With one peer there is no reassignment: its FIFO consumes the common map
 * order. Sum that unchanged order instead of replaying every block arrival. */
function finishSinglePeer(copy, candidates, now) {
  const wire = copy.wires[0];
  const speed = wire.downloadSpeed();
  if (!(speed > 0) || !(peerRequestCapacity(copy, wire) > 0)) return;
  let at = now;
  for (const request of wire.requests) {
    at += request.length / speed * 1000;
    const state = copy.states.get(request.piece);
    if (!state || state.complete) continue;
    for (let block = request.offset / BLOCK_BYTES; block * BLOCK_BYTES < request.offset + request.length; block++) {
      state.present.add(block);
      state.reserved.delete(block);
    }
    if (state.present.size === state.count) {
      state.complete = true;
      state.present.clear();
      state.reserved.clear();
      copy.arrivals.set(request.piece, at);
    }
  }
  for (const { piece } of candidates) {
    const state = copy.states.get(piece);
    if (state.complete || !peerCanServe(wire, piece)) continue;
    let missing = 0;
    for (let block = 0; block < state.count; block++) {
      if (!state.present.has(block)) missing += Math.min(BLOCK_BYTES, state.length - block * BLOCK_BYTES);
    }
    at += missing / speed * 1000;
    state.complete = true;
    copy.arrivals.set(piece, at);
  }
}
