/**
 * @file Lowering the download limit while a slice already waits for tokens
 * (torrent-tv/meta#178). WebTorrent's limit is `speed-limiter`'s
 * ThrottleGroup over `limiter`'s TokenBucket; the group is real here, the
 * client around it is the part of WebTorrent's `throttleDownload` it uses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ThrottleGroup } from "speed-limiter";
import { applyDownloadRate } from "../../services/torrent/download/throttle.js";

/** WebTorrent 2.8.5 `throttleDownload`, over a real group. */
function clientWith(group) {
  return {
    throttleGroups: { down: group },
    throttleDownload(rate) {
      if (rate < 0) return group.setEnabled(false);
      group.setEnabled(true);
      group.setRate(rate);
    }
  };
}

/** Write `data` through a throttle of `group`, lower the rate once a slice waits, collect what comes out. */
function lowerWhileWaiting(group, data, lower) {
  const throttle = group.throttle();
  const out = [];
  return new Promise((resolve) => {
    throttle.on("data", (chunk) => out.push(chunk));
    throttle.on("error", (error) => resolve({ error, out: Buffer.concat(out) }));
    throttle.on("end", () => resolve({ error: null, out: Buffer.concat(out) }));
    throttle.write(data);
    throttle.end();
    // The first slice finds the bucket empty and waits for its tokens; the
    // rate falls while it waits.
    setImmediate(lower);
  });
}

const data = Buffer.from(Array.from({ length: 200_000 }, (_, n) => n % 251));

test("a slice cut at the old rate fails when the bucket shrinks under it — the defect", async () => {
  const group = new ThrottleGroup({ rate: 0, enabled: false });
  const client = clientWith(group);
  client.throttleDownload(2_000_000); // slices of rate / 10 = 200 000 bytes
  const { error } = await lowerWhileWaiting(group, data, () => client.throttleDownload(100_000));
  assert.match(String(error), /exceeds bucket size/);
});

test("with slices of one BitTorrent block, lowering the limit loses and repeats nothing", async () => {
  const group = new ThrottleGroup({ rate: 0, enabled: false });
  const client = clientWith(group);
  applyDownloadRate(client, 2_000_000);
  const { error, out } = await lowerWhileWaiting(group, data, () => applyDownloadRate(client, 100_000));
  assert.equal(error, null);
  assert.ok(out.equals(data), `${out.length} of ${data.length} bytes, in order`);
});

test("lifting the limit and setting it again keeps the slice at one block", () => {
  const group = new ThrottleGroup({ rate: 0, enabled: false });
  const client = clientWith(group);
  applyDownloadRate(client, 47_000_000);
  assert.equal(group.getChunksize(), 16_384);
  applyDownloadRate(client, -1);
  assert.equal(group.getEnabled(), false);
  applyDownloadRate(client, 600_000);
  assert.equal(group.getChunksize(), 16_384);
  // A limit below one block slices at the limit itself, as the group requires.
  applyDownloadRate(client, 10_000);
  assert.equal(group.getChunksize(), 10_000);
});
