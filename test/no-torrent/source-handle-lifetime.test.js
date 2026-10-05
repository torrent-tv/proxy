import test from "node:test";
import assert from "node:assert/strict";
import { WorkerTorrentPool } from "../../services/torrent/worker/pool-adapter.js";

const hash = "0123456789012345678901234567890123456789";
const magnet = `magnet:?xt=urn:btih:${hash}`;
const sourceKey = `torrent:${hash}`;

test("concurrent source metadata requests share the fake worker result", async () => {
  let calls = 0, resolve;
  const result = new Promise(done => { resolve = done; });
  const pool = new WorkerTorrentPool({}, { getTorrent: () => { calls++; return result; } });
  const first = pool.getTorrent("magnet", magnet);
  const second = pool.getTorrent("magnet", magnet);
  await new Promise(done => setImmediate(done));
  assert.equal(calls, 1);
  const handle = { infoHash: hash, files: [] };
  resolve(handle);
  assert.equal(await first, handle);
  assert.equal(await second, handle);
  assert.equal(pool.knownTorrent(sourceKey), handle);
  pool.forget(sourceKey);
  assert.equal(pool.knownTorrent(sourceKey), null);
});

test("forgotten metadata cannot overwrite a newly resolved source handle", async () => {
  let resolveOld, calls = 0;
  const old = new Promise(resolve => { resolveOld = resolve; });
  const fresh = { infoHash: hash, files: [{ name: "new" }] };
  const pool = new WorkerTorrentPool({}, { getTorrent: async () => ++calls === 1 ? old : fresh });
  const first = pool.getTorrent("magnet", magnet);
  const rejected = assert.rejects(first, { code: "SOURCE_FORGOTTEN" });
  await new Promise(done => setImmediate(done));
  pool.forget(sourceKey);
  assert.equal(await pool.getTorrent("magnet", magnet), fresh);
  resolveOld({ infoHash: hash, files: [{ name: "obsolete" }] });
  await rejected;
  assert.equal(pool.knownTorrent(sourceKey), fresh);
});
