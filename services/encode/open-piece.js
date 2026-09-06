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
 * **A piece is whole only if the run PROVED it, and reading it proves nothing.**
 *
 * The highest-numbered file in a run's stretch is the one it had open. How a
 * run ends decides what became of that file, and all three outcomes leave it
 * readable-looking: stopped with SIGTERM, ffmpeg writes it out and names it on
 * the ready channel exactly as it names a finished one; killed harder, or dying
 * on its own, it leaves the bytes it had written with no name at all. In every
 * case the file decodes and holds film only up to the instant the run ended,
 * under a number whose playlist entry promises a whole span. Field 2026-09-06:
 * `segment-00010.mp4` held 3.92 s of its declared 5.589 s — 96 frames — and the
 * picture jumped 1.5 s at 1:02; the soundtrack did the same at 17.5 s, 2.8 s
 * wide, in the same session. Both decoded, which is how both reached the viewer.
 *
 * So the question asked here is not what the file contains but whether the run
 * named it while it was still running normally. That is a fact the run holds,
 * so there is no span to measure and no tolerance to choose.
 *
 * A piece finished in the moment between the last such name and the end is
 * then made a second time. That is the cheaper error: the other is a hole the
 * viewer sees.
 *
 * @param {string | null | undefined} runDirPath
 * @param {{ isSegmentFileName: (name: string) => boolean, segmentIndexFromName: (name: string) => number }} segmentFormat
 * @param {((raw: Buffer) => boolean) | null} judgeUsable - Whether a non-empty
 *   piece carries what it should. Null where nothing can say, and then only an
 *   empty file is removed.
 * @param {string | null} [provenName] - The last piece the run named while it
 *   was running normally. A file beyond it was open when the run ended and goes
 *   whether or not it reads. Null where the run proved nothing, and then every
 *   piece it left is unproven.
 * @returns {Promise<number | null>} The segment number removed, or null.
 */
export async function discardOpenPiece(runDirPath, segmentFormat, within, judgeUsable, provenName = null) {
  if (!runDirPath || typeof segmentFormat?.isSegmentFileName !== "function") {
    return null;
  }
  // Only inside the stretch the ended run was given. Every run of an output
  // writes into one directory now — they are kept apart by their intervals
  // rather than by a directory each — so the highest-numbered file in there may
  // belong to a run that is still going, and removing it would take away a
  // piece somebody is producing.
  const from = Number.isInteger(within?.from) ? within.from : 0;
  // THE RUN'S OWN REACH, which is a fact it holds and needs nothing measured.
  //
  // A run cannot have opened a file above the one just past the last it named:
  // ffmpeg names a piece when it closes it and opens the next, so the open piece
  // is at most `proven + 1`, and where it named nothing at all the open one is
  // the first it was given.
  //
  // Used only where no end was declared — `to` below `from`, which is how "to
  // the end of the track" is written everywhere here. Such a run had no bound at
  // all: the search covered the whole directory and took the highest-numbered
  // file in it. Every run of an output writes into that one
  // directory, so what it took was a piece a LIVE run had just finished. Field
  // 2026-09-06: the piece holding 2:47-2:57 went that way, its number is spent
  // for good because names only grow, and the picture stood still for 647 s.
  const provenIndex = typeof provenName === "string" && segmentFormat.isSegmentFileName(provenName)
    ? segmentFormat.segmentIndexFromName(provenName)
    : null;
  const reach = Number.isInteger(provenIndex) && provenIndex >= from ? provenIndex + 1 : from;
  // The declared end is the bound wherever there is one. The run's own reach is
  // the bound of LAST RESORT, for a run given none: before it, such a run had no
  // bound at all and the search covered the whole directory.
  const to = Number.isInteger(within?.to) && within.to >= from ? within.to : reach;
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
  // Proven finished only if the run said so while it was running. Anything
  // beyond that name was open when the run ended, and its contents cannot say
  // so — it decodes.
  const proven = typeof provenName === "string" && provenName === highest.name;
  let unusable = !proven;
  try {
    const info = await stat(filePath);
    if (info.size === 0) {
      unusable = true;
    } else if (!unusable && typeof judgeUsable === "function") {
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
