/**
 * Eviction under concurrency.
 *
 * Pieces arrive from several peers at once, so `put` runs concurrently by
 * nature. Choosing a victim and releasing it either side of the spill write
 * therefore let two claims pick the SAME victim and receive the SAME slot, at
 * which point two pieces overwrite each other, both fail their hash, and the
 * torrent re-downloads them without end — which looks from outside exactly like
 * a seek that never completes while the download runs at full speed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SharedPieceStore } from "../services/piece-store/shared-piece-store.js";

const PIECE = 1024;

/**
 * @param {number} capacityPieces
 * @returns {Promise<{ store: SharedPieceStore, directory: string }>}
 */
async function makeStore(capacityPieces) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "piece-store-test-"));
  const store = new SharedPieceStore(PIECE, {
    length: PIECE * 64,
    memoryBytes: PIECE * capacityPieces,
    spillDirectory: directory,
    name: "eviction-test"
  });
  return { store, directory };
}

/**
 * @param {number} index
 * @returns {Buffer} A piece whose every byte identifies it.
 */
const pieceOf = (index) => Buffer.alloc(PIECE, index % 251);

/**
 * @param {SharedPieceStore} store
 * @param {number} index
 * @param {Buffer} bytes
 * @returns {Promise<void>}
 */
const put = (store, index, bytes) =>
  new Promise((resolve, reject) => {
    store.put(index, bytes, (error) => (error ? reject(error) : resolve()));
  });

/**
 * @param {SharedPieceStore} store
 * @param {number} index
 * @returns {Promise<Buffer>}
 */
const get = (store, index) =>
  new Promise((resolve, reject) => {
    store.get(index, (error, bytes) => (error ? reject(error) : resolve(bytes)));
  });

test("concurrent puts past capacity never hand two pieces the same slot", async () => {
  const capacity = 4;
  const { store, directory } = await makeStore(capacity);
  try {
    const total = 24;

    // All at once — the interleaving that a sequential test never produces.
    await Promise.all(
      Array.from({ length: total }, (unused, index) => put(store, index, pieceOf(index)))
    );

    // Every piece must read back as itself, from memory or from disk. A shared
    // slot shows up here as one piece carrying another's bytes.
    for (let index = 0; index < total; index += 1) {
      const bytes = await get(store, index);
      assert.equal(bytes.length, PIECE, `piece ${index} came back the wrong length`);
      assert.ok(
        bytes.equals(pieceOf(index)),
        `piece ${index} came back as piece ${bytes[0]} — two pieces shared a slot`
      );
    }

    const stats = store.stats();
    assert.ok(
      stats.resident <= stats.capacity,
      `resident ${stats.resident} exceeds capacity ${stats.capacity}: slots were handed out twice`
    );
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a piece caught mid-spill is waited for, not reported missing", async () => {
  const { store, directory } = await makeStore(2);
  try {
    await put(store, 0, pieceOf(0));
    await put(store, 1, pieceOf(1));

    // Forces piece 0 out while piece 0 is asked for in the same tick.
    const evicting = put(store, 2, pieceOf(2));
    const reading = get(store, 0);

    await evicting;
    const bytes = await reading;
    assert.ok(bytes.equals(pieceOf(0)), "piece 0 came back wrong while being spilled");
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("pinned pieces are never evicted, and the pin count is reported", async () => {
  const { store, directory } = await makeStore(2);
  try {
    await put(store, 0, pieceOf(0));
    store.pin(0);
    assert.equal(store.stats().pinned, 1, "pin is not reflected in the stats");

    await put(store, 1, pieceOf(1));
    await put(store, 2, pieceOf(2));

    // Piece 0 is pinned, so it must still be the one in memory, not on disk.
    assert.ok(store.locate(0), "a pinned piece was evicted");

    store.unpin(0);
    assert.equal(store.stats().pinned, 0, "unpin is not reflected in the stats");
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the store says why it spills: what is asked of it, what it had to take, how soon it came back", async () => {
  const capacity = 4;
  const { store, directory } = await makeStore(capacity);
  try {
    // A reader declaring more than the store may hold. This is the shape the
    // field session of 2026-09-02 is suspected of — 88 slots against an
    // encoder running 120-380 s ahead of a viewer, half the reads missing —
    // and nothing recorded it (roadmap item 9).
    store.protectRange("video", 0, 9);
    for (let index = 0; index < 10; index += 1) {
      await put(store, index, pieceOf(index));
    }

    const asked = store.stats();
    assert.equal(asked.demand.readers, 1);
    assert.equal(asked.demand.unionPieces, 10);
    assert.equal(asked.demand.capacity, capacity);
    assert.ok(
      asked.demand.unionPieces > asked.demand.capacity,
      "a reader asking for more than the store holds is arithmetic, not a policy fault"
    );
    // And it no longer has to take a declared piece to make room. The reader
    // asked for ten pieces of a store that holds four, and the arrivals that
    // will be wanted LATER than what is already resident are written straight
    // to disk instead of displacing what will be wanted sooner. Before
    // 2026-09-02 every one of them displaced something and was read back
    // moments later: 233 evictions against 119 completed writes in a minute.
    assert.equal(asked.evictedProtected, 0, "a nearer piece was pushed out for a further one");
    assert.equal(asked.spills, 0, "nothing had to be written out to make room on admission");
    assert.ok(asked.admittedToDisk > 0, "the further arrivals were supposed to go to disk");

    // Read back the pieces that were spilled: each one comes home, and the
    // store says how long it had been away.
    for (let index = 0; index < 10; index += 1) {
      const bytes = await get(store, index);
      assert.ok(bytes.equals(pieceOf(index)), `piece ${index} came back changed`);
    }

    const after = store.stats();
    // Reading them back does evict, and that is ordinary: a piece brought into
    // memory has to displace one. What the change of 2026-09-02 removed is the
    // eviction on ADMISSION — `asked.spills` above is zero, where before it all
    // six arrivals displaced a nearer piece and were read back moments later.
    assert.ok(after.fromDisk > 0, "the pieces that went to disk were read back from it");
    assert.ok(after.revivals > 0, "reading one back brings it into memory");
    // No age to report, and that is right rather than missing: an age measures
    // how long an EVICTED piece stayed away, and these were never resident —
    // they were written on arrival and read back once.
    assert.equal(after.revivalAgeSamples, 0);
    assert.equal(after.revivalAgeMedianMs, null);

    store.releaseProtection("video");
    assert.equal(store.stats().demand.readers, 0, "a reader that ends stops being counted");
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a piece nobody has declared does not push out one that is being read", async () => {
  const capacity = 4;
  const { store, directory } = await makeStore(capacity);
  try {
    // A reader declares the pieces it will need, and they are put in memory.
    store.protectRange("video", 0, 3);
    for (let index = 0; index < 4; index += 1) {
      await put(store, index, pieceOf(index));
    }
    assert.equal(store.stats().resident, capacity, "the declared window fills the store");

    // Now pieces arrive that the download fetched ahead of every reader. Before
    // 2026-09-02 each of them claimed a slot and evicted one of the four above,
    // which was then read back from disk moments later: 6565 spills and 7575
    // revivals in 44 minutes, 53.6% of reads served from memory.
    for (let index = 100; index < 110; index += 1) {
      await put(store, index, pieceOf(index));
    }

    const stats = store.stats();
    assert.equal(stats.admittedToDisk, 10, "every undeclared arrival went straight to disk");
    assert.equal(stats.admittedOutsideWindow, 10);
    assert.equal(stats.admittedInsideWindow, 4);
    assert.equal(stats.spills, 0, "and nothing had to be pushed out to make room");

    // The declared pieces are still in memory, and every piece reads back as
    // itself from whichever tier holds it.
    assert.equal(stats.resident, capacity);
    for (const index of [0, 1, 2, 3, 100, 105, 109]) {
      const bytes = await get(store, index);
      assert.ok(bytes.equals(pieceOf(index)), `piece ${index} came back changed`);
    }
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("before any reader has declared anything, an arriving piece still goes to memory", async () => {
  const { store, directory } = await makeStore(4);
  try {
    // No window declared: there is no basis for calling a piece unwanted, so
    // the store behaves as it always did. This is the initial download, and the
    // warm-up fetches of the header and the tail.
    for (let index = 0; index < 8; index += 1) {
      await put(store, index, pieceOf(index));
    }
    const stats = store.stats();
    assert.equal(stats.admittedToDisk, 0, "nothing was refused memory on a guess");
    assert.equal(stats.admittedOutsideWindow, 8);
    assert.ok(stats.spills > 0, "the store filled and evicted, as it did before");
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the store asks for what its readers declared, and for a whole window at least", async () => {
  const { store, directory } = await makeStore(64);
  try {
    // With nobody reading there is no demand to speak of, so the store asks for
    // what it is already allowed and the first revision after a read begins
    // brings it down.
    const idle = store.wantedBytes;
    assert.equal(idle, store.stats().budgetBytes);

    // Two readers of one file — picture and sound — overlapping by
    // construction. The ask is their union, not their sum.
    store.protectRange("video", 10, 29);
    store.protectRange("audio", 25, 44);
    assert.equal(store.wantedBytes, 35 * PIECE, "10..44 is thirty-five pieces, not forty");

    // One reader with a window wider than the union of nothing else: the ask
    // never falls below a single window, or that reader's read cannot complete
    // at all — every resident piece ends up pinned and the read returns zero
    // bytes.
    store.releaseProtection("audio");
    store.releaseProtection("video");
    store.protectRange("video", 0, 49);
    assert.equal(store.wantedBytes, 50 * PIECE);
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a block is re-used instead of a new one being allocated for every piece", async () => {
  const capacity = 4;
  const { store, directory } = await makeStore(capacity);
  try {
    // Twenty pieces through a store that may hold four. Before 2026-09-02 that
    // was twenty allocations of a piece each, every one of them released only
    // when the collector got to it — 7575 of them in 44 minutes in the field,
    // and 1.86 GB held while the store's own accounting said 352 MB.
    for (let index = 0; index < 20; index += 1) {
      await put(store, index, pieceOf(index));
    }

    const stats = store.stats();
    assert.ok(
      stats.blocksAllocated <= capacity,
      `the pool never exceeds the allowance: ${stats.blocksAllocated} blocks for ${capacity} slots`
    );
    assert.equal(stats.committedBytes, stats.blocksAllocated * PIECE);
    assert.equal(stats.returnedWhilePinned, 0);
    assert.ok(stats.reuseGapMs !== null, "blocks were taken from the free list, not freshly made");

    // And every piece still reads back as itself: a re-used block must not
    // carry the last piece's bytes into the next one.
    for (let index = 0; index < 20; index += 1) {
      const bytes = await get(store, index);
      assert.ok(bytes.equals(pieceOf(index)), `piece ${index} came back changed`);
    }
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a spare block is given up once it has sat longer than the store's own working rhythm", async () => {
  const { store, directory } = await makeStore(8);
  try {
    for (let index = 0; index < 12; index += 1) {
      await put(store, index, pieceOf(index));
    }
    // The allowance falls: pieces are written out and their blocks fall spare.
    store.reviseGrowthCeiling(2 * PIECE);
    const spare = store.stats().blocksFree;

    // Nothing is given up while the blocks are younger than the longest wait
    // this store has actually seen between a block falling free and being
    // wanted again.
    assert.equal(store.sweepFreeBlocks(Date.now()), 0, "a block in use moments ago is not spare");
    assert.equal(store.stats().blocksFree, spare);

    // An hour later they plainly are.
    const released = store.sweepFreeBlocks(Date.now() + 3_600_000);
    assert.equal(released, spare);
    assert.equal(store.stats().blocksFree, 0);
    assert.equal(store.stats().blocksReleased, released);
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("evicting a piece the disk already holds costs no second write", async () => {
  const { store, directory } = await makeStore(2);
  try {
    // Three pieces through two slots: piece 0 is written out.
    for (let index = 0; index < 3; index += 1) {
      await put(store, index, pieceOf(index));
    }
    const written = store.stats().spills;
    assert.ok(written > 0);
    assert.equal(store.stats().spillsSkipped, 0, "the first write of a piece is a real one");

    // Read it back — it returns to memory and the copy stays on disk. Evicting
    // it again writes bytes that are already there, byte for byte, because only
    // `put` removes the disk copy and no `put` has happened.
    assert.ok((await get(store, 0)).equals(pieceOf(0)));
    for (let index = 10; index < 13; index += 1) {
      await put(store, index, pieceOf(index));
    }
    assert.ok(store.stats().spillsSkipped > 0, "the second write of the same bytes is skipped");

    // And the piece still comes back correctly from the disk copy.
    assert.ok((await get(store, 0)).equals(pieceOf(0)));
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a store whose readers have gone asks for nothing, one that never had them keeps its opening", async () => {
  const { store, directory } = await makeStore(16);
  try {
    // Never had a reader: this is the initial download and the warm-up fetches
    // of the header and the tail, with a read on its way.
    const opening = store.wantedBytes;
    assert.equal(opening, store.stats().budgetBytes);

    store.protectRange("video", 0, 9);
    assert.equal(store.wantedBytes, 10 * PIECE);

    // The read ends. Its torrent sits until the pool's idle timer removes it,
    // and that timer needs a refcount of zero and can be a quarter of an hour
    // away. Holding the pieces for a reader that has gone is memory taken from
    // the machine for nothing.
    store.releaseProtection("video");
    assert.ok(store.wantedBytes < opening, "a store with no readers left asks for nothing");
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the allowance is never cut below one reader's whole window", async () => {
  const { store, directory } = await makeStore(16);
  try {
    store.protectRange("video", 0, 9);
    // The machine says this store may have two pieces. Obeying that would leave
    // it unable to finish the read it is serving: every resident piece pinned,
    // zero bytes returned, and ffmpeg taking that for the end of the file —
    // which killed every encoder on that file in the field on 2026-08-15.
    const revised = store.reviseGrowthCeiling(2 * PIECE);
    assert.equal(revised.ceilingBytes, 10 * PIECE, "one whole window is the floor");
    assert.equal(revised.belowAWindow, true, "and the store says the share was smaller than that");

    // With no reader there is no window to protect and the share is obeyed.
    store.releaseProtection("video");
    const obeyed = store.reviseGrowthCeiling(2 * PIECE);
    assert.equal(obeyed.ceilingBytes, 2 * PIECE);
    assert.equal(obeyed.belowAWindow, false);
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the pool stays the size it is allowed to be, however many pieces pass through it", async () => {
  // The field failure of 2026-09-02, and the case none of the earlier checks
  // covered: an allowance far smaller than the number of pieces in flight.
  // Both paths that register a piece look first and then await — `put` for a
  // slot, a revival for the disk — and in that gap another caller can register
  // the same index. Overwriting the entry dropped the previous block without
  // returning it, so the pool's count climbed past its ceiling for ever and it
  // degenerated into a fresh block per piece. A store holding THREE pieces
  // reported 812 MB committed against 68 MB allowed, 739 blocks allocated and
  // 676 still alive, and the process was killed at 4.37 GB.
  const capacity = 4;
  const { store, directory } = await makeStore(capacity);
  try {
    // Concurrent, because that is what produces the race: several peers deliver
    // pieces of one torrent at the same time.
    for (let round = 0; round < 6; round += 1) {
      await Promise.all(
        Array.from({ length: 16 }, (unused, index) => put(store, index, pieceOf(index)))
      );
      // And read them back, which revives from disk and races registration the
      // other way about.
      await Promise.all([0, 3, 7, 11, 15].map((index) => get(store, index)));
    }

    const stats = store.stats();
    assert.equal(stats.blocksBeyondCeiling, 0, "the pool grew past what it is allowed to hold");
    assert.ok(
      stats.blocksAllocated <= capacity + stats.blocksFree,
      `pool of ${stats.blocksAllocated} blocks for ${capacity} slots and ${stats.blocksFree} spare`
    );
    assert.equal(stats.committedBytes, stats.blocksAllocated * PIECE);

    // Every piece still reads back as itself: a block returned to the pool
    // twice, or reused while somebody held it, shows up here as wrong bytes.
    for (let index = 0; index < 16; index += 1) {
      const bytes = await get(store, index);
      assert.ok(bytes.equals(pieceOf(index)), `piece ${index} came back changed`);
    }
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a piece wanted later than the one it would displace goes to disk instead", async () => {
  const capacity = 4;
  const { store, directory } = await makeStore(capacity);
  try {
    // A reader is at the start of the file and the store is full of what it
    // wants. Its window is pieces 0-3.
    store.protectRange("video", 0, 3);
    for (let index = 0; index < capacity; index += 1) {
      await put(store, index, pieceOf(index));
    }
    const before = store.stats().admittedToDisk;

    // A piece arrives from far ahead. It IS inside a window in the field case —
    // six readers covered the whole file — but it lies further from every read
    // head than the piece the store would have to evict for it. Admitting it
    // would write out the nearer piece and read that one back sooner.
    store.protectRange("far", 90, 99);
    await put(store, 95, pieceOf(95));

    assert.ok(
      store.stats().admittedToDisk > before,
      "the further piece was admitted to memory and the nearer one written out"
    );
    // And it still reads back as itself, from the disk it was put on.
    assert.ok((await get(store, 95)).equals(pieceOf(95)));
    for (let index = 0; index < capacity; index += 1) {
      assert.ok((await get(store, index)).equals(pieceOf(index)), `piece ${index} was lost`);
    }
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
