/**
 * @file Files downloaded whole are files, and outlive the torrent that fetched
 * them.
 *
 * Asked for in these words on 2026-09-11: as soon as a torrent is fully
 * downloaded, downloading stops, the torrent is deleted, and the artefacts —
 * what was downloaded — stay for as long as they are wanted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { CompletedFiles } from "../../services/storage/files/CompletedFiles.js";

const INFO_HASH = "abcdef0123456789abcdef0123456789abcdef01";

/** @returns {Promise<string>} */
const directory = () => fs.mkdtemp(path.join(os.tmpdir(), "whole-files-"));

/**
 * @param {Buffer} bytes
 * @param {number} [chunk]
 * @returns {() => NodeJS.ReadableStream}
 */
const opens = (bytes, chunk = 7) => () => {
  const parts = [];
  for (let at = 0; at < bytes.length; at += chunk) {
    parts.push(bytes.subarray(at, Math.min(at + chunk, bytes.length)));
  }
  return Readable.from(parts);
};

test("a file read whole is kept whole, and reads back byte for byte", async () => {
  const root = await directory();
  const files = new CompletedFiles({ root });
  const bytes = Buffer.from("the whole of a small film", "utf8");
  try {
    const kept = await files.keep({ infoHash: INFO_HASH, fileIndex: 3, length: bytes.length, name: "film.mkv", open: opens(bytes) });
    assert.ok(kept, "the file was not kept");
    assert.equal(kept.length, bytes.length);

    const found = files.find(INFO_HASH, 3);
    assert.deepEqual(found, kept, "what was kept is not what is found");
    assert.deepEqual(await fs.readFile(found.path), bytes, "the bytes came back changed");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a read that ends early leaves nothing that looks whole", async () => {
  const root = await directory();
  const files = new CompletedFiles({ root });
  const bytes = Buffer.from("half a film", "utf8");
  try {
    // The torrent says the file is longer than what its read produced — the
    // data went away mid-write, which over a torrent is ordinary.
    const kept = await files.keep({
      infoHash: INFO_HASH,
      fileIndex: 0,
      length: bytes.length + 100,
      open: opens(bytes)
    });
    assert.equal(kept, null, "a short file was kept as whole");
    assert.equal(files.find(INFO_HASH, 0), null);
    await assert.rejects(fs.stat(path.join(root, INFO_HASH)), { code: "ENOENT" }, "an empty torrent directory was left behind");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("what a previous life left is taken up, and what is the wrong size is not", async () => {
  const root = await directory();
  const bytes = Buffer.from("a film from the last time this ran", "utf8");
  try {
    const first = new CompletedFiles({ root });
    await first.keep({ infoHash: INFO_HASH, fileIndex: 2, length: bytes.length, name: "film.mkv", open: opens(bytes) });
    // And one that was being written when the process died, under a name that
    // says it is whole — the only way to tell is its size.
    await fs.writeFile(path.join(root, INFO_HASH, "5"), Buffer.alloc(3));

    const second = new CompletedFiles({ root });
    const adopted = await second.adopt((infoHash, fileIndex) =>
      infoHash === INFO_HASH && fileIndex === 2 ? bytes.length : 999
    );
    assert.equal(adopted, 1, "the whole file was not taken up, or the short one was");
    assert.equal(second.find(INFO_HASH, 2)?.name, "film.mkv", "the name the torrent gave it was lost");
    assert.equal(second.find(INFO_HASH, 5), null, "a file of the wrong size was taken up");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("forgetting a torrent removes its files and nobody else's", async () => {
  const root = await directory();
  const files = new CompletedFiles({ root });
  const other = "0123456789abcdef0123456789abcdef01234567";
  const bytes = Buffer.from("kept", "utf8");
  try {
    await files.keep({ infoHash: INFO_HASH, fileIndex: 1, length: bytes.length, name: "one.mkv", open: opens(bytes) });
    await files.keep({ infoHash: other, fileIndex: 1, length: bytes.length, name: "two.mkv", open: opens(bytes) });

    await files.forget(INFO_HASH);
    assert.equal(files.find(INFO_HASH, 1), null);
    assert.ok(files.find(other, 1), "another torrent's file went with it");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("the files held whole are listed by torrent, and listing them is not a read", async () => {
  const root = await directory();
  const files = new CompletedFiles({ root });
  try {
    await files.allow(1024);
    await files.keep({ infoHash: INFO_HASH, fileIndex: 3, length: 4, name: "a.mkv", open: opens(Buffer.from("abcd")) });
    await files.keep({ infoHash: INFO_HASH, fileIndex: 5, length: 2, name: "b.mkv", open: opens(Buffer.from("ef")) });
    const held = files.heldByTorrent();
    assert.deepEqual([...held.keys()], [INFO_HASH]);
    assert.deepEqual(held.get(INFO_HASH).fileIndexes.sort(), [3, 5]);
    assert.equal(held.get(INFO_HASH).bytes, 6);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent writes reserve the allowance before either file is assembled", async () => {
  const root = await directory();
  const files = new CompletedFiles({ root });
  let startWrite;
  let finishWrite;
  const started = new Promise(resolve => { startWrite = resolve; });
  const waitForFinish = new Promise(resolve => { finishWrite = resolve; });
  const slow = () => Readable.from((async function* () {
    startWrite();
    await waitForFinish;
    yield Buffer.alloc(700, 1);
  })());
  try {
    await files.allow(1000);
    const first = files.keep({ infoHash: INFO_HASH, fileIndex: 0, length: 700, name: "first", open: slow });
    await started;
    const second = await files.keep({ infoHash: INFO_HASH, fileIndex: 1, length: 700, name: "second", open: opens(Buffer.alloc(700, 2)) });
    assert.equal(second, null, "a second write used bytes already reserved by the first");
    finishWrite();
    assert.ok(await first, "the admitted file was not kept");
    assert.equal(files.bytes, 700);
    assert.ok(files.bytes <= 1000);
  } finally {
    finishWrite();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("admission replaces the oldest unused whole file when the allowance is full", async () => {
  const root = await directory();
  const files = new CompletedFiles({ root });
  try {
    await files.allow(1000);
    await files.keep({ infoHash: INFO_HASH, fileIndex: 0, length: 700, name: "old", open: opens(Buffer.alloc(700, 1)) });
    const current = await files.keep({ infoHash: INFO_HASH, fileIndex: 1, length: 700, name: "current", open: opens(Buffer.alloc(700, 2)) });
    assert.ok(current, "the current file was refused despite an eligible victim");
    assert.equal(files.find(INFO_HASH, 0), null, "the eligible old file was retained");
    assert.equal(files.bytes, 700);
    assert.deepEqual(await fs.readFile(current.path), Buffer.alloc(700, 2));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("admission preserves a live reader and releases a failed write reservation", async () => {
  const root = await directory();
  const files = new CompletedFiles({ root });
  try {
    await files.allow(10);
    await files.keep({ infoHash: INFO_HASH, fileIndex: 0, length: 7, name: "old", open: opens(Buffer.from("olddata")) });
    const reader = files.acquire(INFO_HASH, 0);
    assert.ok(reader);
    assert.equal(await files.keep({ infoHash: INFO_HASH, fileIndex: 1, length: 7, name: "current", open: opens(Buffer.from("newdata")) }), null);
    assert.ok(files.find(INFO_HASH, 0), "the live reader's file was evicted");
    await reader.release();

    const failed = await files.keep({
      infoHash: INFO_HASH,
      fileIndex: 2,
      length: 7,
      name: "failed",
      open: () => Readable.from((async function* () { yield Buffer.from("bad"); throw new Error("read failed"); })())
    });
    assert.equal(failed, null);
    const current = await files.keep({ infoHash: INFO_HASH, fileIndex: 1, length: 7, name: "current", open: opens(Buffer.from("newdata")) });
    assert.ok(current, "failed write left a reservation behind");
    assert.equal(files.bytes, 7);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a smaller allowance is enforced when an admitted write finishes", async () => {
  const root = await directory();
  const files = new CompletedFiles({ root });
  let startWrite;
  let finishWrite;
  const started = new Promise(resolve => { startWrite = resolve; });
  const waitForFinish = new Promise(resolve => { finishWrite = resolve; });
  try {
    await files.allow(10);
    const pending = files.keep({
      infoHash: INFO_HASH,
      fileIndex: 0,
      length: 8,
      name: "pending",
      open: () => Readable.from((async function* () { startWrite(); await waitForFinish; yield Buffer.alloc(8); })())
    });
    await started;
    await files.allow(0);
    finishWrite();
    assert.equal(await pending, null, "the completed write remained over the revised allowance");
    assert.equal(files.bytes, 0);
  } finally {
    finishWrite();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("whole files expire after idle use, but an active read gets its full lease", async () => {
  const root = await directory();
  let now = 1_000;
  const files = new CompletedFiles({ root, idleTtlMs: 100, now: () => now });
  const bytes = Buffer.from("cached film");
  try {
    const kept = await files.keep({ infoHash: INFO_HASH, fileIndex: 0, length: bytes.length, name: "film.mkv", open: opens(bytes) });
    assert.ok(kept);

    now += 99;
    assert.equal(files.peek(INFO_HASH, 0)?.path, kept.path);
    now += 1;
    const reader = files.acquire(INFO_HASH, 0);
    assert.ok(reader);
    now += 101;
    assert.deepEqual(await files.expireIdle(), { bytes: bytes.length, removed: 0 });
    assert.deepEqual(await fs.readFile(reader.path), bytes);

    await reader.release();
    now += 99;
    assert.deepEqual(await files.expireIdle(), { bytes: bytes.length, removed: 0 });
    now += 1;
    assert.deepEqual(await files.expireIdle(), { bytes: 0, removed: 1 });
    assert.equal(files.find(INFO_HASH, 0), null);
    await assert.rejects(fs.stat(path.join(root, INFO_HASH)), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup removes orphaned partial whole files and preserves a live writer", async () => {
  const root = await directory();
  try {
    const torrentDirectory = path.join(root, INFO_HASH);
    await fs.mkdir(torrentDirectory, { recursive: true });
    await fs.writeFile(path.join(torrentDirectory, "3.partial"), Buffer.from("incomplete"));
    await fs.utimes(path.join(torrentDirectory, "3.partial"), new Date(0), new Date(0));
    await fs.writeFile(path.join(torrentDirectory, `4.partial-${Number.MAX_SAFE_INTEGER}-${"a".repeat(32)}`), Buffer.from("orphan"));
    await fs.writeFile(path.join(torrentDirectory, `5.partial-${process.pid}-${"b".repeat(32)}`), Buffer.from("live write"));
    await fs.writeFile(path.join(torrentDirectory, "manifest.json"), "{}");

    const files = new CompletedFiles({ root });
    assert.equal(await files.adopt(() => null), 0);
    assert.deepEqual((await fs.readdir(torrentDirectory)).sort(), [
      "5.partial-" + process.pid + "-" + "b".repeat(32),
      "manifest.json"
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
