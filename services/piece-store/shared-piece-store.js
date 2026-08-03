/**
 * @file Torrent pieces in shared memory, with disk as the second tier.
 *
 * Replaces the chunk store WebTorrent would otherwise build for itself. Two
 * reasons, one forced and one chosen.
 *
 * **Forced.** WebTorrent's own piece cache hands out the buffer it keeps using
 * and slices again on the next read. The torrent client now runs on its own
 * thread, and moving a piece to the main thread by transferring ownership
 * detached the cache's memory: proxy 2.9.71-2.9.73 answered every read with an
 * empty body (`Stream ends prematurely at 0`) and the failure was invisible,
 * because the error never reached the reader. Owning the memory ourselves
 * removes the question of whose it was.
 *
 * **Chosen.** Memory this side of the thread boundary can be *shared* memory,
 * which the main thread reads by offset instead of receiving as bytes — see
 * {@link SharedPieceStore#locate}. Measured on the field host: a piece copy
 * costs 3.64 ms, a read from the page cache into a buffer we own 7.63 ms, and
 * re-downloading a piece from the swarm ~1430 ms. So memory first, disk under
 * it, and never the swarm twice.
 *
 * What this deliberately does NOT do is manage the disk as a cache of its own.
 * Pieces evicted from memory are written once and read back on demand; the file
 * is discarded whole when the torrent goes away. libtorrent 2.0 and webtor's
 * seeder both concluded that a hand-rolled disk cache earns less than it costs,
 * and nothing here disagrees.
 */

import { PieceLru } from "./piece-lru.js";
import { DiskTier } from "./disk-tier.js";

/** Fallback budget when the caller names none: enough for a comfortable window. */
const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024;
/**
 * Never keep fewer than this many pieces resident, whatever the budget says.
 *
 * Two is the smallest workable number rather than a round one: a piece being
 * read holds its slot, so a second slot must exist for the next piece to land
 * in. With one, a single reader would deadlock the store against itself.
 */
const MIN_RESIDENT_PIECES = 2;

/**
 * A chunk store holding pieces in a `SharedArrayBuffer`, spilling to disk.
 *
 * Implements the `abstract-chunk-store` shape WebTorrent expects — `put`,
 * `get`, `close`, `destroy` — plus {@link locate}, {@link pin} and
 * {@link unpin}, which is how the main thread reads a piece without it being
 * copied or moved.
 */
export class SharedPieceStore {
  #chunkLength;
  #lastChunkLength;
  #lastChunkIndex;
  #capacity;
  /** @type {SharedArrayBuffer} */
  #shared;
  /** @type {Buffer} A view over the whole pool, for slot arithmetic. */
  #pool;
  /** Piece index → slot number. */
  #slotOf = new Map();
  /** Slot numbers not currently holding a piece. */
  #freeSlots = [];
  #lru;
  #disk;
  #closed = false;

  /**
   * @param {number} chunkLength - Piece length, and therefore the slot size.
   * @param {object} [options]
   * @param {number} [options.length] - Total torrent length, so the short last piece is sized correctly.
   * @param {number} [options.memoryBytes] - Budget for resident pieces.
   * @param {string} [options.path] - Directory for the spill file.
   * @param {string} [options.name] - Spill file name; must be unique per torrent.
   */
  constructor(chunkLength, options = {}) {
    if (!Number.isInteger(chunkLength) || chunkLength < 1) {
      throw new Error(`Chunk length must be a positive integer, got ${chunkLength}.`);
    }
    this.#chunkLength = chunkLength;

    const totalLength = Number.isFinite(options.length) ? options.length : 0;
    this.#lastChunkIndex = totalLength > 0 ? Math.ceil(totalLength / chunkLength) - 1 : -1;
    const remainder = totalLength % chunkLength;
    this.#lastChunkLength = remainder === 0 ? chunkLength : remainder;

    const memoryBytes = Number.isFinite(options.memoryBytes) && options.memoryBytes > 0
      ? options.memoryBytes
      : DEFAULT_MEMORY_BYTES;
    this.#capacity = Math.max(MIN_RESIDENT_PIECES, Math.floor(memoryBytes / chunkLength));

    this.#shared = new SharedArrayBuffer(this.#capacity * chunkLength);
    this.#pool = Buffer.from(this.#shared);
    for (let slot = 0; slot < this.#capacity; slot += 1) {
      this.#freeSlots.push(slot);
    }
    this.#lru = new PieceLru(this.#capacity);
    this.#disk = new DiskTier({
      directory: options.path ?? ".",
      name: `${options.name ?? "pieces"}.pieces`,
      chunkLength
    });
  }

  /** `abstract-chunk-store` exposes the piece size under this name. */
  get chunkLength() {
    return this.#chunkLength;
  }

  /**
   * The pool itself, so another thread can map the same memory and read a piece
   * by the offset {@link locate} reports.
   *
   * @returns {SharedArrayBuffer}
   */
  get sharedBuffer() {
    return this.#shared;
  }

  /** How many pieces fit in memory at once. */
  get capacity() {
    return this.#capacity;
  }

  /** How many pieces are resident right now. */
  get residentCount() {
    return this.#slotOf.size;
  }

  /** How many pieces have been spilled to disk. */
  get spilledCount() {
    return this.#disk.size;
  }

  /**
   * Length of a given piece — the last one is usually short.
   *
   * @param {number} index
   * @returns {number}
   */
  #lengthOf(index) {
    return index === this.#lastChunkIndex ? this.#lastChunkLength : this.#chunkLength;
  }

  /**
   * Where a resident piece sits in the shared pool, or `null` if it is not
   * resident.
   *
   * The main thread reads straight from those bytes, so callers MUST hold a pin
   * across the read — see {@link pin}.
   *
   * @param {number} index
   * @returns {{ offset: number, length: number } | null}
   */
  locate(index) {
    const slot = this.#slotOf.get(index);
    if (slot === undefined) {
      return null;
    }
    return { offset: slot * this.#chunkLength, length: this.#lengthOf(index) };
  }

  /**
   * Hold a piece in memory across a read. Nested; release with {@link unpin}.
   *
   * @param {number} index
   * @returns {void}
   */
  pin(index) {
    this.#lru.pin(index);
  }

  /**
   * @param {number} index
   * @returns {void}
   */
  unpin(index) {
    this.#lru.unpin(index);
  }

  /**
   * Make a slot available, spilling the least recently used piece if need be.
   *
   * @returns {Promise<number>} Slot number.
   */
  async #claimSlot() {
    const free = this.#freeSlots.pop();
    if (free !== undefined) {
      return free;
    }

    const victim = this.#lru.evictionCandidate();
    if (victim === null) {
      // Every resident piece is being read. Taking one anyway is precisely the
      // failure this store exists to make impossible.
      throw new Error("Every resident piece is pinned; no slot can be freed.");
    }

    const slot = this.#slotOf.get(victim);
    const bytes = this.#pool.subarray(slot * this.#chunkLength, slot * this.#chunkLength + this.#lengthOf(victim));
    await this.#disk.write(victim, bytes);

    this.#slotOf.delete(victim);
    this.#lru.remove(victim);
    return slot;
  }

  /**
   * Store a piece.
   *
   * @param {number} index
   * @param {Uint8Array} bytes
   * @param {(error?: Error | null) => void} [callback]
   * @returns {void}
   */
  put(index, bytes, callback = () => undefined) {
    if (this.#closed) {
      queueMicrotask(() => callback(new Error("Piece store is closed.")));
      return;
    }

    const existing = this.#slotOf.get(index);
    const write = async () => {
      const slot = existing ?? (await this.#claimSlot());
      bytes.copy
        ? bytes.copy(this.#pool, slot * this.#chunkLength)
        : this.#pool.set(bytes, slot * this.#chunkLength);
      this.#slotOf.set(index, slot);
      this.#lru.touch(index);
      // A newer copy is in memory; whatever is on disk is stale.
      this.#disk.forget(index);
    };

    write().then(() => callback(null), (error) => callback(error));
  }

  /**
   * Fetch a piece, or a range within it.
   *
   * Returns a buffer of its own rather than a view into the pool: WebTorrent
   * keeps what it is given — to verify a hash, to serve a peer — and the slot
   * underneath may be reused meanwhile. The thread-crossing path avoids this
   * copy entirely by going through {@link locate}.
   *
   * @param {number} index
   * @param {{ offset?: number, length?: number } | ((error: Error | null, bytes?: Buffer) => void)} [options]
   * @param {(error: Error | null, bytes?: Buffer) => void} [callback]
   * @returns {void}
   */
  get(index, options, callback) {
    if (typeof options === "function") {
      return this.get(index, undefined, options);
    }
    const done = callback ?? (() => undefined);
    if (this.#closed) {
      queueMicrotask(() => done(new Error("Piece store is closed.")));
      return;
    }

    const pieceLength = this.#lengthOf(index);
    const offset = options?.offset ?? 0;
    const length = options?.length ?? pieceLength - offset;

    const fetch = async () => {
      const slot = this.#slotOf.get(index);
      if (slot !== undefined) {
        this.#lru.touch(index);
        const start = slot * this.#chunkLength + offset;
        return Buffer.from(this.#pool.subarray(start, start + length));
      }

      if (!this.#disk.has(index)) {
        throw new Error(`Piece ${index} is not in the store.`);
      }

      // Bring it back into memory: it was just asked for, so it is likely to be
      // asked for again, and the caller may follow up with `locate`.
      const revived = await this.#claimSlot();
      const target = this.#pool.subarray(
        revived * this.#chunkLength,
        revived * this.#chunkLength + pieceLength
      );
      await this.#disk.read(index, target);
      this.#slotOf.set(index, revived);
      this.#lru.touch(index);
      const start = revived * this.#chunkLength + offset;
      return Buffer.from(this.#pool.subarray(start, start + length));
    };

    fetch().then((bytes) => done(null, bytes), (error) => done(error));
  }

  /**
   * Close the store, keeping the spill file.
   *
   * @param {(error?: Error | null) => void} [callback]
   * @returns {void}
   */
  close(callback = () => undefined) {
    this.#closed = true;
    this.#disk.close().then(() => callback(null), (error) => callback(error));
  }

  /**
   * Close the store and delete everything it wrote.
   *
   * @param {(error?: Error | null) => void} [callback]
   * @returns {void}
   */
  destroy(callback = () => undefined) {
    this.#closed = true;
    this.#slotOf.clear();
    this.#disk.destroy().then(() => callback(null), (error) => callback(error));
  }
}
