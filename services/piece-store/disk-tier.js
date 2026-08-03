/**
 * @file The second tier: pieces that no longer fit in memory.
 *
 * One sparse file per torrent, a piece at `index * chunkLength`. Not the
 * torrent's real files — nobody reads those directly; playback goes through
 * `/stream`, and the data is discarded when the torrent goes idle. A single
 * file by piece index keeps the mapping arithmetic instead of bookkeeping, and
 * sparseness means the untouched gaps cost nothing.
 *
 * Reads take a destination buffer rather than returning a fresh one. That is
 * not a style preference — measured on the field host, an 8 MB piece costs
 * 22.08 ms via `readFile`, which allocates, and **7.63 ms** read into a buffer
 * we already hold. Two thirds of the apparent "disk" cost was allocation.
 */

import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export class DiskTier {
  #filePath;
  #chunkLength;
  /** @type {import("node:fs/promises").FileHandle | null} */
  #handle = null;
  /** Piece indices known to be on disk. */
  #stored = new Set();
  /** @type {Promise<void> | null} */
  #opening = null;

  /**
   * @param {object} params
   * @param {string} params.directory - Where the backing file lives.
   * @param {string} params.name - File name, unique per torrent.
   * @param {number} params.chunkLength - Piece size; fixes the stride on disk.
   */
  constructor({ directory, name, chunkLength }) {
    this.#filePath = path.join(directory, name);
    this.#chunkLength = chunkLength;
  }

  /** Where the backing file lives, for logging and cleanup. */
  get filePath() {
    return this.#filePath;
  }

  /** How many pieces are currently held on disk. */
  get size() {
    return this.#stored.size;
  }

  /**
   * Open the backing file, creating it and its directory if needed.
   *
   * Concurrent callers share one open — several evictions can start at once.
   *
   * @returns {Promise<import("node:fs/promises").FileHandle>}
   */
  async #open() {
    if (this.#handle) {
      return this.#handle;
    }
    if (!this.#opening) {
      this.#opening = (async () => {
        await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
        // Read/write, created if absent — NOT append mode. Under `a+` POSIX
        // ignores the position on every write and puts the bytes at the end of
        // the file, so pieces would pile up in arrival order and each read
        // would return whichever piece happened to land at that offset.
        this.#handle = await fs.open(this.#filePath, constants.O_RDWR | constants.O_CREAT);
      })();
    }
    await this.#opening;
    if (!this.#handle) {
      throw new Error(`Could not open the piece file at ${this.#filePath}.`);
    }
    return this.#handle;
  }

  /**
   * @param {number} index
   * @returns {boolean}
   */
  has(index) {
    return this.#stored.has(index);
  }

  /**
   * Write a piece out.
   *
   * @param {number} index
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   */
  async write(index, bytes) {
    const handle = await this.#open();
    await handle.write(bytes, 0, bytes.length, index * this.#chunkLength);
    this.#stored.add(index);
  }

  /**
   * Read a piece back into a buffer the caller already owns.
   *
   * @param {number} index
   * @param {Uint8Array} target - Destination; its length is what gets read.
   * @returns {Promise<number>} Bytes read.
   */
  async read(index, target) {
    if (!this.#stored.has(index)) {
      throw new Error(`Piece ${index} is not on disk.`);
    }
    const handle = await this.#open();
    const { bytesRead } = await handle.read(target, 0, target.length, index * this.#chunkLength);
    return bytesRead;
  }

  /**
   * Forget a piece. The bytes stay on disk until the file is removed — there is
   * nothing to gain from punching them out, since the file is discarded whole.
   *
   * @param {number} index
   * @returns {void}
   */
  forget(index) {
    this.#stored.delete(index);
  }

  /**
   * Close the file, leaving its contents in place.
   *
   * @returns {Promise<void>}
   */
  async close() {
    const handle = this.#handle;
    this.#handle = null;
    this.#opening = null;
    if (handle) {
      await handle.close();
    }
  }

  /**
   * Close and delete the backing file.
   *
   * @returns {Promise<void>}
   */
  async destroy() {
    await this.close();
    this.#stored.clear();
    await fs.rm(this.#filePath, { force: true });
  }
}
