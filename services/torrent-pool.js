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
import { rmSync, statfsSync } from "node:fs";
import WebTorrent from "webtorrent";
import parseTorrent from "parse-torrent";
import { logger } from "../utils/logger.js";

// WebTorrent's default download root (see webtorrent lib/torrent.js: TMP =
// path.join(os.tmpdir(), 'webtorrent')). We use the default store, so all
// torrent data lives under here.
const WEBTORRENT_STORE_ROOT = path.join(os.tmpdir(), "webtorrent");

// How long a torrent may sit with zero active file readers before it is
// removed (with its on-disk store). Generous so brief gaps between ffmpeg
// range reads — a pause, a backgrounded tab, or a phone turned off for a few
// minutes — do not evict an in-use torrent's already-downloaded data, so a
// resume plays from disk instead of re-downloading. A longer idle (viewer truly
// gone) frees the disk; the global disk cap still evicts earlier under pressure.
const TORRENT_IDLE_TTL_MS = 15 * 60 * 1000;

// Bytes ahead of a read position to mark CRITICAL on each range request. In
// WebTorrent, `critical` does NOT reorder the sequential piece scan — it enables
// HOTSWAP (re-request a block from a faster peer when a slower one already
// reserved it), so this is the near read-ahead cushion where stealing from slow
// peers pays off. The actual "download the seek target first" effect comes from
// deselecting the gap BEHIND the playhead (see prioritizeByteRange). Kept a
// moving window (reset each call) so criticality never accumulates over the
// whole file across seeks, which would make hotswap thrash.
const PRIORITY_WINDOW_BYTES = 16 * 1024 * 1024;

// The file's header/index region the codec probe needs (phase 1). Must match
// the ranges prefetchFileEdges fetches: leading bytes + trailing bytes.
const HEADER_HEAD_BYTES = 256 * 1024;
const HEADER_TAIL_BYTES = 2 * 1024 * 1024;

// Global disk cap. Downloaded torrent data is removed on idle TTL and at
// shutdown, but under pressure (several large files within the TTL window)
// it can still fill a small HA host's disk (SD/eMMC), which can take down
// Home Assistant itself. When the total exceeds the cap, whole torrents with
// no active reader are evicted least-recently-used first. Active torrents are
// never evicted (we cannot delete what is playing).
const DISK_CAP_ABSOLUTE_MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const DISK_CAP_SWEEP_INTERVAL_MS = 30_000;

// Adaptive upload. Seeding to the BitTorrent swarm does not help our viewer (we
// deliver over our own WebRTC/HTTPS channel) — it is pure uplink cost and the
// riskiest legal act (active distribution). So the default is minimal: no
// seeding when nothing is being watched, and only a token upload while actively
// downloading. BUT zero upload can get us choked by tit-for-tat (peers re-rank
// and stop sending) → slower download → the exact starvation we fight. So the
// limit is ADAPTIVE: raised only when download is starving AND the wires show
// reciprocity is the cause (many peers we want data from are choking us).
const UPLOAD_FLOOR_BYTES = 50 * 1024;            // token upload while a reader is active
const UPLOAD_BOOST_BYTES = 512 * 1024;           // raised to earn tit-for-tat unchoke slots
const UPLOAD_STARVING_SPEED_BYTES = 200 * 1024;  // download below this (with demand) = starving
const UPLOAD_CHOKED_WIRE_THRESHOLD = 2;          // interested-but-choked wires implying reciprocity
const UPLOAD_ADJUST_INTERVAL_MS = 5_000;

/**
 * Decide the client-wide upload limit (bytes/sec) from the torrents that
 * currently have an active reader. Pure function so the policy is unit-testable
 * without a live swarm.
 *
 * - No active readers → 0 (stop seeding entirely; nothing is being watched).
 * - Any active torrent starving (still wants data, download barely trickling)
 *   AND showing reciprocity choke (>= threshold wires we are interested in that
 *   are choking us) → boost, to earn unchoke slots.
 * - Otherwise → floor (token upload, avoids an immediate choke without seeding).
 *
 * @param {Array<{ wires?: Array<{ amInterested?: boolean, peerChoking?: boolean }>, downloadSpeed?: number, progress?: number, name?: string }>} activeTorrents
 * @param {{ floor?: number, boost?: number, starvingSpeed?: number, chokedThreshold?: number }} [opts]
 * @returns {{ bytesPerSec: number, reason: string }}
 */
export function decideUploadLimit(activeTorrents, opts = {}) {
  const floor = opts.floor ?? UPLOAD_FLOOR_BYTES;
  const boost = opts.boost ?? UPLOAD_BOOST_BYTES;
  const starvingSpeed = opts.starvingSpeed ?? UPLOAD_STARVING_SPEED_BYTES;
  const chokedThreshold = opts.chokedThreshold ?? UPLOAD_CHOKED_WIRE_THRESHOLD;

  if (!Array.isArray(activeTorrents) || activeTorrents.length === 0) {
    return { bytesPerSec: 0, reason: "idle: no active readers — stop seeding" };
  }

  for (const torrent of activeTorrents) {
    const wires = Array.isArray(torrent?.wires) ? torrent.wires : [];
    const chokedInterested = wires.filter(
      (wire) => wire && wire.amInterested === true && wire.peerChoking === true
    ).length;
    const downloadSpeed = typeof torrent?.downloadSpeed === "number" ? torrent.downloadSpeed : 0;
    const progress = typeof torrent?.progress === "number" ? torrent.progress : 0;
    const starving = progress < 1 && downloadSpeed < starvingSpeed;
    if (starving && chokedInterested >= chokedThreshold) {
      const name = typeof torrent?.name === "string" ? torrent.name : "?";
      return {
        bytesPerSec: boost,
        reason:
          `earn unchoke — "${name}" choked=${chokedInterested}/${wires.length} ` +
          `down=${Math.round(downloadSpeed / 1024)}KB/s`
      };
    }
  }

  return { bytesPerSec: floor, reason: "active readers, not choke-starved" };
}

/**
 * Compute the default disk cap: the smaller of a fixed 10 GB and half of the
 * currently free space on the store's filesystem (so a tiny host is never
 * asked to hold more than it can). Best-effort; falls back to the fixed max
 * when the filesystem cannot be stat'd.
 *
 * Format a WebTorrent warning for logging: message plus a bounded stack.
 * WebTorrent surfaces internal peer-connection failures (e.g. the µTP
 * null-peer NPEs, webtorrent#1932/#1940) as non-fatal "warning" events
 * carrying only a terse message; the stack pinpoints the exact library path,
 * so we log the first few frames to diagnose which failure it is.
 *
 * @param {unknown} warning
 * @returns {string}
 */
function formatWarning(warning) {
  if (!(warning instanceof Error)) {
    return String(warning);
  }
  const stack = typeof warning.stack === "string" ? warning.stack.split("\n").slice(0, 4).join(" | ") : "";
  return stack || warning.message;
}

/**
 * @param {string} storePath
 * @returns {number}
 */
function computeDefaultDiskCap(storePath) {
  try {
    const stat = statfsSync(storePath);
    const freeBytes = stat.bavail * stat.bsize;
    if (Number.isFinite(freeBytes) && freeBytes > 0) {
      return Math.min(DISK_CAP_ABSOLUTE_MAX_BYTES, Math.floor(freeBytes / 2));
    }
  } catch {
    // statfs unavailable (old Node / odd FS) — fall back to the fixed max.
  }
  return DISK_CAP_ABSOLUTE_MAX_BYTES;
}

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

  /**
   * Last time each torrent was acquired or fetched, for LRU eviction under
   * the disk cap.
   *
   * @type {Map<import("webtorrent").Torrent, number>}
   */
  #lastAccess = new Map();

  /** Global disk cap in bytes (0 = disabled). */
  #maxDiskBytes = 0;

  /** Periodic disk-cap enforcement timer. */
  #diskSweepTimer = null;

  /** Current client-wide upload limit in bytes/sec (adaptive). -1 = not yet set. */
  #uploadLimit = -1;

  /** Periodic adaptive-upload adjustment timer. */
  #uploadAdjustTimer = null;

  /**
   * @param {{ maxDiskBytes?: number }} [options]
   *   `maxDiskBytes` caps total downloaded torrent data; when omitted a
   *   default is computed from free disk (min(10 GB, half free)). Pass 0 to
   *   disable the cap.
   */
  constructor({ maxDiskBytes } = {}) {
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
      logger.warn(`torrent-pool: client warning: ${formatWarning(warning)}`);
    });

    this.#maxDiskBytes = Number.isFinite(maxDiskBytes) && maxDiskBytes >= 0
      ? maxDiskBytes
      : computeDefaultDiskCap(os.tmpdir());
    if (this.#maxDiskBytes > 0) {
      const gb = (this.#maxDiskBytes / (1024 * 1024 * 1024)).toFixed(1);
      logger.info(`torrent-pool: disk cap ${gb} GB (LRU eviction of idle torrents above it)`);
      this.#diskSweepTimer = setInterval(() => this.#enforceDiskCap(), DISK_CAP_SWEEP_INTERVAL_MS);
      this.#diskSweepTimer.unref?.();
    }

    // Adaptive upload: start with seeding OFF (nothing is being watched yet),
    // then let the periodic adjuster raise it to the floor while a reader is
    // active and to the boost when download is choke-starved. WebTorrent's
    // default is unlimited upload, which we explicitly do NOT want.
    if (typeof this.client.throttleUpload === "function") {
      this.client.throttleUpload(0);
      this.#uploadLimit = 0;
    }
    this.#uploadAdjustTimer = setInterval(() => this.#adjustUploadLimit(), UPLOAD_ADJUST_INTERVAL_MS);
    this.#uploadAdjustTimer.unref?.();
  }

  /**
   * Re-evaluate and apply the client-wide upload limit from current swarm state
   * (see {@link decideUploadLimit}). Runs on a timer; only calls into WebTorrent
   * when the target changes, and logs each change for field tuning.
   *
   * @returns {void}
   */
  #adjustUploadLimit() {
    if (!this.client || this.client.destroyed || typeof this.client.throttleUpload !== "function") {
      return;
    }
    const active = [...this.torrents.values()].filter((torrent) => {
      const usage = this.fileUsageByTorrent.get(torrent);
      return usage && usage.size > 0;
    });
    const { bytesPerSec, reason } = decideUploadLimit(active);
    if (bytesPerSec === this.#uploadLimit) {
      return;
    }
    this.#uploadLimit = bytesPerSec;
    this.client.throttleUpload(bytesPerSec);
    logger.info(`torrent-pool: upload limit -> ${Math.round(bytesPerSec / 1024)} KB/s (${reason})`);
  }

  /**
   * Sum of downloaded bytes across pooled torrents — a cheap proxy for the
   * on-disk footprint (the FS store writes downloaded pieces).
   *
   * @returns {number}
   */
  #currentDiskBytes() {
    let total = 0;
    for (const torrent of this.torrents.values()) {
      const downloaded = typeof torrent?.downloaded === "number" ? torrent.downloaded : 0;
      total += Math.max(0, downloaded);
    }
    return total;
  }

  /**
   * Evict whole torrents, least-recently-used first, while the total on-disk
   * footprint exceeds the cap. Only torrents with NO active file reader are
   * evictable — a playing torrent cannot be deleted. Best-effort.
   *
   * @returns {void}
   */
  #enforceDiskCap() {
    if (this.#maxDiskBytes <= 0) {
      return;
    }
    let used = this.#currentDiskBytes();
    if (used <= this.#maxDiskBytes) {
      return;
    }
    // Candidates: pooled torrents with zero active readers, LRU first.
    const candidates = [...this.torrents.values()]
      .filter((t) => {
        const usage = this.fileUsageByTorrent.get(t);
        return !usage || usage.size === 0;
      })
      .sort((a, b) => (this.#lastAccess.get(a) ?? 0) - (this.#lastAccess.get(b) ?? 0));

    for (const torrent of candidates) {
      if (used <= this.#maxDiskBytes) {
        break;
      }
      const freed = typeof torrent?.downloaded === "number" ? Math.max(0, torrent.downloaded) : 0;
      const name = typeof torrent?.name === "string" ? torrent.name : "(unknown)";
      const gb = (this.#maxDiskBytes / (1024 * 1024 * 1024)).toFixed(1);
      logger.info(
        `torrent-pool: disk cap ${gb} GB exceeded — evicting idle torrent "${name}" ` +
          `(~${(freed / (1024 * 1024)).toFixed(0)} MB)`
      );
      this.#cancelIdleRemoval(torrent);
      this.#removeTorrent(torrent);
      used -= freed;
    }
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
      logger.warn(`torrent-pool: [${label}] warning: ${formatWarning(warning)}`);
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
      this.#lastAccess.set(existing, Date.now());
      return existing;
    }

    // In-flight — a concurrent request already called client.add() for the
    // same torrent; join that promise instead of calling add() again.
    const inFlight = this.#pending.get(key);
    if (inFlight) {
      return inFlight;
    }

    const torrentId = decodeTorrentSource(sourceType, source);

    // Pre-validate the infohash BEFORE handing the source to WebTorrent.
    // WebTorrent's Torrent._onTorrentId does `arr2hex(parsedTorrent.infoHash)`
    // assuming a BitTorrent v1 infohash exists; a v2-only / hybrid magnet (or a
    // malformed source) parses with `infoHash === undefined`, so that call does
    // `Buffer.from(undefined)` and throws in a microtask that bypasses the
    // client "error" event — crashing the whole process. Reject cleanly here so
    // the browser gets an error it can show, and the proxy stays up.
    let parsed;
    try {
      parsed = await parseTorrent(torrentId);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.infoHash !== "string" || !/^[0-9a-f]{40}$/i.test(parsed.infoHash)) {
      throw new Error(
        "Unsupported torrent source: no BitTorrent v1 infohash (v2-only or malformed torrents are not supported)."
      );
    }

    const promise = new Promise((resolve, reject) => {
      const onError = (error) => {
        this.client.off("error", onError);
        // The same content can arrive as a .torrent AND as a magnet —
        // different pool keys, one swarm. WebTorrent rejects the duplicate
        // add; resolve with the already-loaded torrent instead of failing.
        const message = error instanceof Error ? error.message : String(error);
        const dupMatch = /duplicate torrent ([0-9a-f]{40})/i.exec(message);
        if (dupMatch) {
          const existing = this.client.torrents.find((t) => t?.infoHash === dupMatch[1]);
          if (existing) {
            const settle = () => {
              this.torrents.set(key, existing);
              this.#lastAccess.set(existing, Date.now());
              this.#pending.delete(key);
              resolve(existing);
            };
            if (existing.ready) {
              settle();
            } else {
              existing.once("ready", settle);
            }
            return;
          }
        }
        this.#pending.delete(key);
        reject(error);
      };
      this.client.once("error", onError);
      this.client.add(torrentId, (readyTorrent) => {
        this.client.off("error", onError);
        this.torrents.set(key, readyTorrent);
        this.#lastAccess.set(readyTorrent, Date.now());
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
    // The torrent is in use again — cancel any pending idle removal and mark
    // it recently accessed so LRU eviction keeps it.
    this.#cancelIdleRemoval(torrent);
    this.#lastAccess.set(torrent, Date.now());
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
    this.#lastAccess.delete(torrent);
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
   * Bias the torrent's download toward the current read position, so a seek
   * downloads the seek target first instead of waiting behind the sequential
   * backlog (which caused ~15-18 s stalls when seeking into an undownloaded
   * region). Called on every range request.
   *
   * Two levers, matched to how WebTorrent's picker actually works:
   *
   * 1. **Demote the gap BEHIND the playhead** — `deselect(fileStart, playhead-1)`.
   *    The picker scans each selection sequentially from its first UNdownloaded
   *    piece; with the whole file selected, a far forward seek would make it
   *    fetch the undownloaded gap behind the new position first. Removing that
   *    gap from the selection makes the scan START at the playhead, so all peer
   *    capacity goes to the pieces the player needs next. This only STOPS
   *    fetching the gap; already-downloaded pieces stay on disk (deleting them
   *    is Disk hygiene Level 2), and a later backward seek re-selects the region
   *    via this same call. The whole file is re-selected by `file.select()` on
   *    the next `acquireFile`, so nothing is permanently dropped.
   *
   * 2. **Critical read-ahead window** — `critical(playhead, playhead+window)`.
   *    `critical` does not reorder the scan; it enables HOTSWAP (re-request a
   *    block from a faster peer when a slow one reserved it) over the near
   *    window. Reset first so criticality stays a moving window rather than
   *    accumulating over the whole file across seeks.
   *
   * Scope: single active reader per file (≈100% today). The multi-viewer union
   * window — demote only where behind for ALL sessions — is deferred (roadmap
   * item 23); here the latest read position wins.
   *
   * The pinned head/tail (prefetchFileEdges, codec probe) is downloaded up front
   * and lives forward of the playhead (tail) or is already on disk (head), so
   * demotion never costs the probe its data.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {number} fileIndex
   * @param {number} byteStart - Start offset within the file.
   * @param {number} [windowBytes] - Bytes ahead of `byteStart` to mark critical.
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
    const fileLength = Number(file.length);
    if (!Number.isFinite(fileLength) || fileLength <= 0) {
      return;
    }
    const fileStartPiece = Math.floor(fileOffset / pieceLength);
    const fileEndPiece = Math.floor((fileOffset + fileLength - 1) / pieceLength);

    const safeStart = Math.max(0, Number(byteStart) || 0);
    const absStart = fileOffset + safeStart;
    const playheadPiece = Math.floor(absStart / pieceLength);
    const absWindowEnd = Math.min(
      fileOffset + fileLength - 1,
      absStart + Math.max(1, windowBytes) - 1
    );
    const windowEndPiece = Math.floor(absWindowEnd / pieceLength);

    // (1) Demote the gap behind the playhead so the picker scans forward from
    //     the read position. Only when there IS a gap (not at the file start).
    if (playheadPiece > fileStartPiece && typeof torrent.deselect === "function") {
      try {
        torrent.deselect(fileStartPiece, playheadPiece - 1);
      } catch {
        // Best effort — never break streaming because demotion failed.
      }
    }

    // (2) Reset criticality to a moving read-ahead window (hotswap over the near
    //     pieces), so it does not accumulate over the whole file across seeks.
    if (Array.isArray(torrent._critical)) {
      torrent._critical.length = 0;
    }
    if (windowEndPiece >= playheadPiece) {
      try {
        torrent.critical(playheadPiece, windowEndPiece);
      } catch {
        // Best effort.
      }
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
    // Stop periodic disk-cap enforcement.
    if (this.#diskSweepTimer) {
      clearInterval(this.#diskSweepTimer);
      this.#diskSweepTimer = null;
    }
    // Stop periodic adaptive-upload adjustment.
    if (this.#uploadAdjustTimer) {
      clearInterval(this.#uploadAdjustTimer);
      this.#uploadAdjustTimer = null;
    }
    // Cancel any pending idle-removal timers — destroyAll handles teardown.
    for (const timer of this.#idleTimers.values()) {
      clearTimeout(timer);
    }
    this.#idleTimers.clear();
    this.#lastAccess.clear();

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
