/**
 * @file Reading a byte range as positions in shared memory, not as bytes.
 *
 * The pieces already live in a `SharedArrayBuffer` the main thread can map. So
 * the torrent thread does not need to hand over any bytes at all: it can say
 * *where* a piece sits and let the other side read it there. What crosses the
 * boundary is two numbers per piece.
 *
 * That is the whole point of the exercise. The alternative — copying each piece
 * into memory we own and transferring it — costs 18.84 ms per 10 MB segment on
 * the field host, and costs it **on the critical path**, in the thread that is
 * also running the torrent, at the moment a viewer is waiting for that segment.
 * Here the copy is gone entirely rather than moved.
 *
 * Two obligations come with it, and both are enforced rather than assumed:
 *
 *  - a piece being read is **pinned**, so eviction cannot take the memory out
 *    from under the reader mid-read;
 *  - the pin is released only once the other thread reports it has finished
 *    with those bytes — not when they were sent, because nothing was sent.
 */

import { findSharedStore } from "../piece-store/shared-piece-store.js";

/**
 * Wait until a piece has been downloaded and verified.
 *
 * WebTorrent announces this as `verified`. The bitfield is re-checked after the
 * listener is attached because the piece can complete in between, and a missed
 * event here would wait forever.
 *
 * @param {import("webtorrent").Torrent} torrent
 * @param {number} index
 * @param {{ isCancelled: () => boolean }} cancellation
 * @returns {Promise<void>}
 */
function whenPieceReady(torrent, index, cancellation) {
  if (torrent.bitfield?.get(index)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    /** @param {number} verifiedIndex */
    const onVerified = (verifiedIndex) => {
      if (verifiedIndex === index) {
        cleanup();
        resolve();
      }
    };
    const onDestroyed = () => {
      cleanup();
      reject(new Error(`Torrent went away while waiting for piece ${index}.`));
    };
    // Cancellation is polled rather than pushed: a superseded seek destroys the
    // read, and without this the wait would outlive it and hold a pin.
    const poll = setInterval(() => {
      if (cancellation.isCancelled()) {
        cleanup();
        reject(new Error(`Read cancelled while waiting for piece ${index}.`));
      }
    }, 250);

    function cleanup() {
      clearInterval(poll);
      torrent.removeListener("verified", onVerified);
      torrent.removeListener("close", onDestroyed);
    }

    torrent.on("verified", onVerified);
    torrent.once("close", onDestroyed);

    // The piece may have arrived between the check above and this listener.
    if (torrent.bitfield?.get(index)) {
      cleanup();
      resolve();
    }
  });
}

/**
 * A fragment of a read: where to find it, and how to let it go.
 *
 * @typedef {object} PieceFragment
 * @property {number} pieceIndex
 * @property {number} offset - Byte offset into the shared pool.
 * @property {number} length
 * @property {() => void} release - Drops this fragment's pin. Call exactly once.
 */

/**
 * Walk a byte range of a file, yielding each piece's position in shared memory.
 *
 * Yields at most one fragment per piece; the first and last are usually partial.
 * The caller must `release()` every fragment it receives, including on failure —
 * an unreleased pin permanently costs a slot.
 *
 * @param {object} params
 * @param {import("webtorrent").Torrent} params.torrent
 * @param {number} params.fileIndex
 * @param {number} params.start - Inclusive, relative to the file.
 * @param {number} params.end - Inclusive, relative to the file.
 * @param {{ isCancelled: () => boolean }} params.cancellation
 * @returns {AsyncGenerator<PieceFragment>}
 */
export async function* readFragments({ torrent, fileIndex, start, end, cancellation }) {
  const store = findSharedStore(torrent);
  if (!store) {
    throw new Error("This torrent is not backed by a shared piece store.");
  }

  const file = torrent.files?.[fileIndex];
  if (!file) {
    throw new Error(`File ${fileIndex} not found.`);
  }

  const pieceLength = torrent.pieceLength;
  // Piece numbers are torrent-wide, so a file's own offsets have to be lifted
  // into the torrent's address space first.
  const absoluteStart = file.offset + start;
  const absoluteEnd = file.offset + end;
  const firstPiece = Math.floor(absoluteStart / pieceLength);
  const lastPiece = Math.floor(absoluteEnd / pieceLength);

  // Ask for these pieces first. `select` puts them in the download set at all;
  // `critical` marks them as wanted now, which is what allows a piece to be
  // fetched out of sequential order for a reader that is waiting on it.
  if (typeof torrent.select === "function") {
    torrent.select(firstPiece, lastPiece, 1);
  }
  if (typeof torrent.critical === "function") {
    torrent.critical(firstPiece, lastPiece);
  }

  for (let pieceIndex = firstPiece; pieceIndex <= lastPiece; pieceIndex += 1) {
    if (cancellation.isCancelled()) {
      return;
    }

    const pieceStart = pieceIndex * pieceLength;
    const fromWithinPiece = Math.max(absoluteStart, pieceStart) - pieceStart;
    const toWithinPiece = Math.min(absoluteEnd, pieceStart + pieceLength - 1) - pieceStart;

    await whenPieceReady(torrent, pieceIndex, cancellation);

    // Pinned BEFORE it is located, and before any await that could let an
    // eviction run: the offset is only meaningful while the piece is held.
    store.pin(pieceIndex);
    let located = null;
    try {
      located = await store.reside(pieceIndex);
    } catch (error) {
      store.unpin(pieceIndex);
      throw error;
    }

    if (!located) {
      store.unpin(pieceIndex);
      throw new Error(`Piece ${pieceIndex} is verified but absent from the store.`);
    }

    let releasedThisPiece = false;
    yield {
      pieceIndex,
      offset: located.offset + fromWithinPiece,
      length: toWithinPiece - fromWithinPiece + 1,
      release() {
        if (releasedThisPiece) {
          return;
        }
        releasedThisPiece = true;
        store.unpin(pieceIndex);
      }
    };
  }
}
