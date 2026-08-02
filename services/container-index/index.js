/**
 * @file Container keyframe index — where a file's real keyframes are, read
 * from the container's own tables rather than by scanning the media.
 *
 * The problem it solves: on the video-COPY path ffmpeg can only cut segments at
 * the source's existing keyframes. If our playlist declares an even grid
 * instead, the declared times do not match the media, and players respond by
 * either walking the whole file to rebuild the timeline or showing audio with
 * no picture (both seen in the field 2026-08-02). Getting those positions by
 * decoding is not an option here — the file is served from a torrent, and a
 * full packet scan of 5.5 GB found 77 keyframes in 45 s without finishing.
 *
 * Containers already store this. The reader takes a byte-range function and
 * does a couple of point reads, so it works over any transport and knows
 * nothing about torrents, HTTP or our session model.
 *
 * Format support is deliberately partial: a container we cannot index returns
 * null, and the caller falls back (re-encode with forced keyframes, which is
 * what Jellyfin, hls-media-server and hls-vod-too all do unconditionally).
 */

import { logger } from "../../utils/logger.js";
import { isMatroska, readMatroskaKeyframeTimes } from "./matroska.js";

/**
 * @callback ReadRange
 * @param {number} start - First byte, inclusive.
 * @param {number} end - Last byte, inclusive.
 * @returns {Promise<Buffer | null>} The bytes, or null when unavailable.
 */

// Enough to identify any supported container from its magic bytes.
const SNIFF_BYTES = 16;

/**
 * Read a file's keyframe times from its container index.
 *
 * @param {object} params
 * @param {ReadRange} params.readRange
 * @param {number} params.fileSize
 * @param {string} [params.label] - For logging only.
 * @returns {Promise<number[] | null>} Ascending seconds, or null when this file
 *   has no readable index — the caller must then not claim to know the grid.
 */
export async function readKeyframeIndex({ readRange, fileSize, label = "" }) {
  if (typeof readRange !== "function" || !Number.isFinite(fileSize) || fileSize <= 0) {
    return null;
  }

  const startedAt = Date.now();
  let times = null;
  try {
    const sniff = await readRange(0, Math.min(SNIFF_BYTES - 1, fileSize - 1));
    if (!sniff) {
      return null;
    }
    if (isMatroska(sniff)) {
      times = await readMatroskaKeyframeTimes(readRange, fileSize);
    }
    // Other containers fall through as null until their readers land; MP4's
    // sync-sample table and AVI's index are the next candidates.
  } catch (error) {
    // A malformed or partially-downloaded index must never take playback down —
    // it only means we do not know the grid, which the caller handles.
    logger.warn(`container-index: failed to read index for "${label}": ${error?.message ?? error}`);
    return null;
  }

  const elapsedMs = Date.now() - startedAt;
  if (times) {
    logger.info(`container-index: ${times.length} keyframes from the container index in ${elapsedMs}ms for "${label}"`);
  } else {
    logger.info(`container-index: no usable index for "${label}" (${elapsedMs}ms)`);
  }
  return times;
}
