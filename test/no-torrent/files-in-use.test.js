/**
 * @file Which files of a torrent are in use for the whole-file sweep. Pure:
 * no torrent is started (see services/torrent/worker/files-in-use.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { filesInUse, filesToKeep, mayRemoveWholeTorrent, readWhileInUse } from "../../services/torrent/worker/files-in-use.js";

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

test("a downloaded file is written out while somebody watches it, and only then", () => {
  // torrent-tv/meta#173: written after its last viewer left, it serves nobody.
  const files = [{ done: true }, { done: true }, { done: false }, { done: true }];
  const kept = new Set([3]);
  const toKeep = filesToKeep({ files, isKept: (index) => kept.has(index), inUse: new Set([0, 2, 3]) });
  assert.deepEqual(toKeep, [0], "only the watched, downloaded file not yet kept is written");
});

test("a torrent saved whole is removed though a viewer still states a need for it", () => {
  const torrent = { done: true, files: [{}, {}] };
  assert.equal(mayRemoveWholeTorrent({ torrent, isKept: () => true, openReads: [], announcedNow: false }), true,
    "a stated need is answered from the files and does not keep the torrent");
});

test("a read still on the piece store keeps the torrent", () => {
  // torrent-tv/meta#105: removing the torrent closes the store under the read.
  const torrent = { done: true, files: [{}] };
  const openReads = new Map();
  assert.equal(mayRemoveWholeTorrent({ torrent, isKept: () => true, openReads: openReads.values(), announcedNow: false }), true);
  // A read that opened while a file was being written is seen, because the
  // reads are taken at the moment of the decision.
  openReads.set(1, { torrent, fileIndex: 0 });
  assert.equal(mayRemoveWholeTorrent({ torrent, isKept: () => true, openReads: openReads.values(), announcedNow: false }), false);
  assert.equal(mayRemoveWholeTorrent({ torrent, isKept: () => true, openReads: [{ torrent: {}, fileIndex: 0 }], announcedNow: false }), true,
    "a read of another torrent does not keep this one");
});

test("a torrent is not removed in the sweep that announced its file, nor before it is whole", () => {
  const torrent = { done: true, files: [{}, {}] };
  assert.equal(mayRemoveWholeTorrent({ torrent, isKept: () => true, openReads: [], announcedNow: true }), false,
    "the main thread has not yet learned that the file answers");
  assert.equal(mayRemoveWholeTorrent({ torrent, isKept: (index) => index === 0, openReads: [], announcedNow: false }), false);
  assert.equal(mayRemoveWholeTorrent({ torrent: { done: false, files: [{}] }, isKept: () => true, openReads: [], announcedNow: false }), false);
});
