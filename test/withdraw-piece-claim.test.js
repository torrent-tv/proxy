/**
 * @file One owner of the fact "this proxy has piece N".
 *
 * The store holds the bytes, so it owns the fact. The library keeps a second
 * copy of it in its completion bitfield, and until 2026-09-12 nothing
 * reconciled them: the disk tier dropped a piece once every reader was past it
 * — correctly, that is what bounds the spill — and the bitfield went on saying
 * the piece was verified. A read then concluded the piece was had, asked for it,
 * was told it was absent, and failed; nothing fetched it again either, because
 * the library does not download what it believes it owns. Field: a film played
 * 80 seconds and then answered `Piece 0 is verified but absent from the store`
 * for 92 minutes.
 *
 * Pinned here: the announcement and its one rule — said when the piece has gone
 * from EVERYWHERE, never when one tier alone lost it — and the withdrawal.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { SharedPieceStore } from "../services/piece-store/shared-piece-store.js";
import { withdrawClaim } from "../services/download/withdraw-claim.js";

const PIECE = 1024;

/**
 * A store of four pieces with room for one, so every admission spills the last,
 * plus the announcements it made.
 */
async function storeWithGone(extras = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "withdraw-test-"));
  /** @type {number[]} */
  const gone = [];
  const store = new SharedPieceStore(PIECE, {
    length: 4 * PIECE,
    memoryBytes: PIECE,
    path: directory,
    name: "test",
    files: [{ offset: 0, length: 4 * PIECE, name: "file.bin" }],
    onPieceGone: ({ index }) => gone.push(index),
    ...extras
  });
  const put = (index) => new Promise((resolve, reject) => {
    store.put(index, Buffer.alloc(PIECE, index + 1), (error) => (error ? reject(error) : resolve()));
  });
  const clean = async () => {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  };
  return { store, gone, put, clean };
}

/**
 * Wait for the CONDITION, with a deadline only as a backstop. A fixed pause
 * here would measure the machine rather than the store.
 *
 * @param {() => boolean} ready
 * @param {string} what
 */
async function until(ready, what) {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a piece left behind every reader is dropped AND the claim withdrawn", async () => {
  const { store, gone, put, clean } = await storeWithGone();
  try {
    await put(0);
    await put(1);
    await put(2);
    // WHERE THE READERS STAND, which is the whole trigger: the encoder ran
    // ahead, so pieces 0-1 are behind every one of them. This is the production
    // path — `reviseSpillCeiling` asks `forgetBehind(readHeads)` — and it is
    // what dropped 565 pieces in the field.
    store.protectRange("reader", 2, 3, 0);
    const revision = store.reviseSpillCeiling(null);

    assert.ok(revision.behind >= 1, `something should have been dropped, got ${revision.behind}`);
    assert.ok(gone.includes(0), `piece 0 has gone and should say so, got ${JSON.stringify(gone)}`);
    assert.ok(
      gone.every((index) => index < 2),
      `nothing a reader still wants may be announced, got ${JSON.stringify(gone)}`
    );
  } finally {
    await clean();
  }
});

test("a piece dropped as a duplicate of a file held whole is NOT announced", async () => {
  const { store, gone, put, clean } = await storeWithGone({
    // Every piece can be had from the assembled file, which is exactly why the
    // spilled copy is being dropped. Nothing has been lost, so nothing is said.
    isPieceElsewhere: () => true
  });
  try {
    await put(0);
    await put(1);
    await put(2);
    // The spill is what puts a piece on disk, and it finishes on its own time;
    // dropping duplicates deliberately leaves a piece whose spill is still in
    // flight alone, so the precondition is waited for rather than assumed.
    await until(() => store.stats().spilled >= 1, "a piece to reach the disk");
    const dropped = store.dropDuplicatesHeldElsewhere();
    assert.ok(dropped >= 1, "the spilled duplicate should have been dropped");
    assert.deepEqual(gone, [], "a piece still readable from a whole file has not gone");
  } finally {
    await clean();
  }
});

test("a closing store announces nothing, because its torrent is going too", async () => {
  const { store, gone, put, clean } = await storeWithGone();
  try {
    await put(0);
    await put(1);
    store.protectRange("reader", 2, 3, 0);
    store.close(() => undefined);
    store.reviseSpillCeiling(null);
    assert.deepEqual(gone, [], "a claim withdrawn against a dying torrent reaches nothing useful");
  } finally {
    await clean();
  }
});

test("the withdrawal is counted in the store's own figures", async () => {
  const { store, put, clean } = await storeWithGone();
  try {
    await put(0);
    await put(1);
    await put(2);
    store.protectRange("reader", 2, 3, 0);
    store.reviseSpillCeiling(null);
    assert.ok(
      store.stats().withdrawn >= 1,
      "the figure that makes the eviction's bargain checkable must move"
    );
  } finally {
    await clean();
  }
});

test("a piece the library thinks it has is withdrawn", () => {
  const asked = [];
  const torrent = {
    name: "film.mkv",
    destroyed: false,
    bitfield: { get: () => true },
    _markUnverified: (index) => asked.push(index)
  };
  assert.equal(withdrawClaim({ index: 3, files: [{ _torrent: torrent }] }), "withdrawn");
  assert.deepEqual(asked, [3]);
});

test("a piece the library already knows is missing is left alone", () => {
  let touched = 0;
  const torrent = {
    destroyed: false,
    bitfield: { get: () => false },
    _markUnverified: () => { touched += 1; }
  };
  assert.equal(
    withdrawClaim({ index: 7, torrent }),
    "nothing-to-withdraw",
    "re-creating a piece the library is already fetching would discard its blocks in flight"
  );
  assert.equal(touched, 0);
});

test("a destroyed torrent is left alone", () => {
  let touched = 0;
  const torrent = {
    destroyed: true,
    bitfield: { get: () => true },
    _markUnverified: () => { touched += 1; }
  };
  assert.equal(withdrawClaim({ index: 1, torrent }), "no-torrent");
  assert.equal(touched, 0);
});

test("a library that refuses says so instead of failing the eviction", () => {
  const said = [];
  const torrent = {
    name: "film.mkv",
    destroyed: false,
    bitfield: { get: () => true },
    _markUnverified: () => { throw new Error("no such method any more"); }
  };
  assert.equal(withdrawClaim({ index: 2, torrent, warn: (line) => said.push(line) }), "refused");
  assert.equal(said.length, 1);
  assert.match(said[0], /piece 2 of film\.mkv/);
});

test("a store with nobody listening evicts exactly as it did before", async () => {
  const { store, put, clean } = await storeWithGone({ onPieceGone: undefined });
  try {
    await put(0);
    await put(1);
    await put(2);
    store.protectRange("reader", 2, 3, 0);
    const revision = store.reviseSpillCeiling(null);
    assert.ok(revision.behind >= 1, "the eviction does not depend on anybody listening");
  } finally {
    await clean();
  }
});
