/**
 * @file The piece a run had open when it ended, and what proves one whole.
 *
 * `-segment_list pipe:3` was taken as proof: ffmpeg names a file when it closes
 * it, so a named file is closed. True of the FILE and false of the SPAN. The
 * highest-numbered file in a run's stretch is the one it had open, and how the
 * run ended decides what became of it — stopped with SIGTERM, ffmpeg writes it
 * out and names it exactly as it names a finished one; killed harder, or dying
 * on its own, it leaves the bytes it had written. All three outcomes decode,
 * and all three hold film only up to the instant the run ended.
 *
 * Field 2026-09-06, one session, both tracks: `segment-00010.mp4` held 3.92 s
 * of its declared 5.589 s (96 frames), and the picture jumped 1.5 s at 1:02;
 * the soundtrack's own stopped run left the same shape at 17.5 s, 2.8 s wide.
 * Judging such a file by whether it decodes answers yes, which is how both
 * reached the viewer.
 *
 * So what is kept is what the run PROVED it finished: the last piece it named
 * while it was still running normally.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "open-piece-"));
  for (let index = 0; index <= last; index += 1) {
    await writeFile(path.join(dir, `segment-${String(index).padStart(5, "0")}.mp4`), Buffer.alloc(64, 7));
  }
  return dir;
}

test("the piece written out on the way to being stopped goes, though it reads", async () => {
  // The field case: ffmpeg named #10 while shutting down, so #9 is the last it
  // proved. Everything decodes, and nothing about #10's contents betrays it.
  const dir = await runDirectory(10);
  try {
    const removed = await discardOpenPiece(
      dir, format, { from: 0, to: 535 }, () => true, "segment-00009.mp4"
    );
    assert.equal(removed, 10, "the open piece was kept because it decodes");
    const left = await readdir(dir);
    assert.ok(!left.includes("segment-00010.mp4"));
    assert.ok(left.includes("segment-00009.mp4"), "a piece the run proved was taken too");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a piece the run never named goes too, however it was killed", async () => {
  // Killed harder than SIGTERM, or dead on its own: the open piece is left
  // half-written and unnamed. It still decodes, and it is still short.
  const dir = await runDirectory(10);
  try {
    const removed = await discardOpenPiece(
      dir, format, { from: 0, to: 535 }, () => true, "segment-00009.mp4"
    );
    assert.equal(removed, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the piece the run proved finished stays", async () => {
  // A run stopped in the moment after closing #10 and before opening #11
  // proved #10. Removing it would mean encoding it a second time for nothing.
  const dir = await runDirectory(10);
  try {
    const removed = await discardOpenPiece(
      dir, format, { from: 0, to: 535 }, () => true, "segment-00010.mp4"
    );
    assert.equal(removed, null);
    assert.ok((await readdir(dir)).includes("segment-00010.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a run that proved nothing keeps nothing", async () => {
  const dir = await runDirectory(3);
  try {
    const removed = await discardOpenPiece(dir, format, { from: 0, to: 535 }, () => true, null);
    assert.equal(removed, 3, "a run that named nothing had its last piece believed");
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
      dir, format, { from: 0, to: 10 }, () => true, "segment-00009.mp4"
    );
    assert.equal(removed, 10);
    assert.ok((await readdir(dir)).includes("segment-00020.mp4"), "another run's piece was taken");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a run given no end never reaches past what it made, so a live run's piece is safe", async () => {
  // Field 2026-09-06. Three encoders wrote into one directory; the first was
  // stopped, its stretch was `#0..#-1` — "to the end of the track" — and the
  // cleanup after it took the highest-numbered file anywhere in that directory,
  // which a LIVE encoder had just finished. The number is spent for good,
  // because names only grow, and the picture stood still for 647 seconds.
  const dir = await mkdtemp(path.join(os.tmpdir(), "open-piece-"));
  // What the stopped run made: #0 and #1, with #2 left open.
  await writeFile(path.join(dir, "segment-00000.mp4"), Buffer.alloc(1000, 1));
  await writeFile(path.join(dir, "segment-00001.mp4"), Buffer.alloc(1000, 1));
  await writeFile(path.join(dir, "segment-00002.mp4"), Buffer.alloc(0));
  // What a live encoder, working further along the same track, has finished.
  await writeFile(path.join(dir, "segment-00040.mp4"), Buffer.alloc(9000, 1));

  const removed = await discardOpenPiece(
    dir,
    format,
    { from: 0, to: -1 },
    null,
    "segment-00001.mp4"
  );

  assert.equal(removed, 2, "its own open piece goes");
  assert.ok(existsSync(path.join(dir, "segment-00040.mp4")), "the live run's piece stays");
});

test("a run that named nothing leaves only its own first piece", async () => {
  // It opened one file and died — 548 ms after starting, in the field. Nothing
  // above that can be its.
  const dir = await mkdtemp(path.join(os.tmpdir(), "open-piece-"));
  await writeFile(path.join(dir, "segment-00010.mp4"), Buffer.alloc(0));
  await writeFile(path.join(dir, "segment-00011.mp4"), Buffer.alloc(9000, 1));

  const removed = await discardOpenPiece(dir, format, { from: 10, to: -1 }, null, null);

  assert.equal(removed, 10, "the one it opened");
  assert.ok(existsSync(path.join(dir, "segment-00011.mp4")), "and nothing beyond it");
});
