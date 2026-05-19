/**
 * @file WebTorrent client pool.
 *
 * Manages a shared WebTorrent client instance and a map of active torrents
 * keyed by a hash of their source. Tracks file-level usage so that only
 * the pieces needed by active streams are selected for download.
 */

import crypto from "node:crypto";
import WebTorrent from "webtorrent";
import { logger } from "../utils/logger.js";

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

  constructor() {
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
      }
      this.#syncSelections(torrent, usage);
    };
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

    return {
      ...base,
      fileProgress: typeof file.progress === "number" ? file.progress : 0,
      fileDownloaded: typeof file.downloaded === "number" ? file.downloaded : 0,
      fileLength: typeof file.length === "number" ? file.length : 0
    };
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
}
