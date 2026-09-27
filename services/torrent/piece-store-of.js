/**
 * @file The piece store behind a torrent, reached through what it does.
 *
 * WebTorrent wraps the store it was given in stores of its own, each holding
 * the next one as `store`, so the store the torrent component talks to is found
 * by walking that chain. It is recognised by the interface this component uses
 * — which pieces the readers have asked to keep (`protectedRanges`) — and not by
 * its class: the torrent component does not import the storage component's
 * implementation, it is handed it where the thread is assembled
 * (`worker/worker.js`).
 */

/** How deep WebTorrent's own wrappers are allowed to go before the walk gives up. */
const WRAPPER_DEPTH = 8;

/**
 * @param {{ store?: object } | null | undefined} torrent
 * @returns {object | null}
 */
export function pieceStoreOf(torrent) {
  let candidate = torrent?.store;
  for (let depth = 0; candidate && depth < WRAPPER_DEPTH; depth += 1) {
    if (typeof candidate.protectedRanges === "function") {
      return candidate;
    }
    candidate = candidate.store;
  }
  return null;
}
