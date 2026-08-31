/**
 * @file `TorrentPool`'s interface, served from the worker thread.
 *
 * The routes, the planner, the health report and the session manager all reach
 * for a torrent pool and use it the same handful of ways. Rather than rewrite
 * every one of them to thread a `sourceKey` through and await what used to be
 * immediate, this presents the shape they already expect and does the thread
 * hop behind it. Swapping the implementation is then a one-line change at
 * construction, and the call sites are untouched — which is what keeps a change
 * of this size reviewable.
 *
 * Two accommodations are needed, and both are deliberate:
 *
 *  - **`acquireFile` and `prioritizeByteRange` stay synchronous.** They return
 *    nothing the caller inspects, so the command is dispatched and not awaited.
 *    `acquireFile` hands back a release function exactly as before, which sends
 *    its own command when called. Awaiting them would mean touching every call
 *    site for no observable gain.
 *  - **`getTorrent` needs a `sourceKey`.** Torrent objects cannot cross a
 *    thread, so the worker keys them. Callers that have one pass it; the rest
 *    get one derived from the source itself, so the identity stays stable
 *    across calls for the same torrent.
 */

import { TorrentWorkerClient } from "./client.js";
import { deriveSourceKey } from "../torrent-source-key.js";

/**
 * A torrent pool whose work happens on another thread.
 *
 * See `protocol.js` for why: the torrent was taking ~85% of the main thread and
 * everything owed to a viewer queued behind it.
 */
export class WorkerTorrentPool {
  #client;
  /** Stand-ins by source key, so repeat calls return the same object. */
  #torrents = new Map();

  /**
   * @param {{ maxDiskBytes?: number, memoryBytes?: number, stateDir?: string }} [options]
   */
  constructor(options = {}) {
    this.#client = new TorrentWorkerClient(options);
  }

  /**
   * Load (or join) a torrent and return a stand-in for it.
   *
   * @param {"magnet" | "torrent"} sourceType
   * @param {string} source
   * @returns {Promise<object>}
   */
  async getTorrent(sourceType, source) {
    const sourceKey = await deriveSourceKey(sourceType, source);
    const existing = this.#torrents.get(sourceKey);
    if (existing) {
      return existing;
    }
    const torrent = await this.#client.getTorrent({ sourceKey, sourceType, source });
    this.#torrents.set(sourceKey, torrent);
    return torrent;
  }

  /**
   * Claim a file for reading; the returned function releases it.
   *
   * Synchronous by design — see the file header.
   *
   * @param {object} torrent - A stand-in from {@link getTorrent}.
   * @param {number} fileIndex
   * @returns {() => void}
   */
  acquireFile(torrent, fileIndex) {
    const sourceKey = torrent?.sourceKey;
    if (!sourceKey) {
      return () => undefined;
    }
    // Dispatched, not awaited — callers use the result immediately and inspect
    // nothing. But the release MUST NOT overtake it: both are ordinary messages
    // to the worker, and if release arrives first the reader count drops to zero
    // while a read is still running. The idle sweep then removes the torrent AND
    // its downloaded data out from under the encoder — field 2026-08-02:
    // "removed idle torrent ... and its store" mid-playback, after which every
    // read hung and ffmpeg saw an empty input ("Stream ends prematurely at 0").
    // Chaining the release onto the acquire keeps them in order.
    const acquired = this.#client.acquireFile(sourceKey, fileIndex).catch(() => null);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      // Release the claim this call opened, not "the file" — waiting for the
      // acquire is also what tells us which claim that is.
      void acquired
        .then((claimId) => (claimId ? this.#client.releaseFile(claimId) : undefined))
        .catch(() => undefined);
    };
  }

  /**
   * Live download figures for the progress display.
   *
   * @param {object} torrent
   * @param {number | null} [fileIndex]
   * @param {{ resumeAnchorByteStart?: number | null }} [options]
   * @returns {Promise<object | null>}
   */
  /**
   * Bytes every torrent here has moved.
   *
   * @returns {Promise<{ downloaded: number, uploaded: number }>}
   */
  async getTorrentTotals() {
    return this.#client.getTorrentTotals();
  }

  async getFileStats(torrent, fileIndex = null, options = {}) {
    const sourceKey = torrent?.sourceKey;
    if (!sourceKey) {
      return null;
    }
    return this.#client.getFileStats({
      sourceKey,
      fileIndex,
      resumeAnchorByteStart: options?.resumeAnchorByteStart ?? null
    });
  }

  /**
   * The text subtitle tracks a file carries, read from its own header.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @returns {Promise<object[]>}
   */
  async getSubtitleTracks(torrent, fileIndex) {
    const sourceKey = torrent?.sourceKey;
    if (!sourceKey) {
      return [];
    }
    const answer = await this.#client.getSubtitleTracks({ sourceKey, fileIndex });
    return Array.isArray(answer?.tracks) ? answer.tracks : [];
  }

  /**
   * What the container itself declares about its subtitle tracks, in its own
   * order and including the picture-based ones — for lining up against
   * ffmpeg's own numbering.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @returns {Promise<object[]>}
   */
  async getDeclaredSubtitleTracks(torrent, fileIndex) {
    const sourceKey = torrent?.sourceKey;
    if (!sourceKey) {
      return [];
    }
    const answer = await this.#client.getSubtitleTracks({ sourceKey, fileIndex });
    return Array.isArray(answer?.declared) ? answer.declared : [];
  }

  /**
   * The cues of one subtitle track that the downloaded clusters already carry.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {number} trackNumber
   * @returns {Promise<object | null>}
   */
  async getSubtitleCues(torrent, fileIndex, trackNumber) {
    const sourceKey = torrent?.sourceKey;
    if (!sourceKey) {
      return null;
    }
    return this.#client.getSubtitleCues({ sourceKey, fileIndex, trackNumber });
  }

  /**
   * Reorder piece selection around a read position.
   *
   * Synchronous by design — see the file header.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {number} byteStart
   * @param {number} [windowBytes]
   * @param {{ wholeFileRead?: boolean }} [options]
   * @returns {void}
   */
  prioritizeByteRange(torrent, fileIndex, byteStart, windowBytes, options) {
    const sourceKey = torrent?.sourceKey;
    if (!sourceKey) {
      return;
    }
    void this.#client
      .prioritizeByteRange({
        sourceKey,
        fileIndex,
        byteStart,
        windowBytes,
        wholeFileRead: options?.wholeFileRead === true
      })
      .catch(() => undefined);
  }

  /**
   * Pre-fetch the head and tail the codec probe needs.
   *
   * Takes an options object, matching `TorrentPool.prefetchFileEdges` — this
   * adapter exists to present that same interface. It previously declared
   * positional parameters instead, so the planner's options object arrived as
   * `headBytes` and only worked because it was passed along far enough to be
   * destructured at the far end. Anyone calling it as documented got the
   * defaults instead of the sizes they asked for.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {{ headBytes?: number, tailBytes?: number, timeoutMs?: number }} [options]
   * @returns {Promise<unknown>}
   */
  async prefetchFileEdges(torrent, fileIndex, options = {}) {
    const sourceKey = torrent?.sourceKey;
    if (!sourceKey) {
      return null;
    }
    return this.#client.prefetchFileEdges({ sourceKey, fileIndex, options });
  }

  /**
   * Shut the torrent client down and stop the thread.
   *
   * @returns {Promise<void>}
   */
  async destroyAll() {
    this.#torrents.clear();
    await this.#client.destroyAll();
  }
}
