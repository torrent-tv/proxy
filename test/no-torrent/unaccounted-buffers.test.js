/**
 * What earns the torrent worker a snapshot besides its heap: array buffers that
 * no store accounts for. On 2026-10-01 the worker held 4.3 GB of them against
 * 40 MB its stores had committed, the kernel killed the process twice, and no
 * snapshot existed because the only trigger watched the heap. Pure arithmetic;
 * nothing is started.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { unaccountedBufferBytes } from "../../services/storage/memory-report.js";

const MB = 1024 * 1024;

test("pieces the stores have committed are not counted against the worker", () => {
  assert.equal(unaccountedBufferBytes(4370 * MB, [{ committedBytes: 40 * MB }]), 4330 * MB);
  assert.equal(
    unaccountedBufferBytes(300 * MB, [{ committedBytes: 200 * MB }, { committedBytes: 50 * MB }]),
    50 * MB
  );
});

test("a store holding more than the isolate reports leaves nothing unaccounted", () => {
  assert.equal(unaccountedBufferBytes(10 * MB, [{ committedBytes: 40 * MB }]), 0);
});

test("missing figures read as nothing rather than as a number", () => {
  assert.equal(unaccountedBufferBytes(undefined, undefined), 0);
  assert.equal(unaccountedBufferBytes(8 * MB, [{}]), 8 * MB);
});
