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

import os from "node:os";
import { PieceLru } from "./piece-lru.js";
import { DiskTier } from "./disk-tier.js";

/**
 * Live stores, so the worker can report on them.
 *
 * WebTorrent constructs the store itself, deep inside its own wrappers, so
 * there is no handle to reach for from outside. Registering here is what makes
 * the store's behaviour visible in the field at all — without it the first
 * strange case has nothing to go on.
 *
 * @type {Set<SharedPieceStore>}
 */
const liveStores = new Set();

/**
 * A snapshot of every live store, for logging.
 *
 * @returns {{ name: string, resident: number, capacity: number, spilled: number, fromMemory: number, fromDisk: number, spills: number, revivals: number, blockedByPins: number }[]}
 */
export function collectStoreStats() {
  return [...liveStores].map((store) => store.stats());
}

/**
 * The shared store behind a torrent, or `null` if it is not one of ours.
 *
 * WebTorrent wraps whatever store it is given — today in `ImmediateChunkStore`,
 * and historically in a piece cache as well — and offers no way to ask for the
 * innermost one. Walking the `store` chain finds it regardless of how many
 * wrappers there are or what order they sit in, which is sturdier than reaching
 * for a fixed `torrent.store.store`.
 *
 * @param {{ store?: object } | null | undefined} torrent
 * @returns {SharedPieceStore | null}
 */
export function findSharedStore(torrent) {
  let candidate = torrent?.store;
  // Bounded rather than `while (candidate)`: a store that referenced itself
  // would otherwise hang the thread instead of failing.
  for (let depth = 0; candidate && depth < 8; depth += 1) {
    if (candidate instanceof SharedPieceStore) {
      return candidate;
    }
    candidate = candidate.store;
  }
  return null;
}

/**
 * Ceiling for the automatic budget, and the share of free memory it will take.
 *
 * A flat default would be a guess dressed as a decision: the proxy runs on
 * whatever the owner has, from a Pi to a rented box, and the budget is **per
 * torrent** — several viewers mean several of these. Measured on the field host
 * after one session: the proxy container sat at 796 MB with 4.1 GB free and 1.3
 * GB already in swap, so a fixed half-gigabyte per torrent is not something to
 * hand out blindly. Hence: a quarter of what is free, capped.
 */
const MEMORY_BUDGET_CEILING_BYTES = 512 * 1024 * 1024;
const FREE_MEMORY_SHARE = 0.25;

/**
 * Budget for one torrent's resident pieces when the caller names none.
 *
 * @returns {number}
 */
function defaultMemoryBytes() {
  const share = Math.floor(os.freemem() * FREE_MEMORY_SHARE);
  return Math.max(MIN_BUDGET_BYTES, Math.min(MEMORY_BUDGET_CEILING_BYTES, share));
}

/** Floor for the automatic budget — below this the store thrashes to disk. */
const MIN_BUDGET_BYTES = 64 * 1024 * 1024;
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
  /** Slots backed by memory right now; grows towards {@link capacity}. */
  #allocatedSlots = 0;
  #closed = false;
  #name;
  /**
   * What the store has actually been doing. Reported, not just kept: the
   * balance between memory and disk reads is the number that says whether the
   * budget is right, and it cannot be guessed from outside.
   */
  #counters = {
    fromMemory: 0,
    fromDisk: 0,
    spills: 0,
    revivals: 0,
    blockedByPins: 0
  };

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
      : defaultMemoryBytes();
    this.#capacity = Math.max(MIN_RESIDENT_PIECES, Math.floor(memoryBytes / chunkLength));

    // Grows into the budget instead of taking it up front. The budget is per
    // torrent, so claiming all of it on `add` would charge a host for pieces
    // nobody has asked for — and a torrent that is merely open, or one being
    // probed for its codecs, needs a handful of slots, not the ceiling.
    this.#shared = new SharedArrayBuffer(MIN_RESIDENT_PIECES * chunkLength, {
      maxByteLength: this.#capacity * chunkLength
    });
    this.#pool = Buffer.from(this.#shared);
    for (let slot = 0; slot < MIN_RESIDENT_PIECES; slot += 1) {
      this.#freeSlots.push(slot);
    }
    this.#allocatedSlots = MIN_RESIDENT_PIECES;
    this.#lru = new PieceLru(this.#capacity);
    this.#name = options.name ?? "pieces";
    this.#disk = new DiskTier({
      directory: options.path ?? ".",
      name: `${this.#name}.pieces`,
      chunkLength
    });
    liveStores.add(this);
  }

  /**
   * What this store has been doing, for the periodic report.
   *
   * @returns {{ name: string, resident: number, capacity: number, spilled: number, fromMemory: number, fromDisk: number, spills: number, revivals: number, blockedByPins: number }}
   */
  stats() {
    return {
      name: this.#name,
      resident: this.#slotOf.size,
      capacity: this.#capacity,
      spilled: this.#disk.size,
      ...this.#counters
    };
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

    // Room left in the budget: take more memory rather than evicting. Growing
    // replaces the view over the pool, so every slot offset stays valid — the
    // bytes do not move.
    if (this.#allocatedSlots < this.#capacity) {
      this.#allocatedSlots += 1;
      this.#shared.grow(this.#allocatedSlots * this.#chunkLength);
      this.#pool = Buffer.from(this.#shared);
      return this.#allocatedSlots - 1;
    }

    const victim = this.#lru.evictionCandidate();
    if (victim === null) {
      // Every resident piece is being read. Taking one anyway is precisely the
      // failure this store exists to make impossible.
      this.#counters.blockedByPins += 1;
      throw new Error("Every resident piece is pinned; no slot can be freed.");
    }

    const slot = this.#slotOf.get(victim);
    const bytes = this.#pool.subarray(slot * this.#chunkLength, slot * this.#chunkLength + this.#lengthOf(victim));
    await this.#disk.write(victim, bytes);
    this.#counters.spills += 1;

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
        this.#counters.fromMemory += 1;
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
      this.#counters.fromDisk += 1;
      this.#counters.revivals += 1;
      const start = revived * this.#chunkLength + offset;
      return Buffer.from(this.#pool.subarray(start, start + length));
    };

    fetch().then((bytes) => done(null, bytes), (error) => done(error));
  }

  /**
   * Ensure a piece is in memory and say where it sits — without copying it.
   *
   * This is {@link get} minus its final copy, and it exists for exactly one
   * caller: the reader that hands pieces to the other thread. That thread maps
   * the same {@link sharedBuffer}, so an offset and a length are all it needs,
   * and the bytes never move. `get` cannot serve that purpose because
   * WebTorrent keeps what `get` returns while the slot underneath may be
   * reused.
   *
   * The caller MUST hold a pin across the whole read — the returned offset
   * stays valid only while the piece is pinned.
   *
   * @param {number} index
   * @returns {Promise<{ offset: number, length: number } | null>} `null` when
   *   the store holds no such piece, in memory or on disk.
   */
  async reside(index) {
    if (this.#closed) {
      throw new Error("Piece store is closed.");
    }

    const slot = this.#slotOf.get(index);
    if (slot !== undefined) {
      this.#lru.touch(index);
      this.#counters.fromMemory += 1;
      return this.locate(index);
    }

    if (!this.#disk.has(index)) {
      return null;
    }

    const pieceLength = this.#lengthOf(index);
    const revived = await this.#claimSlot();
    const target = this.#pool.subarray(
      revived * this.#chunkLength,
      revived * this.#chunkLength + pieceLength
    );
    await this.#disk.read(index, target);
    this.#slotOf.set(index, revived);
    this.#lru.touch(index);
    this.#counters.fromDisk += 1;
    this.#counters.revivals += 1;
    return this.locate(index);
  }

  /**
   * Close the store, keeping the spill file.
   *
   * @param {(error?: Error | null) => void} [callback]
   * @returns {void}
   */
  close(callback = () => undefined) {
    this.#closed = true;
    liveStores.delete(this);
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
    liveStores.delete(this);
    this.#slotOf.clear();
    this.#disk.destroy().then(() => callback(null), (error) => callback(error));
  }
}
