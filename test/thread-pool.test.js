/**
 * @file The blocking-call pool is stated before anything can create it.
 *
 * Field 2026-08-18: a film with 517 seeders spent eleven minutes with zero
 * peers on the addon host. Every announce timed out — UDP and HTTP alike — and
 * the cause was not the network: resolving that torrent's ten tracker names as
 * a burst took 7.58 s on the default four-thread pool, against 27-42 ms each
 * when the pool was larger. A dead tracker holds a thread for the resolver's
 * whole timeout, and every announce queued behind it misses its own deadline.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the pool is set, and left alone when the deployment states its own", async () => {
  const previous = process.env.UV_THREADPOOL_SIZE;
  try {
    process.env.UV_THREADPOOL_SIZE = "";
    await import(`../services/thread-pool.js?first=${Date.now()}`);
    assert.equal(
      Number(process.env.UV_THREADPOOL_SIZE) >= 16,
      true,
      "enough threads for a torrent's whole announce list to resolve at once"
    );

    process.env.UV_THREADPOOL_SIZE = "8";
    await import(`../services/thread-pool.js?stated=${Date.now()}`);
    assert.equal(process.env.UV_THREADPOOL_SIZE, "8", "a stated size is the deployment's to choose");
  } finally {
    if (previous === undefined) {
      delete process.env.UV_THREADPOOL_SIZE;
    } else {
      process.env.UV_THREADPOOL_SIZE = previous;
    }
  }
});

test("the entry point imports it before anything that could create the pool", async () => {
  const cli = await readFile(path.join(here, "..", "bin", "cli.js"), "utf8");
  const imports = [...cli.matchAll(/^import\s.*?from\s+["'](.+?)["'];|^import\s+["'](.+?)["'];/gm)]
    .map((match) => match[1] ?? match[2]);

  assert.equal(
    imports[0],
    "../services/thread-pool.js",
    "a module's imports run before its body, so this cannot be a statement in cli.js"
  );
});
