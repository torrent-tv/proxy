/**
 * @file The piece a run had open when it ended.
 *
 * A fact of a run's output directory, and therefore of the encoding layer. It
 * lived in the eleven-thousand-line file that is being taken apart, where it was
 * called by the one place that killed a run; stopping is decided in one place
 * now and carried out in another, so the cleanup belongs to the layer that owns
 * the directories rather than to whoever happened to do the killing.
 */

import { readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Remove the piece a run had open when it ended, if that piece is unusable.
 *
 * The `segment` muxer creates its output file when it OPENS it and writes into
 * it until the next cut, so at any instant exactly one file in a run's
 * directory is unfinished: the highest-numbered one. A run that reaches the end
 * of its work closes that file and it is a good piece; a run killed for a seek
 * does not — measured 2026-09-03, ffmpeg exited 19 ms after SIGTERM and left
 * `segment-00025.mp4` at zero bytes, which then closed the only hole in the
 * numbering and convinced the look-ahead to keep the encoder stopped for having
 * "produced" it.
 *
 * Only an unusable piece goes. A run stopped between two cuts leaves a finished
 * file behind, and deleting good output would mean making it a second time.
 *
 * @param {string | null | undefined} runDirPath
 * @param {{ isSegmentFileName: (name: string) => boolean, segmentIndexFromName: (name: string) => number }} segmentFormat
 * @param {((raw: Buffer) => boolean) | null} judgeUsable - Whether a non-empty
 *   piece carries what it should. Null where nothing can say, and then only an
 *   empty file is removed.
 * @returns {Promise<number | null>} The segment number removed, or null.
 */
export async function discardOpenPiece(runDirPath, segmentFormat, within, judgeUsable) {
  if (!runDirPath || typeof segmentFormat?.isSegmentFileName !== "function") {
    return null;
  }
  // Only inside the stretch the ended run was given. Every run of an output
  // writes into one directory now — they are kept apart by their intervals
  // rather than by a directory each — so the highest-numbered file in there may
  // belong to a run that is still going, and removing it would take away a
  // piece somebody is producing.
  const from = Number.isInteger(within?.from) ? within.from : 0;
  const to = Number.isInteger(within?.to) && within.to >= from ? within.to : Number.MAX_SAFE_INTEGER;
  let highest = null;
  try {
    for (const name of await readdir(runDirPath)) {
      if (!segmentFormat.isSegmentFileName(name)) {
        continue;
      }
      const index = segmentFormat.segmentIndexFromName(name);
      if (index < from || index > to) {
        continue;
      }
      if (index >= 0 && (highest === null || index > highest.index)) {
        highest = { index, name };
      }
    }
  } catch {
    return null; // The run wrote nothing, or its directory is already gone.
  }
  if (highest === null) {
    return null;
  }
  const filePath = path.join(runDirPath, highest.name);
  let unusable = false;
  try {
    const info = await stat(filePath);
    if (info.size === 0) {
      unusable = true;
    } else if (typeof judgeUsable === "function") {
      unusable = !judgeUsable(await readFile(filePath));
    }
  } catch {
    return null; // Gone between the listing and the question.
  }
  if (!unusable) {
    return null;
  }
  try {
    await unlink(filePath);
    return highest.index;
  } catch {
    return null; // Already removed.
  }
}
