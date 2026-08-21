/**
 * @file Keep the last few core dumps and no more.
 *
 * Each is the worker thread's whole address space — 4.18 GB on the field host —
 * and four of them had nearly filled a 235 GB disk by 2026-08-21. The newest
 * are evidence for a fault that is still open, so they stay; the rest go.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { dumpsToRemove, isCoreDump } from "../services/core-dumps.js";

const dumps = [
  { name: "core.WorkerThread.81.1787176646", writtenAt: 1787176646000 },
  { name: "core.WorkerThread.81.1787224562", writtenAt: 1787224562000 },
  { name: "core.WorkerThread.81.1787237468", writtenAt: 1787237468000 },
  { name: "core.WorkerThread.81.1787243278", writtenAt: 1787243278000 },
  { name: "core.WorkerThread.81.1787292750", writtenAt: 1787292750000 }
];

test("the newest two stay and the rest go, oldest first", () => {
  assert.deepEqual(dumpsToRemove(dumps), [
    "core.WorkerThread.81.1787176646",
    "core.WorkerThread.81.1787224562",
    "core.WorkerThread.81.1787237468"
  ]);
});

test("fewer than the limit leaves everything alone", () => {
  assert.deepEqual(dumpsToRemove(dumps.slice(0, 2)), []);
  assert.deepEqual(dumpsToRemove([]), []);
});

test("order on disk does not decide; the time written does", () => {
  const shuffled = [dumps[3], dumps[0], dumps[4], dumps[2], dumps[1]];
  assert.deepEqual(dumpsToRemove(shuffled, 1), [
    "core.WorkerThread.81.1787176646",
    "core.WorkerThread.81.1787224562",
    "core.WorkerThread.81.1787237468",
    "core.WorkerThread.81.1787243278"
  ]);
});

test("only core dumps are considered", () => {
  assert.equal(isCoreDump("core.WorkerThread.81.1787292750"), true);
  assert.equal(isCoreDump("proxy.log"), false);
  assert.equal(isCoreDump("host-timings.json"), false);
  // Not a path, and not a directory called core.
  assert.equal(isCoreDump("core.foo/bar"), false);
  assert.equal(isCoreDump(""), false);
});

test("nothing readable is not a reason to delete anything", () => {
  assert.deepEqual(dumpsToRemove(null), []);
  assert.deepEqual(dumpsToRemove([{ name: 5, writtenAt: "x" }]), []);
});
