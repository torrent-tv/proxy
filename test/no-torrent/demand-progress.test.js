import assert from "node:assert/strict";
import test from "node:test";
import { demandProgress } from "../../services/torrent/demand-progress.js";

test("preparation progress counts the union of exact wanted bytes using actual residence", () => {
  const params = { file: { offset: 5, length: 50 }, pieceLength: 16,
    windows: [{ byteStart: 7, byteEnd: 18 }, { byteStart: 10, byteEnd: 22 }, { byteStart: 30, byteEnd: 35 }],
    locationOf: index => index === 1 ? "missing" : "disk" };
  assert.deepEqual(demandProgress(params), { totalBytes: 22, downloadedBytes: 10 });
  assert.deepEqual(demandProgress({ ...params, locationOf: () => "ram" }), { totalBytes: 22, downloadedBytes: 22 });
  assert.equal(demandProgress({ ...params, windows: [] }), null);
});
