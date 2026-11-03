/**
 * @file The narrow WebTorrent 2.8.5 adapter used by torrent/download/TailRepeat.
 *
 * This is the only live caller allowed to inspect piece buffers and wire
 * queues, or to touch Piece.cancel/reserve and Torrent._request for bounded
 * late-tail repetition. Keep library-private assumptions here and update the
 * compatibility check when the pinned WebTorrent/torrent-piece pair changes.
 */

const BLOCK_BYTES = 1 << 14;

function speedOf(wire) {
  try {
    const speed = wire?.downloadSpeed?.();
    return Number.isFinite(speed) ? speed : 0;
  } catch {
    return 0;
  }
}

function usableWires(torrent, pieceIndex) {
  const wires = Array.isArray(torrent?.wires) ? torrent.wires : [];
  return wires.filter((wire) => {
    // WebTorrent's _request uses reserveRemaining/chunkLengthRemaining for a
    // webseed, which requests the piece suffix rather than one bounded block.
    if (!wire || wire.type === "webSeed" || wire.destroyed || wire.peerChoking) return false;
    try {
      return wire.peerPieces?.get?.(pieceIndex) === true;
    } catch {
      return false;
    }
  }).sort((left, right) => speedOf(right) - speedOf(left));
}

function requestCoversBlock(request, pieceIndex, blockIndex, chunks) {
  if (request?.piece !== pieceIndex || !Number.isFinite(request.offset) || request.offset < 0) return false;
  const firstBlock = Math.floor(request.offset / BLOCK_BYTES);
  // A request without a length is an incompatible observation. Count it
  // conservatively through the piece's end rather than allowing extra copies.
  const lastBlock = Number.isFinite(request.length) && request.length > 0
    ? Math.min(chunks - 1, Math.ceil((request.offset + request.length) / BLOCK_BYTES) - 1)
    : chunks - 1;
  return blockIndex >= firstBlock && blockIndex <= lastBlock;
}

/**
 * Adapts a live WebTorrent Torrent to the small observation/action contract
 * needed by TailRepeat. It does not choose which piece or block to repeat.
 */
export class WebTorrentTailRepeatAdapter {
  #torrent;
  #disabled = false;

  /** @param {object} torrent A WebTorrent Torrent instance. */
  constructor(torrent) {
    this.#torrent = torrent;
  }

  /** Disable the exception after an incompatible private API is observed. */
  disable() {
    this.#disabled = true;
  }

  /**
   * Read missing blocks and their in-flight copy count/age.
   *
   * @param {number} pieceIndex
   * @param {number} maxMissing Upper bound supplied by the download policy; a
   *   larger tail is reported by count without allocating a per-block list.
   * @returns {{ available: boolean, missingCount: number, blocks: Array<{ index: number, copies: number, firstAskedAt: number|null }> }}
   */
  observe(pieceIndex, maxMissing) {
    const torrent = this.#torrent;
    const piece = torrent?.pieces?.[pieceIndex];
    // Completed pieces are removed from Torrent.pieces; a piece with no
    // allocated block buffer has no request in flight, so neither is a tail.
    if (!piece) return { available: true, missingCount: 0, blocks: [] };
    const buffer = Array.isArray(piece?._buffer) ? piece._buffer : null;
    if (!buffer) return { available: true, missingCount: 0, blocks: [] };
    if (this.#disabled || typeof piece.cancel !== "function" || typeof torrent?._request !== "function") {
      this.#disabled = true;
      return { available: false, missingCount: 0, blocks: [] };
    }

    const chunks = Number.isFinite(piece._chunks) ? piece._chunks : buffer.length;
    let missingCount = Number.isFinite(piece._buffered) ? chunks - piece._buffered : 0;
    if (!Number.isFinite(piece._buffered)) {
      for (let index = 0; index < chunks; index += 1) if (!buffer[index]) missingCount += 1;
    }
    if (missingCount === 0 || missingCount > maxMissing) {
      return { available: true, missingCount, blocks: [] };
    }

    const blocks = [];
    for (let index = 0; index < chunks; index += 1) {
      if (buffer[index]) continue;
      blocks.push({ index, copies: 0, firstAskedAt: null });
    }
    for (const wire of Array.isArray(torrent.wires) ? torrent.wires : []) {
      for (const request of Array.isArray(wire?.requests) ? wire.requests : []) {
        for (const block of blocks) {
          if (!requestCoversBlock(request, pieceIndex, block.index, chunks)) continue;
          block.copies += 1;
          const askedAt = Number.isFinite(request.askedAt) ? request.askedAt : Number.NEGATIVE_INFINITY;
          block.firstAskedAt = block.firstAskedAt === null ? askedAt : Math.min(block.firstAskedAt, askedAt);
        }
      }
    }
    return { available: true, missingCount, blocks };
  }

  /**
   * Try one repeat for an already-selected, already-aged missing block.
   * Returns a status instead of throwing so an incompatible private API cannot
   * stop ordinary downloading. Every refusal restores the reservation.
   *
   * @param {number} pieceIndex
   * @param {number} blockIndex
   * @returns {"placed"|"refused"|"unavailable"}
   */
  repeatBlock(pieceIndex, blockIndex) {
    const torrent = this.#torrent;
    const piece = torrent?.pieces?.[pieceIndex];
    const buffer = Array.isArray(piece?._buffer) ? piece._buffer : null;
    if (this.#disabled || !piece || !buffer || buffer[blockIndex] || typeof piece.cancel !== "function" ||
        typeof piece.reserve !== "function" || typeof torrent?._request !== "function") {
      return "unavailable";
    }

    const candidates = usableWires(torrent, pieceIndex);
    const chunks = Number.isFinite(piece._chunks) ? piece._chunks : buffer.length;
    if (candidates.length === 0) return "refused";

    for (const wire of candidates) {
      if ((wire.requests ?? []).some((request) => requestCoversBlock(request, pieceIndex, blockIndex, chunks))) continue;

      try {
        piece.cancel(blockIndex);
      } catch {
        this.#disabled = true;
        return "unavailable";
      }

      let placed = false;
      try {
        // false prevents WebTorrent's hotswap from freeing a third reservation.
        placed = torrent._request(wire, pieceIndex, false) === true;
      } catch {
        // A thrown private call may have queued the request before failing.
        placed = (wire.requests ?? []).some((request) => request?.piece === pieceIndex &&
          Math.floor(request.offset / BLOCK_BYTES) === blockIndex);
        if (!placed) {
          try {
            if (piece.reserve() !== blockIndex) this.#disabled = true;
          } catch { this.#disabled = true; }
        }
        this.#disabled = true;
        return placed ? "placed" : "unavailable";
      }
      if (placed) return "placed";

      // _request refused before reserving. Claim the freed block back so the
      // normal picker cannot see an unaccounted reservation.
      try {
        if (piece.reserve() !== blockIndex) {
          this.#disabled = true;
          return "unavailable";
        }
      } catch {
        this.#disabled = true;
        return "unavailable";
      }
    }
    return "refused";
  }

  /** Subscribe to changes that can alter tail observations. */
  watch(onChange, onLateBlock = () => {}) {
    const torrent = this.#torrent;
    const watched = new Map();
    const poke = () => onChange();
    const forget = (wire) => {
      const listeners = watched.get(wire);
      if (!listeners) return;
      wire.removeListener?.("piece", listeners.onBlock);
      for (const event of ["unchoke", "have", "bitfield"]) wire.removeListener?.(event, listeners.onPeer);
      wire.removeListener?.("close", listeners.onClose);
      watched.delete(wire);
    };
    const watchWire = (wire) => {
      if (!wire || watched.has(wire) || typeof wire.on !== "function") return;
      const listeners = {
        onBlock: (index) => {
          if (Number.isInteger(index) && torrent.bitfield?.get?.(index)) onLateBlock();
          poke();
        },
        onPeer: poke,
        onClose: () => { forget(wire); poke(); }
      };
      watched.set(wire, listeners);
      wire.on("piece", listeners.onBlock);
      for (const event of ["unchoke", "have", "bitfield"]) wire.on(event, listeners.onPeer);
      wire.once?.("close", listeners.onClose);
      poke();
    };
    const onWire = watchWire;
    torrent.on?.("wire", onWire);
    torrent.on?.("verified", poke);
    for (const wire of Array.isArray(torrent.wires) ? torrent.wires : []) watchWire(wire);
    return () => {
      torrent.removeListener?.("wire", onWire);
      torrent.removeListener?.("verified", poke);
      for (const wire of [...watched.keys()]) forget(wire);
    };
  }
}
