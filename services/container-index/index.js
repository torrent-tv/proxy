/**
 * @file Container keyframe index — where a file's real keyframes are, read
 * from the container's own tables rather than by scanning the media.
 *
 * The problem it solves: on the video-COPY path ffmpeg can only cut segments at
 * the source's existing keyframes. A playlist declaring an even grid instead is
 * then false, and players punish it — either walking the whole file to rebuild
 * the timeline, or presenting audio with no picture because a segment begins
 * with nothing decodable (both seen in the field 2026-08-02; the file measured
 * had 10.43 s keyframe spacing against our declared 4 s).
 *
 * Scanning for the answer is not an option here: the file is served from a
 * torrent, and a full packet scan of 5.5 GB found 77 keyframes in 45 s without
 * finishing. Containers already store the table — this reads it with a couple
 * of point reads (16 KB, 0.8 s for 570 keyframes on that same file).
 *
 * Transport-agnostic by construction: it takes a byte-range function and knows
 * nothing about torrents, HTTP or our session model, which is what let it be
 * verified standalone before being wired in.
 */

import { logger } from "../../utils/logger.js";
import { isMatroska, readMatroskaKeyframeTimes } from "./matroska.js";
import { isMp4, readMp4KeyframeTimes } from "./mp4.js";
import { isAvi, readAviKeyframeTimes } from "./avi.js";

/**
 * @callback ReadRange
 * @param {number} start - First byte, inclusive.
 * @param {number} end - Last byte, inclusive.
 * @returns {Promise<Buffer | null>} The bytes, or null when unavailable.
 */

// Enough to identify every supported container from its opening bytes.
const SNIFF_BYTES = 16;

/**
 * Container readers, in detection order. Each pairs a cheap magic-byte test
 * with the reader for that format.
 *
 * Formats deliberately absent, and why:
 *  - **MPEG-TS / M2TS** carry no index at all — the format is a continuous
 *    broadcast stream with no table of contents anywhere. Nothing to read.
 *  - **FLV / ASF-WMV** do have keyframe tables, but effectively never appear in
 *    the releases this serves; adding them is mechanical if that changes.
 *  - **Fragmented MP4** spreads its timing across fragments instead of a single
 *    `moov` table; `readMp4KeyframeTimes` returns null for it rather than
 *    guessing.
 *
 * @type {{ name: string, matches: (head: Buffer) => boolean, read: ReadRange extends never ? never : (readRange: ReadRange, fileSize: number) => Promise<number[] | null> }[]}
 */
const READERS = [
  { name: "matroska", matches: isMatroska, read: readMatroskaKeyframeTimes },
  { name: "mp4", matches: isMp4, read: readMp4KeyframeTimes },
  { name: "avi", matches: isAvi, read: readAviKeyframeTimes }
];

/**
 * Read a file's keyframe times from its container index.
 *
 * @param {object} params
 * @param {ReadRange} params.readRange
 * @param {number} params.fileSize
 * @param {string} [params.label] - For logging only.
 * @returns {Promise<{ times: number[] | null, format: string }>} Ascending
 *   seconds, or null times when this file has no readable index — the caller
 *   must then not claim to know the grid. The format is which reader matched,
 *   reported whether or not it produced anything: how often an index disagrees
 *   with its own file is a question about the CONTAINER, and it cannot be
 *   answered by a measurement that does not say which one it came from.
 */
export async function readKeyframeIndex({ readRange, fileSize, label = "" }) {
  if (typeof readRange !== "function" || !Number.isFinite(fileSize) || fileSize <= 0) {
    return { times: null, format: "unknown" };
  }

  const startedAt = Date.now();
  let times = null;
  let format = "unrecognised";
  try {
    const sniff = await readRange(0, Math.min(SNIFF_BYTES - 1, fileSize - 1));
    if (!sniff) {
      return { times: null, format: "unread" };
    }
    const reader = READERS.find((candidate) => candidate.matches(sniff));
    if (reader) {
      format = reader.name;
      times = await reader.read(readRange, fileSize);
    }
  } catch (error) {
    // A malformed or partially-downloaded index must never take playback down —
    // it only means the grid is unknown, which the caller already handles.
    logger.warn(`container-index: failed to read index for "${label}": ${error?.message ?? error}`);
    return { times: null, format };
  }

  const elapsedMs = Date.now() - startedAt;
  if (times) {
    logger.info(
      `container-index: ${times.length} keyframes from the ${format} index in ${elapsedMs}ms for "${label}"`
    );
  } else {
    logger.info(`container-index: no usable index for "${label}" (${format}, ${elapsedMs}ms)`);
  }
  return { times, format };
}
