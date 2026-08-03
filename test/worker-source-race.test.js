/**
 * @file Naming a source that is still being added.
 *
 * Adding a magnet takes as long as its metadata does — seconds to tens of
 * seconds — while the browser is already polling stats and the planner is
 * already asking for a plan. Until 2.9.77 the worker registered the torrent
 * only once the add had finished, so everything arriving in that window was
 * told `Unknown source`, which is false: the source exists, it is not ready.
 * Reproduced with a magnet nobody seeds — stats, the file listing and a read
 * all failed instantly while the add was in flight.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { TorrentWorkerClient } from "../services/torrent-worker/client.js";

/** A well-formed infohash nobody is seeding, so the add stays in flight. */
function pendingMagnet() {
  return `magnet:?xt=urn:btih:${crypto.randomBytes(20).toString("hex")}&dn=nobody-has-this`;
}

/**
 * What a promise did within `ms` — settled how, or still waiting.
 *
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @returns {Promise<string>}
 */
function outcomeWithin(promise, ms) {
  return Promise.race([
    promise.then(() => "resolved", (error) => `rejected: ${error?.message}`),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), ms))
  ]);
}

test("commands wait for a source that is still being added", async () => {
  const client = new TorrentWorkerClient({ memoryBytes: 16 * 1024 * 1024 });
  try {
    // Without this the worker's own startup would keep the commands waiting and
    // the test would pass for the wrong reason.
    await client.listFiles("warm-up").catch(() => undefined);

    const sourceKey = "pending-source";
    // Deliberately not awaited: this is the window under test.
    const adding = client.addSource({ sourceKey, sourceType: "magnet", source: pendingMagnet() });
    adding.catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 500));

    const stats = await outcomeWithin(client.getFileStats({ sourceKey, fileIndex: 0 }), 3000);
    const files = await outcomeWithin(client.listFiles(sourceKey), 3000);

    assert.equal(stats, "waiting", `stats did not wait for the add: ${stats}`);
    assert.equal(files, "waiting", `the file listing did not wait for the add: ${files}`);
  } finally {
    await client.destroyAll();
  }
});

test("a source that was never added is still reported as unknown", async () => {
  const client = new TorrentWorkerClient({ memoryBytes: 16 * 1024 * 1024 });
  try {
    // Starting the worker takes several seconds — it builds a torrent client,
    // a DHT and the rest — so the first command measures startup, not the
    // behaviour under test. Wait for one to come back before timing anything.
    await client.listFiles("warm-up").catch(() => undefined);

    // Waiting forever for something nobody ever asked for would be worse than
    // an error — this case must stay an error.
    const outcome = await outcomeWithin(client.listFiles("never-added"), 5000);
    assert.match(outcome, /^rejected: .*never-added/, `expected an error, got "${outcome}"`);
  } finally {
    await client.destroyAll();
  }
});
