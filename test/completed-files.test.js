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
import { CompletedFiles } from "../services/files/CompletedFiles.js";

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
    assert.deepEqual(
      (await fs.readdir(path.join(root, INFO_HASH))).filter((entry) => entry !== "manifest.json"),
      [],
      "a partial file was left behind"
    );
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
