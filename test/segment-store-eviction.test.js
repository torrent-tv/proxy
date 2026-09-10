/**
 * @file What goes first when the disk is short: the viewers decide.
 *
 * The store used to throw away whole outputs by when their directory was last
 * read, which says nothing about what anybody is about to watch. The order here
 * is the priority map's own, read from the other end: nobody's output first,
 * then what is behind the earliest viewer, then what is ahead of the furthest.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SegmentStore } from "../services/encode/SegmentStore.js";

const SEGMENT = 1024;

const format = {
  isSegmentFileName: (name) => /^segment-\d{5}\.mp4$/.test(name),
  segmentIndexFromName: (name) => {
    const match = /^segment-(\d{5})\.mp4$/.exec(name);
    return match ? Number(match[1]) : -1;
  }
};

/**
 * @param {number} [now]
 */
async function makeStore(now = 1000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "segment-store-test-"));
  const clock = { at: now };
  const store = new SegmentStore({ root, now: () => clock.at });
  return { store, root, clock };
}

/**
 * @param {SegmentStore} store
 * @param {string} key
 * @param {number[]} indexes
 */
async function fill(store, key, indexes) {
  store.useFormat(key, format);
  const dir = store.directoryFor(key);
  for (const index of indexes) {
    await fs.writeFile(
      path.join(dir, `segment-${String(index).padStart(5, "0")}.mp4`),
      Buffer.alloc(SEGMENT, index % 251)
    );
  }
}

/**
 * @param {SegmentStore} store
 * @param {string} key
 */
async function heldNumbers(store, key) {
  const names = await fs.readdir(store.pathFor(key)).catch(() => []);
  return names
    .filter((name) => format.isSegmentFileName(name))
    .map((name) => format.segmentIndexFromName(name))
    .sort((left, right) => left - right);
}

test("what nobody is watching goes before anything anybody is", async () => {
  const { store, root } = await makeStore();
  try {
    await fill(store, "watched", [0, 1, 2, 3]);
    await fill(store, "abandoned", [0, 1, 2, 3]);

    // Room for five segments of the eight held.
    store.enforce({
      idleMs: Number.POSITIVE_INFINITY,
      maxBytes: 5 * SEGMENT,
      viewersAt: (key) => (key === "watched" ? [2] : [])
    });

    // Three of eight had to go, and all three came from the output nobody is on.
    assert.deepEqual(
      await heldNumbers(store, "watched"),
      [0, 1, 2, 3],
      "the watched output lost segments while an unwatched one still held some"
    );
    assert.equal((await heldNumbers(store, "abandoned")).length, 1, "the unwatched output kept too much");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("behind the viewer goes before ahead of the viewer, furthest behind first", async () => {
  const { store, root } = await makeStore();
  try {
    await fill(store, "one", [0, 1, 2, 3, 4, 5]);

    // The viewer stands on #3. Room for four of the six.
    store.enforce({
      idleMs: Number.POSITIVE_INFINITY,
      maxBytes: 4 * SEGMENT,
      viewersAt: () => [3]
    });

    assert.deepEqual(
      await heldNumbers(store, "one"),
      [2, 3, 4, 5],
      "the two furthest behind the viewer should have gone, and nothing ahead"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("with nothing left behind, the furthest ahead goes next", async () => {
  const { store, root } = await makeStore();
  try {
    await fill(store, "one", [4, 5, 6, 7, 8]);

    // The viewer is on #4, so nothing is behind. Room for three of the five.
    store.enforce({
      idleMs: Number.POSITIVE_INFINITY,
      maxBytes: 3 * SEGMENT,
      viewersAt: () => [4]
    });

    assert.deepEqual(
      await heldNumbers(store, "one"),
      [4, 5, 6],
      "the two furthest ahead should have gone, nearest kept"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("the segment a viewer is standing on is never taken", async () => {
  const { store, root } = await makeStore();
  try {
    await fill(store, "one", [0, 1, 2]);

    // Two viewers, one on each end, and room for one segment only.
    store.enforce({
      idleMs: Number.POSITIVE_INFINITY,
      maxBytes: SEGMENT,
      viewersAt: () => [0, 2]
    });

    const left = await heldNumbers(store, "one");
    assert.ok(left.includes(0), "the segment the first viewer is on was taken");
    assert.ok(left.includes(2), "the segment the second viewer is on was taken");
    assert.deepEqual(left, [0, 2], "the one between two viewers should have gone");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("two viewers of one output: behind the EARLIEST, ahead of the FURTHEST", async () => {
  const { store, root } = await makeStore();
  try {
    await fill(store, "one", [0, 1, 2, 3, 4, 5, 6]);

    // Viewers on #2 and #5. Behind means below #2; ahead means above #5.
    store.enforce({
      idleMs: Number.POSITIVE_INFINITY,
      maxBytes: 5 * SEGMENT,
      viewersAt: () => [2, 5]
    });

    assert.deepEqual(
      await heldNumbers(store, "one"),
      [2, 3, 4, 5, 6],
      "what lies behind the earliest viewer must go before anything ahead of the furthest"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("an output nobody has read for long enough goes whole, however much room there is", async () => {
  const { store, root, clock } = await makeStore();
  try {
    await fill(store, "stale", [0, 1, 2]);
    clock.at += 60 * 60 * 1000;
    await fill(store, "fresh", [0, 1, 2]);

    const result = store.enforce({
      idleMs: 30 * 60 * 1000,
      // Room for everything: this is the rule that does not wait for pressure.
      maxBytes: Number.MAX_SAFE_INTEGER,
      viewersAt: () => []
    });

    assert.equal(result.droppedIdle, 1);
    assert.deepEqual(await heldNumbers(store, "stale"), [], "the stale output was kept");
    assert.deepEqual(await heldNumbers(store, "fresh"), [0, 1, 2], "the fresh output was taken");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("told nothing about viewers, it falls back to the oldest directory", async () => {
  const { store, root, clock } = await makeStore();
  try {
    await fill(store, "older", [0, 1, 2]);
    clock.at += 1000;
    await fill(store, "newer", [0, 1, 2]);

    const result = store.enforce({ idleMs: Number.POSITIVE_INFINITY, maxBytes: 4 * SEGMENT });

    assert.equal(result.droppedForRoom, 1);
    assert.deepEqual(await heldNumbers(store, "older"), []);
    assert.deepEqual(await heldNumbers(store, "newer"), [0, 1, 2]);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a clean exit leaves nothing of ours, so what is found next time is from a kill", async () => {
  const { store, root } = await makeStore();
  try {
    await fill(store, "one", [0, 1, 2]);
    await fill(store, "two", [0, 1]);
    // A directory this process adopted at startup and no session owns: the very
    // thing the old rule left behind, which is how an orphan became permanent.
    await fs.mkdir(path.join(root, "abandoned"), { recursive: true });
    await fs.writeFile(path.join(root, "abandoned", "segment-00000.mp4"), Buffer.alloc(SEGMENT));

    assert.equal(store.dropAll("the proxy is shutting down"), 2);

    await assert.rejects(() => fs.stat(root), /ENOENT/, "the store left its root behind");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});
