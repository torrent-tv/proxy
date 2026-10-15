import assert from "node:assert/strict";
import test from "node:test";
import { sourceService } from "../../services/server/ViewerRequests.js";

// r54 (torrent-tv/meta#178): a stretch our selection held nothing back read
// 0 B/s while the torrent carried 5-18 MB/s, and the viewer was held.
test("the forecast's source service is never below what the swarm carried", () => {
  const free = { lastValue: 0 }, delivered = { lastValue: 9_000_000 };
  assert.equal(sourceService(free, delivered), delivered);
  const capacity = { lastValue: 14_000_000 };
  assert.equal(sourceService(capacity, delivered), capacity, "where it carried more unheld, that is its capacity");
  assert.equal(sourceService(null, delivered), delivered);
  assert.equal(sourceService(free, null), free);
  assert.equal(sourceService(null, null), null);
});
