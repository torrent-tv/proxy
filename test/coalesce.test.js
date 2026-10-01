/**
 * @file A request that arrives during a run gives one more run, never a lost
 * one and never a queue.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { coalescing } from "../utils/coalesce.js";

test("asked during a run: one more run after it, however often it was asked", async () => {
  const runs = [];
  let release;
  const run = coalescing(async (label) => {
    runs.push(label);
    if (runs.length === 1) {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
  });
  const first = run("file", "first");
  await run("file", "second");
  await run("file", "third");
  assert.deepEqual(runs, ["first"], "nothing ran beside the run in progress");
  release();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runs, ["first", "third"], "exactly one more run, with the latest arguments");
});

test("different keys run side by side", async () => {
  const runs = [];
  const run = coalescing(async (label) => {
    runs.push(label);
  });
  await Promise.all([run("a", "a"), run("b", "b")]);
  assert.deepEqual(runs.sort(), ["a", "b"]);
});
