/**
 * @file What the allowance has to bound, and why it is not the resident pieces.
 *
 * The field failure of 2026-09-02, in one sentence: a piece being written out
 * leaves the store's own count the moment the eviction begins, while its memory
 * stays held until the write that reads from it has finished. So every
 * admission turned one resident block into one block held by the disk and took
 * a fresh block for the arrival, and the memory in use went UP by one per
 * admission for as long as the disk was behind.
 *
 * It was behind by a factor of two: 233 evictions started against about 119
 * writes completed in the same minute. The store reported 203 blocks held with
 * THREE pieces resident and 68 MB allowed, and the kernel killed the process at
 * 4.37 GB.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SharedPieceStore } from "../services/piece-store/shared-piece-store.js";

const PIECE = 1024;

/**
 * Wait for the thing being asserted, not for a length of time.
 *
 * @param {() => boolean} until
 * @param {string} what - Named in the failure, since a timeout otherwise says
 *   only that something did not happen.
 * @param {number} [limit]
 * @returns {Promise<void>}
 */
async function waitFor(until, what, limit = 10_000) {
  const deadline = Date.now() + limit;
  while (!until()) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never happened`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

/**
 * A disk that answers only when the test lets it, so writes can be made slower
 * than arrivals on purpose — which is the whole of the field condition.
 */
function heldDisk() {
  const stored = new Set();
  /** @type {Array<() => void>} */
  const waiting = [];
  return {
    pending: waiting,
    get size() {
      return stored.size;
    },
    get bytes() {
      return 0;
    },
    get path() {
      return ".";
    },
    get allowanceBytes() {
      return null;
    },
    reviseAllowance() {
      return null;
    },
    stats() {
      return { pieces: stored.size, bytes: 0, allowanceBytes: null, evictions: 0 };
    },
    has: (index) => stored.has(index),
    forget: (index) => stored.delete(index),
    write(index) {
      return new Promise((resolve) => {
        waiting.push(() => {
          stored.add(index);
          resolve();
        });
      });
    },
    async read(index, target) {
      target.fill(index % 251);
      return target.length;
    },
    async close() { waiting.length = 0; },
    async destroy() { stored.clear(); waiting.length = 0; }
  };
}

/**
 * @param {SharedPieceStore} store
 * @param {number} index
 * @returns {Promise<void>}
 */
const put = (store, index) =>
  new Promise((resolve, reject) => {
    store.put(index, Buffer.alloc(PIECE, index % 251), (error) => (error ? reject(error) : resolve()));
  });

test("memory in use never runs past the allowance while the disk is behind", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slow-disk-test-"));
  const disk = heldDisk();
  const capacity = 4;
  const store = new SharedPieceStore(PIECE, {
    length: PIECE * 200,
    memoryBytes: PIECE * capacity,
    path: directory,
    name: "slow-disk",
    disk
  });
  try {
    // Fill it, then keep pieces coming while every write stays unfinished.
    for (let index = 0; index < capacity; index += 1) {
      await put(store, index);
    }
    const arrivals = [];
    for (let index = capacity; index < capacity + 40; index += 1) {
      arrivals.push(put(store, index).catch(() => undefined));
    }
    // Until the state being asserted has been reached: a write is outstanding
    // and admission has waited for the disk rather than evicting. Waited out as
    // 200 ms instead, this asserted how far the arrivals had got in that time —
    // and on a machine slow enough that none of them reached a disk write, both
    // of those figures are zero and the test fails with nothing wrong.
    //
    // The bound below is what the wait must NOT decide, so it is checked after
    // the state is reached rather than after an interval: the store may never
    // hold more blocks than it is allowed, however many arrivals are in flight.
    await waitFor(() => {
      const now = store.stats();
      return now.blocksInFlight > 0 && now.waitedForDisk > 0;
    }, "a held write and an admission that waited for it");

    const held = store.stats();
    // The check the field failure would fail: a store allowed four pieces held
    // two hundred and three. Blocks held by a pending write count here, because
    // they are memory whatever the piece count says.
    assert.ok(
      held.blocksInUse <= capacity,
      `${held.blocksInUse} blocks in use with ${capacity} allowed `
      + `(${held.blocksInFlight} of them held by writes that have not finished)`
    );
    assert.ok(held.blocksInFlight > 0, "the disk was supposed to be holding some");
    assert.ok(held.waitedForDisk > 0, "admission was supposed to wait for the disk, not evict");

    // Let the disk answer: the blocks come back and everything settles.
    while (disk.pending.length > 0) {
      disk.pending.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(arrivals);
    assert.ok(store.stats().blocksInUse <= capacity + 1, "the pool did not settle");
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});
