import { piecesOf } from "../demand/pieces.js";
import { pieceStoreOf } from "../piece-store-of.js";

/** The block length and one-second request allowance used by WebTorrent. */
const BLOCK_BYTES = 16 * 1024;
const compiledDemand = new WeakMap();
const requestArrivals = new WeakMap();

/** Keep the same reassignment evidence in an isolated forecast request. */
export function copyRequestArrival(source, target) {
  if (requestArrivals.has(source)) requestArrivals.set(target, requestArrivals.get(source));
  return target;
}

function requestArrival(wire, request, now) {
  if (!requestArrivals.has(request)) {
    const speed = Number(wire.downloadSpeed?.());
    let bytes = 0;
    for (const queued of wire.requests ?? []) {
      bytes += queued.length;
      if (queued === request) break;
    }
    requestArrivals.set(request, speed > 0 ? now + bytes / speed * 1000 : Infinity);
  }
  return requestArrivals.get(request);
}

export function peerRequestCapacity(torrent, wire, speed = Math.max(0, Number(wire.downloadSpeed?.()) || 0)) {
  if (wire.type === "webSeed") {
    return Math.min(1 + Math.ceil(speed / torrent.pieceLength), torrent.maxWebConns);
  }
  let capacity = 2 + Math.ceil(speed / BLOCK_BYTES);
  const maximum = wire.peerExtendedHandshake?.reqq;
  if (Number.isFinite(maximum) && maximum > 0) capacity = Math.min(capacity, Math.floor(maximum));
  return capacity;
}

export function requestCompletionAt(wire, bytes, now, speed = Number(wire.downloadSpeed?.())) {
  if (!(speed > 0)) return Number.POSITIVE_INFINITY;
  const queued = (wire.requests ?? []).reduce((total, request) => total + request.length, 0);
  return now + (queued + bytes) / speed * 1000;
}

export function peerCanServe(wire, piece) {
  return !wire.destroyed && (!wire.peerChoking || (wire.hasFast && wire.peerAllowedFastSet?.includes(piece))) &&
    wire.peerPieces?.get(piece);
}

function peerCanRequest(wire) {
  return !wire.destroyed &&
    (!wire.peerChoking || (wire.hasFast && wire.peerAllowedFastSet?.length > 0));
}

/** Identical map ordering for present requests and conditional future requests. */
export function compareDownloadCandidates(a, b) {
  return a.deadlineAt - b.deadlineAt || b.priority - a.priority || a.order - b.order || a.piece - b.piece;
}

/** One ordering across torrents; peers retain protocol-owned block verification. */
export class DeadlineScheduler {
  #entries;
  #running = false;
  #store;

  constructor({ entries, findStore = pieceStoreOf }) {
    this.#entries = entries;
    this.#store = findStore;
  }

  reconcile(now = Date.now(), { torrent = null, wire = null } = {}) {
    if (this.#running) return { requested: 0, reassigned: 0 };
    // WebTorrent updates each peer in turn. A full or choked peer cannot issue
    // a request, so its heartbeat must not scan every file's byte availability.
    if (wire && (!peerCanRequest(wire) ||
      (wire.requests?.length ?? 0) >= peerRequestCapacity(torrent, wire))) {
      return { requested: 0, reassigned: 0 };
    }
    this.#running = true;
    try {
      const entries = [...this.#entries()].filter(entry => !torrent || entry.torrent === torrent);
      return dispatchDownloadCandidates(downloadCandidates(entries, this.#store), now, { wire });
    } finally {
      this.#running = false;
    }
  }
}


/** The published map defines the same candidates for every scheduling pass. */
export function downloadCandidates(entries, findStore = pieceStoreOf) {
  const candidates = [];
  for (const { torrent, register } of entries) {
    if (torrent.destroyed || torrent.ready === false || typeof torrent._request !== "function") continue;
    const store = findStore(torrent);
    let compiled = compiledDemand.get(register);
    if (!Number.isSafeInteger(register.revision) || compiled?.revision !== register.revision ||
        compiled.torrent !== torrent || compiled.files !== torrent.files || compiled.pieceLength !== torrent.pieceLength) {
      const byPiece = new Map();
      for (const window of register.windows()) {
        const file = torrent.files?.[window.fileIndex];
        if (!file) continue;
        const range = piecesOf({ fileOffset: file.offset, byteStart: window.byteStart, byteEnd: Math.min(window.byteEnd, file.length - 1), pieceLength: torrent.pieceLength });
        if (!range) continue;
        for (let piece = range.from; piece <= range.to; piece++) {
          const prior = byPiece.get(piece);
          if (!prior || window.deadlineAt < prior.deadlineAt ||
            (window.deadlineAt === prior.deadlineAt && (window.priority > prior.priority ||
              (window.priority === prior.priority && window.order < prior.order)))) {
            byPiece.set(piece, { torrent, piece, deadlineAt: window.deadlineAt, priority: window.priority, order: window.order, requestId: window.requestId });
          }
        }
      }
      compiled = { torrent, revision: register.revision, files: torrent.files,
        pieceLength: torrent.pieceLength, pieces: [...byPiece.values()] };
      compiledDemand.set(register, compiled);
    }
    for (const candidate of compiled.pieces) {
      const present = store?.locationOf ? store.locationOf(candidate.piece) !== "missing" : torrent.bitfield?.get(candidate.piece);
      if (!present) candidates.push(candidate);
    }
  }
  candidates.sort(compareDownloadCandidates);
  return candidates;
}

/** Run against protocol peers or an isolated future-state copy. */
export function dispatchDownloadCandidates(candidates, now, { wire: changedWire = null } = {}) {
  let requested = 0, reassigned = 0;
  // Rates and advertised limits cannot change during this synchronous pass.
  // Read each peer once, and only inspect torrents once regardless of map size.
  const readings = new Map();
  const readingOf = (torrent, wire) => {
    let reading = readings.get(wire);
    if (!reading) {
      const speed = Math.max(0, Number(wire.downloadSpeed?.()) || 0);
      readings.set(wire, reading = { speed, capacity: peerRequestCapacity(torrent, wire, speed) });
    }
    return reading;
  };
  const available = (torrent, wire) => peerCanRequest(wire) &&
    (wire.requests?.length ?? 0) < readingOf(torrent, wire).capacity;
  const completionAt = (torrent, wire, bytes) =>
    requestCompletionAt(wire, bytes, now, readingOf(torrent, wire).speed);
  const writable = new Map();
  for (const torrent of new Set(candidates.map(candidate => candidate.torrent))) {
    const peers = (changedWire ? [changedWire] : torrent.wires ?? [])
      .filter(wire => available(torrent, wire));
    if (peers.length) writable.set(torrent, peers);
  }
  for (const candidate of candidates) {
    if (!writable.size) break;
    const { torrent, piece, deadlineAt, requestId } = candidate;
    if (!writable.has(torrent)) continue;
    const peers = writable.get(torrent);
    const wires = peers.filter(wire => peerCanServe(wire, piece) && available(torrent, wire));
    while (wires.length) {
      wires.sort((a, b) => completionAt(torrent, a, BLOCK_BYTES) - completionAt(torrent, b, BLOCK_BYTES) ||
        (a.requests?.length ?? 0) - (b.requests?.length ?? 0));
      const wire = wires[0];
      const before = wire.requests?.length ?? 0;
      let accepted = torrent._request(wire, piece, false);
      if (!accepted && Number.isFinite(deadlineAt)) {
        const fasterAt = completionAt(torrent, wire, BLOCK_BYTES);
        for (const slower of torrent.wires ?? []) {
          if (slower === wire || typeof slower.cancel !== "function") continue;
          const lateAt = completionAt(torrent, slower, 0);
          if (!Number.isFinite(lateAt) || !(lateAt > deadlineAt && fasterAt < lateAt)) continue;
          const request = slower.requests?.find(one => one.piece === piece);
          if (!request) continue;
          // A later queue estimate must not move the same block between peers
          // indefinitely. Reassignment must improve its previous arrival;
          // protocol completion or timeout ends this request's evidence.
          if (!(fasterAt < requestArrival(slower, request, now))) continue;
          slower.cancel(piece, request.offset, request.length);
          reassigned++;
          torrent.emit?.("download-request-cancelled", { ...request, reason: "deadline-reassigned", requestId });
          accepted = torrent._request(wire, piece, false);
          if (accepted) {
            const replacement = wire.requests?.find(one => one.piece === piece && one.offset === request.offset);
            if (replacement) requestArrivals.set(replacement, fasterAt);
          }
          if (accepted) break;
        }
      }
      if (accepted) {
        requested++;
        torrent.emit?.("download-requested", { piece, deadlineAt, requestId, peer: wire.remoteAddress, queued: wire.requests?.length ?? 0 });
      }
      if (!accepted || (wire.requests?.length ?? 0) <= before ||
        (wire.requests?.length ?? 0) >= readingOf(torrent, wire).capacity) wires.shift();
    }
    if (!peers.some(wire => available(torrent, wire))) writable.delete(torrent);
  }
  return { requested, reassigned };
}
