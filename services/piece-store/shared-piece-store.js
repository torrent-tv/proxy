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
import { readFileSync } from "node:fs";
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
 * @returns {{ name: string, resident: number, capacity: number, residentBytes: number, budgetBytes: number, spilled: number, fromMemory: number, fromDisk: number, spills: number, revivals: number, blockedByPins: number }[]}
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
 * Ceiling for the automatic budget, and the share of available memory it takes.
 *
 * A flat default would be a guess dressed as a decision: the proxy runs on
 * whatever the owner has, from a Pi to a rented box. So it is a share of what
 * the machine can actually give, capped.
 *
 * Two things about this were wrong until 2026-08-28, and the kernel found both.
 * It killed the proxy at 2.4 GB resident (`exit code 137`, no dump, `Out of
 * memory: Killed process ... anon-rss: 2422628kB`), on a host with under two
 * gigabytes to spare and an `oom_score_adj` of 200 that makes the addon the
 * first thing chosen.
 *
 * The first: the budget was **per torrent**, so two torrents meant two of it and
 * nothing anywhere asked what the process as a whole was holding. It is shared
 * now — {@link budgetForNewStore} divides what is allowed between the stores
 * that exist.
 *
 * The second: it was a share of `os.freemem()`, which on Linux counts only the
 * pages free at that instant while the kernel deliberately keeps that number low
 * by filling the rest with reclaimable cache. The kernel publishes its own
 * estimate of what an allocation could obtain — `MemAvailable` — and that is the
 * quantity to divide.
 */
const MEMORY_BUDGET_CEILING_BYTES = 512 * 1024 * 1024;
const AVAILABLE_MEMORY_SHARE = 0.25;

/**
 * What all torrent stores together may hold, in bytes.
 *
 * Sampled when a store is made rather than kept, because what the machine has
 * to spare is not ours to predict: another container starting is as much a
 * change as another viewer arriving.
 *
 * @param {number} availableBytes - What the machine can still give out.
 * @returns {number}
 */
export function totalStoreBudgetBytes(availableBytes) {
  const share = Math.floor(Math.max(availableBytes, 0) * AVAILABLE_MEMORY_SHARE);
  return Math.max(MIN_BUDGET_BYTES, Math.min(MEMORY_BUDGET_CEILING_BYTES, share));
}

/**
 * One store's share of the whole, given how many stores there will be.
 *
 * Divided rather than handed out whole: the failure this replaces is several
 * stores each taking the maximum. The floor is what a store needs to work at
 * all — below it the store thrashes to disk and the viewer pays for it — so a
 * proxy serving many torrents at once on a small machine will exceed the total,
 * and that is deliberate: refusing to serve is worse, and the memory report now
 * says plainly what is being held.
 *
 * @param {number} availableBytes
 * @param {number} storeCount - Stores that will exist, this one included.
 * @returns {number}
 */
export function budgetForNewStore(availableBytes, storeCount) {
  const total = totalStoreBudgetBytes(availableBytes);
  const shares = Math.max(1, Math.floor(storeCount));
  return Math.max(MIN_BUDGET_BYTES, Math.floor(total / shares));
}

/**
 * Budget for one torrent's resident pieces when the caller names none.
 *
 * @returns {number}
 */
function defaultMemoryBytes() {
  return budgetForNewStore(availableMemorySync(), liveStores.size + 1);
}

/**
 * What the machine can still give out, without waiting on a file read.
 *
 * The store is constructed synchronously, so the asynchronous reading in
 * `services/memory-report.js` cannot be used here. `MemAvailable` is read from
 * `/proc` with a blocking read, which is a few microseconds on a pseudo-file,
 * and `os.freemem()` remains the answer where `/proc` is not there.
 *
 * @returns {number}
 */
function availableMemorySync() {
  try {
    const text = readFileSync("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
    if (match) {
      return Number(match[1]) * 1024;
    }
  } catch {
    // silent-ok: not Linux, or /proc is not mounted.
  }
  return os.freemem();
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
 * How long a caller waits for a pinned piece to be released before the store
 * calls it a deadlock. A pin lasts one read of one piece — milliseconds — so
 * anything approaching this is a reader waiting for itself.
 */
const PINNED_WAIT_MS = 5_000;
/** How often a wait for a slot looks again when no event is due to wake it. */
const CLAIM_RETRY_MS = 50;

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
  /**
   * Pieces being written out to disk right now: index → that write.
   *
   * Such a piece is in neither place — its slot has already been given away,
   * and the disk copy is not finished. A reader arriving in that window must
   * wait for the write instead of concluding the piece is gone.
   *
   * @type {Map<number, Promise<void>>}
   */
  #evicting = new Map();
  /**
   * Slots handed out but not yet recorded against a piece.
   *
   * A slot is claimed before the piece is copied into it, so between those two
   * moments the slot belongs to nobody the books know about. Without counting
   * them, a burst of concurrent puts — which is the normal case, pieces arrive
   * from many peers at once — sees an empty eviction list and concludes the
   * store is exhausted, when in fact it is merely mid-flight.
   */
  #outstandingSlots = 0;
  /** When the wait for a pinned piece began; 0 when nothing is waiting. */
  #pinnedWaitStartedAt = 0;
  /** Resolvers waiting for a slot to become claimable. @type {(() => void)[]} */
  #waiters = [];
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
    blockedByPins: 0,
    waitedForPins: 0
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
   * @returns {{ name: string, resident: number, capacity: number, residentBytes: number, budgetBytes: number, spilled: number, fromMemory: number, fromDisk: number, spills: number, revivals: number, blockedByPins: number }}
   */
  stats() {
    return {
      name: this.#name,
      resident: this.#slotOf.size,
      capacity: this.#capacity,
      residentBytes: this.#slotOf.size * this.#chunkLength,
      budgetBytes: this.#capacity * this.#chunkLength,
      pinned: this.#lru.pinnedCount,
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
    // A released pin can be exactly what a caller waiting for a slot needs.
    this.#wake();
  }

  /**
   * Make a slot available, spilling the least recently used piece if need be.
   *
   * @returns {Promise<number>} Slot number.
   */
  async #claimSlot() {
    for (;;) {
      const slot = await this.#claimSlotOnce();
      if (slot !== null) {
        return slot;
      }
      // Nothing claimable this instant, but work is in flight that will make a
      // slot claimable: a spill finishing, or a piece being written into a slot
      // already handed out. Wait for either and look again, rather than failing
      // while the store is in the middle of making room.
      await new Promise((resolve) => {
        this.#waiters.push(resolve);
        for (const spill of this.#evicting.values()) {
          void spill.then(() => this.#wake(), () => this.#wake());
        }
        // A wake is not guaranteed to come. Waiting for a spill is safe — one
        // is in flight and will finish — but waiting for a PIN to be released
        // is not: if every piece is held and nothing else is happening, there
        // is no event left to fire, and the deadline that gives up cannot be
        // reached because it is only tested inside an attempt. That is a hang,
        // and it hung this store's own test for the full ten minutes a run is
        // allowed. So the wait also re-checks on a timer.
        const retry = setTimeout(() => this.#wake(), CLAIM_RETRY_MS);
        retry.unref?.();
      });
    }
  }

  /**
   * Record a piece against the slot it now occupies, and let waiters retry.
   *
   * @param {number} index
   * @param {number} slot
   * @returns {void}
   */
  #registerSlot(index, slot) {
    this.#slotOf.set(index, slot);
    this.#lru.touch(index);
    this.#outstandingSlots -= 1;
    this.#wake();
  }

  /**
   * Release everyone waiting for a slot; each rechecks for itself.
   *
   * @returns {void}
   */
  #wake() {
    const waiting = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiting) {
      resolve();
    }
  }

  /**
   * One attempt at a slot: a number, or `null` when the caller should wait for
   * an in-flight spill and try again.
   *
   * @returns {Promise<number | null>}
   */
  async #claimSlotOnce() {
    // Every slot handed out below is counted BEFORE this function can suspend.
    // Counting it after an `await` would leave concurrent callers — which is
    // how pieces actually arrive — seeing an idle store and declaring it
    // exhausted while its slots are already spoken for.
    const free = this.#freeSlots.pop();
    if (free !== undefined) {
      this.#outstandingSlots += 1;
      return free;
    }

    // Room left in the budget: take more memory rather than evicting. Growing
    // replaces the view over the pool, so every slot offset stays valid — the
    // bytes do not move.
    if (this.#allocatedSlots < this.#capacity) {
      this.#allocatedSlots += 1;
      this.#shared.grow(this.#allocatedSlots * this.#chunkLength);
      this.#pool = Buffer.from(this.#shared);
      this.#outstandingSlots += 1;
      return this.#allocatedSlots - 1;
    }

    const victim = this.#lru.evictionCandidate();
    if (victim === null) {
      if (this.#evicting.size > 0 || this.#outstandingSlots > 0) {
        return null;
      }
      // Every resident piece is being READ right now. That is not a permanent
      // condition: a pin lasts as long as one read of one piece, and the reader
      // releases it a moment later. So wait for that, exactly as the loop above
      // waits for a spill — pins now wake the waiters.
      //
      // It became reachable when a viewer could have three readers on one file
      // (2026-08-15: picture, the audio track chosen and the one left behind);
      // failing here ended a read with zero bytes, which ffmpeg reads as the
      // end of the file, so every encoder died and the session answered 500 to
      // everything after that.
      //
      // The deadline is what keeps a genuine deadlock visible: a reader that
      // holds a pin while waiting for a slot would otherwise wait for itself
      // for ever.
      if (this.#pinnedWaitStartedAt === 0) {
        this.#pinnedWaitStartedAt = Date.now();
      }
      if (Date.now() - this.#pinnedWaitStartedAt < PINNED_WAIT_MS) {
        this.#counters.waitedForPins += 1;
        return null;
      }
      this.#pinnedWaitStartedAt = 0;
      this.#counters.blockedByPins += 1;
      throw new Error(
        `Every resident piece is pinned and none was released in ${PINNED_WAIT_MS}ms; no slot can be freed.`
      );
    }
    this.#pinnedWaitStartedAt = 0;

    const slot = this.#slotOf.get(victim);

    // Claim the victim NOW, before the write can suspend us. Picking it and
    // releasing it either side of an `await` lets a second claim, arriving in
    // that gap, pick the same victim and be handed the same slot — after which
    // two pieces write over each other, both fail their hash, and the torrent
    // downloads them again, forever. Removing it from the books first makes the
    // choice atomic; `#evicting` keeps readers correct in the meantime.
    this.#slotOf.delete(victim);
    this.#lru.remove(victim);
    this.#outstandingSlots += 1;

    const bytes = this.#pool.subarray(slot * this.#chunkLength, slot * this.#chunkLength + this.#lengthOf(victim));
    const spill = this.#disk.write(victim, bytes).then(
      () => {
        this.#counters.spills += 1;
        this.#evicting.delete(victim);
      },
      (error) => {
        this.#evicting.delete(victim);
        throw error;
      }
    );
    this.#evicting.set(victim, spill);
    await spill;
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
      if (existing === undefined) {
        this.#registerSlot(index, slot);
      } else {
        this.#lru.touch(index);
      }
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

      // Mid-spill: neither in memory nor yet on disk. See `reside` — reporting
      // it missing here would tell WebTorrent to fetch a piece we already have.
      const spill = this.#evicting.get(index);
      if (spill) {
        await spill.catch(() => undefined);
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
      this.#registerSlot(index, revived);
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
  /**
   * Declare the pieces a reader is about to need, so eviction takes something
   * else while it can. Replaces that reader's previous declaration.
   *
   * @param {string|number} readerId
   * @param {number} from - First piece, inclusive.
   * @param {number} to - Last piece, inclusive.
   * @returns {void}
   */
  protectRange(readerId, from, to) {
    this.#lru.protect(readerId, from, to);
  }

  /**
   * Forget a reader's declaration. Call it when the reader ends.
   *
   * @param {string|number} readerId
   * @returns {void}
   */
  /**
   * The windows live readers have declared. See {@link PieceLru.protectedRanges}.
   *
   * @returns {Array<{ from: number, to: number }>}
   */
  protectedRanges() {
    return this.#lru.protectedRanges();
  }

  releaseProtection(readerId) {
    this.#lru.unprotect(readerId);
  }

  /**
   * Bring back into memory, in parallel and without waiting, the pieces of a
   * range that have been spilled to disk.
   *
   * A piece is otherwise revived only when the reader arrives at it, one at a
   * time and in step with decoding, so a seek backward into content already
   * downloaded pays a disk round trip per piece. The disk is local; the whole
   * window can be brought back at once while the reader is still on its first
   * piece.
   *
   * Bounded, because each revival needs a slot and unbounded revival of a
   * window larger than the store would simply thrash. Errors are swallowed: a
   * failed warm-up costs nothing, the reader will ask for the piece properly.
   *
   * @param {number} from - First piece, inclusive.
   * @param {number} to - Last piece, inclusive.
   * @param {number} [limit] - Most pieces to revive at once.
   * @returns {number} How many revivals were started.
   */
  warmRange(from, to, limit = Math.max(1, Math.floor(this.#capacity / 4))) {
    if (this.#closed || !Number.isInteger(from) || !Number.isInteger(to)) {
      return 0;
    }
    let started = 0;
    for (let index = from; index <= to && started < limit; index += 1) {
      if (this.#slotOf.has(index) || !this.#disk.has(index)) {
        continue;
      }
      started += 1;
      void this.reside(index).catch(() => undefined);
    }
    return started;
  }

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

    // Caught mid-spill: the slot is already gone, the disk copy is not there
    // yet. Waiting is the only correct answer — reporting it missing would make
    // the caller re-download a piece we are in the middle of keeping.
    const spill = this.#evicting.get(index);
    if (spill) {
      await spill.catch(() => undefined);
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
    this.#registerSlot(index, revived);
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
