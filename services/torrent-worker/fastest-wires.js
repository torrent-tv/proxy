/**
 * @file Put the piece a reader is blocked on onto the fastest wires that hold
 * it.
 *
 * Measured 2026-08-17: the swarm delivered 5.1-5.9 MB/s against a film consumed
 * at about 1 MB/s — a fivefold surplus — and the reader still blocked 47 times
 * in two minutes, 1.0-4.5 s each. So the shortage is not bandwidth. The piece
 * that blocked had been requested from a median of five peers, and what set the
 * tail was WHICH wire held the last outstanding block: a block is reserved for
 * exactly one wire, and the read finishes when the slowest holder delivers.
 *
 * What the library already does, and what it does not: `torrent.critical()`
 * (which the reader already sets over its window) enables HOTSWAP — an idle
 * wire may take a block away from the SLOWEST holder. It does not duplicate:
 * `piece.reserve()` returns -1 once every block is spoken for, and the
 * end-game that would ask a second peer for the same block is commented out in
 * `webtorrent/lib/torrent.js`. Hotswap therefore fires only when the library's
 * own picker happens to visit an idle wire while our piece is critical.
 *
 * This asks for it on purpose, and chooses who: the wires that are unchoked,
 * hold the piece and are measurably fastest are handed the piece through the
 * same entry the library's picker uses, with hotswap enabled. Nothing is
 * duplicated and no protocol rule is bent — the block moves to a faster holder
 * instead of staying with whoever got it first.
 */

/**
 * The library's own request entry. Internal, so its absence must be noticed
 * rather than swallowed: without it this lever silently does nothing.
 *
 * @param {object} torrent
 * @returns {boolean}
 */
export function canPlaceRequests(torrent) {
  return typeof torrent?._request === "function";
}

/**
 * Wires that could deliver this piece right now, fastest first.
 *
 * Excluded, each for its own reason: a wire that is choking us cannot be asked
 * at all; one that does not hold the piece has nothing to give; a destroyed one
 * is a corpse. Speed is the library's own measurement over its own window, so
 * nothing here needs a history of its own.
 *
 * @param {object} torrent
 * @param {number} pieceIndex
 * @returns {object[]}
 */
export function wiresForPiece(torrent, pieceIndex) {
  const wires = Array.isArray(torrent?.wires) ? torrent.wires : [];
  const usable = [];
  for (const wire of wires) {
    if (!wire || wire.destroyed || wire.peerChoking) {
      continue;
    }
    if (wire.peerPieces?.get?.(pieceIndex) !== true) {
      continue;
    }
    usable.push(wire);
  }
  return usable.sort((left, right) => speedOf(right) - speedOf(left));
}

/**
 * A wire's measured download speed in bytes per second, or 0 when it has not
 * been measured. Wrapped because `downloadSpeed` is a method on the wire and a
 * throw from a destroyed one must not take the caller with it.
 *
 * @param {object} wire
 * @returns {number}
 */
function speedOf(wire) {
  try {
    const speed = wire?.downloadSpeed?.();
    return Number.isFinite(speed) ? speed : 0;
  } catch {
    // A wire that cannot say how fast it is ranks last, which is the honest
    // answer — and the caller's own log line reports how many were asked.
    return 0;
  }
}

/**
 * Ask the fastest holders of `pieceIndex` for it.
 *
 * @param {object} torrent
 * @param {number} pieceIndex
 * @param {number} [limit] - How many wires to push it onto.
 * @returns {{ asked: number, considered: number, fastestBytesPerSecond: number }}
 *   `asked` counts requests the library actually placed: it refuses when a
 *   wire's pipeline is full or when nothing can be reserved even with hotswap,
 *   and that refusal is information — a piece nobody can be asked for is
 *   waiting on the wire, not on the picker.
 */
export function askFastestWiresFor(torrent, pieceIndex, limit = 3) {
  if (!canPlaceRequests(torrent) || !Number.isInteger(pieceIndex) || pieceIndex < 0) {
    return { asked: 0, considered: 0, fastestBytesPerSecond: 0 };
  }
  const candidates = wiresForPiece(torrent, pieceIndex);
  let asked = 0;
  for (const wire of candidates.slice(0, Math.max(1, limit))) {
    try {
      // `true` is hotswap: if every block is reserved, take one from the
      // slowest holder. That is the whole point — the reader is blocked
      // precisely because a slow holder has one.
      if (torrent._request(wire, pieceIndex, true) === true) {
        asked += 1;
      }
    } catch (error) {
      // Internal call: report it once per attempt rather than letting the lever
      // fail in silence.
      throw new Error(`could not place a request for piece ${pieceIndex}: ${error?.message ?? error}`);
    }
  }
  return {
    asked,
    considered: candidates.length,
    fastestBytesPerSecond: candidates.length > 0 ? speedOf(candidates[0]) : 0
  };
}
