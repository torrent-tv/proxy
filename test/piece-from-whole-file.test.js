/**
 * @file A piece read out of the files it was assembled into.
 *
 * Without this a whole file is a second copy of bytes the piece store also
 * holds, and neither copy can be dropped. With it the spilled copy is a
 * duplicate and can go — one episode on the field host of 2026-09-11 was
 * 1417 MB of segments beside 1424 MB of spilled pieces — and a torrent can be
 * destroyed and added again without fetching a byte.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pieceFromWholeFiles, pieceIsInWholeFiles } from "../services/files/piece-from-whole-file.js";

const PIECE = 16;

/**
 * Two files laid end to end, as a torrent lays them out, with a piece straddling
 * the boundary between them.
 *
 * @returns {Promise<{ root: string, files: object[], length: number, bytes: Buffer }>}
 */
async function twoFiles() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piece-of-whole-"));
  const first = Buffer.alloc(20, 1);
  const second = Buffer.alloc(24, 2);
  await fs.writeFile(path.join(root, "0"), first);
  await fs.writeFile(path.join(root, "1"), second);
  return {
    root,
    files: [
      { offset: 0, length: first.length },
      { offset: first.length, length: second.length }
    ],
    length: first.length + second.length,
    bytes: Buffer.concat([first, second])
  };
}

/**
 * @param {string} root
 * @param {number[]} whole - Which file indexes this proxy holds whole.
 * @returns {(fileIndex: number) => { path: string, length: number } | null}
 */
const holds = (root, whole) => (fileIndex) =>
  whole.includes(fileIndex) ? { path: path.join(root, String(fileIndex)), length: 0 } : null;

test("a piece inside one file comes back byte for byte", async () => {
  const { root, files, length, bytes } = await twoFiles();
  try {
    const piece = await pieceFromWholeFiles({
      index: 0,
      pieceLength: PIECE,
      length,
      files,
      wholeFileAt: holds(root, [0, 1])
    });
    assert.deepEqual(piece, bytes.subarray(0, PIECE));
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a piece straddling two files is stitched from both", async () => {
  const { root, files, length, bytes } = await twoFiles();
  try {
    // Piece 1 covers bytes 16..31: four from the first file, twelve from the
    // second.
    const piece = await pieceFromWholeFiles({
      index: 1,
      pieceLength: PIECE,
      length,
      files,
      wholeFileAt: holds(root, [0, 1])
    });
    assert.deepEqual(piece, bytes.subarray(PIECE, PIECE * 2));
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("the last piece is read to the end of the torrent and no further", async () => {
  const { root, files, length, bytes } = await twoFiles();
  try {
    // 44 bytes in pieces of 16: the last piece is 12 long.
    const piece = await pieceFromWholeFiles({
      index: 2,
      pieceLength: PIECE,
      length,
      files,
      wholeFileAt: holds(root, [0, 1])
    });
    assert.equal(piece.length, 12);
    assert.deepEqual(piece, bytes.subarray(32));
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a piece any part of which is not held whole is refused, not half read", async () => {
  const { root, files, length } = await twoFiles();
  try {
    // Only the first file is here; piece 1 straddles both. Half a piece is
    // worse than none: the layer above would hash it and mark it bad.
    const piece = await pieceFromWholeFiles({
      index: 1,
      pieceLength: PIECE,
      length,
      files,
      wholeFileAt: holds(root, [0])
    });
    assert.equal(piece, null);
    assert.equal(
      pieceIsInWholeFiles({ index: 1, pieceLength: PIECE, length, files, wholeFileAt: holds(root, [0]) }),
      false
    );
    // And one wholly inside the file that IS held is both readable and known to
    // be a duplicate of what is on the spill.
    assert.equal(
      pieceIsInWholeFiles({ index: 0, pieceLength: PIECE, length, files, wholeFileAt: holds(root, [0]) }),
      true
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});
