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

/**
 * The largest fall in the machine's available memory that this process has
 * seen and did not cause itself.
 *
 * What has to be left for everything else on the machine. It cannot be a share
 * of what is free — a share is a number chosen out of nothing, which is what
 * `AVAILABLE_MEMORY_SHARE = 0.25`, `MIN_BUDGET_BYTES` and
 * `MEMORY_BUDGET_CEILING_BYTES` were until 2026-09-02, all three traceable to
 * one observation of one host on 2026-08-03. It is measured instead: between
 * two readings, how much available memory went away beyond what the stores
 * themselves took. On the field host that quantity is large — while the proxy
 * held 76-133 MB overnight the machine's available memory fell from 2378 MB to
 * 306 MB and came back — and on a quiet host it stays near zero, which is the
 * right answer there.
 *
 * Starts at zero: nothing is reserved until somebody else has been seen to
 * need it.
 */
const otherDemand = { falls: [], lastAvailableBytes: 0, lastStoreBytes: 0 };

/**
 * How many observations of other processes' demand are kept.
 *
 * A window rather than a high-water, and for the reason the block re-use gap is
 * one too: a single spike would otherwise stand for the life of the process and
 * squeeze the stores against something that happened once, hours ago.
 */
const OTHER_DEMAND_SAMPLES = 60;

/**
 * Note what the machine had, and how much of the change was not ours.
 *
 * @param {number} availableBytes
 * @param {number} storeBytes - What the live stores hold right now.
 * @returns {number} The reserve, in bytes.
 */
export function noteMachineMemory(availableBytes, storeBytes) {
  if (otherDemand.lastAvailableBytes > 0) {
    const fell = otherDemand.lastAvailableBytes - availableBytes;
    const ours = storeBytes - otherDemand.lastStoreBytes;
    otherDemand.falls.push(Math.max(0, fell - ours));
    if (otherDemand.falls.length > OTHER_DEMAND_SAMPLES) {
      otherDemand.falls.shift();
    }
  }
  otherDemand.lastAvailableBytes = availableBytes;
  otherDemand.lastStoreBytes = storeBytes;
  return machineReserveBytes();
}

/** What has recently been observed to be needed by everything that is not us. */
export function machineReserveBytes() {
  return otherDemand.falls.length === 0 ? 0 : Math.max(...otherDemand.falls);
}

/** Forget what other processes have needed. For tests, which share a module. */
export function forgetMachineMemory() {
  otherDemand.falls = [];
  otherDemand.lastAvailableBytes = 0;
  otherDemand.lastStoreBytes = 0;
}

/**
 * How much memory the stores may hold between them.
 *
 * `MemAvailable` is what could be allocated on top of what is already held, so
 * the stores' own bytes are added back: the pair is the ceiling the stores
 * could reach. The reserve is what has been seen to be needed elsewhere.
 *
 * @param {number} availableBytes
 * @param {number} storeBytes
 * @param {number} reserveBytes
 * @returns {number}
 */
export function machineAllowanceBytes(availableBytes, storeBytes, reserveBytes) {
  return Math.max(0, Math.max(availableBytes, 0) + Math.max(storeBytes, 0) - Math.max(reserveBytes, 0));
}

/**
 * Divide what the machine allows between the stores, by what each is asking
 * for.
 *
 * A store asks for the pieces its readers have declared. When everyone's ask
 * fits, everyone gets it and the machine's limit never binds — which is the
 * usual case, since two readers of one film declare 32-192 MB against gigabytes
 * of free memory. When the asks do not fit, each store is cut in proportion to
 * what it asked, so a store wanting little is not cut to make room for one
 * wanting much.
 *
 * @param {number[]} wantedBytes - What each store is asking for, in order.
 * @param {number} allowanceBytes
 * @returns {number[]} What each store may hold, in the same order.
 */
export function divideAllowance(wantedBytes, allowanceBytes) {
  const total = wantedBytes.reduce((sum, want) => sum + Math.max(0, want), 0);
  if (total <= allowanceBytes || total === 0) {
    return wantedBytes.map((want) => Math.max(0, want));
  }
  return wantedBytes.map((want) => Math.floor(allowanceBytes * (Math.max(0, want) / total)));
}

export function reviseStoreBudgets() {
  const stores = [...liveStores];
  const held = stores.reduce((sum, store) => sum + store.residentBytes, 0);
  const available = availableMemorySync();
  const reserve = noteMachineMemory(available, held);
  const allowance = machineAllowanceBytes(available, held, reserve);
  const shares = divideAllowance(stores.map((store) => store.wantedBytes), allowance);
  const revised = [];
  for (const [position, store] of stores.entries()) {
    revised.push(store.reviseGrowthCeiling(shares[position]));
  }
  return revised;
}

function defaultMemoryBytes() {
  const stores = [...liveStores];
  const held = stores.reduce((sum, store) => sum + store.residentBytes, 0);
  const available = availableMemorySync();
  const allowance = machineAllowanceBytes(available, held, machineReserveBytes());
  // A store being created has no readers, so it has no demand to state and no
  // basis for asking for more or less than the others. It opens on an equal
  // share and the first revision — within a minute, and within seconds of a
  // read starting — replaces that with what its readers actually declare.
  // Deliberately not the whole allowance: on a machine with gigabytes free that
  // would let a torrent nobody is reading yet fill memory before the first
  // revision arrives.
  return Math.floor(allowance / (stores.length + 1));
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
 * How many blocks of piece memory this thread has let go of, and how many the
 * collector has actually taken back.
 *
 * Since the store keeps a pool, one block serves many pieces, so this counts
 * blocks and not pieces — and a healthy store allocates only as many as its
 * allowance permits, so both numbers are now small and nearly equal.
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
 * How many block re-use gaps are kept. The same window as the revival ages, and
 * for the same reason: what is wanted is the rhythm of recent work, not a
 * history of it.
 */
const REUSE_GAP_SAMPLES = 200;

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
    evictedWithDistance: 0,
    // Where an arriving piece went. A piece nobody has declared is being
    // downloaded ahead of every reader; putting it in memory pushes out one
    // that IS declared, which is then read back from disk moments later
    // (roadmap item 9).
    admittedInsideWindow: 0,
    admittedOutsideWindow: 0,
    admittedToDisk: 0,
    /** Blocks given back to the operating system. */
    blocksReleased: 0,
    /**
     * A block put back for re-use while a reader still held the piece. Zero by
     * construction — a pinned piece is never evicted, and a re-put of a pinned
     * one drops its block instead of recycling it. Counted because if it ever
     * stops being zero, a consumer is reading another piece's bytes, and that
     * is invisible from anywhere else.
     */
    returnedWhilePinned: 0,
    /** Spills that found the disk already holding identical bytes. */
    spillsSkipped: 0
  };
  /**
   * Blocks that hold no piece, most recently freed last.
   *
   * A block is one piece's worth of memory. Allocating a new one for every
   * piece meant 7575 allocations of 4 MiB in 44 minutes on 2026-09-02, each
   * released only when the collector got to it — which is why the process held
   * 1.86 GB while its own accounting said 352 MB. Blocks are taken from here
   * and put back here instead (roadmap item 2).
   *
   * @type {{ buffer: SharedArrayBuffer, freedAt: number }[]}
   */
  #freeBlocks = [];
  /** Blocks that exist at all: free plus holding a piece. */
  #blocksAllocated = 0;
  /** Whether a reader has ever declared a window here. See `wantedBytes`. */
  #everHadReader = false;
  /** Whether the last revision had to exceed the machine's share. */
  #beyondTheMachine = false;
  /**
   * How long a block sat free before it was taken again, in milliseconds.
   * Bounded, because what is wanted is the longest gap of RECENT work: an
   * all-time maximum would be raised by one long pause and then never let a
   * block go again.
   *
   * @type {number[]}
   */
  #reuseGaps = [];
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
    // Only where this store STARTS. It is not kept, so it cannot come back as a
    // cap on the revision the way `#capacity` did.
    const openingCeiling = Math.max(MIN_RESIDENT_PIECES, Math.floor(memoryBytes / chunkLength));
    this.#growthCeiling = openingCeiling;
    this.#lru = new PieceLru(openingCeiling);
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
      allocatedSlots: this.#blocksAllocated,
      // What the process HOLDS, which with a pool is the blocks that exist —
      // not the pieces in them. Holding and using are different quantities and
      // the difference is the point of the reading.
      committedBytes: this.#blocksAllocated * this.#chunkLength,
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
      // What the process actually holds for this store, which is not the same
      // as what it is using: blocks are kept for re-use. The difference is the
      // spare, and it is the whole of the question whether consumption only
      // grows (roadmap item 2).
      blocksAllocated: this.#blocksAllocated,
      blocksFree: this.#freeBlocks.length,
      blockBytes: this.#blocksAllocated * this.#chunkLength,
      reuseGapMs: this.#reuseGapCeilingMs(),
      revivalAgeMedianMs: median(this.#revivalAges),
      revivalAgeSamples: this.#revivalAges.length,
      revivedWithinFiveSeconds: this.#revivalAges.filter((age) => age <= 5_000).length,
      ...this.#counters
    };
  }

  /**
   * Whether the machine's share of memory is smaller than one reader's window.
   *
   * The store holds the window anyway — refusing would leave the read it is
   * serving unable to finish, which is worse — but it is the honest measure of
   * "this machine cannot take any more", and it is measured rather than
   * guessed: it is the last revision's own comparison of what the machine
   * allowed against what the widest reader declared.
   */
  get isBeyondTheMachine() {
    return this.#beyondTheMachine;
  }

  /** What this store holds right now, in bytes. */
  get residentBytes() {
    return this.#buffers.size * this.#chunkLength;
  }

  /**
   * What this store is asking to be allowed to hold, in bytes.
   *
   * The union of its readers' declared windows — what they have said they will
   * need — never below the widest single window, because a store that cannot
   * hold one reader's window cannot complete that reader's read at all: every
   * resident piece ends up pinned, the read returns zero bytes and ffmpeg takes
   * that for the end of the file (field 2026-08-15, roadmap item 9).
   *
   * With no reader declaring anything there is no demand to speak of, so the
   * store asks for what the machine allows and the first revision after a read
   * begins brings it down to what that read needs.
   */
  get wantedBytes() {
    const demand = this.#lru.demand();
    if (demand.readers > 0) {
      this.#everHadReader = true;
      const pieces = Math.max(MIN_RESIDENT_PIECES, demand.unionPieces, demand.widestPieces);
      return pieces * this.#chunkLength;
    }
    // Readers that have GONE are not the same as readers that have not arrived.
    // A store whose readers ended has nothing to hold pieces for — its torrent
    // sits until the pool's idle timer removes it, which needs a refcount of
    // zero and can be a quarter of an hour away — so it asks for nothing and
    // its memory goes back to the machine now. A store that has never had a
    // reader is being filled for one that is on its way, and asks for what it
    // was opened with until the first read says what it needs.
    return this.#everHadReader
      ? MIN_RESIDENT_PIECES * this.#chunkLength
      : this.#growthCeiling * this.#chunkLength;
  }

  reviseGrowthCeiling(allowedBytes) {
    // No cap at what the machine could spare when this store was CREATED.
    // `#capacity` was computed once in the constructor and used as an upper
    // bound here, so the allowance could only ever fall: a torrent opened while
    // the machine was full kept a small allowance for its whole life, however
    // much memory was freed afterwards (roadmap item 2, 2026-09-02).
    const wanted = Math.floor(Number(allowedBytes) / this.#chunkLength);
    // Never below one reader's whole window while a reader exists, even when
    // the machine's share says less. A store that cannot hold the window of the
    // read it is serving cannot complete that read at all: every resident piece
    // ends up pinned, the read returns zero bytes and ffmpeg takes that for the
    // end of the file, which killed every encoder on that file in the field on
    // 2026-08-15. Exceeding the share is the lesser failure, and the line below
    // says when it happens.
    const demand = this.#lru.demand();
    this.#growthCeiling = Math.max(
      MIN_RESIDENT_PIECES,
      demand.readers > 0 ? demand.widestPieces : MIN_RESIDENT_PIECES,
      Number.isFinite(wanted) ? wanted : MIN_RESIDENT_PIECES
    );
    const belowAWindow = demand.readers > 0
      && Number.isFinite(wanted)
      && wanted < demand.widestPieces;
    this.#beyondTheMachine = belowAWindow;
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
    // Blocks the store is no longer using and has waited long enough to give
    // up. The allowance falling is the moment to ask, because that is when the
    // machine has been shown to need the memory.
    const releasedBlocks = this.sweepFreeBlocks();
    return {
      name: this.#name,
      ceilingBytes: this.#growthCeiling * this.#chunkLength,
      committedBytes: this.#blocksAllocated * this.#chunkLength,
      evicted,
      releasedBlocks,
      belowAWindow
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
    // The disk may already hold these very bytes. `#revive` reads a piece back
    // into memory and leaves the copy on disk, and only `put` removes it — so a
    // piece that was revived and not re-put is identical to what is already
    // written, and writing it again is work for nothing. There were 7575
    // revivals in one session on 2026-09-02, and every later eviction of one of
    // them wrote a second time (roadmap item 66: 14.4 GB written in a single
    // viewing).
    if (this.#disk.has(index)) {
      this.#counters.spills += 1;
      this.#counters.spillsSkipped += 1;
      this.#spilledAt.set(index, Date.now());
      this.#returnBlock(buffer);
      this.#noteProgress();
      return Promise.resolve();
    }

    const bytes = Buffer.from(buffer, 0, this.#lengthOf(index));
    const spill = this.#disk.write(index, bytes).then(
      () => {
        this.#counters.spills += 1;
        this.#spilledAt.set(index, Date.now());
        this.#evicting.delete(index);
        // Only now. The write reads out of this block, so a block handed to
        // another piece before the write finished would put that piece's bytes
        // into this piece's place in the file.
        this.#returnBlock(buffer);
        this.#noteProgress();
      },
      (error) => {
        this.#evicting.delete(index);
        // The block is no longer holding anything either way; keeping it out of
        // the pool because the write failed would lose it for good.
        this.#returnBlock(buffer);
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
   * Whether admitting one more piece would need something evicted first.
   *
   * Reservations count: a slot claimed and not yet filled is as taken as a
   * resident piece.
   *
   * @returns {boolean}
   */
  #isFullNow() {
    return this.#buffers.size + this.#outstandingPieces >= this.#growthCeiling;
  }

  /**
   * Write an arriving piece straight to disk, without it ever occupying memory.
   *
   * Registered in `#evicting` like a spill, so a `get` for this index waits for
   * the write instead of finding the piece on neither tier. Deliberately NOT
   * recorded in `#spilledAt`: that clock measures how long an EVICTED piece
   * stayed away, and a piece that was never resident has no such age.
   *
   * @param {number} index
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   */
  #writeThrough(index, bytes) {
    // Copied, not viewed. `DiskTier.write` opens the file before it reads the
    // bytes, so a view onto the caller's buffer could be written to in between
    // and the file would get the wrong data. The spill path may pass a view
    // because that memory is ours; this buffer belongs to the torrent client.
    // It costs nothing extra: the piece was being copied into a shared buffer
    // on this path before, and now it is copied here instead.
    const copy = Buffer.from(bytes.subarray(0, Math.min(bytes.length, this.#lengthOf(index))));
    const write = this.#disk.write(index, copy).then(
      () => {
        this.#evicting.delete(index);
        this.#noteProgress();
      },
      (error) => {
        this.#evicting.delete(index);
        this.#noteProgress();
        throw error;
      }
    );
    this.#evicting.set(index, write);
    return write;
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
      const target = this.#takeBlock();
      try {
        // Only this piece's own length: the block is a full piece long and the
        // last piece of a file is shorter, so reading the whole block would ask
        // the file for bytes past its end.
        await this.#disk.read(index, Buffer.from(target, 0, this.#lengthOf(index)));
      } catch (error) {
        this.#returnBlock(target);
        throw error;
      }
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
   * A block to hold one piece: the most recently freed one, or a new one.
   *
   * Every block is a full piece long, whatever piece will live in it. The last
   * piece of a file is shorter, and it occupies a full block with only its own
   * bytes meaningful — `#lengthOf` is what decides how much is ever read out.
   * Uniform blocks are what makes them interchangeable at all.
   *
   * Most recently freed first, deliberately: a few blocks then carry the whole
   * of a busy store's traffic and the rest age out of use, which is what makes
   * {@link SharedPieceStore#sweepFreeBlocks} able to tell a spare block from a
   * working one.
   *
   * @returns {SharedArrayBuffer}
   */
  #takeBlock() {
    const spare = this.#freeBlocks.pop();
    if (spare !== undefined) {
      this.#noteReuseGap(Date.now() - spare.freedAt);
      return spare.buffer;
    }
    this.#blocksAllocated += 1;
    return this.#watchForCollection(new SharedArrayBuffer(this.#chunkLength));
  }

  /**
   * Put a block back for re-use, or give it up.
   *
   * Given up when the allowance has fallen below the number of blocks that
   * exist: keeping it would hold memory the machine has just been shown to
   * need. Otherwise it waits in the free list for the next piece.
   *
   * @param {SharedArrayBuffer | undefined} buffer
   * @returns {void}
   */
  #returnBlock(buffer) {
    if (buffer === undefined) {
      return;
    }
    if (this.#closed || this.#blocksAllocated > this.#growthCeiling) {
      // Never below zero: `close` gives up every block at once, and a spill
      // that was already in flight resolves afterwards and arrives here.
      if (this.#blocksAllocated > 0) {
        this.#blocksAllocated -= 1;
        this.#counters.blocksReleased += 1;
      }
      return;
    }
    this.#freeBlocks.push({ buffer, freedAt: Date.now() });
  }

  /**
   * Record how long a block waited to be used again.
   *
   * @param {number} gapMs
   * @returns {void}
   */
  #noteReuseGap(gapMs) {
    this.#reuseGaps.push(Math.max(0, gapMs));
    if (this.#reuseGaps.length > REUSE_GAP_SAMPLES) {
      this.#reuseGaps.shift();
    }
  }

  /**
   * The longest a block has recently waited before being wanted again, or null
   * when no block has yet been re-used.
   *
   * This is the store's own working rhythm, measured rather than chosen: while
   * a film is being watched a block is taken again within milliseconds, because
   * one is taken for every piece that arrives. A block that has been sitting
   * longer than the longest of those waits is not part of the work.
   *
   * @returns {number | null}
   */
  #reuseGapCeilingMs() {
    if (this.#reuseGaps.length === 0) {
      return null;
    }
    return Math.max(...this.#reuseGaps);
  }

  /**
   * Give up blocks that have sat unused longer than this store's own working
   * rhythm.
   *
   * The case it is for: a torrent whose peers have gone. Its readers are still
   * attached, so nothing removes the torrent — the pool's idle timer needs a
   * refcount of zero and never starts. Its allowance falls to what those
   * readers declared, the pieces beyond it are written out, and their blocks
   * would otherwise wait in the free list for peers that may not return.
   *
   * @param {number} [now]
   * @returns {number} Blocks given up.
   */
  sweepFreeBlocks(now = Date.now()) {
    const ceiling = this.#reuseGapCeilingMs();
    if (ceiling === null) {
      return 0;
    }
    const keeping = [];
    let released = 0;
    for (const spare of this.#freeBlocks) {
      if (now - spare.freedAt <= ceiling) {
        keeping.push(spare);
        continue;
      }
      this.#blocksAllocated -= 1;
      this.#counters.blocksReleased += 1;
      released += 1;
    }
    this.#freeBlocks = keeping;
    return released;
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
    const block = this.#takeBlock();
    const view = Buffer.from(block, 0, length);
    if (bytes.copy) {
      bytes.copy(view, 0, 0, length);
    } else {
      view.set(bytes.subarray(0, length), 0);
    }
    return block;
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
        const previous = this.#buffers.get(index);
        // A fresh block rather than a write into the old one, so a reader
        // holding the old reference cannot see a torn write.
        this.#buffers.set(index, this.#copyIntoNewBuffer(index, bytes));
        this.#lru.touch(index);
        // And the old block goes back for re-use only if nobody is reading it.
        // A pinned piece has a view onto its memory somewhere; that block is
        // given up instead, and the pool allocates another when it needs one.
        if (this.#lru.isPinned(index)) {
          if (this.#blocksAllocated > 0) {
            this.#blocksAllocated -= 1;
            this.#counters.blocksReleased += 1;
          }
        } else {
          this.#returnBlock(previous);
        }
        await this.#forgetOnDisk(index);
        this.#noteProgress();
        return;
      }

      const declared = this.#lru.wants(index);
      if (declared) {
        this.#counters.admittedInsideWindow += 1;
      } else {
        this.#counters.admittedOutsideWindow += 1;
      }

      // A piece no reader has declared, arriving at a store with no room, goes
      // straight to disk. It costs the same one write it would have cost when
      // the next arrival evicted it, and it saves pushing out a piece a reader
      // is about to read. Only when SOMETHING is declared: before the first
      // read there is no basis for calling a piece unwanted.
      if (!declared && this.#lru.protectedCount > 0 && this.#isFullNow()) {
        this.#counters.admittedToDisk += 1;
        await this.#writeThrough(index, bytes);
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
    this.#counters.blocksReleased += this.#blocksAllocated;
    this.#blocksAllocated = 0;
    this.#freeBlocks = [];
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
    this.#counters.blocksReleased += this.#blocksAllocated;
    this.#blocksAllocated = 0;
    this.#freeBlocks = [];
    this.#wake();
    this.#disk.destroy().then(() => callback(null), (error) => callback(error));
  }
}
