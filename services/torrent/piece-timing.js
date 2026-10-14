/**
 * @file When each piece was asked of the swarm, and how long its blocks were
 * in flight (torrent-tv/meta#178).
 *
 * The order in which pieces were verified cannot say why one came last: it
 * may have been asked for late, or asked for early with its last blocks held
 * by slow peers, and the two need different fixes. Field 2026-10-14: the
 * first input of a 1080p MKV waited 18.7 s for pieces 1 and 2, verified after
 * pieces 3-33. WebTorrent states no outgoing request, so the torrent pool
 * tells this record each block it asks and each block that arrives; the
 * record answers once, when the piece is verified, and then forgets it.
 */

/**
 * @typedef {object} PieceTiming
 * @property {number} askedAgoMs - From the first block asked to the verification.
 * @property {number} asks - Blocks asked, duplicates included.
 * @property {number} peers - Distinct peers asked.
 * @property {number} slowestMs - The longest a block was in flight, from its first ask to its arrival.
 * @property {string | null} slowestPeer - Who sent that block.
 * @property {number} lastInFlightMs - How long the block that completed the piece was in flight.
 * @property {string | null} lastPeer - Who sent it.
 */

export class PieceTimings {
  /** @type {Map<number, { firstAskAt: number, asks: number, peers: Set<string>, blocks: Map<number, number>, slowestMs: number, slowestPeer: string | null, lastInFlightMs: number, lastPeer: string | null }>} */
  #pieces = new Map();

  /**
   * A block of `piece` at `offset` was asked of `peer`.
   *
   * @param {number} piece
   * @param {number} offset
   * @param {string} peer
   * @param {number} now
   */
  asked(piece, offset, peer, now) {
    let record = this.#pieces.get(piece);
    if (!record) {
      record = { firstAskAt: now, asks: 0, peers: new Set(), blocks: new Map(), slowestMs: 0, slowestPeer: null, lastInFlightMs: 0, lastPeer: null };
      this.#pieces.set(piece, record);
    }
    record.asks += 1;
    record.peers.add(peer);
    if (!record.blocks.has(offset)) record.blocks.set(offset, now);
  }

  /**
   * A block of `piece` at `offset` arrived from `peer`. A block never asked
   * through this record — it is not one of ours — says nothing.
   *
   * @param {number} piece
   * @param {number} offset
   * @param {string} peer
   * @param {number} now
   */
  arrived(piece, offset, peer, now) {
    const record = this.#pieces.get(piece);
    const askedAt = record?.blocks.get(offset);
    if (askedAt === undefined) return;
    const inFlightMs = now - askedAt;
    if (inFlightMs >= record.slowestMs) {
      record.slowestMs = inFlightMs;
      record.slowestPeer = peer;
    }
    record.lastInFlightMs = inFlightMs;
    record.lastPeer = peer;
  }

  /**
   * The timing of `piece`, verified at `now`, or null when no block of it was
   * asked through this record; forgotten either way.
   *
   * @param {number} piece
   * @param {number} now
   * @returns {PieceTiming | null}
   */
  verified(piece, now) {
    const record = this.#pieces.get(piece);
    this.#pieces.delete(piece);
    if (!record) return null;
    return {
      askedAgoMs: now - record.firstAskAt,
      asks: record.asks,
      peers: record.peers.size,
      slowestMs: record.slowestMs,
      slowestPeer: record.slowestPeer,
      lastInFlightMs: record.lastInFlightMs,
      lastPeer: record.lastPeer
    };
  }
}

/**
 * The timing said after a verified piece.
 *
 * @param {PieceTiming | null} timing
 * @returns {string}
 */
export function describePieceTiming(timing) {
  if (!timing) return "";
  return `; first block asked ${(timing.askedAgoMs / 1000).toFixed(1)}s before, ${timing.asks} block ask(s) to ${timing.peers} peer(s), ` +
    `slowest block ${(timing.slowestMs / 1000).toFixed(1)}s in flight from ${timing.slowestPeer ?? "?"}, ` +
    `the last one ${(timing.lastInFlightMs / 1000).toFixed(1)}s from ${timing.lastPeer ?? "?"}`;
}
