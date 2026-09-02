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
 * which the main thread reads without receiving bytes as a copy — see
 * {@link SharedPieceStore#locate}. Measured on the field host: a piece copy
 * costs 3.64 ms, a read from the page cache into a buffer we own 7.63 ms, and
 * re-downloading a piece from the swarm ~1430 ms. So memory first, disk under
 * it, and never the swarm twice.
 *
 * Per piece allocation: each resident piece owns its own `SharedArrayBuffer`.
 * Evicting a piece deletes its entry and the memory is reclaimable by GC.
 * `committed` therefore equals `resident`, not a high-water mark.
 *
 * **Room for a piece is an owned reservation, not a shared number.**
 * `#claimSlot` hands back a release the caller runs in a `finally`; nothing
 * else touches `#outstandingPieces`. It was a counter incremented in one
 * function and decremented in another, and every consequence of that was a
 * defect: a failure between the two lost a slot for the life of the process,
 * `put`'s error path guessed at the correction and could take back a
 * reservation belonging to a different claim, and one lost reservation made
 * the five-second "everything is pinned" error permanently unreachable, so a
 * read retried every 50 ms for ever without completing or failing. Read out of
 * the field failure of 2026-08-31 (`research/worker-heap-oom-2026-08-31.md`).
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
 * @type {Set<SharedPieceStore>}
 */
const liveStores = new Set();

export function collectStoreStats() {
  return [...liveStores].map((store) => store.stats());
}

export function findSharedStore(torrent) {
  let candidate = torrent?.store;
  for (let depth = 0; candidate && depth < 8; depth += 1) {
    if (candidate instanceof SharedPieceStore) {
      return candidate;
    }
    candidate = candidate.store;
  }
  return null;
}

const MEMORY_BUDGET_CEILING_BYTES = 512 * 1024 * 1024;
const AVAILABLE_MEMORY_SHARE = 0.25;

export function totalStoreBudgetBytes(availableBytes) {
  const share = Math.floor(Math.max(availableBytes, 0) * AVAILABLE_MEMORY_SHARE);
  return Math.max(MIN_BUDGET_BYTES, Math.min(MEMORY_BUDGET_CEILING_BYTES, share));
}

export function budgetForNewStore(availableBytes, storeCount) {
  const total = totalStoreBudgetBytes(availableBytes);
  const shares = Math.max(1, Math.floor(storeCount));
  return Math.max(MIN_BUDGET_BYTES, Math.floor(total / shares));
}

export function reviseStoreBudgets() {
  const share = budgetForNewStore(availableMemorySync(), liveStores.size);
  const revised = [];
  for (const store of liveStores) {
    revised.push(store.reviseGrowthCeiling(share));
  }
  return revised;
}

function defaultMemoryBytes() {
  return budgetForNewStore(availableMemorySync(), liveStores.size + 1);
}

function availableMemorySync() {
  try {
    const text = readFileSync("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
    if (match) {
      return Number(match[1]) * 1024;
    }
  } catch {
  }
  return os.freemem();
}

/**
 * How many piece buffers this thread has let go of, and how many the collector
 * has actually taken back.
 *
 * The one reading that separates the two explanations of the 700 MB nobody can
 * account for (roadmap item 2, field 2026-08-31): if the two numbers track each
 * other, this code is holding nothing and whatever grows is below us, in the
 * allocator — on musl there is no `malloc_trim` and no way to ask. If the gap
 * widens, a reference of ours outlives the piece, and then a heap snapshot can
 * name the holder.
 *
 * What it does NOT prove: a `SharedArrayBuffer`'s memory is shared between the
 * isolates, so this thread's handle going means only that THIS thread let go.
 * The main thread counts its own (`torrent-worker/client.js`), and the pair is
 * what answers the question.
 */
const released = { count: 0, collected: 0 };
const collector = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(() => {
    released.collected += 1;
  })
  : null;

/**
 * What the collector has taken back against what was let go.
 *
 * @returns {{ released: number, collected: number }}
 */
export function pieceBufferCollection() {
  return { released: released.count, collected: released.collected };
}

const MIN_BUDGET_BYTES = 64 * 1024 * 1024;
const MIN_RESIDENT_PIECES = 2;
/**
 * How long a claim may go without ANYTHING moving before it gives up.
 *
 * Measured against progress, not against activity. The earlier rule skipped
 * this timer entirely while a spill was in flight or a reservation was held —
 * so one reservation that was never returned made the timer unreachable and a
 * read retried every 50 ms for the life of the process, never completing and
 * never failing (field 2026-08-31).
 */
const PINNED_WAIT_MS = 5_000;

/**
 * How many revival ages are kept for the median. A window, not a history: two
 * hundred covers several minutes of the busiest session measured (7575
 * revivals in 44 minutes) and costs two hundred numbers.
 */
const REVIVAL_AGE_SAMPLES = 200;

/**
 * The middle value of a sample, or null when there is nothing to take a middle
 * of. Null rather than zero: no revivals and instant revivals are different
 * facts and must not print the same.
 *
 * @param {number[]} values
 * @returns {number | null}
 */
function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}
const CLAIM_RETRY_MS = 50;

export class SharedPieceStore {
  #chunkLength;
  #lastChunkLength;
  #lastChunkIndex;
  #capacity;
  #growthCeiling;
  /** Piece index → SharedArrayBuffer of that piece */
  #buffers = new Map();
  /** @type {Map<number, Promise<void>>} */
  #evicting = new Map();
  /**
   * Slots claimed but not yet filled.
   *
   * Handed out by {@link SharedPieceStore##claimSlot} as a release function the
   * caller must call in a `finally`, never as a number one function increments
   * and another decrements. The counter used to be paired across
   * `#claimSlot`/`#registerPiece`, so any failure between the two lost a slot
   * for the life of the process, and `put`'s error path tried to correct that
   * by guessing — which could take back a reservation belonging to a different
   * claim and let the store admit past its allowance.
   */
  #outstandingPieces = 0;
  #pinnedWaitStartedAt = 0;
  /** When something last actually moved: a piece admitted, spilled or unpinned. */
  #lastProgressAt = 0;
  #waiters = [];
  #lru;
  #disk;
  #closed = false;
  #name;
  #counters = {
    fromMemory: 0,
    fromDisk: 0,
    spills: 0,
    revivals: 0,
    blockedByPins: 0,
    waitedForPins: 0,
    evictedOnRevise: 0,
    spillFailures: 0,
    // Whether the store is doing its job or being asked to hold more than it
    // has room for. An eviction that had to take a piece a reader declared it
    // wants is the second, and it comes back from disk moments later
    // (roadmap item 9).
    evictedProtected: 0,
    evictedDistanceSum: 0,
    evictedWithDistance: 0
  };
  /** Piece index → when it was written out, for the age it comes back at. */
  #spilledAt = new Map();
  /**
   * Ages, in milliseconds, of the last revivals — bounded, because the figure
   * wanted is a median and not a history. A piece that comes back seconds
   * after it left should not have left.
   *
   * @type {number[]}
   */
  #revivalAges = [];

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

    this.#growthCeiling = this.#capacity;
    this.#lru = new PieceLru(this.#capacity);
    this.#name = options.name ?? "pieces";
    // `options.disk` exists so a test can hold a write open or make one fail on
    // purpose. Four of the defects fixed here live in what happens when the
    // disk tier does not answer immediately or at all, and none of them is
    // reachable from outside without saying so.
    this.#disk = options.disk ?? new DiskTier({
      directory: options.path ?? ".",
      name: `${this.#name}.pieces`,
      chunkLength
    });
    liveStores.add(this);
  }

  stats() {
    const resident = this.#buffers.size;
    const residentBytes = resident * this.#chunkLength;
    // Last piece may be short but stats historically use chunkLength.
    return {
      name: this.#name,
      resident,
      capacity: this.#growthCeiling,
      residentBytes,
      allocatedSlots: resident,
      committedBytes: residentBytes,
      budgetBytes: this.#growthCeiling * this.#chunkLength,
      pinned: this.#lru.pinnedCount,
      // Slots claimed and not yet filled. Reported because a reservation that
      // is never returned is invisible until the store cannot admit anything,
      // and by then the reason is long gone. At rest this is zero.
      outstanding: this.#outstandingPieces,
      spilled: this.#disk.size,
      spilledBytes: this.#disk.size * this.#chunkLength,
      // What the readers between them are asking this store to keep, against
      // what it may hold. A union wider than the capacity cannot be held
      // however the eviction is ordered, and that is the difference between a
      // policy to fix and arithmetic to accept (roadmap item 9).
      demand: this.#lru.demand(),
      revivalAgeMedianMs: median(this.#revivalAges),
      revivalAgeSamples: this.#revivalAges.length,
      revivedWithinFiveSeconds: this.#revivalAges.filter((age) => age <= 5_000).length,
      ...this.#counters
    };
  }

  reviseGrowthCeiling(allowedBytes) {
    const wanted = Math.floor(Number(allowedBytes) / this.#chunkLength);
    this.#growthCeiling = Math.min(
      this.#capacity,
      Math.max(MIN_RESIDENT_PIECES, Number.isFinite(wanted) ? wanted : this.#capacity)
    );
    // The LRU is told too. It was constructed with the store's original
    // capacity and never revised, so `isFull()` answered against a number that
    // had not been the limit for some time — dormant only because nothing calls
    // it, which is a trap for whoever calls it next.
    this.#lru.setCapacity(this.#growthCeiling);
    // With per-piece buffers memory CAN be given back immediately, unlike the
    // old growable pool. Eagerly evict excess to honour the new ceiling.
    let evicted = 0;
    while (this.#buffers.size > this.#growthCeiling) {
      const { index: victim, protectionYielded, distance } = this.#lru.evictionChoice();
      if (victim === null) {
        break;
      }
      const victimBuffer = this.#buffers.get(victim);
      if (victimBuffer === undefined) {
        this.#lru.remove(victim);
        continue;
      }
      this.#buffers.delete(victim);
      this.#lru.remove(victim);
      evicted += 1;
      this.#counters.evictedOnRevise += 1;
      this.#noteEviction(protectionYielded, distance);
      // Nobody awaits this spill, so its failure has to end here. Rethrowing
      // made it an unhandled rejection, and an unhandled rejection in the
      // torrent worker ends the thread — a second way to lose the torrent
      // client, on top of the one that already loses it.
      void this.#spill(victim, victimBuffer).catch(() => {
        this.#counters.spillFailures += 1;
      });
    }
    return {
      name: this.#name,
      ceilingBytes: this.#growthCeiling * this.#chunkLength,
      committedBytes: this.#buffers.size * this.#chunkLength,
      evicted
    };
  }

  get chunkLength() {
    return this.#chunkLength;
  }

  get capacity() {
    return this.#growthCeiling;
  }

  get residentCount() {
    return this.#buffers.size;
  }

  get spilledCount() {
    return this.#disk.size;
  }

  #lengthOf(index) {
    return index === this.#lastChunkIndex ? this.#lastChunkLength : this.#chunkLength;
  }

  /**
   * Where a resident piece sits, or `null` if not resident.
   * Returns the piece's own SharedArrayBuffer and the intra-piece range.
   * @param {number} index
   * @returns {{ buffer: SharedArrayBuffer, offset: number, length: number } | null}
   */
  locate(index) {
    const buffer = this.#buffers.get(index);
    if (buffer === undefined) {
      return null;
    }
    return { buffer, offset: 0, length: this.#lengthOf(index) };
  }

  /**
   * Direct access to a piece's buffer for zero-copy consumers.
   * @param {number} index
   * @returns {SharedArrayBuffer | undefined}
   */
  getPieceBuffer(index) {
    return this.#buffers.get(index);
  }

  pin(index) {
    this.#lru.pin(index);
  }

  unpin(index) {
    this.#lru.unpin(index);
    this.#noteProgress();
  }

  /**
   * Reserve room for one piece.
   *
   * @returns {Promise<() => void>} The release, which the caller MUST call in a
   *   `finally`. Calling it twice is harmless.
   */
  async #claimSlot() {
    for (;;) {
      if (this.#closed) {
        throw new Error("Piece store is closed.");
      }
      const ok = await this.#claimSlotOnce();
      if (ok) {
        let released = false;
        return () => {
          if (released) {
            return;
          }
          released = true;
          this.#outstandingPieces -= 1;
          this.#noteProgress();
        };
      }
      await this.#waitForSlot();
    }
  }

  /**
   * Sleep until something moves, or until the retry interval, whichever first.
   *
   * One handler, idempotent, and its timer is cleared when it is woken. The
   * earlier version attached a fresh pair of handlers to EVERY pending spill on
   * every attempt and left a timer running each time, so a claim that could not
   * be satisfied allocated in proportion to attempts times pending spills. A
   * settling spill now wakes the store itself, which is where that belongs.
   *
   * @returns {Promise<void>}
   */
  #waitForSlot() {
    return new Promise((resolve) => {
      let settled = false;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let retry = null;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (retry !== null) {
          clearTimeout(retry);
        }
        resolve();
      };
      this.#waiters.push(finish);
      retry = setTimeout(finish, CLAIM_RETRY_MS);
      retry.unref?.();
    });
  }

  #registerPiece(index, buffer) {
    this.#buffers.set(index, buffer);
    this.#lru.touch(index);
    this.#noteProgress();
  }

  /**
   * Write a piece out and account for it, from the one place that does it.
   *
   * @param {number} index
   * @param {SharedArrayBuffer} buffer
   * @returns {Promise<void>}
   */
  #spill(index, buffer) {
    const bytes = Buffer.from(buffer, 0, this.#lengthOf(index));
    const spill = this.#disk.write(index, bytes).then(
      () => {
        this.#counters.spills += 1;
        this.#spilledAt.set(index, Date.now());
        this.#evicting.delete(index);
        this.#noteProgress();
      },
      (error) => {
        this.#evicting.delete(index);
        this.#noteProgress();
        throw error;
      }
    );
    this.#evicting.set(index, spill);
    return spill;
  }

  /** Something actually moved: wake whoever is waiting and restart the clock. */
  #noteProgress() {
    this.#lastProgressAt = Date.now();
    this.#wake();
  }

  /**
   * Record how long a piece stayed on disk before it was wanted again.
   *
   * A piece that comes back seconds after it left was evicted from a working
   * set that does not fit, and the write and the read were both waste. Kept as
   * a bounded window of ages because the figure wanted is a median, not a
   * history.
   *
   * @param {number} index
   * @returns {void}
   */
  #noteRevival(index) {
    const spilledAt = this.#spilledAt.get(index);
    if (spilledAt === undefined) {
      return;
    }
    this.#spilledAt.delete(index);
    this.#revivalAges.push(Date.now() - spilledAt);
    if (this.#revivalAges.length > REVIVAL_AGE_SAMPLES) {
      this.#revivalAges.shift();
    }
  }

  /**
   * Record what an eviction had to take.
   *
   * @param {boolean} protectionYielded - The victim was inside a window a
   *   reader had declared, and was taken anyway because nothing else was free.
   * @param {number} distance - Pieces from the nearest declared window, -1 when
   *   no reader declared one.
   * @returns {void}
   */
  #noteEviction(protectionYielded, distance) {
    if (protectionYielded) {
      this.#counters.evictedProtected += 1;
    }
    if (distance >= 0) {
      this.#counters.evictedDistanceSum += distance;
      this.#counters.evictedWithDistance += 1;
    }
  }

  #wake() {
    const waiting = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiting) {
      resolve();
    }
  }

  async #claimSlotOnce() {
    // Reserve before suspension so concurrent callers see the reservation.
    if (this.#buffers.size + this.#outstandingPieces < this.#growthCeiling) {
      this.#outstandingPieces += 1;
      this.#pinnedWaitStartedAt = 0;
      return true;
    }

    const { index: victim, protectionYielded, distance } = this.#lru.evictionChoice();
    if (victim === null) {
      // Nothing may leave. Wait while the store is still MOVING — a spill
      // completing, a piece admitted, a pin released — and give up when it has
      // not moved for PINNED_WAIT_MS, whatever is nominally in flight. The old
      // rule asked whether anything was in flight rather than whether anything
      // had happened, which is why one lost reservation could hold a read here
      // for ever.
      if (this.#pinnedWaitStartedAt === 0) {
        this.#pinnedWaitStartedAt = Date.now();
      }
      const stillFor = Date.now() - Math.max(this.#pinnedWaitStartedAt, this.#lastProgressAt);
      if (stillFor < PINNED_WAIT_MS) {
        this.#counters.waitedForPins += 1;
        return false;
      }
      this.#pinnedWaitStartedAt = 0;
      this.#counters.blockedByPins += 1;
      throw new Error(
        `Every resident piece is pinned and nothing moved for ${PINNED_WAIT_MS}ms; no slot can be freed.`
      );
    }
    this.#pinnedWaitStartedAt = 0;

    const victimBuffer = this.#buffers.get(victim);
    if (victimBuffer === undefined) {
      // Should not happen: LRU says resident but buffer missing.
      this.#lru.remove(victim);
      return false;
    }

    // Claim atomically before await.
    this.#buffers.delete(victim);
    this.#lru.remove(victim);
    this.#outstandingPieces += 1;
    this.#noteEviction(protectionYielded, distance);

    try {
      await this.#spill(victim, victimBuffer);
    } catch (error) {
      // The caller never received a release for this reservation, so it is
      // given back here rather than left outstanding for ever.
      this.#outstandingPieces -= 1;
      this.#noteProgress();
      throw error;
    }
    // Outstanding stays +1 for the caller; the slot for the new piece is now free.
    return true;
  }

  /**
   * Bring a spilled piece back into memory, once, however many callers ask.
   *
   * @param {number} index
   * @returns {Promise<SharedArrayBuffer | null>} `null` when the piece is on
   *   neither tier.
   */
  async #revive(index) {
    const spill = this.#evicting.get(index);
    if (spill) {
      await spill.catch(() => undefined);
    }

    if (!this.#disk.has(index)) {
      return null;
    }

    const release = await this.#claimSlot();
    try {
      // Another caller may have brought it back while this one waited for a
      // slot. Registering a second buffer for the same piece would leave
      // whoever holds the first reading memory nothing evicts.
      const already = this.#buffers.get(index);
      if (already !== undefined) {
        this.#lru.touch(index);
        this.#counters.fromMemory += 1;
        return already;
      }
      const target = this.#watchForCollection(new SharedArrayBuffer(this.#lengthOf(index)));
      await this.#disk.read(index, Buffer.from(target));
      this.#registerPiece(index, target);
      this.#counters.fromDisk += 1;
      this.#counters.revivals += 1;
      this.#noteRevival(index);
      return target;
    } finally {
      release();
    }
  }

  /**
   * Count this buffer as one this thread will have to let go of, and notice
   * when the collector takes it. See {@link pieceBufferCollection}.
   *
   * @param {SharedArrayBuffer} buffer
   * @returns {SharedArrayBuffer} The same buffer.
   */
  #watchForCollection(buffer) {
    released.count += 1;
    collector?.register(buffer, null);
    return buffer;
  }

  /**
   * A fresh buffer holding this piece's bytes.
   *
   * @param {number} index
   * @param {Uint8Array} bytes
   * @returns {SharedArrayBuffer}
   */
  #copyIntoNewBuffer(index, bytes) {
    const length = this.#lengthOf(index);
    const sab = this.#watchForCollection(new SharedArrayBuffer(length));
    const view = Buffer.from(sab);
    if (bytes.copy) {
      bytes.copy(view, 0, 0, length);
    } else {
      view.set(bytes.subarray(0, length), 0);
    }
    return sab;
  }

  /**
   * Drop the disk copy of a piece that memory now holds — after any spill of
   * that same piece has finished.
   *
   * `DiskTier.write` records the index when it COMPLETES, so forgetting while a
   * spill of that index is still running let the completing write put it back,
   * and a later read then returned the stale bytes.
   *
   * @param {number} index
   * @returns {Promise<void>}
   */
  async #forgetOnDisk(index) {
    const spill = this.#evicting.get(index);
    if (spill) {
      await spill.catch(() => undefined);
    }
    this.#disk.forget(index);
    this.#spilledAt.delete(index);
  }

  put(index, bytes, callback = () => undefined) {
    if (this.#closed) {
      queueMicrotask(() => callback(new Error("Piece store is closed.")));
      return;
    }

    const write = async () => {
      // Already resident: the buffer is replaced, not added, so no slot is
      // needed and none is claimed. A fresh buffer rather than a write into the
      // old one, so a reader holding the old reference cannot see a torn write.
      if (this.#buffers.has(index)) {
        this.#buffers.set(index, this.#copyIntoNewBuffer(index, bytes));
        this.#lru.touch(index);
        await this.#forgetOnDisk(index);
        this.#noteProgress();
        return;
      }

      const release = await this.#claimSlot();
      try {
        this.#registerPiece(index, this.#copyIntoNewBuffer(index, bytes));
        await this.#forgetOnDisk(index);
      } finally {
        release();
      }
    };

    write().then(() => callback(null), (error) => callback(error));
  }

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
      const buffer = this.#buffers.get(index);
      if (buffer !== undefined) {
        this.#lru.touch(index);
        this.#counters.fromMemory += 1;
        return Buffer.from(Buffer.from(buffer, offset, length));
      }

      const revived = await this.#revive(index);
      if (revived === null) {
        throw new Error(`Piece ${index} is not in the store.`);
      }
      return Buffer.from(Buffer.from(revived, offset, length));
    };

    fetch().then((bytes) => done(null, bytes), (error) => done(error));
  }

  protectRange(readerId, from, to) {
    this.#lru.protect(readerId, from, to);
  }

  protectedRanges() {
    return this.#lru.protectedRanges();
  }

  releaseProtection(readerId) {
    this.#lru.unprotect(readerId);
  }

  warmRange(from, to, limit = Math.max(1, Math.floor(this.#growthCeiling / 4))) {
    if (this.#closed || !Number.isInteger(from) || !Number.isInteger(to)) {
      return 0;
    }
    let started = 0;
    for (let index = from; index <= to && started < limit; index += 1) {
      if (this.#buffers.has(index) || !this.#disk.has(index)) {
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

    const buffer = this.#buffers.get(index);
    if (buffer !== undefined) {
      this.#lru.touch(index);
      this.#counters.fromMemory += 1;
      return this.locate(index);
    }

    const revived = await this.#revive(index);
    if (revived === null) {
      return null;
    }
    return { buffer: revived, offset: 0, length: this.#lengthOf(index) };
  }

  close(callback = () => undefined) {
    this.#closed = true;
    liveStores.delete(this);
    this.#buffers.clear();
    this.#spilledAt.clear();
    // Whoever is waiting for a slot is woken and finds the store closed, which
    // is an error they can report. Left asleep they simply never returned.
    this.#wake();
    this.#disk.close().then(() => callback(null), (error) => callback(error));
  }

  destroy(callback = () => undefined) {
    this.#closed = true;
    liveStores.delete(this);
    this.#buffers.clear();
    this.#spilledAt.clear();
    this.#wake();
    this.#disk.destroy().then(() => callback(null), (error) => callback(error));
  }
}
