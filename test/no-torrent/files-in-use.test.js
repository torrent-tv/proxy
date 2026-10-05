/**
 * @file Which files of a torrent are in use for the whole-file sweep. Pure:
 * no torrent is started (see services/torrent/worker/files-in-use.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { filesInUse, readWhileInUse } from "../../services/torrent/worker/files-in-use.js";

test("range admission retains its file until asynchronous storage completes", async () => {
  const torrent = {};
  const openReads = new Map();
  let finish;
  const stored = new Promise(resolve => { finish = resolve; });
  const reading = readWhileInUse(openReads, 7, torrent, 5, () => {
    assert.deepEqual([...filesInUse({ torrent, windows: [], openReads: openReads.values() })], [5]);
    return stored;
  });
  assert.equal(openReads.size, 1);
  finish("bytes");
  assert.equal(await reading, "bytes");
  assert.equal(openReads.size, 0);
});

test("failed storage releases only its own read registration", async () => {
  const torrent = {};
  const openReads = new Map();
  await assert.rejects(readWhileInUse(openReads, 8, torrent, 5, async () => {
    throw new Error("storage failed");
  }), /storage failed/);
  assert.equal(openReads.size, 0);
  const replacement = { torrent, fileIndex: 6 };
  await readWhileInUse(openReads, 8, torrent, 5, async () => {
    openReads.set(8, replacement);
  });
  assert.equal(openReads.get(8), replacement);
});

test("a file being read is in use though nobody states a need for it", () => {
  // Field 2026-10-04: every piece was here, so the read waited for nothing and
  // stated nothing, and the torrent was removed under it.
  const torrent = {};
  const used = filesInUse({ torrent, windows: [], openReads: [{ torrent, fileIndex: 0 }] });
  assert.deepEqual([...used], [0]);
});

test("a read of another torrent does not count", () => {
  const used = filesInUse({ torrent: {}, windows: [], openReads: [{ torrent: {}, fileIndex: 0 }] });
  assert.equal(used.size, 0);
});

test("stated needs count, and the fills that read nothing do not", () => {
  const used = filesInUse({
    torrent: {},
    windows: [
      { claimant: "reader:7", fileIndex: 2 },
      { claimant: "file-edges:1", fileIndex: 1 },
      { claimant: "torrent-fill:x", fileIndex: 3 },
      { claimant: "background-fill:x", fileIndex: 4 }
    ],
    openReads: []
  });
  assert.deepEqual([...used], [2]);
});
