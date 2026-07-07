/**
 * @file WebTorrent client pool.
 *
 * Manages a shared WebTorrent client instance and a map of active torrents
 * keyed by a hash of their source. Tracks file-level usage so that only
 * the pieces needed by active streams are selected for download.
 */

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import WebTorrent from "webtorrent";
import { logger } from "../utils/logger.js";

// WebTorrent's default download root (see webtorrent lib/torrent.js: TMP =
// path.join(os.tmpdir(), 'webtorrent')). We use the default store, so all
// torrent data lives under here.
const WEBTORRENT_STORE_ROOT = path.join(os.tmpdir(), "webtorrent");

// How long a torrent may sit with zero active file readers before it is
// removed (with its on-disk store). Generous so brief gaps between ffmpeg
// range reads — or a short pause — do not evict an in-use torrent; a longer
// idle (viewer gone) frees the disk. Re-requesting re-adds (re-downloads) it.
const TORRENT_IDLE_TTL_MS = 300_000;

// Bytes ahead of a read position to mark CRITICAL (download-first) on each
// range request. Big enough to unstick a seek into an undownloaded region,
// small enough not to make "everything critical" (which defeats prioritization).
const PRIORITY_WINDOW_BYTES = 8 * 1024 * 1024;

// The file's header/index region the codec probe needs (phase 1). Must match
// the ranges prefetchFileEdges fetches: leading bytes + trailing bytes.
const HEADER_HEAD_BYTES = 256 * 1024;
const HEADER_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Decode a raw torrent source value into the format expected by WebTorrent.
 *
 * @param {"magnet" | "torrent"} sourceType - How the source is encoded.
 * @param {string} source                   - Magnet URI or base64-encoded .torrent file.
 * @returns {string | Buffer}
 */
function decodeTorrentSource(sourceType, source) {
  if (sourceType === "magnet") {
    return source;
  }
  if (sourceType === "torrent") {
    return Buffer.from(source, "base64");
  }
  throw new Error("Unsupported sourceType. Expected magnet or torrent.");
}

/**
 * Shared WebTorrent pool.
 *
 * Torrents are loaded on demand and cached indefinitely (the pool has no
 * eviction policy — callers are responsible for keeping the set small).
 * File-level piece selection is tracked through a reference-count map so
 * that only files with at least one active stream cause downloading.
 */
export class TorrentPool {
  /**
   * In-flight `client.add()` promises keyed by the same key as `torrents`.
   * Prevents duplicate `client.add()` calls when two requests arrive
   * concurrently for the same torrent before the first one resolves.
   *
   * @type {Map<string, Promise<import("webtorrent").Torrent>>}
   */
  #pending = new Map();

  /**
   * Pending idle-removal timers, keyed by torrent object. A torrent with zero
   * file refcount is scheduled for removal; re-acquiring it cancels the timer.
   *
   * @type {Map<import("webtorrent").Torrent, ReturnType<typeof setTimeout>>}
   */
  #idleTimers = new Map();

  constructor() {
    // Sweep orphaned torrent data left by a previous hard kill (no graceful
    // shutdown ran, so destroyAll never cleaned the store). Safe here: no
    // torrents are loaded yet at construction. Best-effort, synchronous so it
    // completes before the client starts writing.
    try {
      rmSync(WEBTORRENT_STORE_ROOT, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`torrent-pool: could not sweep orphaned store at startup: ${message}`);
    }

    /** @type {import("webtorrent").WebTorrent} */
    this.client = new WebTorrent();

    /**
     * Active torrents keyed by `"${sourceType}:${sha1(source)}"`.
     *
     * @type {Map<string, import("webtorrent").Torrent>}
     */
    this.torrents = new Map();

    /**
     * Per-torrent file usage reference counts.
     * Maps torrent object → (fileIndex → refCount).
     *
     * @type {WeakMap<import("webtorrent").Torrent, Map<number, number>>}
     */
    this.fileUsageByTorrent = new WeakMap();

    this.client.on("error", (error) => {
      logger.error(`WebTorrent client error: ${error.message}`);
    });
    this.client.on("warning", (warning) => {
      const message = warning instanceof Error ? warning.message : String(warning);
      logger.warn(`torrent-pool: client warning: ${message}`);
    });
  }

  /**
   * Attach peer-discovery diagnostics to a freshly added torrent: tracker
   * announce results (seeders/leechers per announce) and torrent-level
   * warnings (tracker rejections/errors surface here). Without these a
   * zero-peer torrent gives no clue WHY it has no peers.
   *
   * @param {string} label - Short source label for log lines.
   * @param {import("webtorrent").Torrent} torrent
   * @returns {void}
   */
  #attachSwarmDiagnostics(label, torrent) {
    const trackerCount = Array.isArray(torrent.announce) ? torrent.announce.length : 0;
    logger.info(
      `torrent-pool: [${label}] added: files=${torrent.files?.length ?? 0} ` +
        `private=${torrent.private ? "yes" : "no"} trackers=${trackerCount}`
    );

    torrent.on("warning", (warning) => {
      const message = warning instanceof Error ? warning.message : String(warning);
      logger.warn(`torrent-pool: [${label}] warning: ${message}`);
    });

    // bittorrent-tracker's Client emits "update" with each announce response.
    // `complete`/`incomplete` are the tracker's seeder/leecher counts — the
    // authoritative answer to "does the tracker accept us and does the swarm
    // have anyone in it". Internal API, so strictly best-effort.
    const tracker = torrent.discovery?.tracker;
    if (tracker && typeof tracker.on === "function") {
      tracker.on("update", (data) => {
        // Private trackers embed the account passkey in the announce URL —
        // strip the query string before logging.
        const announceUrl =
          typeof data?.announce === "string" ? data.announce.replace(/\?.*$/, "") : "?";
        logger.info(
          `torrent-pool: [${label}] announce ${announceUrl}: ` +
            `seeders=${data?.complete ?? "?"} leechers=${data?.incomplete ?? "?"}`
        );
      });
    } else {
      logger.info(`torrent-pool: [${label}] tracker client not exposed; announce results not logged`);
    }
  }

  /**
   * Return the torrent for the given source, loading it if necessary.
   * Resolves once the torrent metadata is ready.
   *
   * @param {"magnet" | "torrent"} sourceType
   * @param {string} source - Magnet URI or base64-encoded .torrent bytes.
   * @returns {Promise<import("webtorrent").Torrent>}
   */
  async getTorrent(sourceType, source) {
    const key = `${sourceType}:${crypto.createHash("sha1").update(source).digest("hex")}`;

    // Already resolved — return immediately.
    const existing = this.torrents.get(key);
    if (existing) {
      return existing;
    }

    // In-flight — a concurrent request already called client.add() for the
    // same torrent; join that promise instead of calling add() again.
    const inFlight = this.#pending.get(key);
    if (inFlight) {
      return inFlight;
    }

    const torrentId = decodeTorrentSource(sourceType, source);
    const promise = new Promise((resolve, reject) => {
      const onError = (error) => {
        this.client.off("error", onError);
        this.#pending.delete(key);
        reject(error);
      };
      this.client.once("error", onError);
      this.client.add(torrentId, (readyTorrent) => {
        this.client.off("error", onError);
        this.torrents.set(key, readyTorrent);
        this.#pending.delete(key);
        // Key layout is `${sourceType}:${sha1}`; log with the sha1 prefix so
        // lines correlate with the [stats] source key.
        this.#attachSwarmDiagnostics(key.split(":")[1]?.slice(0, 8) ?? key, readyTorrent);
        resolve(readyTorrent);
      });
    });

    this.#pending.set(key, promise);
    return promise;
  }

  /**
   * Mark a single file as active, deselecting all others.
   * Prefer {@link acquireFile} when the active set may contain multiple files.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {number} fileIndex - Zero-based index into `torrent.files`.
   * @returns {void}
   */
  setActiveFile(torrent, fileIndex) {
    if (!torrent || !Array.isArray(torrent.files)) {
      return;
    }
    for (let index = 0; index < torrent.files.length; index += 1) {
      const file = torrent.files[index];
      if (!file) {
        continue;
      }
      if (index === fileIndex) {
        if (typeof file.select === "function") {
          file.select();
        }
        continue;
      }
      if (typeof file.deselect === "function") {
        file.deselect();
      }
    }
  }

  /**
   * Increment the reference count for a file, selecting it for download.
   * Returns a release function that decrements the count; when it reaches
   * zero the file is automatically deselected.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {number} fileIndex - Zero-based index into `torrent.files`.
   * @returns {() => void} Release function — call it once when done streaming.
   */
  acquireFile(torrent, fileIndex) {
    if (!torrent || !Array.isArray(torrent.files) || !Number.isInteger(fileIndex) || fileIndex < 0) {
      return () => undefined;
    }
    let usage = this.fileUsageByTorrent.get(torrent);
    if (!usage) {
      usage = new Map();
      this.fileUsageByTorrent.set(torrent, usage);
    }
    // The torrent is in use again — cancel any pending idle removal.
    this.#cancelIdleRemoval(torrent);
    usage.set(fileIndex, (usage.get(fileIndex) ?? 0) + 1);
    this.#syncSelections(torrent, usage);

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const nextCount = (usage.get(fileIndex) ?? 0) - 1;
      if (nextCount > 0) {
        usage.set(fileIndex, nextCount);
      } else {
        usage.delete(fileIndex);
      }
      if (usage.size === 0) {
        this.fileUsageByTorrent.delete(torrent);
        // No active readers — schedule removal (with store) after an idle TTL.
        this.#scheduleIdleRemoval(torrent);
      }
      this.#syncSelections(torrent, usage);
    };
  }

  /**
   * Schedule removal of a torrent (with its on-disk store) after
   * {@link TORRENT_IDLE_TTL_MS} of zero file refcount. Idempotent — replaces
   * any existing timer for the torrent.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @returns {void}
   */
  #scheduleIdleRemoval(torrent) {
    if (!torrent) {
      return;
    }
    this.#cancelIdleRemoval(torrent);
    const timer = setTimeout(() => {
      this.#idleTimers.delete(torrent);
      // Re-check: a new acquire since scheduling would have cancelled this
      // timer, but guard anyway against a race.
      const usage = this.fileUsageByTorrent.get(torrent);
      if (usage && usage.size > 0) {
        return;
      }
      this.#removeTorrent(torrent);
    }, TORRENT_IDLE_TTL_MS);
    timer.unref?.();
    this.#idleTimers.set(torrent, timer);
  }

  /**
   * Cancel a pending idle-removal timer for a torrent, if any.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @returns {void}
   */
  #cancelIdleRemoval(torrent) {
    const timer = this.#idleTimers.get(torrent);
    if (timer) {
      clearTimeout(timer);
      this.#idleTimers.delete(torrent);
    }
  }

  /**
   * Remove a torrent from the pool together with its on-disk store, freeing
   * disk while the proxy keeps running. Best-effort.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @returns {void}
   */
  #removeTorrent(torrent) {
    if (!torrent) {
      return;
    }
    // Drop it from the source→torrent map so a later request re-adds it.
    for (const [key, value] of this.torrents) {
      if (value === torrent) {
        this.torrents.delete(key);
        break;
      }
    }
    this.fileUsageByTorrent.delete(torrent);
    const name = typeof torrent.name === "string" ? torrent.name : "(unknown)";
    try {
      torrent.destroy({ destroyStore: true }, () => {
        logger.info(`torrent-pool: removed idle torrent "${name}" and its store`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`torrent-pool: failed to remove idle torrent "${name}": ${message}`);
    }
  }

  /**
   * Return download statistics for a torrent and optionally a specific file.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {number | null} [fileIndex] - Zero-based file index, or null for torrent-level only.
   * @returns {{
   *   numPeers: number,
   *   downloadSpeed: number,
   *   uploadSpeed: number,
   *   fileProgress: number | null,
   *   fileDownloaded: number | null,
   *   fileLength: number | null
   * }}
   */
  getFileStats(torrent, fileIndex = null) {
    const numPeers = typeof torrent?.numPeers === "number" ? torrent.numPeers : 0;
    const downloadSpeed = typeof torrent?.downloadSpeed === "number" ? torrent.downloadSpeed : 0;
    const uploadSpeed = typeof torrent?.uploadSpeed === "number" ? torrent.uploadSpeed : 0;

    const base = { numPeers, downloadSpeed, uploadSpeed };

    if (fileIndex === null || !Number.isInteger(fileIndex) || !Array.isArray(torrent?.files)) {
      return { ...base, fileProgress: null, fileDownloaded: null, fileLength: null };
    }

    const file = torrent.files[fileIndex];
    if (!file) {
      return { ...base, fileProgress: null, fileDownloaded: null, fileLength: null };
    }

    const header = this.#getHeaderRangeProgress(torrent, file);

    return {
      ...base,
      fileProgress: typeof file.progress === "number" ? file.progress : 0,
      fileDownloaded: typeof file.downloaded === "number" ? file.downloaded : 0,
      fileLength: typeof file.length === "number" ? file.length : 0,
      // Phase-1 progress: how much of the header/index region (the bytes the
      // codec probe needs before transcoding can start) is downloaded. Counted
      // by whole pieces from the torrent bitfield, so it advances coarsely
      // (piece granularity). Null when the bitfield/piece info is unavailable.
      headerBytes: header ? header.totalBytes : null,
      headerDownloadedBytes: header ? header.downloadedBytes : null
    };
  }

  /**
   * Count, by whole torrent pieces, how many bytes of a file's header/index
   * region (leading {@link HEADER_HEAD_BYTES} + trailing {@link HEADER_TAIL_BYTES})
   * are downloaded. Used to show progress toward the codec-probe phase.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {import("webtorrent").TorrentFile} file
   * @returns {{ totalBytes: number, downloadedBytes: number } | null}
   */
  #getHeaderRangeProgress(torrent, file) {
    const pieceLength = Number(torrent?.pieceLength);
    const bitfield = torrent?.bitfield;
    const fileLength = Number(file?.length);
    if (
      !Number.isFinite(pieceLength) || pieceLength <= 0 ||
      !bitfield || typeof bitfield.get !== "function" ||
      !Number.isFinite(fileLength) || fileLength <= 0
    ) {
      return null;
    }
    const fileOffset = Number.isFinite(file.offset) ? file.offset : 0;
    const headEnd = Math.min(HEADER_HEAD_BYTES, fileLength) - 1;
    const ranges = [[0, headEnd]];
    const tailStart = Math.max(headEnd + 1, fileLength - HEADER_TAIL_BYTES);
    if (tailStart <= fileLength - 1) {
      ranges.push([tailStart, fileLength - 1]);
    }
    const pieces = new Set();
    for (const [start, end] of ranges) {
      const first = Math.floor((fileOffset + start) / pieceLength);
      const last = Math.floor((fileOffset + end) / pieceLength);
      for (let piece = first; piece <= last; piece += 1) {
        pieces.add(piece);
      }
    }
    let totalBytes = 0;
    let downloadedBytes = 0;
    for (const piece of pieces) {
      totalBytes += pieceLength;
      if (bitfield.get(piece)) {
        downloadedBytes += pieceLength;
      }
    }
    return { totalBytes, downloadedBytes };
  }

  /**
   * Pre-fetch the leading and trailing bytes of a torrent file so that
   * WebTorrent prioritises the pieces that contain file headers and footers.
   *
   * For MP4 files the MOOV atom is often placed at the very end of the file
   * (non-faststart encoding).  Fetching the tail ensures that ffprobe can
   * identify codecs and duration even for freshly-added torrents without
   * waiting for the rest of the content to download.
   *
   * Resolves once both regions have been fully downloaded, or when the
   * timeout elapses — whichever comes first.  Never rejects.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {number} fileIndex - Zero-based index into `torrent.files`.
   * @param {object} [options]
   * @param {number} [options.headBytes=262144]   - Leading bytes to fetch (default 256 KB).
   * @param {number} [options.tailBytes=2097152]  - Trailing bytes to fetch (default 2 MB).
   * @param {number} [options.timeoutMs=300000]   - Maximum wait time in milliseconds (default 5 min).
   * @returns {Promise<void>}
   */
  async prefetchFileEdges(
    torrent,
    fileIndex,
    { headBytes = 256 * 1024, tailBytes = 2 * 1024 * 1024, timeoutMs = 300_000 } = {}
  ) {
    if (!torrent || !Array.isArray(torrent.files)) {
      return;
    }
    const file = torrent.files[fileIndex];
    if (!file || typeof file.createReadStream !== "function") {
      return;
    }
    const fileSize = file.length;
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      return;
    }

    const safeHeadEnd = Math.min(headBytes, fileSize) - 1;
    const safeTailStart = Math.max(0, fileSize - tailBytes);

    /** Drain a readable stream, resolving on end/error/close. */
    const drainStream = (stream) =>
      new Promise((resolve) => {
        stream.on("data", () => undefined);
        stream.once("end", resolve);
        stream.once("error", resolve);
        stream.once("close", resolve);
      });

    try {
      const tasks = [
        // Head: FTYP/MOOV (faststart MP4), EBML header (MKV), etc.
        drainStream(file.createReadStream({ start: 0, end: safeHeadEnd }))
      ];

      // Tail: MOOV atom for non-faststart MP4.  Skip when it overlaps the head.
      if (safeTailStart > safeHeadEnd + 1) {
        tasks.push(drainStream(file.createReadStream({ start: safeTailStart, end: fileSize - 1 })));
      }

      await Promise.race([
        Promise.all(tasks),
        new Promise((resolve) => setTimeout(resolve, timeoutMs))
      ]);
    } catch (_error) {
      // Best-effort — a prefetch failure must never prevent playback.
    }
  }

  /**
   * Update WebTorrent piece selection to match the current usage map.
   * Files with at least one consumer are selected; all others are deselected.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {Map<number, number>} usage - fileIndex → refCount.
   * @returns {void}
   */
  #syncSelections(torrent, usage) {
    if (!torrent || !Array.isArray(torrent.files)) {
      return;
    }
    for (let index = 0; index < torrent.files.length; index += 1) {
      const file = torrent.files[index];
      if (!file) {
        continue;
      }
      const shouldSelect = (usage.get(index) ?? 0) > 0;
      if (shouldSelect) {
        if (typeof file.select === "function") {
          file.select();
        }
        continue;
      }
      if (typeof file.deselect === "function") {
        file.deselect();
      }
    }
  }

  /**
   * Mark the torrent pieces covering a byte window of a file as CRITICAL, so
   * WebTorrent downloads them before the rest of the selected file. Called on
   * every range request: after a seek, the new read position jumps the download
   * queue instead of waiting behind the sequential backlog (which caused
   * ~15-18 s stalls when seeking into an undownloaded region).
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {number} fileIndex
   * @param {number} byteStart - Start offset within the file.
   * @param {number} [windowBytes] - Bytes ahead of `byteStart` to prioritize.
   * @returns {void}
   */
  prioritizeByteRange(torrent, fileIndex, byteStart, windowBytes = PRIORITY_WINDOW_BYTES) {
    if (!torrent || typeof torrent.critical !== "function" || !Array.isArray(torrent.files)) {
      return;
    }
    const pieceLength = Number(torrent.pieceLength);
    if (!Number.isFinite(pieceLength) || pieceLength <= 0) {
      return;
    }
    const file = torrent.files[fileIndex];
    if (!file) {
      return;
    }
    const fileOffset = Number.isFinite(file.offset) ? file.offset : 0;
    const safeStart = Math.max(0, Number(byteStart) || 0);
    const absStart = fileOffset + safeStart;
    const absEnd = Math.min(fileOffset + file.length - 1, absStart + Math.max(1, windowBytes) - 1);
    const startPiece = Math.floor(absStart / pieceLength);
    const endPiece = Math.floor(absEnd / pieceLength);
    if (endPiece < startPiece) {
      return;
    }
    try {
      torrent.critical(startPiece, endPiece);
    } catch {
      // Best effort — never break streaming because prioritization failed.
    }
  }

  /**
   * Destroy every torrent together with its on-disk store, then tear down the
   * WebTorrent client. Called from the proxy's graceful-shutdown `onClose`
   * hook so downloaded torrent data does not linger under `os.tmpdir()` after
   * the process stops.
   *
   * `client.destroy()` on its own destroys the torrents but only *closes* their
   * stores (data stays on disk), so each torrent is removed explicitly with
   * `{ destroyStore: true }` first. Best-effort: never rejects and never hangs
   * on a single store-removal error during shutdown.
   *
   * @returns {Promise<void>}
   */
  async destroyAll() {
    // Cancel any pending idle-removal timers — destroyAll handles teardown.
    for (const timer of this.#idleTimers.values()) {
      clearTimeout(timer);
    }
    this.#idleTimers.clear();

    if (!this.client || this.client.destroyed) {
      return;
    }

    // Destroy each torrent with its store so downloaded pieces are removed
    // from disk. This also removes the torrent from `client.torrents`, so the
    // subsequent `client.destroy()` only tears down the client internals.
    const torrents = [...this.client.torrents];
    await Promise.all(
      torrents.map(
        (torrent) =>
          new Promise((resolve) => {
            try {
              torrent.destroy({ destroyStore: true }, () => resolve());
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logger.warn(`failed to destroy torrent store: ${message}`);
              resolve();
            }
          })
      )
    );

    // Tear down the client itself (DHT, connection pool, TCP server).
    await new Promise((resolve) => {
      try {
        this.client.destroy(() => resolve());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`failed to destroy WebTorrent client: ${message}`);
        resolve();
      }
    });

    this.torrents.clear();
    this.#pending.clear();
  }
}
