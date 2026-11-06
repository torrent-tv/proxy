/**
 * @file The torrent-pool ports of the output graph (torrent-tv/meta#280,
 * design.md §6.5 D): a fake pool and a fake registry.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { torrentPoolPorts } from "../../services/server/torrent-pool-ports.js";

const record = { sourceType: "magnet", source: "magnet:?xt=x" };

function ports(pool = {}, records = { src: record }) {
  const sourceRegistry = { get: key => records[key] };
  const torrentPool = { knownTorrent: key => (key === "src" ? { id: "t" } : null), ...pool };
  return torrentPoolPorts({ torrentPool, sourceRegistry, wholeFilesRoot: "/files" });
}

test("a pool without the claimants gives null claimants", () => {
  const found = ports();
  assert.equal(found.spillDisk, null);
  assert.equal(found.wholeFiles, null);
  assert.equal(found.memoryClaimant, null);
});

test("claimants read the pool and pass the allowance on", () => {
  const allowed = [];
  const found = ports({
    spilledBytes: 5, wholeFileBytes: 6, wholeFileRequiredBytes: 7, memoryClaim: { held: 8, wanted: 9 },
    allowSpillBytes: bytes => allowed.push(["spill", bytes]),
    allowWholeFileBytes: bytes => allowed.push(["whole", bytes]),
    allowMemoryBytes: bytes => allowed.push(["memory", bytes])
  });
  assert.equal(found.spillDisk.held(), 5);
  assert.equal(found.wholeFiles.held(), 6);
  assert.equal(found.wholeFiles.required(), 7);
  assert.equal(found.wholeFiles.root, "/files");
  assert.deepEqual([found.memoryClaimant.held(), found.memoryClaimant.wanted()], [8, 9]);
  found.spillDisk.allow(1); found.wholeFiles.allow(2); found.memoryClaimant.allow(3);
  assert.deepEqual(allowed, [["spill", 1], ["whole", 2], ["memory", 3]]);
});

test("ranges are read through the known torrent, and null or empty for an unknown one", async () => {
  const reads = [];
  const found = ports({
    readHeldRangesOf: (torrent, fileIndex, ranges, maxBytes) => { reads.push([torrent.id, fileIndex, ranges, maxBytes]); return "bytes"; },
    heldRangesOf: (torrent, fileIndex) => [[fileIndex, fileIndex]]
  });
  assert.equal(await found.readEncodeRanges({ sourceKey: "src", fileIndex: 2 }, [[0, 1]], 10), "bytes");
  assert.deepEqual(reads, [["t", 2, [[0, 1]], 10]]);
  assert.equal(await found.readEncodeRanges({ sourceKey: "none", fileIndex: 2 }, [[0, 1]], 10), null);
  assert.deepEqual(await found.readEncodeHeldRanges({ sourceKey: "src", fileIndex: 4 }), [[4, 4]]);
  assert.deepEqual(await found.readEncodeHeldRanges({ sourceKey: "none", fileIndex: 4 }), []);
});

test("stats of a source with no record, no torrent or a throwing pool are null", async () => {
  const stats = [];
  const found = ports({ getFileStats: async (torrent, fileIndex, options) => { stats.push([torrent.id, fileIndex, options]); return { ok: 1 }; } });
  assert.deepEqual(await found.getSourceStats("src", 1, { a: 1 }), { ok: 1 });
  assert.deepEqual(await found.getSourceStats("src", "x"), { ok: 1 });
  assert.deepEqual(stats[1], ["t", null, undefined]);
  assert.equal(await found.getSourceStats("missing", 0), null);
  const noTorrent = ports({ knownTorrent: () => null, getFileStats: async () => ({}) }, { gone: record });
  assert.equal(await noTorrent.getSourceStats("gone", 0), null);
  const throwing = ports({ getFileStats: async () => { throw new Error("worker gone"); } });
  assert.equal(await throwing.getSourceStats("src", 0), null);
});

test("torrent totals are null when the pool cannot say, and the rate setters tolerate a pool without them", async () => {
  const found = ports();
  assert.equal(await found.getTorrentTotals(), null);
  assert.equal(found.setDownloadRate(1, "x"), undefined);
  assert.equal(found.setSpeculativeHold(true, "x"), undefined);
  const full = ports({ getTorrentTotals: async () => ({ down: 1 }), setDownloadRate: (rate, because) => [rate, because] });
  assert.deepEqual(await full.getTorrentTotals(), { down: 1 });
  assert.deepEqual(full.setDownloadRate(5, "why"), [5, "why"]);
});

test("fetching a whole file fills it in the background from the registry's source", async () => {
  const filled = [];
  const found = ports({
    getTorrent: async (type, source) => ({ type, source }),
    fillFileInBackground: async (torrent, fileIndex) => { filled.push([torrent, fileIndex]); }
  });
  await found.fetchWholeFile({ sourceKey: "src", fileIndex: 3 });
  assert.deepEqual(filled, [[{ type: "magnet", source: "magnet:?xt=x" }, 3]]);
  await found.fetchWholeFile({ sourceKey: "missing", fileIndex: 3 });
  assert.equal(filled.length, 1);
});

test("whole files are acquired through the pool", () => {
  const found = ports({ acquireWholeFile: source => ({ held: source }) });
  assert.deepEqual(found.openEncodeWholeFile({ sourceKey: "src", fileIndex: 0 }), { held: { sourceKey: "src", fileIndex: 0 } });
});
