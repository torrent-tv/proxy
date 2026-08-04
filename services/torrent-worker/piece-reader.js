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
 * How far ahead of the read head pieces are asked for.
 *
 * A read is open-ended — ffmpeg opens its input as `bytes <position>-<EOF>` and
 * keeps it for the whole film — so taking the requested range literally asks
 * for everything from the seek point to the end of the file at once. That is
 * what a seek used to do: the swarm was told the entire tail was wanted, went
 * at it from its first missing piece, and the one piece the decoder was blocked
 * on arrived only when the sequential scan reached it. Measured on a 4.7 GB
 * film: a seek to 89.1% took 93 s and pulled 2.47 GB.
 *
 * So the reader asks for a window and moves it as it goes. The size is a
 * compromise the caller cannot yet express: the right unit is seconds of
 * playback (duration and size are both known — to the transcode session, not to
 * this thread), and 32 MB is about 34 s of a 1080p film but only a few seconds
 * of a disc remux. Sizing it from the real byte rate is a follow-up; what
 * matters here is that it is bounded and moving rather than "to the end".
 */
const READ_WINDOW_BYTES = 32 * 1024 * 1024;

/**
 * How many pieces past the one being waited for are marked critical.
 *
 * `critical` means "a reader is blocked on this now" — it is what lets a piece
 * jump the sequential scan. Marking a whole range critical, as this did, says
 * it about hundreds of pieces at once and the signal stops meaning anything.
 * WebTorrent's own reader marks `min(1 MB / pieceLength, 2)` pieces, i.e. the
 * one under the head and at most two more; the same rule is used here.
 *
 * @param {number} pieceLength
 * @returns {number}
 */
function criticalRunLength(pieceLength) {
  return Math.min(Math.floor((1024 * 1024) / Math.max(1, pieceLength)), 2);
}

/**
 * The pieces a reader at `pieceIndex` wants next, clamped to its own range.
 *
 * @param {{ pieceIndex: number, lastPiece: number, windowPieces: number }} params
 * @returns {{ from: number, to: number }}
 */
export function readWindowFor({ pieceIndex, lastPiece, windowPieces }) {
  const span = Math.max(1, windowPieces);
  return { from: pieceIndex, to: Math.min(lastPiece, pieceIndex + span - 1) };
}

/**
 * Add this reader's window to the download set as a stream selection.
 *
 * `_select`/`_deselect` with the stream flag are what WebTorrent's own
 * `FileIterator` uses; there is no public call for it, because the public
 * `select` produces the merging, interval-subtracted kind whose bookkeeping
 * cannot express "one of several readers wants this". Falls back to the public
 * call if a future version drops the private one.
 *
 * @param {import("webtorrent").Torrent} torrent
 * @param {{ from: number, to: number }} window
 * @returns {void}
 */
function claimWindow(torrent, { from, to }) {
  try {
    if (typeof torrent._select === "function") {
      torrent._select(from, to, 1, null, true);
    } else if (typeof torrent.select === "function") {
      torrent.select(from, to, 1);
    }
  } catch {
    // Best effort — never fail a read because selection bookkeeping refused.
  }
}

/**
 * Take this reader's window back out of the download set.
 *
 * The bounds must match the ones given to {@link claimWindow} exactly: a stream
 * selection is removed by equality, not by overlap.
 *
 * @param {import("webtorrent").Torrent} torrent
 * @param {{ from: number, to: number }} window
 * @returns {void}
 */
function releaseWindow(torrent, { from, to }) {
  try {
    if (typeof torrent._deselect === "function") {
      torrent._deselect(from, to, true);
    } else if (typeof torrent.deselect === "function") {
      torrent.deselect(from, to);
    }
  } catch {
    // Best effort.
  }
}

/**
 * Mark the piece a reader is blocked on, clearing the mark it set before.
 *
 * Criticality is never cleared by WebTorrent itself, so a reader that walked a
 * film would leave every piece of it marked. Only the indices this reader set
 * are cleared, so a second reader's mark on the same piece is not stolen — and
 * the flag is advisory anyway.
 *
 * @param {import("webtorrent").Torrent} torrent
 * @param {number} from
 * @param {number} to
 * @param {{ from: number, to: number } | null} previous
 * @returns {{ from: number, to: number } | null}
 */
function markCritical(torrent, from, to, previous) {
  if (previous && previous.from === from && previous.to === to) {
    return previous;
  }
  if (previous) {
    clearCritical(torrent, previous);
  }
  try {
    torrent.critical?.(from, to);
  } catch {
    return null;
  }
  return { from, to };
}

/**
 * Drop critical marks this reader set.
 *
 * @param {import("webtorrent").Torrent} torrent
 * @param {{ from: number, to: number }} mark
 * @returns {void}
 */
function clearCritical(torrent, { from, to }) {
  if (!Array.isArray(torrent._critical)) {
    return;
  }
  for (let index = from; index <= to; index += 1) {
    torrent._critical[index] = false;
  }
}

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
 * @param {number} [params.windowBytes] - How far ahead of the read head to ask
 *   the swarm for. Defaults to {@link READ_WINDOW_BYTES}; a caller that knows
 *   the media's byte rate should size it in seconds of playback instead.
 * @returns {AsyncGenerator<PieceFragment>}
 */
export async function* readFragments({
  torrent,
  fileIndex,
  start,
  end,
  cancellation,
  windowBytes = READ_WINDOW_BYTES
}) {
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

  // This reader owns what it asks for, and gives it back when it is done. The
  // window is a STREAM selection: those are removed by exact bounds and several
  // identical ones coexist — WebTorrent's own source calls that "in a way a
  // count" — so N readers on one torrent produce the union of their windows,
  // and each one leaving takes away only its own. That is what makes several
  // parallel readers (the codec probe's head and tail, subtitles, one input per
  // viewer) cooperate instead of overwrite each other.
  //
  // The previous code selected the whole requested range, marked all of it
  // critical, and never deselected anything — so ffmpeg's opening
  // `bytes 0-<EOF>` left a permanent selection over the entire file, and no
  // later prioritisation could outrank it.
  const windowPieces = Math.max(1, Math.ceil(Math.max(1, windowBytes) / pieceLength));
  const criticalRun = criticalRunLength(pieceLength);
  /** @type {{ from: number, to: number } | null} */
  let window = null;
  /** @type {{ from: number, to: number } | null} */
  let criticalMark = null;

  const moveWindowTo = (pieceIndex) => {
    const next = readWindowFor({ pieceIndex, lastPiece, windowPieces });
    if (window && window.from === next.from && window.to === next.to) {
      return;
    }
    if (window) {
      releaseWindow(torrent, window);
    }
    claimWindow(torrent, next);
    window = next;
  };

  try {
    for (let pieceIndex = firstPiece; pieceIndex <= lastPiece; pieceIndex += 1) {
      if (cancellation.isCancelled()) {
        return;
      }

      const pieceStart = pieceIndex * pieceLength;
      const fromWithinPiece = Math.max(absoluteStart, pieceStart) - pieceStart;
      const toWithinPiece = Math.min(absoluteEnd, pieceStart + pieceLength - 1) - pieceStart;

      moveWindowTo(pieceIndex);

      if (!torrent.bitfield?.get(pieceIndex)) {
        // Blocked here and now — this is the one case `critical` is meant for.
        criticalMark = markCritical(torrent, pieceIndex, Math.min(lastPiece, pieceIndex + criticalRun), criticalMark);
      }

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
  } finally {
    // Reached on completion, on cancellation, on a throw, and when the consumer
    // stops iterating — a window left behind would keep the swarm fetching for
    // a reader that no longer exists.
    if (window) {
      releaseWindow(torrent, window);
    }
    if (criticalMark) {
      clearCritical(torrent, criticalMark);
    }
  }
}
