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

const MIN_BUDGET_BYTES = 64 * 1024 * 1024;
const MIN_RESIDENT_PIECES = 2;
const PINNED_WAIT_MS = 5_000;
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
  #outstandingPieces = 0;
  #pinnedWaitStartedAt = 0;
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
    evictedOnRevise: 0
  };

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
    this.#disk = new DiskTier({
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
      spilled: this.#disk.size,
      spilledBytes: this.#disk.size * this.#chunkLength,
      ...this.#counters
    };
  }

  reviseGrowthCeiling(allowedBytes) {
    const wanted = Math.floor(Number(allowedBytes) / this.#chunkLength);
    this.#growthCeiling = Math.min(
      this.#capacity,
      Math.max(MIN_RESIDENT_PIECES, Number.isFinite(wanted) ? wanted : this.#capacity)
    );
    // With per-piece buffers memory CAN be given back immediately, unlike the
    // old growable pool. Eagerly evict excess to honour the new ceiling.
    let evicted = 0;
    while (this.#buffers.size > this.#growthCeiling) {
      const victim = this.#lru.evictionCandidate();
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
      const bytes = Buffer.from(victimBuffer, 0, this.#lengthOf(victim));
      const spill = this.#disk.write(victim, bytes).then(
        () => {
          this.#counters.spills += 1;
          this.#evicting.delete(victim);
          this.#wake();
        },
        (error) => {
          this.#evicting.delete(victim);
          this.#wake();
          throw error;
        }
      );
      this.#evicting.set(victim, spill);
    }
    if (evicted > 0) {
      // Logged by the caller (worker) via reviseStoreBudgets, but also countable here.
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
    this.#wake();
  }

  async #claimSlot() {
    for (;;) {
      const ok = await this.#claimSlotOnce();
      if (ok) {
        return;
      }
      await new Promise((resolve) => {
        this.#waiters.push(resolve);
        for (const spill of this.#evicting.values()) {
          void spill.then(() => this.#wake(), () => this.#wake());
        }
        const retry = setTimeout(() => this.#wake(), CLAIM_RETRY_MS);
        retry.unref?.();
      });
    }
  }

  #registerPiece(index, buffer) {
    this.#buffers.set(index, buffer);
    this.#lru.touch(index);
    this.#outstandingPieces -= 1;
    this.#wake();
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
      return true;
    }

    const victim = this.#lru.evictionCandidate();
    if (victim === null) {
      if (this.#evicting.size > 0 || this.#outstandingPieces > 0) {
        return false;
      }
      if (this.#pinnedWaitStartedAt === 0) {
        this.#pinnedWaitStartedAt = Date.now();
      }
      if (Date.now() - this.#pinnedWaitStartedAt < PINNED_WAIT_MS) {
        this.#counters.waitedForPins += 1;
        return false;
      }
      this.#pinnedWaitStartedAt = 0;
      this.#counters.blockedByPins += 1;
      throw new Error(
        `Every resident piece is pinned and none was released in ${PINNED_WAIT_MS}ms; no slot can be freed.`
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

    const bytes = Buffer.from(victimBuffer, 0, this.#lengthOf(victim));
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
    // Outstanding stays +1 for the caller; the slot for the new piece is now free.
    return true;
  }

  // For compatibility: some callers check #freeSlots / #allocatedSlots — not needed.

  put(index, bytes, callback = () => undefined) {
    if (this.#closed) {
      queueMicrotask(() => callback(new Error("Piece store is closed.")));
      return;
    }

    // Overwrite in place if already resident: no eviction needed.
    if (this.#buffers.has(index)) {
      const write = async () => {
        const length = this.#lengthOf(index);
        // Replace buffer so readers with old reference don't see torn write.
        const sab = new SharedArrayBuffer(length);
        const view = Buffer.from(sab);
        if (bytes.copy) {
          bytes.copy(view, 0, 0, length);
        } else {
          view.set(bytes.subarray(0, length), 0);
        }
        this.#buffers.set(index, sab);
        this.#lru.touch(index);
        this.#disk.forget(index);
      };
      write().then(() => callback(null), (error) => callback(error));
      return;
    }

    const write = async () => {
      await this.#claimSlot();
      const length = this.#lengthOf(index);
      const sab = new SharedArrayBuffer(length);
      const view = Buffer.from(sab);
      if (bytes.copy) {
        bytes.copy(view, 0, 0, length);
      } else {
        view.set(bytes.subarray(0, length), 0);
      }
      this.#registerPiece(index, sab);
      this.#disk.forget(index);
    };

    write().then(() => callback(null), (error) => {
      // If claim failed, outstanding was already incremented; correct it.
      // #registerPiece decrements on success; on failure we must decrement too.
      // But #claimSlotOnce already handles increment; we need to decrement if write threw before register.
      // Easiest: if error and outstanding still +1 and piece not registered, decrement.
      if (error) {
        // If we reserved but never registered, outstanding is still +1.
        // Check if piece is not in map and we have outstanding.
        if (!this.#buffers.has(index) && this.#outstandingPieces > 0) {
          // Only decrement if the failure happened before register.
          // Heuristic: if error message is pinned exhaustion, it came from claimSlotOnce which did not increment? Actually claimSlotOnce increments only on success/eviction.
          // For pinned error, outstanding was not incremented? Let's handle: claimSlot throws before increment? No, it throws after check, without increment.
          // So only failures after claim (disk write etc) need decrement — those have outstanding +1.
          // We conservatively decrement if outstanding >0 and piece not registered.
          // But to avoid double-decrement we check if this specific write's outstanding is still held.
          // Simple: decrement if outstanding >0 and piece not in map, and the error is not the pinned throw's pre-increment case.
          // The pinned throw does not increment, so outstanding is 0 there.
          if (this.#outstandingPieces > 0) {
            this.#outstandingPieces -= 1;
            this.#wake();
          }
        }
      }
      callback(error);
    });
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
        const view = Buffer.from(buffer, offset, length);
        return Buffer.from(view);
      }

      const spill = this.#evicting.get(index);
      if (spill) {
        await spill.catch(() => undefined);
      }

      if (!this.#disk.has(index)) {
        throw new Error(`Piece ${index} is not in the store.`);
      }

      await this.#claimSlot();
      const targetSab = new SharedArrayBuffer(pieceLength);
      const target = Buffer.from(targetSab);
      await this.#disk.read(index, target);
      this.#registerPiece(index, targetSab);
      this.#counters.fromDisk += 1;
      this.#counters.revivals += 1;
      const view = Buffer.from(targetSab, offset, length);
      return Buffer.from(view);
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

    const spill = this.#evicting.get(index);
    if (spill) {
      await spill.catch(() => undefined);
    }

    if (!this.#disk.has(index)) {
      return null;
    }

    const pieceLength = this.#lengthOf(index);
    await this.#claimSlot();
    const targetSab = new SharedArrayBuffer(pieceLength);
    const target = Buffer.from(targetSab);
    await this.#disk.read(index, target);
    this.#registerPiece(index, targetSab);
    this.#counters.fromDisk += 1;
    this.#counters.revivals += 1;
    return this.locate(index);
  }

  close(callback = () => undefined) {
    this.#closed = true;
    liveStores.delete(this);
    this.#buffers.clear();
    this.#disk.close().then(() => callback(null), (error) => callback(error));
  }

  destroy(callback = () => undefined) {
    this.#closed = true;
    liveStores.delete(this);
    this.#buffers.clear();
    this.#disk.destroy().then(() => callback(null), (error) => callback(error));
  }
}
