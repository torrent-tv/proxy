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
import { askFastestWiresFor, canPlaceRequests } from "./fastest-wires.js";
import { minimumBufferFrom, requiredSpeedFrom } from "../supply-margin.js";

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
 * How wide the window should be after a piece that made the reader wait — or
 * did not.
 *
 * The swarm's surplus is what pays for this. Measured 2026-08-17 on the field
 * torrent: 5.1-5.9 MB/s delivered against a film consumed at about 1 MB/s, and
 * the reader still blocked 47 times in two minutes, median 1.5 s, worst 4.5 s.
 * A fivefold surplus never became distance ahead of the head, because the
 * window is a fixed number of seconds of playback and everything past it is
 * ordinary background fill at no priority.
 *
 * So the window follows the evidence: every wait that mattered widens it by a
 * piece, every piece that was already there narrows it back toward the size the
 * caller asked for. Nothing here is chosen — the wait is measured, the
 * threshold is the one that already defines "a wait worth recording", and the
 * ceiling is this reader's share of the store's memory, so widening can never
 * cost more than the store can hold.
 *
 * @param {{ current: number, base: number, ceiling: number, waitedMs: number, waitThresholdMs: number }} params
 * @returns {number}
 */
export function nextWindowPieces({ current, base, ceiling, waitedMs, waitThresholdMs }) {
  const floor = Math.max(1, Math.floor(base));
  const top = Math.max(floor, Math.floor(ceiling));
  const now = Math.min(top, Math.max(floor, Math.floor(current)));
  if (waitedMs >= waitThresholdMs) {
    return Math.min(top, now + 1);
  }
  return Math.max(floor, now - 1);
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
 * Who is working on the piece a reader is blocked on, right now.
 *
 * The open question about a seek: a single 8 MiB piece takes 3.0-4.6 s to
 * arrive while the swarm as a whole is moving 4-6 MB/s, so roughly 2 MB/s is
 * reaching the piece that is actually being waited for. Whether that is because
 * few peers hold it, few are being asked, or each is slow cannot be told apart
 * from the outside — these three counts tell them apart.
 *
 * `wire.requests` is what has been asked of that peer and not yet answered; a
 * block is 16 KB, so `blocks x 16 KB` is the work in flight on this piece.
 *
 * @param {import("webtorrent").Torrent} torrent
 * @param {number} pieceIndex
 * @returns {{ peers: number, holders: number, askedOf: number, blocks: number }}
 */
export function pieceSupply(torrent, pieceIndex) {
  const wires = Array.isArray(torrent?.wires) ? torrent.wires : [];
  let holders = 0;
  let askedOf = 0;
  let blocks = 0;
  for (const wire of wires) {
    if (wire?.peerPieces?.get?.(pieceIndex)) {
      holders += 1;
    }
    const requests = Array.isArray(wire?.requests) ? wire.requests : [];
    const forThisPiece = requests.filter((request) => request?.piece === pieceIndex).length;
    if (forThisPiece > 0) {
      askedOf += 1;
      blocks += forThisPiece;
    }
  }
  return { peers: wires.length, holders, askedOf, blocks };
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
/**
 * The last interruptions this file's readers met, newest last.
 *
 * Bounded and per file, because both figures derived from it describe THIS
 * file on THIS swarm: a piece is 8 MiB here and 512 KiB elsewhere, and a swarm
 * that answers in 200 ms today may not tomorrow. Nothing is stored beyond the
 * process — a restart starts from no evidence, which is the honest state.
 *
 * @type {Map<string, Array<{ waitedMs: number, at: number }>>}
 */
const supplyWaits = new Map();

/** How many interruptions are kept per file. */
const SUPPLY_WAIT_HISTORY = 40;

/** How often the derived figures are printed, at most. */
const SUPPLY_REPORT_INTERVAL_MS = 30_000;

/** When each file's figures were last printed. */
const supplyReportedAt = new Map();

/**
 * Record one interruption and, at most twice a minute, say what it implies.
 *
 * The two figures are the whole of roadmap item 3: the speed a step must
 * sustain to survive this supply (`1 + worst wait / median interval`), and the
 * smallest buffer that hides an interruption from the viewer. Both are printed
 * before either is USED, so the field says whether the arithmetic describes
 * reality before anything is decided by it.
 *
 * @param {string} key - Something stable per file.
 * @param {string} label - What to call it in the log.
 * @param {number} waitedMs
 * @returns {void}
 */
function noteSupplyWait(key, label, waitedMs) {
  const history = supplyWaits.get(key) ?? [];
  history.push({ waitedMs, at: Date.now() });
  while (history.length > SUPPLY_WAIT_HISTORY) {
    history.shift();
  }
  supplyWaits.set(key, history);

  const now = Date.now();
  if (now - (supplyReportedAt.get(key) ?? 0) < SUPPLY_REPORT_INTERVAL_MS) {
    return;
  }
  const demand = requiredSpeedFrom(history);
  if (!demand) {
    return;
  }
  supplyReportedAt.set(key, now);
  const buffer = minimumBufferFrom({
    segmentSeconds: SEGMENT_SECONDS_FOR_BUFFER,
    worstSupplyWaitSec: demand.worstWaitSec
  });
  logger.info(
    `supply "${label.slice(0, 40)}": a step must run at ${demand.requiredSpeed.toFixed(2)}x ` +
    `to survive this swarm (worst wait ${demand.worstWaitSec.toFixed(2)}s, one every ` +
    `${demand.medianIntervalSec.toFixed(2)}s, ${demand.samples} measured) — ` +
    `and the smallest buffer that hides it is ${buffer ? buffer.seconds.toFixed(1) : "?"}s`
  );
}

/**
 * The segment length the buffer figure is stated against. The reader does not
 * know the session's own, and this is a REPORT rather than a decision — the
 * decision, when it is made, will use the session's real one.
 */
const SEGMENT_SECONDS_FOR_BUFFER = 4;

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
  const basePieces = Math.max(1, Math.ceil(Math.max(1, windowBytes) / pieceLength));
  // What the window is RIGHT NOW. It starts at what the caller sized in seconds
  // of playback and grows while the reader keeps being made to wait — see
  // `nextWindowPieces`.
  let windowPieces = basePieces;
  /**
   * The widest this reader may go: its share of what the store can hold in
   * memory. Measured rather than chosen — the capacity is the store's own, and
   * the number of readers is how many windows are declared on it right now.
   *
   * @returns {number}
   */
  const ceilingPieces = () => {
    const capacity = Number(store?.capacity);
    if (!Number.isFinite(capacity) || capacity <= 0) {
      return basePieces;
    }
    const readers = Math.max(1, store.protectedRanges?.().length ?? 1);
    return Math.max(basePieces, Math.floor(capacity / readers));
  };
  /** @type {{ from: number, to: number } | null} */
  let window = null;
  /** @type {{ from: number, to: number } | null} */
  let criticalMark = null;
  /**
   * Drops the pin of the fragment currently in the consumer's hands, if it
   * still holds one. See where it is assigned.
   *
   * @type {(() => void) | null}
   */
  let releaseHeldPin = null;

  // Identity of this read, so the store can tell one reader's window from
  // another's. Each read gets its own; `readerSequence` never repeats within a
  // process.
  const readerId = `read-${(readerSequence += 1)}`;

  const moveWindowTo = (pieceIndex) => {
    const next = readWindowFor({ pieceIndex, lastPiece, windowPieces });
    if (window && window.from === next.from && window.to === next.to) {
      return;
    }
    const isJump = !window || next.from > window.to || next.from < window.from;
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
      // The reader is blocked, so this piece is now the only thing that matters
      // on this torrent: hand it to the fastest wires that hold it. A block is
      // reserved for exactly one wire, and the read ends when the slowest
      // holder delivers — measured 2026-08-17, the swarm had a fivefold surplus
      // of bandwidth and the reader still waited 1.0-4.5 s, 47 times in two
      // minutes, on pieces five peers already had.
      let pushed = { asked: 0, attempted: 0, considered: 0, fastestBytesPerSecond: 0 };
      const pushToFastest = () => {
        try {
          const result = askFastestWiresFor(torrent, pieceIndex);
          pushed = {
            asked: pushed.asked + result.asked,
            // Summed like the successes, so the line compares two totals over
            // the same attempts instead of a total against a snapshot.
            attempted: (pushed.attempted ?? 0) + result.attempted,
            considered: result.considered,
            fastestBytesPerSecond: result.fastestBytesPerSecond
          };
        } catch (error) {
          // The entry is internal to the library; if a version changes it, this
          // lever stops working and that must be visible rather than silent.
          logger.warn(`piece-reader: could not steer piece ${pieceIndex} — ${error?.message ?? error}`);
        }
      };
      if (canPlaceRequests(torrent)) {
        pushToFastest();
      } else {
        logger.warn(
          "piece-reader: this webtorrent build offers no way to place a request; " +
            "the blocked piece cannot be steered onto a faster peer"
        );
      }
      // Sampled while waiting rather than after: once the piece lands, nothing
      // is outstanding on it any more and every count reads zero.
      let supply = null;
      const supplyProbe = setInterval(() => {
        const sample = pieceSupply(torrent, pieceIndex);
        if (!supply || sample.blocks > supply.blocks) {
          supply = sample;
        }
        // Wires come and go, and their speeds change: a holder that was slow a
        // moment ago may now be the fastest one available.
        pushToFastest();
      }, 500);
      try {
        await whenPieceReady(torrent, pieceIndex, cancellation);
      } finally {
        clearInterval(supplyProbe);
      }
      // What a reader spent waiting for data, attributed to the exact piece. A
      // seek's cost is dominated by the first segment after the encoder
      // restarts (measured 9.2-9.4 s), and without this there is no way to say
      // whether that is the swarm, the picker, or ffmpeg. Logged only when the
      // wait is long enough to matter, so ordinary sequential reading is silent.
      const waitedMs = Date.now() - waitStartedAt;
      // The window answers to what just happened: a wait means the lead was too
      // short, an immediate hit means it is longer than it needs to be. Applied
      // before the logging below so the line reports the window the next piece
      // will actually use.
      noteSupplyWait(`${torrent?.infoHash ?? "?"}/${file?.name ?? "?"}`, file?.name ?? "", waitedMs);
      const widened = nextWindowPieces({
        current: windowPieces,
        base: basePieces,
        ceiling: ceilingPieces(),
        waitedMs,
        waitThresholdMs: PIECE_WAIT_LOG_MS
      });
      if (widened !== windowPieces) {
        windowPieces = widened;
      }
      if (waitedMs >= PIECE_WAIT_LOG_MS) {
        const rateKbps = Math.round(pieceLength / 1024 / (waitedMs / 1000));
        logger.info(
          `piece-reader: waited ${waitedMs}ms for piece ${pieceIndex} ` +
            `(${pieceIndex - firstPiece + 1} of ${lastPiece - firstPiece + 1} in a read from ` +
            `${(start / 1024 / 1024).toFixed(0)}MB of "${file.name}") ` +
            `— ${rateKbps}KB/s on this piece; ` +
            (supply
              ? `${supply.holders}/${supply.peers} peers had it, ${supply.askedOf} were asked, ` +
                `${supply.blocks} blocks (${Math.round((supply.blocks * 16384) / 1024)}KB) in flight at peak`
              : "no sample taken") +
            // What WE did about it, so the next session says whether steering
            // the piece onto faster holders shortens the tail — by number
            // rather than by impression.
            `; steered onto ${pushed.asked} of ${pushed.attempted} asks (${pushed.considered} peers held it)` +
            (pushed.fastestBytesPerSecond > 0
              ? `, fastest ${Math.round(pushed.fastestBytesPerSecond / 1024)}KB/s`
              : "")
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
      // Remembered so the generator can drop it itself. The pin is taken here
      // and the consumer is expected to release it — but a consumer that
      // ABANDONS the iterator never gets the chance, and a seek abandons it
      // every time: the encoder is killed, the response is torn down, and the
      // loop is left between two fragments. Field 2026-08-06: after one seek
      // every slot in the store was pinned, the store answered
      // `Every resident piece is pinned; no slot can be freed` — to the
      // WebTorrent client, which closed the store and destroyed the torrent —
      // and the session died with `File 0 not found`.
      releaseHeldPin = () => {
        if (!releasedThisPiece) {
          releasedThisPiece = true;
          store.unpin(pieceIndex);
        }
      };
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
      // Handed back, and released by the consumer or not at all — either way
      // this reader no longer owes anything for it.
      releaseHeldPin = null;
    }
  } finally {
    // A fragment handed out and never released is a slot lost for the life of
    // the process. Reached on every exit, including the consumer walking away.
    if (releaseHeldPin) {
      releaseHeldPin();
      releaseHeldPin = null;
    }
    // Reached on completion, on cancellation, on a throw, and when the consumer
    // stops iterating — a window left behind would keep the swarm fetching for
    // a reader that no longer exists.
    if (window) {
      releaseWindow(torrent, window);
    }
    store.releaseProtection?.(readerId);
    if (criticalMark) {
      clearCritical(torrent, criticalMark);
    }
  }
}
