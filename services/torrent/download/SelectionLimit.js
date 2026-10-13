/**
 * @file Whether what this proxy let the swarm send was what held it back.
 *
 * A download rate measured while we asked for too little describes our asking,
 * not the swarm: on a cold Matroska the forecast read 0.4-1.3 MB/s, swung from
 * 0.9 s to 19 075 s, and the same swarm later gave 12-14 MB/s
 * (torrent-tv/meta#178). So the rate is split by cause, here, on the torrent's
 * thread, where the connections are.
 *
 * A connection was held back by our selection when three things held at once:
 *
 * 1. the peer let us download (it was not choking us);
 * 2. its queue was short of what WebTorrent keeps on it — the blocks half a
 *    second of its speed carries, at most what the peer accepts (2.8.5
 *    `getBlockPipelineLength` with `PIPELINE_MIN_DURATION`), below which
 *    `_updateWire` asks for more;
 * 3. the peer held a piece the priority map wants and we lack, outside what
 *    the selection states — something it could have sent had we asked.
 *
 * A request still queued does not make a connection busy; a queue topped up is
 * what does. A peer that lacks every piece the map wants, or chokes us, or
 * slows down, is the swarm's own limit and stays in the measurement.
 *
 * An interval of time takes the state found at its start. Totals only grow:
 * whoever reads them takes differences over its own span, so this owner keeps
 * no window of its own. Per connection, the rate it carried while its queue was
 * kept full is kept as what it can carry, for the forecast of single pieces.
 */

import { piecesOf } from "../demand/pieces.js";

const BLOCK_BYTES = 16 * 1024;
/** WebTorrent 2.8.5 `PIPELINE_MIN_DURATION`: the queue is refilled below this many seconds of speed. */
const PIPELINE_MIN_SECONDS = 0.5;

/**
 * Whether WebTorrent would ask this connection for more right now.
 *
 * @param {object} wire
 * @returns {boolean}
 */
export function queueIsShort(wire) {
  let length = 2 + Math.ceil(PIPELINE_MIN_SECONDS * (Number(wire.downloadSpeed?.()) || 0) / BLOCK_BYTES);
  const reqq = wire.peerExtendedHandshake?.reqq;
  if (typeof reqq === "number" && reqq > 0) length = Math.min(length, reqq);
  return (wire.requests?.length ?? 0) < length;
}

export class SelectionLimit {
  #torrent;
  #register;
  #selection;
  #now;
  /** The last sample: when, the torrent's bytes then, and whether it was held back. */
  #last = null;
  #totals = { bytes: 0, ms: 0, freeBytes: 0, freeMs: 0, heldBackMs: 0 };
  /** Per connection: its bytes at the last sample, whether its queue was full, what it carried full. */
  #wires = new WeakMap();
  /** The last sample's held-back connections, for the log. */
  heldBack = 0;

  /**
   * @param {object} params
   * @param {object} params.torrent
   * @param {import("../demand/index.js").DemandRegister} params.register
   * @param {{ statedRanges: () => Array<{ from: number, to: number }> }} params.selection
   * @param {() => number} [params.now]
   */
  constructor({ torrent, register, selection, now = Date.now }) {
    this.#torrent = torrent;
    this.#register = register;
    this.#selection = selection;
    this.#now = now;
  }

  /**
   * Look at every connection once, close the interval since the last look, and
   * open the next with what is found.
   *
   * @returns {void}
   */
  sample() {
    const torrent = this.#torrent;
    if (!torrent || torrent.destroyed) return;
    const at = this.#now();
    const downloaded = Number(torrent.downloaded) || 0;
    if (this.#last !== null && at > this.#last.at) {
      const ms = at - this.#last.at;
      const bytes = Math.max(0, downloaded - this.#last.downloaded);
      this.#totals.bytes += bytes;
      this.#totals.ms += ms;
      if (this.#last.heldBack) this.#totals.heldBackMs += ms;
      else {
        this.#totals.freeBytes += bytes;
        this.#totals.freeMs += ms;
      }
    }
    const unasked = this.#unaskedWants();
    let heldBack = 0;
    for (const wire of torrent.wires ?? []) {
      if (wire.destroyed) continue;
      const short = queueIsShort(wire);
      const seen = this.#wires.get(wire);
      const wireBytes = Number(wire.downloaded) || 0;
      // What a connection carries while its queue stays topped up is what it
      // can carry; a stretch it was short in measures our asking.
      if (seen && seen.full && !short && at > seen.at) {
        seen.capacity = Math.max(0, wireBytes - seen.bytes) * 1000 / (at - seen.at);
      }
      this.#wires.set(wire, { at, bytes: wireBytes, full: !wire.peerChoking && !short, capacity: seen?.capacity ?? null });
      if (wire.peerChoking || !short || unasked.length === 0) continue;
      if (unasked.some(piece => wire.peerPieces?.get?.(piece))) heldBack += 1;
    }
    this.heldBack = heldBack;
    this.#last = { at, downloaded, heldBack: heldBack > 0 };
  }

  /**
   * Grow-only totals: every byte and millisecond sampled, those of intervals
   * no connection was held back in, and the time some was.
   *
   * @returns {{ at: number | null, bytes: number, ms: number, freeBytes: number, freeMs: number, heldBackMs: number }}
   */
  totals() {
    return { at: this.#last?.at ?? null, ...this.#totals };
  }

  /**
   * What a connection carried while its queue was kept full, in bytes per
   * second; null until it has been seen so.
   *
   * @param {object} wire
   * @returns {number | null}
   */
  capacityOf(wire) {
    return this.#wires.get(wire)?.capacity ?? null;
  }

  /** Pieces the map wants, missing here, that the selection does not state, in map order. */
  #unaskedWants() {
    const torrent = this.#torrent;
    const stated = this.#selection.statedRanges();
    const pieces = [];
    const seen = new Set();
    for (const window of this.#register.windows()) {
      const file = torrent.files?.[window.fileIndex];
      if (!file) continue;
      const range = piecesOf({ fileOffset: Number(file.offset), byteStart: window.byteStart,
        byteEnd: Math.min(window.byteEnd, Number(file.length) - 1), pieceLength: Number(torrent.pieceLength) });
      if (!range) continue;
      for (let piece = range.from; piece <= range.to; piece++) {
        if (seen.has(piece)) continue;
        seen.add(piece);
        if (torrent.bitfield?.get?.(piece)) continue;
        if (stated.some(one => piece >= one.from && piece <= one.to)) continue;
        pieces.push(piece);
      }
    }
    return pieces;
  }
}
