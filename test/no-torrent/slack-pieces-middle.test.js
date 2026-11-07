/**
 * @file Pins what `slackPieces` decides from the write durations it has seen
 * (torrent-tv/meta#294): the UPPER middle element on an even sample, the middle
 * one on an odd sample. The median refactor keeps this through
 * `upperMiddleOf`, so the decision does not change by one piece.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SharedPieceStore } from "../../services/storage/piece-store/shared-piece-store.js";

const PIECE = 1024;
const SPACING_MS = 1000;
const CAPACITY = 2;

/** A disk whose writes finish only when the test releases them. */
function heldDisk() {
  const stored = new Set();
  /** @type {Array<() => void>} */
  const waiting = [];
  return {
    pending: waiting,
    get size() { return stored.size; },
    get bytes() { return 0; },
    get path() { return "."; },
    get allowanceBytes() { return null; },
    reviseAllowance() { return null; },
    stats() { return { pieces: stored.size, bytes: 0, allowanceBytes: null, evictions: 0 }; },
    has: (index) => stored.has(index),
    forget: (index) => stored.delete(index),
    write(index) {
      return new Promise((resolve) => {
        waiting.push(() => { stored.add(index); resolve(); });
      });
    },
    async read(index, target) { target.fill(index % 251); return target.length; },
    async close() { waiting.length = 0; },
    async destroy() { stored.clear(); waiting.length = 0; }
  };
}

/**
 * Admit pieces one per SPACING_MS on a controlled clock, each eviction's write
 * taking the next of `durations`, and return what `slackPieces` then says.
 *
 * @param {number[]} durations
 * @returns {Promise<number>}
 */
async function slackAfter(durations) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slack-pieces-"));
  const disk = heldDisk();
  const store = new SharedPieceStore(PIECE, {
    length: PIECE * 100, memoryBytes: PIECE * CAPACITY, path: directory, name: "slack", disk
  });
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    for (let index = 0; index < CAPACITY + durations.length; index += 1) {
      clock = 1_000_000 + index * SPACING_MS;
      const admitted = new Promise((resolve, reject) => {
        store.put(index, Buffer.alloc(PIECE, index % 251), (error) => (error ? reject(error) : resolve()));
      });
      if (index >= CAPACITY) {
        const deadline = realNow() + 5000;
        while (disk.pending.length === 0) {
          if (realNow() > deadline) throw new Error("the eviction's write never reached the disk");
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        clock += durations[index - CAPACITY];
        disk.pending.shift()();
      }
      await admitted;
    }
    return store.slackPieces();
  } finally {
    Date.now = realNow;
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

test("slackPieces is zero before anything has been measured", async () => {
  assert.equal(await slackAfter([]), 0);
});

test("slackPieces takes the middle write duration of an odd sample", async () => {
  // 3 writes, 5 arrivals over 4 s: 1 per second; middle duration 2000 ms -> 2
  assert.equal(await slackAfter([1000, 3000, 2000]), 2);
});

test("slackPieces takes the UPPER middle write duration of an even sample", async () => {
  // 4 writes, 6 arrivals over 5 s: 1 per second; upper middle 2500 ms -> 3
  // (a true median of 2000 ms would give 2)
  assert.equal(await slackAfter([500, 3500, 1500, 2500]), 3);
});
