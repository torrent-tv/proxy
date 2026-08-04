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
import { logger } from "../../utils/logger.js";

/** Only waits at least this long are reported; sequential reading stays silent. */
const PIECE_WAIT_LOG_MS = 1_000;

/** Distinguishes concurrent readers to the piece store. Never reused. */
let readerSequence = 0;

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
 * @param {number} [priority] - 1 for what a reader needs next, 0 for the
 *   background fill of the rest of the file.
 * @returns {void}
 */
function claimWindow(torrent, { from, to }, priority = 1) {
  try {
    if (typeof torrent._select === "function") {
      torrent._select(from, to, priority, null, true);
    } else if (typeof torrent.select === "function") {
      torrent.select(from, to, priority);
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
  /** @type {{ from: number, to: number } | null} */
  let window = null;
  /** @type {{ from: number, to: number } | null} */
  let criticalMark = null;
  /**
   * The rest of the file, claimed at the lowest priority so it is fetched with
   * whatever capacity the near window does not need. Null whenever it must not
   * be fetched at all — see {@link updateBackfill}.
   *
   * @type {{ from: number, to: number } | null}
   */
  let backfill = null;

  // Identity of this read, so the store can tell one reader's window from
  // another's. Each read gets its own; `readerSequence` never repeats within a
  // process.
  const readerId = `read-${(readerSequence += 1)}`;

  /**
   * Whether every piece of the current window is already downloaded.
   *
   * A handful of pieces, checked against the bitfield, so this is cheap enough
   * to re-run on every window move.
   *
   * @returns {boolean}
   */
  const windowIsComplete = () => {
    if (!window) {
      return false;
    }
    for (let index = window.from; index <= window.to; index += 1) {
      if (!torrent.bitfield?.get(index)) {
        return false;
      }
    }
    return true;
  };

  /**
   * Keep the rest of the file downloading in the background, but ONLY while
   * that cannot cost the viewer anything.
   *
   * The rule is deliberately blunt rather than clever: the tail is in the
   * download set only when every piece of the near window is already on hand.
   * The moment one is missing — the window slid onto undownloaded content, or a
   * seek moved it somewhere new — the tail leaves the set, so the swarm has
   * nothing else to work on. Relying on WebTorrent's priority ordering alone
   * would be weaker: it decides which selection a wire is offered FIRST, not
   * what a wire already has outstanding, so a seek would still queue behind
   * whatever tail blocks were in flight.
   *
   * Priority 0 against the window's 1 is kept as well, for the moments between
   * one evaluation and the next.
   *
   * What this buys: a file watched for a while ends up downloaded, and every
   * later seek into it is instant. What it costs: the pool owner's bandwidth
   * and disk for a film the viewer may abandon — which is why it never runs
   * ahead of the viewer's own needs.
   *
   * @returns {void}
   */
  const updateBackfill = () => {
    const wanted = window && window.to < lastPiece && windowIsComplete()
      ? { from: window.to + 1, to: lastPiece }
      : null;
    if (backfill && (!wanted || backfill.from !== wanted.from || backfill.to !== wanted.to)) {
      releaseWindow(torrent, backfill);
      backfill = null;
    }
    if (wanted && !backfill) {
      claimWindow(torrent, wanted, 0);
      backfill = wanted;
    }
  };

  const moveWindowTo = (pieceIndex) => {
    const next = readWindowFor({ pieceIndex, lastPiece, windowPieces });
    if (window && window.from === next.from && window.to === next.to) {
      updateBackfill();
      return;
    }
    const isJump = !window || next.from > window.to || next.from < window.from;
    // Whatever was being fetched for later stops being wanted the instant the
    // window moves: the new position has to have the whole swarm to itself.
    if (backfill) {
      releaseWindow(torrent, backfill);
      backfill = null;
    }
    if (window) {
      releaseWindow(torrent, window);
    }
    claimWindow(torrent, next);
    window = next;
    // Tell the store these pieces are wanted, so it evicts something else.
    // Without it the piece the decoder reads next looks exactly as stale as one
    // the encoder fetched forty minutes ahead, and the second kind is what
    // fills the store while the encoder runs ahead of the viewer.
    store.protectRange?.(readerId, next.from, next.to);
    if (isJump) {
      // A jump — a seek, not the window sliding along — can land on pieces that
      // are already downloaded but have been spilled to disk. Bring the whole
      // window back at once instead of one disk round trip per piece as the
      // reader reaches them.
      const revived = store.warmRange?.(next.from, next.to) ?? 0;
      if (revived > 0) {
        logger.info(
          `piece-reader: reviving ${revived} spilled piece(s) of ${next.from}-${next.to} ` +
            `for a jump to ${(start / 1024 / 1024).toFixed(0)}MB of "${file.name}"`
        );
      }
    }
    // Only now, with the new window claimed and marked, may anything else be
    // asked for — and only if the window needs nothing.
    updateBackfill();
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
        // Everything from here to the end of the window is wanted NOW, so all
        // of it is marked, not just the piece under the head. `critical`
        // enables hotswap: a block reserved by a slow peer is re-requested from
        // a faster one instead of holding up the reader. Measured 2026-08-04
        // with only the blocked piece marked, the first segment after a seek
        // took 7.2 s while its four 4 MB pieces arrived one after another at
        // ~2.2 MB/s, with waits of 1.3 s and 2.8 s on single pieces.
        //
        // This is not the old behaviour returning: that marked the whole
        // REQUESTED RANGE, which for ffmpeg's input means every piece to the
        // end of the file — hundreds of them, at which point the flag says
        // nothing. A window is what a reader genuinely needs next.
        criticalMark = markCritical(torrent, pieceIndex, window.to, criticalMark);
      }

      const waitStartedAt = Date.now();
      await whenPieceReady(torrent, pieceIndex, cancellation);
      // What a reader spent waiting for data, attributed to the exact piece. A
      // seek's cost is dominated by the first segment after the encoder
      // restarts (measured 9.2-9.4 s), and without this there is no way to say
      // whether that is the swarm, the picker, or ffmpeg. Logged only when the
      // wait is long enough to matter, so ordinary sequential reading is silent.
      const waitedMs = Date.now() - waitStartedAt;
      if (waitedMs >= PIECE_WAIT_LOG_MS) {
        logger.info(
          `piece-reader: waited ${waitedMs}ms for piece ${pieceIndex} ` +
            `(${pieceIndex - firstPiece + 1} of ${lastPiece - firstPiece + 1} in a read from ` +
            `${(start / 1024 / 1024).toFixed(0)}MB of "${file.name}")`
        );
      }

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
    if (backfill) {
      releaseWindow(torrent, backfill);
    }
    if (window) {
      releaseWindow(torrent, window);
    }
    store.releaseProtection?.(readerId);
    if (criticalMark) {
      clearCritical(torrent, criticalMark);
    }
  }
}
