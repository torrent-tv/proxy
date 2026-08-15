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
import { logger } from "../utils/logger.js";
import { SharedPieceStore, findSharedStore } from "./piece-store/shared-piece-store.js";

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
// riskiest legal act (active distribution). So the default is minimal: a
// near-zero keep-alive when nothing is being watched (NOT 0 — that blocks the
// swarm in wt3.x), and only a token upload while actively downloading. BUT zero
// upload can get us choked by tit-for-tat (peers re-rank
// and stop sending) → slower download → the exact starvation we fight. So the
// limit is ADAPTIVE: raised only when download is starving AND the wires show
// reciprocity is the cause (many peers we want data from are choking us).
const UPLOAD_FLOOR_BYTES = 50 * 1024;            // token upload while a reader is active
// Minimal keep-alive upload when NOTHING is being watched. It must NOT be 0:
// in webtorrent 3.x `throttleUpload(0)` blocks ALL swarm exchange client-wide
// (even peer connections and DOWNLOAD), so a torrent still fetching metadata /
// pieces would stall. A few KB/s is negligible seeding but keeps the swarm alive.
const UPLOAD_IDLE_FLOOR_BYTES = 8 * 1024;
const UPLOAD_BOOST_BYTES = 512 * 1024;           // raised to earn tit-for-tat unchoke slots
const UPLOAD_STARVING_SPEED_BYTES = 200 * 1024;  // download below this (with demand) = starving
const UPLOAD_CHOKED_WIRE_THRESHOLD = 2;          // interested-but-choked wires implying reciprocity
const UPLOAD_ADJUST_INTERVAL_MS = 5_000;
/**
 * How long a torrent counts as being in a hurry after it is added, and after
 * the viewer moves to a part of the file that is not downloaded.
 *
 * BitTorrent gives data to peers that give data back: each peer re-ranks whom
 * it serves roughly every 10 s and opens a handful of slots to whoever uploaded
 * most to it, plus one chosen at random. Uploading almost nothing means waiting
 * to be picked at random, one slot per cycle — which is exactly the ramp
 * measured 2026-08-04 on a session with 96 peers already connected: 64 KB/s
 * after 2 s, 1.6 MB/s after 4 s, 4.8 MB/s after 8 s, and the 16 MB the codec
 * probe needs took 8.36 s of the 11.46 s before playback could start.
 *
 * The existing reciprocity boost could not help there: it only fires once the
 * download has all but stopped (below 200 KB/s) with peers visibly choking us,
 * and a ramp is neither. In the same session it first raised the limit 13.3 s
 * after the torrent was added — after the wait it was supposed to shorten — and
 * reached the generous rate at 43.7 s.
 *
 * So the two moments where a viewer is provably waiting get the generous rate
 * outright, for two unchoke cycles, without waiting for evidence of failure.
 */
const UPLOAD_HURRY_MS = 25_000;
// A torrent somebody is reading, that is not finished, and is moving less than
// this, is not downloading. Well below the slowest real swarm seen in the field
// (470 KB/s two seconds after a cold add) and well above idle chatter.
const STALL_SPEED_BYTES = 32 * 1024;
// How long it must stay there before saying so, and how often to repeat.
const STALL_REPORT_AFTER_MS = 10_000;
const STALL_REPORT_INTERVAL_MS = 30_000;

/**
 * What the swarm has been asked for, and what it is doing about it.
 *
 * Answers the question a stalled download cannot answer for itself: were the
 * peers never told what we want, or told and not delivering? Reaches into
 * WebTorrent's own bookkeeping because none of it is exposed — `_selections`
 * is what the picker walks, `wire.requests` is what is actually outstanding.
 *
 * @param {import("webtorrent").Torrent} torrent
 * @returns {string}
 */
function describeSwarmDemand(torrent) {
  const items = Array.isArray(torrent?._selections?._items) ? torrent._selections._items : [];
  let selectedPieces = 0;
  let missingSelected = 0;
  for (const item of items) {
    const from = Number(item?.from);
    const to = Number(item?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      continue;
    }
    selectedPieces += to - from + 1;
    for (let index = from; index <= to; index += 1) {
      if (!torrent.bitfield?.get(index)) {
        missingSelected += 1;
      }
    }
  }

  const wires = Array.isArray(torrent?.wires) ? torrent.wires : [];
  let inFlight = 0;
  let asking = 0;
  let choking = 0;
  let interested = 0;
  for (const wire of wires) {
    const requests = Array.isArray(wire?.requests) ? wire.requests.length : 0;
    inFlight += requests;
    if (requests > 0) {
      asking += 1;
    }
    if (wire?.peerChoking === true) {
      choking += 1;
    }
    if (wire?.amInterested === true) {
      interested += 1;
    }
  }

  const critical = Array.isArray(torrent?._critical)
    ? torrent._critical.reduce((count, flag) => (flag ? count + 1 : count), 0)
    : 0;

  return (
    `${items.length} selection(s) covering ${selectedPieces} piece(s), ` +
    `${missingSelected} of them missing, ${critical} marked critical; ` +
    `${wires.length} peers, ${interested} we want data from, ${choking} choking us, ` +
    `${asking} being asked, ${inFlight} blocks in flight`
  );
}

/**
 * Decide the client-wide upload limit (bytes/sec) from the torrents that
 * currently have an active reader. Pure function so the policy is unit-testable
 * without a live swarm.
 *
 * - No active readers → a MINIMAL keep-alive floor (NOT 0: `throttleUpload(0)`
 *   blocks the whole swarm client-wide in webtorrent 3.x, stalling any torrent
 *   still downloading). Effectively no seeding, just enough to keep peers.
 * - Any active torrent starving (still wants data, download barely trickling)
 *   AND showing reciprocity choke (>= threshold wires we are interested in that
 *   are choking us) → boost, to earn unchoke slots.
 * - Otherwise → floor (token upload, avoids an immediate choke without seeding).
 *
 * - Any active torrent in a HURRY — just added, or the viewer has just moved
 *   somewhere the file is not downloaded — → boost for {@link UPLOAD_HURRY_MS},
 *   because that is when peers must be persuaded to serve us and there is no
 *   time to first prove that they are not.
 *
 * @param {Array<{ wires?: Array<{ amInterested?: boolean, peerChoking?: boolean }>, downloadSpeed?: number, done?: boolean, name?: string, hurryUntil?: number }>} activeTorrents
 * @param {{ floor?: number, idleFloor?: number, boost?: number, starvingSpeed?: number, chokedThreshold?: number, now?: number }} [opts]
 * @returns {{ bytesPerSec: number, reason: string }}
 */
/**
 * The torrents the upload policy is allowed to see.
 *
 * A torrent with a reader qualifies for the obvious reason. A torrent in a
 * HURRY qualifies even without one, and that case is the important one: the
 * first thing done with a new torrent is fetching the file's head and tail for
 * the codec probe, and that read goes straight to `createReadStream` without
 * registering a reader. Judged by readers alone the torrent looks unused for
 * the whole of that wait — 8.36 s of the 11.46 s before playback in the session
 * measured 2026-08-04 — so the upload stayed at the near-silent idle floor
 * during the exact seconds peers were deciding whether to serve us.
 *
 * @param {Iterable<{ hurryUntil?: number }>} torrents
 * @param {Map<object, { size: number }>} usageByTorrent - fileIndex sets, keyed by torrent.
 * @param {number} now
 * @returns {object[]}
 */
export function torrentsForUploadPolicy(torrents, usageByTorrent, now) {
  const chosen = [];
  for (const torrent of torrents) {
    const usage = usageByTorrent?.get?.(torrent);
    const hasReader = Boolean(usage && usage.size > 0);
    if (hasReader || (torrent?.hurryUntil ?? 0) > now) {
      // Recorded so the policy can tell "nothing is arriving and somebody is
      // waiting" from "nothing is arriving because nobody asked".
      torrent.hasActiveReader = hasReader;
      chosen.push(torrent);
    }
  }
  return chosen;
}

export function decideUploadLimit(activeTorrents, opts = {}) {
  const floor = opts.floor ?? UPLOAD_FLOOR_BYTES;
  const idleFloor = opts.idleFloor ?? UPLOAD_IDLE_FLOOR_BYTES;
  const boost = opts.boost ?? UPLOAD_BOOST_BYTES;
  const starvingSpeed = opts.starvingSpeed ?? UPLOAD_STARVING_SPEED_BYTES;
  const chokedThreshold = opts.chokedThreshold ?? UPLOAD_CHOKED_WIRE_THRESHOLD;
  const now = opts.now ?? Date.now();

  if (!Array.isArray(activeTorrents) || activeTorrents.length === 0) {
    return { bytesPerSec: idleFloor, reason: "idle: minimal keep-alive (0 blocks the swarm in wt3.x)" };
  }

  for (const torrent of activeTorrents) {
    const hurryUntil = typeof torrent?.hurryUntil === "number" ? torrent.hurryUntil : 0;
    if (hurryUntil > now && torrent?.done !== true) {
      const name = typeof torrent?.name === "string" ? torrent.name : "?";
      return {
        bytesPerSec: boost,
        reason: `in a hurry — "${name}" needs data now (${Math.round((hurryUntil - now) / 1000)}s left)`
      };
    }
  }

  for (const torrent of activeTorrents) {
    const wires = Array.isArray(torrent?.wires) ? torrent.wires : [];
    const chokedInterested = wires.filter(
      (wire) => wire && wire.amInterested === true && wire.peerChoking === true
    ).length;
    const downloadSpeed = typeof torrent?.downloadSpeed === "number" ? torrent.downloadSpeed : 0;
    // Use `done` (a plain boolean) — NOT `progress`/`downloaded`, whose getters
    // iterate the piece array and throw on webtorrent 3.x when a piece is null
    // (deselected / mid-verify), which would crash this timer every cycle.
    const notDone = torrent?.done !== true;
    // A torrent nobody is reading is not starving, however still its download
    // looks. The encoder is held back once it is far enough ahead of the
    // viewer, and while it is held nothing is requested — measured
    // 2026-08-04: four cycles of 512 -> 50 KB/s in three minutes, each
    // reported as `earn unchoke ... down=0KB/s`, all of them raising the
    // upload at moments when no byte was wanted by anyone.
    const starving = notDone && torrent?.hasActiveReader !== false && downloadSpeed < starvingSpeed;
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
/**
 * What to do when WebTorrent refuses an add because that infohash is already
 * here: take the one that exists, replace it, or wait for it to be ready.
 *
 * The same content arrives as a `.torrent` and as a magnet — different pool
 * keys, one swarm — so a duplicate is ordinary. What is NOT ordinary is a
 * duplicate with no metadata: a magnet whose swarm has not answered has no file
 * list, and every request bound to it is answered 404 for as long as it lives.
 * If this add carries metadata — a `.torrent` holds the files, the piece hashes
 * and the trackers outright — waiting for the swarm to supply what is already
 * in our hands is waiting for nothing. Measured 2026-08-15: one magnet with no
 * reachable peers made the same film unplayable from its own `.torrent` until
 * the proxy was restarted.
 *
 * @param {{ existingIsReady: boolean, incomingHasMetadata: boolean }} params
 * @returns {"adopt" | "replace" | "wait"}
 */
export function duplicateAddDecision({ existingIsReady, incomingHasMetadata }) {
  if (existingIsReady) {
    return "adopt";
  }
  return incomingHasMetadata ? "replace" : "wait";
}

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
 * Downloaded bytes of a single piece, treating a null (deselected) piece as 0.
 *
 * webtorrent 3.x sets `pieces[index] = null` for pieces we removed from the
 * download set via `deselect` (file selection, seek-behind-playhead demotion).
 * Its own `get downloaded` / `get progress` do NOT guard that null and throw
 * `Cannot read properties of null (reading 'length')`, which crashed our
 * disk-cap and stats timers every cycle. A deselected piece has 0 downloaded
 * bytes, so treating null as 0 is the correct value — and keeps the OTHER
 * pieces counted (a blanket try/catch that returned 0 for the whole torrent
 * would under-report disk usage and freeze the progress bar at 0%).
 *
 * @param {import("webtorrent").Torrent} torrent
 * @param {number} index
 * @returns {number}
 */
function pieceDownloadedBytes(torrent, index) {
  const len = index === torrent.pieces.length - 1 ? torrent.lastPieceLength : torrent.pieceLength;
  if (torrent.bitfield.get(index)) {
    return len; // verified
  }
  const piece = torrent.pieces[index];
  return piece ? len - piece.missing : 0; // in-progress, or null (deselected) → 0
}

/**
 * Total downloaded bytes across ALL pieces, null-safe (mirrors webtorrent's
 * `torrent.downloaded` but never throws on a deselected null piece).
 *
 * @param {import("webtorrent").Torrent} torrent
 * @returns {number}
 */
export function torrentDownloadedBytes(torrent) {
  if (!torrent?.bitfield || !Array.isArray(torrent.pieces)) {
    return 0;
  }
  let downloaded = 0;
  for (let index = 0; index < torrent.pieces.length; index += 1) {
    downloaded += pieceDownloadedBytes(torrent, index);
  }
  return downloaded;
}

/**
 * Downloaded bytes of a single file, null-safe (mirrors webtorrent's
 * `file.downloaded`, including the first/last-piece offset trims, but never
 * throws on a deselected null piece).
 *
 * @param {import("webtorrent").Torrent} torrent
 * @param {import("webtorrent").TorrentFile & { _startPiece?: number, _endPiece?: number, offset?: number, length?: number }} file
 * @returns {number}
 */
export function fileDownloadedBytes(torrent, file) {
  if (!torrent?.bitfield || !Array.isArray(torrent.pieces) || !file) {
    return 0;
  }
  const start = file._startPiece;
  const end = file._endPiece;
  const pieceLength = torrent.pieceLength;
  if (!Number.isInteger(start) || !Number.isInteger(end) || !(pieceLength > 0)) {
    return 0;
  }
  let downloaded = 0;
  for (let index = start; index <= end; index += 1) {
    const pieceDownloaded = pieceDownloadedBytes(torrent, index);
    downloaded += pieceDownloaded;
    if (index === start) {
      // First piece may carry irrelevant bytes from the previous file.
      const irrelevant = file.offset % pieceLength;
      downloaded -= Math.min(irrelevant, pieceDownloaded);
    }
    if (index === end) {
      // Last piece may carry irrelevant bytes from the next file.
      const lastLen = index === torrent.pieces.length - 1 ? torrent.lastPieceLength : pieceLength;
      const irrelevant = lastLen - ((file.offset + file.length) % pieceLength);
      downloaded -= Math.min(irrelevant, pieceDownloaded);
    }
  }
  return downloaded;
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

  /**
   * Last byte offset each active reader is streaming from, keyed by torrent then
   * fileIndex. Set by prioritizeByteRange on every /stream range request; read by
   * getFileStats to report how much of the window ahead of the read head is still
   * to download — the "amount left to resume" shown while buffering.
   *
   * @type {Map<import("webtorrent").Torrent, Map<number, number>>}
   */
  #readPositionByTorrent = new Map();

  /**
   * The background-fill selection held for each torrent, so it can be withdrawn
   * again. See #updateBackgroundFill.
   *
   * @type {Map<import("webtorrent").Torrent, { from: number, to: number }>}
   */
  #backgroundFill = new Map();

  /** When each torrent's download first fell below the stall threshold. */
  #stallSince = new Map();
  /** When each torrent's stall was last reported, so it is not repeated hotly. */
  #stallReportedAt = new Map();

  /**
   * Edge prefetches currently running, keyed by infoHash and file index, so two
   * callers asking at the same time share one.
   *
   * @type {Map<string, Promise<void>>}
   */
  #edgePrefetches = new Map();

  /** Global disk cap in bytes (0 = disabled). */
  #maxDiskBytes = 0;

  /** Memory budget per torrent for resident pieces; undefined = store default. */
  #memoryBytes;

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
  constructor({ maxDiskBytes, memoryBytes } = {}) {
    this.#memoryBytes = Number.isFinite(memoryBytes) && memoryBytes > 0 ? memoryBytes : undefined;

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
  /**
   * Note that a torrent needs data now, and act on it immediately.
   *
   * `hurryUntil` is read by {@link decideUploadLimit}; the re-evaluation is
   * what makes it take effect at once, because the adjuster otherwise runs on a
   * 5 s timer and the whole hurry is only 25 s long.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {string} why - For the log line, so the two causes are told apart.
   * @returns {void}
   */
  #markHurry(torrent, why) {
    if (!torrent) {
      return;
    }
    const until = Date.now() + UPLOAD_HURRY_MS;
    if ((torrent.hurryUntil ?? 0) >= until - 1_000) {
      return;
    }
    torrent.hurryUntil = until;
    logger.info(
      `torrent-pool: [${String(torrent.infoHash).slice(0, 8)}] uploading generously for ` +
        `${Math.round(UPLOAD_HURRY_MS / 1000)}s — ${why}`
    );
    this.#adjustUploadLimit();
  }

  /**
   * Say when a torrent that somebody is reading has stopped downloading.
   *
   * Field 2026-08-05: a session died 32 minutes in because the download fell to
   * **1 KB/s for five minutes** with 186 peer connections open and trackers
   * reporting ~300 seeders, on a torrent that was not finished. ffmpeg then ran
   * out of input and reported itself complete at segment 188 of 624. Not one
   * line of the log said anything was wrong — the collapse had to be recovered
   * afterwards by hand from three unrelated counters.
   *
   * So the stall reports itself, and it reports the two things that tell the
   * candidates apart: whether the swarm was ASKED for anything (pieces selected
   * and still missing, blocks in flight) or was asked and did not answer (peers
   * holding what we want, how many are choking us).
   *
   * @returns {void}
   */
  /**
   * Put back the reader windows WebTorrent has quietly dropped.
   *
   * A reader claims its window as a stream selection and releases it when it
   * ends. That claim is NOT durable: `_gcSelections` deletes a selection the
   * moment every piece in it is present, so a window that has been satisfied
   * stops existing — and with it, everything the swarm had been asked for.
   *
   * While a reader keeps moving that is invisible, because the next window is
   * claimed immediately. It becomes fatal when the reader STOPS: the encoder is
   * held back by the look-ahead cap, ffmpeg stops reading, the reader parks on a
   * window that is fully downloaded, the selection disappears — and nothing our
   * code runs can notice, because the reader is parked inside a write. Measured
   * 2026-08-05: the encoder was suspended at 22:44:51, the download hit zero at
   * 22:45:05 and stayed there for **eleven minutes** with 150 peer connections
   * open, `0 selection(s) covering 0 piece(s), 0 being asked, 0 blocks in
   * flight`. When the encoder was let go there was nothing ahead of it, and the
   * viewer's picture stopped.
   *
   * So the claim is re-asserted from outside, on this timer, using the windows
   * the store already knows about — those are declared by live readers and
   * withdrawn when they end, which is exactly the set that should be selected.
   *
   * @returns {void}
   */
  #reassertReaderWindows() {
    for (const torrent of this.torrents.values()) {
      const usage = this.fileUsageByTorrent.get(torrent);
      if (!usage || usage.size === 0 || torrent?.done === true) {
        continue;
      }
      const store = findSharedStore(torrent);
      const ranges = typeof store?.protectedRanges === "function" ? store.protectedRanges() : [];
      if (ranges.length === 0) {
        continue;
      }
      const items = Array.isArray(torrent?._selections?._items) ? torrent._selections._items : [];
      for (const range of ranges) {
        const present = items.some((item) => item?.from === range.from && item?.to === range.to);
        if (present) {
          continue;
        }
        // Only worth re-claiming what is actually missing: re-claiming a window
        // that is already complete would be deleted again on the next pass and
        // the two would take turns forever.
        let missing = false;
        for (let index = range.from; index <= range.to && !missing; index += 1) {
          if (!torrent.bitfield?.get(index)) {
            missing = true;
          }
        }
        if (!missing) {
          continue;
        }
        try {
          torrent._select(range.from, range.to, 1, null, true);
          logger.info(
            `torrent-pool: [${String(torrent.infoHash).slice(0, 8)}] re-claimed reader window ` +
            `${range.from}-${range.to} — the selection had been dropped once it was satisfied`
          );
        } catch {
          // Best effort: a torrent being torn down is not worth failing over.
        }
      }
    }
  }

  /**
   * The reader windows of a torrent, and whether any of them still wants
   * something. Two questions with one answer, because both callers below need
   * exactly this: the background fill may only run when nothing is wanted, and
   * a download sitting at zero is only worth warning about when something is.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @returns {{ ranges: Array<{ from: number, to: number }>, missing: boolean }}
   */
  #readerDemand(torrent) {
    const store = findSharedStore(torrent);
    const ranges = typeof store?.protectedRanges === "function" ? store.protectedRanges() : [];
    let missing = false;
    for (const range of ranges) {
      for (let index = range.from; index <= range.to; index += 1) {
        if (!torrent.bitfield?.get(index)) {
          missing = true;
          break;
        }
      }
      if (missing) {
        break;
      }
    }
    return { ranges, missing };
  }

  /**
   * Keep fetching the rest of the file while the viewer needs nothing.
   *
   * Owned here rather than by the reader, because the reader cannot act while
   * it is parked — and parked is exactly the state this is for. The encoder is
   * held back by the look-ahead cap, the viewer is comfortably ahead, the link
   * is idle: that is the cheapest bandwidth of the whole session and it was
   * going unused, because the fill was re-evaluated only when a reader window
   * MOVED. Priority 0 against the window's 1, and withdrawn the moment any
   * window wants something, so it can never take capacity from the picture.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {{ ranges: Array<{ from: number, to: number }>, missing: boolean }} demand
   * @returns {void}
   */
  #updateBackgroundFill(torrent, demand) {
    const held = this.#backgroundFill.get(torrent) ?? null;
    const wanted = !demand.missing && demand.ranges.length > 0
      ? this.#tailAfterWindows(torrent, demand.ranges)
      : null;
    if (held && (!wanted || held.from !== wanted.from || held.to !== wanted.to)) {
      try {
        torrent._deselect?.(held.from, held.to, false);
      } catch {
        // Best effort.
      }
      this.#backgroundFill.delete(torrent);
    }
    if (wanted && !this.#backgroundFill.has(torrent)) {
      try {
        torrent._select?.(wanted.from, wanted.to, 0, null, false);
        this.#backgroundFill.set(torrent, wanted);
      } catch {
        // Best effort.
      }
    }
  }

  /**
   * Everything after the furthest reader window, up to the end of the file it
   * belongs to. Null when there is nothing left.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {Array<{ from: number, to: number }>} ranges
   * @returns {{ from: number, to: number } | null}
   */
  #tailAfterWindows(torrent, ranges) {
    const pieceLength = Number(torrent.pieceLength);
    if (!Number.isFinite(pieceLength) || pieceLength <= 0) {
      return null;
    }
    const usage = this.fileUsageByTorrent.get(torrent);
    let lastPiece = -1;
    for (const [fileIndex, count] of usage ?? []) {
      const file = count > 0 ? torrent.files?.[fileIndex] : null;
      if (!file) {
        continue;
      }
      lastPiece = Math.max(lastPiece, Math.floor((file.offset + file.length - 1) / pieceLength));
    }
    const from = Math.max(...ranges.map((range) => range.to)) + 1;
    return lastPiece >= from ? { from, to: lastPiece } : null;
  }

  #reportStalledDownloads() {
    const now = Date.now();
    for (const torrent of this.torrents.values()) {
      const usage = this.fileUsageByTorrent.get(torrent);
      if (!usage || usage.size === 0 || torrent?.done === true) {
        continue;
      }
      const speed = typeof torrent.downloadSpeed === "number" ? torrent.downloadSpeed : 0;
      if (speed >= STALL_SPEED_BYTES) {
        this.#stallSince.delete(torrent);
        continue;
      }
      // Nothing is being downloaded because nothing is wanted: every reader has
      // all the pieces of its window. That is the encoder being held back, not
      // a fault, and it warned all through a healthy session on 2026-08-06 —
      // 65.3% of the file present, the encoder 134-159 s ahead, its window
      // complete. A warning that fires when everything is right teaches the
      // reader to ignore it.
      if (!this.#readerDemand(torrent).missing) {
        this.#stallSince.delete(torrent);
        continue;
      }
      const since = this.#stallSince.get(torrent) ?? now;
      this.#stallSince.set(torrent, since);
      if (now - since < STALL_REPORT_AFTER_MS) {
        continue;
      }
      const lastReport = this.#stallReportedAt.get(torrent) ?? 0;
      if (now - lastReport < STALL_REPORT_INTERVAL_MS) {
        continue;
      }
      this.#stallReportedAt.set(torrent, now);
      logger.warn(
        `torrent-pool: [${String(torrent.infoHash).slice(0, 8)}] download stalled at ` +
        `${Math.round(speed / 1024)}KB/s for ${Math.round((now - since) / 1000)}s — ` +
        describeSwarmDemand(torrent)
      );
    }
  }

  #adjustUploadLimit() {
    if (!this.client || this.client.destroyed || typeof this.client.throttleUpload !== "function") {
      return;
    }
    const active = torrentsForUploadPolicy(
      this.torrents.values(),
      this.fileUsageByTorrent,
      Date.now()
    );
    this.#reassertReaderWindows();
    for (const torrent of this.torrents.values()) {
      const usage = this.fileUsageByTorrent.get(torrent);
      if (!usage || usage.size === 0 || torrent?.done === true) {
        continue;
      }
      this.#updateBackgroundFill(torrent, this.#readerDemand(torrent));
    }
    this.#reportStalledDownloads();
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
      total += Math.max(0, torrentDownloadedBytes(torrent));
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
      const freed = Math.max(0, torrentDownloadedBytes(torrent));
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
    // A torrent nobody has asked for yet does not exist: this is called the
    // moment one is added, which is the moment a viewer started waiting.
    this.#markHurry(torrent, "just added");
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
            const decision = duplicateAddDecision({
              existingIsReady: existing.ready === true,
              incomingHasMetadata: Buffer.isBuffer(torrentId)
            });
            if (decision === "adopt") {
              settle();
              return;
            }
            // The one already here has no metadata, and THIS add carries it —
            // a `.torrent` holds the file list, the piece hashes and the
            // trackers outright. Waiting for the other one to become ready is
            // waiting on the swarm to supply what is already in our hands, and
            // when the swarm cannot (a magnet with no reachable peers) it never
            // arrives: measured 2026-08-15, a magnet added first left every
            // later attempt at the same infohash — including the complete
            // `.torrent` — bound to an empty torrent, `/stream` answering 404
            // and playback impossible until the proxy was restarted.
            if (decision === "replace") {
              logger.info(
                `torrent-pool: [${dupMatch[1].slice(0, 8)}] replacing a torrent with no metadata ` +
                `with the .torrent just given, which has it`
              );
              // Everything this class remembers about the old one goes with it,
              // or a later request finds it through a map and works with a
              // torrent the client no longer has.
              for (const [otherKey, value] of this.torrents) {
                if (value === existing) {
                  this.torrents.delete(otherKey);
                }
              }
              this.fileUsageByTorrent.delete(existing);
              this.#lastAccess.delete(existing);
              this.#readPositionByTorrent.delete(existing);
              this.client.remove(existing, { destroyStore: true }, () => {
                this.client.add(torrentId, {
                  store: SharedPieceStore,
                  storeCacheSlots: 0,
                  storeOpts: { memoryBytes: this.#memoryBytes }
                }, (replacement) => {
                  this.torrents.set(key, replacement);
                  this.#lastAccess.set(replacement, Date.now());
                  this.#attachSwarmDiagnostics(dupMatch[1].slice(0, 8), replacement);
                  this.#pending.delete(key);
                  resolve(replacement);
                });
              });
              return;
            }
            // Both are magnets: there is nothing here the other does not have,
            // so wait for the swarm — the caller's own bound answers if it
            // takes too long.
            existing.once("ready", settle);
            return;
          }
        }
        this.#pending.delete(key);
        reject(error);
      };
      this.client.once("error", onError);
      // Our own store, and WebTorrent's piece cache switched off in front of it
      // (`storeCacheSlots: 0`). That cache is what made the thread split fail:
      // it hands out the buffer it keeps and re-slices it later, so moving a
      // piece across threads detached memory still in use. Ours owns what it
      // hands out, holds pieces in shared memory the main thread can read
      // directly, and spills to disk instead of losing them.
      this.client.add(torrentId, {
        store: SharedPieceStore,
        storeCacheSlots: 0,
        storeOpts: { memoryBytes: this.#memoryBytes }
      }, (readyTorrent) => {
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
    this.#readPositionByTorrent.delete(torrent);
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
   * @param {{ resumeAnchorByteStart?: number | null }} [options] - `resumeAnchorByteStart`
   *   pins the resume window to a FIXED byte offset instead of the live (moving)
   *   read position. Without it, the window is anchored to wherever the file is
   *   CURRENTLY being read from — which slides forward as playback/encoding
   *   advances, so "bytes still needed" can jump up mid-poll even though nothing
   *   regressed (the window just moved past already-downloaded pieces into
   *   fresh ones). The caller should capture the returned `resumeAnchorByteStart`
   *   on the FIRST poll of a buffering episode and pass it back on subsequent
   *   polls of that SAME episode, so "bytes needed" counts down monotonically
   *   against a fixed target instead of chasing a moving one.
   * @returns {{
   *   numPeers: number,
   *   downloadSpeed: number,
   *   uploadSpeed: number,
   *   fileProgress: number | null,
   *   fileDownloaded: number | null,
   *   fileLength: number | null
   * }}
   */
  getFileStats(torrent, fileIndex = null, options = {}) {
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

    // Bytes still to download in the window ahead of the anchor point — "how
    // much left to resume". Null until a read position is known. The anchor is
    // the caller-supplied FROZEN offset when given (see JSDoc above), otherwise
    // the live (moving) read position tracked from /stream range requests.
    const readPositions = this.#readPositionByTorrent.get(torrent);
    const liveReadByteStart = readPositions ? readPositions.get(fileIndex) : undefined;
    const requestedAnchor = options?.resumeAnchorByteStart;
    const readByteStart = Number.isFinite(requestedAnchor) ? requestedAnchor : liveReadByteStart;
    const resume = typeof readByteStart === "number"
      ? this.#getResumeWindowProgress(torrent, file, readByteStart)
      : null;

    // Null-safe downloaded/progress (webtorrent's own getters throw on a
    // deselected null piece — see fileDownloadedBytes).
    const fileLength = typeof file.length === "number" ? file.length : 0;
    const fileDownloaded = fileDownloadedBytes(torrent, file);

    return {
      ...base,
      fileProgress: fileLength > 0 ? Math.max(0, Math.min(1, fileDownloaded / fileLength)) : 0,
      fileDownloaded,
      fileLength,
      // Resume window (ahead of the anchor): bytes needed vs downloaded, plus
      // the anchor itself so the caller can pin it for the rest of one episode.
      resumeNeededBytes: resume ? resume.totalBytes : null,
      resumeDownloadedBytes: resume ? resume.downloadedBytes : null,
      resumeAnchorByteStart: typeof readByteStart === "number" ? readByteStart : null,
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
   * Count, by whole torrent pieces, how many bytes of the window AHEAD of the
   * current read position are downloaded — i.e. how much is still to download
   * before playback can continue from that point. Mirrors
   * {@link #getHeaderRangeProgress}, for the moving read head.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {import("webtorrent").TorrentFile} file
   * @param {number} readByteStart - Byte offset within the file the reader is at.
   * @returns {{ totalBytes: number, downloadedBytes: number } | null}
   */
  #getResumeWindowProgress(torrent, file, readByteStart) {
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
    const windowStart = Math.max(0, Math.min(Number(readByteStart) || 0, fileLength - 1));
    const windowEnd = Math.min(fileLength - 1, windowStart + PRIORITY_WINDOW_BYTES - 1);
    const firstPiece = Math.floor((fileOffset + windowStart) / pieceLength);
    const lastPiece = Math.floor((fileOffset + windowEnd) / pieceLength);
    // Byte-accurate: count the PARTIAL progress of in-progress pieces (not whole
    // pieces), so "amount left" moves smoothly instead of jumping by a whole
    // piece (8 MB here) at a time.
    let totalBytes = 0;
    let downloadedBytes = 0;
    for (let piece = firstPiece; piece <= lastPiece; piece += 1) {
      totalBytes += pieceLength;
      downloadedBytes += pieceDownloadedBytes(torrent, piece);
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
    // Two callers can ask for the same edges at once: the warm-up that starts
    // when a torrent is picked, and the playback plan a moment later. Reading
    // the same two pieces twice costs nothing in bandwidth — the torrent
    // fetches each piece once — but it does open a second pair of readers, each
    // claiming a window and holding pieces. One is enough.
    const inFlightKey = `${torrent.infoHash}:${fileIndex}`;
    const running = this.#edgePrefetches.get(inFlightKey);
    if (running) {
      return running;
    }
    const prefetch = this.#prefetchFileEdgesOnce(torrent, fileIndex, { headBytes, tailBytes, timeoutMs });
    this.#edgePrefetches.set(inFlightKey, prefetch);
    try {
      return await prefetch;
    } finally {
      this.#edgePrefetches.delete(inFlightKey);
    }
  }

  /**
   * The body of {@link prefetchFileEdges}, without the de-duplication.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {number} fileIndex
   * @param {{ headBytes: number, tailBytes: number, timeoutMs: number }} options
   * @returns {Promise<void>}
   */
  async #prefetchFileEdgesOnce(torrent, fileIndex, { headBytes, tailBytes, timeoutMs }) {
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
   * Drop the pieces of files nobody is reading from the download set.
   *
   * It does NOT select the files that ARE in use, and that is the point. What a
   * file needs is decided by the readers walking it: each one claims a moving
   * window around its own read head and gives it back when it ends (see
   * `torrent-worker/piece-reader.js`). Selecting the whole file here as well
   * put a second, contradictory claim on the same pieces — one that covered
   * everything and therefore always outranked the window — and it was re-made
   * on every single `/stream` request, so a seek's prioritisation survived at
   * most until the next one. Measured consequence: a seek to 89.1% of a 4.7 GB
   * film waited 93 s while the swarm fetched 2.47 GB in file order.
   *
   * A file with no reader is deselected outright, which is what stops a torrent
   * downloading files the viewer never opened.
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
      if (!file || (usage.get(index) ?? 0) > 0) {
        continue;
      }
      if (typeof file.deselect === "function") {
        file.deselect();
      }
    }
  }

  /**
   * Record where a file is being read from.
   *
   * This used to also decide what the torrent should download, and that was the
   * mistake: it was one of THREE places claiming pieces for the same file — the
   * whole-file `file.select()` in `#syncSelections`, this method, and the reader
   * itself — and they overwrote each other on every request. The claim now
   * belongs to the reader alone, which holds a moving window around its own read
   * head and gives it back when it ends
   * (`torrent-worker/piece-reader.js`); several readers on one file therefore
   * produce the union of their windows instead of the last caller's opinion.
   *
   * What is left here is bookkeeping the readers cannot do: `getFileStats`
   * reports how much of the window ahead of the read head is still missing, so
   * the viewer can be shown how long a resume will take, and a jump in the read
   * position is logged because a seek that never reaches the torrent is
   * invisible otherwise.
   *
   * @param {import("webtorrent").Torrent} torrent
   * @param {number} fileIndex
   * @param {number} byteStart - Start offset within the file.
   * @param {number} [windowBytes] - Unused; kept so callers need not change.
   * @param {{ wholeFileRead?: boolean, isPlaybackRead?: boolean }} [options] -
   *   `wholeFileRead` marks a request that carried no byte range, i.e. one that
   *   merely opens the file at 0 rather than asking to read from there.
   *   `isPlaybackRead` marks the encoder's input read, the only one that
   *   follows the viewer. See the guards below.
   * @returns {void}
   */
  prioritizeByteRange(
    torrent,
    fileIndex,
    byteStart,
    windowBytes = PRIORITY_WINDOW_BYTES,
    options = {}
  ) {
    if (!torrent || !Array.isArray(torrent.files)) {
      return;
    }
    const file = torrent.files[fileIndex];
    if (!file) {
      return;
    }
    const fileLength = Number(file.length);
    if (!Number.isFinite(fileLength) || fileLength <= 0) {
      return;
    }

    const safeStart = Math.max(0, Number(byteStart) || 0);

    // Remember where this file is being read from, so getFileStats can report the
    // download progress of the window ahead of the read head (resume amount).
    let readPositions = this.#readPositionByTorrent.get(torrent);
    if (!readPositions) {
      readPositions = new Map();
      this.#readPositionByTorrent.set(torrent, readPositions);
    }
    const previousStart = readPositions.get(fileIndex);

    // A request with no byte range says nothing about where the viewer is. ffmpeg
    // opens its input with a plain GET and abandons it the moment it seeks, and
    // the keyframe index and the codec probe do the same — four such reads around
    // every encoder restart, each one arriving here as "position 0". Acting on
    // them undoes the seek that just happened: the whole file is re-selected from
    // piece 0, the picker skips the pieces already on disk and walks the swarm
    // forward from the first hole. Measured on a 4.7 GB film: a seek to 89.1%
    // downloaded 2.47 GB over 93 s before the segment could be served. So a
    // whole-file read only sets the position when nothing else has.
    if (options.wholeFileRead && previousStart !== undefined) {
      return;
    }

    readPositions.set(fileIndex, safeStart);

    // Log jumps only. Sequential reading calls this on every range request and
    // would drown the log; a jump is a seek, and a seek that never reaches the
    // torrent is exactly the failure this line exists to make visible — after a
    // seek the encoder waits on pieces nobody has been told to fetch.
    const isJump =
      previousStart === undefined || Math.abs(safeStart - previousStart) > PRIORITY_WINDOW_BYTES;
    if (isJump) {
      // A jump in the read that follows the viewer is a seek. Whatever the
      // swarm was giving us was for somewhere else, and the pieces at the new
      // position have to be earned from peers that are choking us — the same
      // standing start as a fresh torrent. A jump in any OTHER read is the
      // codec probe or the keyframe index visiting the ends of the file, and
      // nobody is waiting on those the way a viewer waits on a seek.
      if (options.isPlaybackRead) {
        this.#markHurry(torrent, "the viewer moved");
      }
      const percent = ((safeStart / fileLength) * 100).toFixed(1);
      logger.info(
        `torrent-pool: [${String(torrent.infoHash).slice(0, 8)}] read position -> ` +
        `${(safeStart / 1024 / 1024).toFixed(0)}MB (${percent}% of file ${fileIndex})` +
        (previousStart === undefined ? " (first)" : ` (was ${(previousStart / 1024 / 1024).toFixed(0)}MB)`)
      );
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
