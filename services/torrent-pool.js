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
    const existing = this.torrents.get(key);
    if (existing) {
      return existing;
    }

    const torrentId = decodeTorrentSource(sourceType, source);
    const torrent = await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.client.off("error", onError);
        reject(error);
      };
      this.client.once("error", onError);
      this.client.add(torrentId, (readyTorrent) => {
        this.client.off("error", onError);
        resolve(readyTorrent);
      });
    });

    this.torrents.set(key, torrent);
    return torrent;
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
