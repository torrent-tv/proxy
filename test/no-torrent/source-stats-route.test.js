import assert from "node:assert/strict";
import test from "node:test";
import { handleApiSourceStatsGet } from "../../routes/api/sources/stats/get.js";

test("statistics cannot add a source and report missing metadata without waiting", async () => {
  const reply = { status: 200, code(status) { this.status = status; return this; }, send: value => value };
  const result = await handleApiSourceStatsGet({ params: { sourceKey: "source" }, query: {} }, reply, {
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "unused" }) },
    torrentPool: { knownTorrent: () => null, getTorrent: () => { throw new Error("Statistics cannot add a source"); } }
  });
  assert.equal(reply.status, 202);
  assert.deepEqual(result, { pending: true });
});
