/**
 * @file Everything that holds bytes is told how many it may hold.
 *
 * Measured 2026-09-14, by reading every file outside the storage layer that
 * touches the filesystem: three claimants had no share at all, and one held a
 * ceiling over bytes it did not own.
 *
 * - whole files: NO BOUND OF ANY KIND. A 2.8 GB film kept whole on a host whose
 *   disk is often a 32 GB card;
 * - diagnostics: bounded by a COUNT and never by a size. Two core dumps and
 *   five heap snapshots came to 3.2 GB on the addon host, and one wedge was
 *   captured thirteen times in six hours;
 * - the torrent pool's "disk cap" of 10 GB: a sum over WebTorrent's downloaded
 *   bitfield, so a piece held purely in MEMORY told against a ceiling called
 *   disk, while the bytes it meant to bound belong to the spill and to the
 *   whole files, which have owners of their own. It owned nothing and is gone.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CompletedFiles } from "../../services/storage/files/CompletedFiles.js";
import { Diagnostics } from "../../services/storage/Diagnostics.js";

const KILOBYTE = 1024;

/**
 * @param {number} length
 * @returns {() => AsyncGenerator<Buffer>}
 */
function bytesOf(length) {
  return async function* source() {
    yield Buffer.alloc(length, 7);
  };
}

/**
 * @returns {Promise<{ files: CompletedFiles, root: string }>}
 */
async function filesInATempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "whole-files-"));
  return { files: new CompletedFiles({ root }), root };
}

test("a whole file is kept only while there is room for it", async () => {
  const { files, root } = await filesInATempRoot();
  try {
    files.allow(4 * KILOBYTE);
    const kept = await files.keep({
      infoHash: "a".repeat(40), fileIndex: 0, length: 3 * KILOBYTE, name: "one.mkv", open: bytesOf(3 * KILOBYTE)
    });
    assert.ok(kept, "it fits, so it is kept");

    const refused = await files.keep({
      infoHash: "b".repeat(40), fileIndex: 0, length: 3 * KILOBYTE, name: "two.mkv", open: bytesOf(3 * KILOBYTE)
    });
    assert.equal(refused, null, "it does not fit, so it is not assembled at all");
    assert.equal(files.size, 1, "and nothing already held was taken to make room during a write");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("over its share, the whole file nobody has read for longest goes", async () => {
  const { files, root } = await filesInATempRoot();
  try {
    files.allow(Number.MAX_SAFE_INTEGER);
    for (const [index, hash] of [["0", "a"], ["1", "b"], ["2", "c"]]) {
      await files.keep({
        infoHash: hash.repeat(40), fileIndex: Number(index), length: KILOBYTE, name: `${index}.mkv`, open: bytesOf(KILOBYTE)
      });
    }
    // The first two are asked for; the third is not, so it is the one nobody
    // wants. Losing it is not losing data — the torrent can fetch it again, and
    // until it does the read falls back to the pieces.
    files.find("a".repeat(40), 0);
    files.find("b".repeat(40), 1);

    const after = await files.allow(2 * KILOBYTE);

    assert.equal(after.removed, 1);
    assert.ok(files.find("a".repeat(40), 0), "a file just read was taken");
    assert.ok(files.find("b".repeat(40), 1), "a file just read was taken");
    assert.equal(files.find("c".repeat(40), 2), null, "the longest-unread should have gone");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("told nothing, whole files keep what they have — a share is not assumed", async () => {
  const { files, root } = await filesInATempRoot();
  try {
    const kept = await files.keep({
      infoHash: "a".repeat(40), fileIndex: 0, length: KILOBYTE, name: "one.mkv", open: bytesOf(KILOBYTE)
    });
    assert.ok(kept, "before the owner has divided anything there is nothing to refuse against");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("over its share the evidence stops being collected, and nothing recorded is deleted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "diagnostics-"));
  try {
    await fs.writeFile(path.join(root, "core.MainThread.1.2"), Buffer.alloc(4 * KILOBYTE));
    await fs.writeFile(path.join(root, "heap-x-1-2.heapsnapshot"), Buffer.alloc(2 * KILOBYTE));
    // Not evidence: the proxy's own state lives in the same directory.
    await fs.writeFile(path.join(root, "host-timings.json"), Buffer.alloc(KILOBYTE));

    const said = [];
    const diagnostics = new Diagnostics({
      logger: { info: () => {}, warn: (line) => said.push(line) },
      kinds: [
        { name: "core dumps", directory: () => root, matches: (name) => name.startsWith("core.") },
        { name: "heap snapshots", directory: () => root, matches: (name) => name.endsWith(".heapsnapshot") }
      ]
    });

    assert.equal(await diagnostics.measure(), 6 * KILOBYTE, "the proxy's own state is not evidence");
    assert.equal(
      diagnostics.wanted(),
      10 * KILOBYTE,
      "what it holds plus one more of the largest kind seen — measured, not a fraction"
    );

    diagnostics.allow(7 * KILOBYTE);
    assert.equal(diagnostics.mayKeep({ what: "a heap snapshot", bytes: KILOBYTE }), true, "there is room for a small one");
    assert.equal(diagnostics.mayKeep({ what: "a heap snapshot", bytes: 4 * KILOBYTE }), false, "there is not for a large one");

    assert.equal(said.length, 1, "a refusal is a line, never a silence");
    assert.match(said[0], /was NOT kept/);
    const left = (await fs.readdir(root)).sort();
    assert.deepEqual(
      left,
      ["core.MainThread.1.2", "heap-x-1-2.heapsnapshot", "host-timings.json"],
      "nothing already recorded may be removed to make room for more"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("before the owner has divided anything, the evidence is not refused", async () => {
  const diagnostics = new Diagnostics({ kinds: [], logger: { info: () => {}, warn: () => {} } });
  assert.equal(
    diagnostics.mayKeep({ what: "a core dump", bytes: Number.MAX_SAFE_INTEGER }),
    true,
    "null is what a claimant that has not been told looks like, and it does not license growth by itself"
  );
});
