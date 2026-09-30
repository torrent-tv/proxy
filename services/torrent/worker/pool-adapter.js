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
 *  - **`prioritizeByteRange` stays synchronous.** It returns nothing the caller
 *    inspects, so the command is dispatched and not awaited. Awaiting it would
 *    mean touching every call site for no observable gain.
 *  - **`getTorrent` needs a `sourceKey`.** Torrent objects cannot cross a
 *    thread, so the worker keys them. Callers that have one pass it; the rest
 *    get one derived from the source itself, so the identity stays stable
 *    across calls for the same torrent.
 */

import { TorrentWorkerClient } from "./client.js";
import { deriveSourceKey } from "../../../utils/torrent-source-key.js";

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
   * @param {{ memoryBytes?: number, stateDir?: string }} [options]
   * @param {object | null} [client] - The worker interface; tests supply a fake.
   */
  constructor(options = {}, client = null) {
    this.#client = client ?? new TorrentWorkerClient(options);
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
  /** What the spilled pieces weigh on the torrent thread, as last revised. */
  get spilledBytes() {
    return this.#client.spilledBytes;
  }

  /**
   * Say how much disk those spilled pieces may take between them.
   *
   * @param {number} bytes
   * @returns {Promise<number>} What they hold now.
   */
  allowSpillBytes(bytes) {
    return this.#client.allowSpillBytes(bytes);
  }

  get memoryClaim() {
    return this.#client.memoryClaim ?? { held: 0, wanted: 0 };
  }

  allowMemoryBytes(bytes) {
    return this.#client.allowMemoryBytes(bytes);
  }

  get wholeFileBytes() {
    return this.#client.wholeFileBytes ?? 0;
  }

  /** Completed files announced by the worker, shared with the HTTP reader. */
  get wholeFiles() {
    return this.#client.wholeFiles;
  }

  allowWholeFileBytes(bytes) {
    return this.#client.allowWholeFileBytes(bytes);
  }

  /**
   * Bytes every torrent here has moved.
   *
   * @returns {Promise<{ downloaded: number, uploaded: number }>}
   */
  async getTorrentTotals() {
    return this.#client.getTorrentTotals();
  }

  /**
   * Live download figures for the progress display.
   *
   * @param {object} torrent
   * @param {number | null} [fileIndex]
   * @param {{ resumeAnchorByteStart?: number | null }} [options]
   * @returns {Promise<object | null>}
   */
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
   * Fetch one whole file using only the room the viewer's own reading leaves.
   *
   * For a soundtrack or subtitle file shipped beside the picture: small next to
   * the film, and having it on disk is what turns a later switch into a local
   * read instead of a wait on the swarm.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @returns {Promise<boolean>} Whether a fill was started by this call.
   */
  async fillFileInBackground(torrent, fileIndex) {
    const sourceKey = torrent?.sourceKey;
    if (!sourceKey) {
      return false;
    }
    const answer = await this.#client.fillFile({ sourceKey, fileIndex });
    return answer?.started === true;
  }

  /**
   * Ask the torrent to fetch all remaining files at conditional TAIL urgency.
   *
   * @param {object} torrent
   * @returns {Promise<boolean>}
   */
  async fillTorrent(torrent) {
    const sourceKey = torrent?.sourceKey;
    if (!sourceKey) {
      return false;
    }
    const answer = await this.#client.fillTorrent(sourceKey);
    return answer?.started === true;
  }




  /**
   * Start fetching the region a viewer is about to resume at. Named in seconds
   * here; the worker turns it into bytes, where the file's duration is readable.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {number} positionSeconds
   * @returns {Promise<boolean>}
   */
  async warmResumePosition(torrent, fileIndex, positionSeconds, durationSeconds) {
    const sourceKey = torrent?.sourceKey;
    if (!sourceKey) {
      return false;
    }
    const answer = await this.#client.warmResumePosition({ sourceKey, fileIndex, positionSeconds, durationSeconds });
    return answer?.started === true;
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
   * Hand the download the priority map for one file.
   *
   * The map is republished whenever it changes, so a call that fails costs a
   * moment rather than correctness — which is why the caller lets it go rather
   * than retrying.
   *
   * @param {{ sourceKey: string, fileIndex: number, durationSeconds: number, zones: object[] }} params
   * @returns {Promise<void>}
   */
  async setPriorityMap({ sourceKey, fileIndex, durationSeconds, zones }) {
    if (!sourceKey) {
      return;
    }
    await this.#client.setPriorityMap({ sourceKey, fileIndex, durationSeconds, zones });
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
  /**
   * One byte range of one file, as bytes, on THIS thread.
   *
   * What the media layer is built from: a container takes `readRange(start,
   * end)` and nothing else, so with this it can be parsed here instead of in
   * the torrent thread. It used to be parsed there for one stated reason —
   * "the main thread cannot open a read stream on one of its files", which is
   * true of WebTorrent's own API and not of the bytes: the pieces live in
   * shared memory and this read is the same one that serves every segment,
   * so it waits for what has not arrived and steers the swarm toward it.
   *
   * **It COPIES, deliberately.** The zero-copy path — positions across the
   * channel, the piece pinned until the far side says it is done — exists for
   * 10 MB segments on the critical path, where the copy was measured at
   * 18.84 ms. A container header is 64-256 KB and read once per file, about
   * 0.12 ms, against a parse of 0.8 s and a swarm wait of up to a minute. The
   * pinning protocol would buy nothing and is not on this path.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {number} start - First byte, inclusive.
   * @param {number} end - Last byte, inclusive.
   * @returns {Promise<Buffer | null>} Null when the read failed or was cut
   *   short, which a container reads as "this file does not say".
   */
  /**
   * The byte ranges of one file the torrent holds WHOLE.
   *
   * What the subtitle walk decides from: it may read only what is already
   * downloaded, and a list taken once per pass replaces a question per cluster.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @returns {Promise<Array<[number, number]>>}
   */
  async heldRangesOf(torrent, fileIndex) {
    const sourceKey = torrent?.sourceKey;
    return sourceKey ? this.#client.heldRanges({ sourceKey, fileIndex }) : [];
  }

  /**
   * Bytes of a range the torrent already holds, never fetched.
   *
   * Not `readRangeOf`: that one declares demand and steers the swarm, which is
   * right for a viewer waiting on a segment and wrong for a walk that must pull
   * nothing the viewer is not waiting for.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {number} start
   * @param {number} end - Inclusive.
   * @returns {Promise<Buffer | null>}
   */
  async readHeldOf(torrent, fileIndex, start, end) {
    const sourceKey = torrent?.sourceKey;
    return sourceKey ? this.#client.readHeld({ sourceKey, fileIndex, start, end }) : null;
  }

  async readRangeOf(torrent, fileIndex, start, end) {
    const sourceKey = torrent?.sourceKey;
    if (!sourceKey || !(end >= start) || !(start >= 0)) {
      return null;
    }
    const stream = this.#client.createReadStream({ sourceKey, fileIndex, start, end });
    const chunks = [];
    let total = 0;
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(Buffer.from(value));
        total += value.length;
      }
    } catch {
      return null;
    }
    return total > 0 ? Buffer.concat(chunks, total) : null;
  }

  async prefetchFileEdges(torrent, fileIndex, options = {}) {
    const sourceKey = torrent?.sourceKey;
    if (!sourceKey) {
      return null;
    }
    return this.#client.prefetchFileEdges({ sourceKey, fileIndex, options });
  }

  /**
   * Which films this proxy holds right now, and how much of each.
   *
   * What content affinity is decided from: a viewer of a film somebody here is
   * already downloading costs this proxy the encode and nothing else, while the
   * same viewer sent anywhere else starts the download from nothing.
   *
   * @returns {Promise<{ infoHash: string, progress: number, bytes: number }[]>}
   */
  async heldTorrents() {
    const answer = await this.#client.heldTorrents();
    return Array.isArray(answer?.held) ? answer.held : [];
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
