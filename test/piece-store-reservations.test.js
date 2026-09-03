/**
 * @file Room for a piece is an owned reservation, and it comes back every time.
 *
 * Each case here is a defect read out of the field failure of 2026-08-31
 * (`research/worker-heap-oom-2026-08-31.md`, §5), where the torrent worker was
 * found holding reservations nobody could return. They all need the disk tier
 * to be slow, or to fail, at a moment the caller chooses — which is what
 * `options.disk` is for.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SharedPieceStore } from "../services/piece-store/shared-piece-store.js";

const CHUNK = 1024;

/**
 * A disk tier the test drives: writes can be held open and either side can be
 * made to fail.
 *
 * @param {{ failWrite?: boolean, failRead?: boolean, holdWrites?: boolean }} [behaviour]
 */
function makeDisk({ failWrite = false, failRead = false, holdWrites = false } = {}) {
  const stored = new Map();
  /** @type {Array<() => void>} */
  const held = [];
  return {
    stored,
    /** Let every held write finish. */
    releaseWrites() {
      const waiting = held.splice(0, held.length);
      for (const resume of waiting) {
        resume();
      }
    },
    get heldCount() {
      return held.length;
    },
    get size() {
      return stored.size;
    },
    has(index) {
      return stored.has(index);
    },
    async write(index, bytes) {
      if (holdWrites) {
        await new Promise((resolve) => held.push(resolve));
      }
      if (failWrite) {
        throw new Error("the disk refused the write");
      }
      stored.set(index, Buffer.from(bytes));
    },
    async read(index, target) {
      if (failRead) {
        throw new Error("the disk refused the read");
      }
      const bytes = stored.get(index);
      if (!bytes) {
        throw new Error(`Piece ${index} is not on disk.`);
      }
      bytes.copy(target);
      return bytes.length;
    },
    forget(index) {
      stored.delete(index);
    },
    async close() {},
    async destroy() {
      stored.clear();
    }
  };
}

/**
 * @param {object} [options]
 * @returns {{ store: SharedPieceStore, disk: ReturnType<typeof makeDisk> }}
 */
function makeStore({ pieces = 2, totalPieces = 16, disk = makeDisk() } = {}) {
  const store = new SharedPieceStore(CHUNK, {
    length: CHUNK * totalPieces,
    memoryBytes: CHUNK * pieces,
    disk,
    name: "test"
  });
  return { store, disk };
}

/**
 * @param {number} index
 * @returns {Buffer}
 */
function piece(index) {
  const bytes = Buffer.allocUnsafeSlow(CHUNK);
  bytes.fill(index % 256);
  bytes.writeUInt32BE(index, 0);
  return bytes;
}

const put = (store, index) =>
  new Promise((resolve, reject) => store.put(index, piece(index), (error) => (error ? reject(error) : resolve())));
const get = (store, index) =>
  new Promise((resolve, reject) =>
    store.get(index, undefined, (error, bytes) => (error ? reject(error) : resolve(bytes)))
  );

/**
 * Wait until a condition holds, rather than for a chosen interval — a test that
 * sleeps samples, it does not check (roadmap item 54).
 *
 * @param {() => boolean} holds
 * @param {string} what
 * @returns {Promise<void>}
 */
async function until(holds, what) {
  const deadline = Date.now() + 5_000;
  while (!holds()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting until ${what}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a revival that fails on the disk gives its slot back", async () => {
  const disk = makeDisk({ failRead: true });
  const { store } = makeStore({ pieces: 2, disk });
  try {
    await put(store, 0);
    await put(store, 1);
    await put(store, 2); // piece 0 is the least recently used, so it spills

    await assert.rejects(() => get(store, 0), /refused the read/);

    assert.equal(
      store.stats().outstanding,
      0,
      "the slot claimed for the revival was never returned"
    );
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
  }
});

test("a spill that fails gives back the slot the eviction claimed", async () => {
  const disk = makeDisk({ failWrite: true });
  const { store } = makeStore({ pieces: 2, disk });
  try {
    await put(store, 0);
    await put(store, 1);
    await assert.rejects(() => put(store, 2), /refused the write/);

    assert.equal(store.stats().outstanding, 0, "the eviction kept its reservation");
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
  }
});

// A bound, because the failure this catches is a claim that never ends: without
// it the check does not fail, it HANGS, and `node --test` then cannot finish at
// all — which is what happened between 2026-08-31 and 2026-09-03 (roadmap item
// 54). The store gives up after PINNED_WAIT_MS, so 30 s is ample for the answer
// and short enough to be a failure rather than a stoppage.
test("a claim that cannot be met ends in an error, not in waiting for ever", { timeout: 30_000 }, async () => {
  const disk = makeDisk({ holdWrites: true });
  const { store } = makeStore({ pieces: 2, disk });
  try {
    await put(store, 0);
    await put(store, 1);

    // Evicts one piece; its write is held, so the store has a spill in flight
    // for as long as this test wants.
    const spilling = put(store, 2);
    await until(() => disk.heldCount > 0, "a write is in flight");

    // Nothing left that may be evicted: one piece is being written out, the
    // other is pinned. The old rule waited while anything was nominally in
    // flight, which here is for ever.
    store.pin(1);
    await assert.rejects(() => put(store, 3), /nothing moved/);

    store.unpin(1);
    disk.releaseWrites();
    await spilling;
  } finally {
    disk.releaseWrites();
    await new Promise((resolve) => store.destroy(resolve));
  }
});

test("closing the store fails whoever is waiting for room", { timeout: 30_000 }, async () => {
  const disk = makeDisk({ holdWrites: true });
  const { store } = makeStore({ pieces: 2, disk });
  try {
    await put(store, 0);
    await put(store, 1);
    const spilling = put(store, 2);
    await until(() => disk.heldCount > 0, "a write is in flight");
    store.pin(1);

    const waiting = put(store, 3);
    // Either counter: the claim waits for the disk first — a block is in flight
    // and the store is full, so evicting another piece would only raise the
    // memory in use — and reaches the pinned wait five seconds later. Asking for
    // `waitedForPins` alone named one of the two ways of waiting and timed out
    // while the store was demonstrably doing the other.
    await until(
      () => store.stats().waitedForPins + store.stats().waitedForDisk > 0,
      "the claim is waiting"
    );

    await new Promise((resolve) => store.close(resolve));
    await assert.rejects(() => waiting, /closed/);

    store.unpin(1);
    disk.releaseWrites();
    await spilling.catch(() => undefined);
  } finally {
    disk.releaseWrites();
  }
});

test("a piece written back to memory is not resurrected on disk by its own spill", { timeout: 30_000 }, async () => {
  const disk = makeDisk({ holdWrites: true });
  const { store } = makeStore({ pieces: 4, disk });
  try {
    await put(store, 0);
    await put(store, 1);
    await put(store, 2);

    // Piece 0 leaves memory because the machine's allowance fell; its write is
    // still in flight. The allowance then recovers to MORE than it was, so the
    // piece coming back needs no eviction and no wait for that write.
    //
    // Four blocks, not three, and the reason is what this check is about. A
    // block being written out is still memory in use, so with a ceiling of three
    // and one block in flight the store is full, and the claim correctly waits
    // for the disk — which the earlier setup did not allow for, so the check
    // timed out on an admission policy it never meant to measure. Whether a
    // piece arriving while its OWN spill is in flight should be admitted without
    // taking a second block is a real question about the accounting and is
    // roadmap item 9, not this check's subject: the subject is that the spill,
    // when it completes, must not put the stale copy back on disk.
    store.reviseGrowthCeiling(CHUNK * 2);
    await until(() => disk.heldCount > 0, "the spill of piece 0 is in flight");
    store.reviseGrowthCeiling(CHUNK * 4);

    // The swarm hands piece 0 back while that write is still going. The store
    // must drop the disk copy AFTER the write has recorded it, not before —
    // `DiskTier.write` adds the index on completion, so an early forget is
    // undone and the next read of piece 0 comes back from before the rewrite.
    let settled = false;
    const rewritten = put(store, 0);
    void rewritten.then(() => {
      settled = true;
    });
    await until(() => store.stats().resident === 3, "piece 0 is back in memory");
    assert.equal(settled, false, "the write finished without waiting for the piece's own spill");

    disk.releaseWrites();
    await rewritten;

    assert.equal(disk.has(0), false, "the completing spill put the stale copy back");
  } finally {
    disk.releaseWrites();
    await new Promise((resolve) => store.destroy(resolve));
  }
});

test("a spill that fails while the allowance is lowered is counted, not thrown", async () => {
  const disk = makeDisk({ failWrite: true });
  const { store } = makeStore({ pieces: 4, disk });
  try {
    await put(store, 0);
    await put(store, 1);
    await put(store, 2);
    await put(store, 3);

    store.reviseGrowthCeiling(CHUNK * 2);
    await until(() => store.stats().spillFailures > 0, "the failed spills are counted");

    assert.equal(store.stats().outstanding, 0, "lowering the allowance held a reservation");
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
  }
});
