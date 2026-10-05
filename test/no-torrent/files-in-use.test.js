/**
 * @file Which files of a torrent are in use for the whole-file sweep. Pure:
 * no torrent is started (see services/torrent/worker/files-in-use.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { filesInUse } from "../../services/torrent/worker/files-in-use.js";

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
