/**
 * @file The piece an encoder writes out on its way to being stopped.
 *
 * `-segment_list pipe:3` was taken as proof that a piece is whole: ffmpeg names
 * a file when it closes it, so a named file is closed. True of the FILE and
 * false of the SPAN. On SIGTERM ffmpeg writes out the piece it had open and
 * names it like any other, so the result is a valid, decodable piece holding
 * film only up to the instant of the stop — under a name whose playlist entry
 * promises the whole span.
 *
 * Field 2026-09-06, one session, both tracks: `segment-00010.mp4` held 3.92 s
 * of its declared 5.589 s (96 frames), and the picture jumped 1.5 s at 1:02;
 * the soundtrack's own stopped run left the same shape at 17.5 s, 2.8 s wide.
 * Judging such a file by whether it decodes answers yes, which is how both
 * reached the viewer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discardOpenPiece } from "../services/encode/open-piece.js";

const format = {
  isSegmentFileName: (name) => /^segment-\d{5}\.mp4$/.test(name),
  segmentIndexFromName: (name) => Number(name.slice(8, 13))
};

/** A run directory holding pieces 0..last, every one of them readable. */
async function runDirectory(last) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flushed-piece-"));
  for (let index = 0; index <= last; index += 1) {
    await writeFile(path.join(dir, `segment-${String(index).padStart(5, "0")}.mp4`), Buffer.alloc(64, 7));
  }
  return dir;
}

test("the piece named on the way out goes, though it reads perfectly", async () => {
  const dir = await runDirectory(10);
  try {
    const removed = await discardOpenPiece(
      dir,
      format,
      { from: 0, to: 535 },
      // Everything decodes. This is the field case exactly: the short piece is
      // a valid fMP4 and nothing about its contents betrays it.
      () => true,
      "segment-00010.mp4"
    );
    assert.equal(removed, 10, "the flushed piece was kept because it decodes");
    const left = await readdir(dir);
    assert.ok(!left.includes("segment-00010.mp4"));
    assert.ok(left.includes("segment-00009.mp4"), "a piece closed before the stop was taken too");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a run that named nothing on the way out loses no readable piece", async () => {
  // A run that reached the end of its stretch closed its last file properly.
  // Removing it would mean encoding it a second time for nothing.
  const dir = await runDirectory(10);
  try {
    const removed = await discardOpenPiece(dir, format, { from: 0, to: 535 }, () => true, null);
    assert.equal(removed, null);
    assert.ok((await readdir(dir)).includes("segment-00010.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a piece that does not read still goes, named or not", async () => {
  const dir = await runDirectory(10);
  try {
    const removed = await discardOpenPiece(dir, format, { from: 0, to: 535 }, () => false, null);
    assert.equal(removed, 10, "an unreadable last piece survived");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only inside the stretch the ended run was given", async () => {
  // Several runs write into one directory, kept apart by their intervals. The
  // highest file overall may belong to a run that is still going.
  const dir = await runDirectory(20);
  try {
    const removed = await discardOpenPiece(
      dir, format, { from: 0, to: 10 }, () => true, "segment-00010.mp4"
    );
    assert.equal(removed, 10);
    assert.ok((await readdir(dir)).includes("segment-00020.mp4"), "another run's piece was taken");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a name from another run's stretch takes nothing", async () => {
  const dir = await runDirectory(20);
  try {
    const removed = await discardOpenPiece(
      dir, format, { from: 0, to: 10 }, () => true, "segment-00020.mp4"
    );
    assert.equal(removed, null, "a name outside the stretch removed a piece anyway");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
