/**
 * @file Fetching the region under a viewer's resume position.
 *
 * All that is left of a file that used to read containers here as well. The
 * parsing moved to the main thread on 2026-09-15: a container is built from one
 * function, `readRange(start, end)`, the pieces behind it live in shared memory,
 * and the reason it had been put here — "the main thread cannot open a read
 * stream on one of its files" — was true of WebTorrent's own API and not of the
 * bytes. Three commands, a second `ContainerOrchestrator` in this thread, and
 * every answer carried back over the channel went with it.
 *
 * What stays is the part that really is the torrent's: turning a position in
 * seconds into a byte offset and pulling that region off the swarm. How long
 * the file runs is TOLD to it, because that is what the file states about
 * itself and this thread no longer reads such things.
 */

import { logger } from "../../utils/logger.js";










/**
 * How much of the file to pull in under the viewer's resume position.
 *
 * One piece of a video torrent is 4-16 MB and a resume lands anywhere inside
 * one, so anything smaller would still leave the encoder waiting for the piece
 * it starts in. Eight megabytes covers that piece and usually the next.
 */
const RESUME_REGION_BYTES = 8 * 1024 * 1024;

/**
 * Where a position in seconds falls in a file, in bytes.
 *
 * Proportional, and therefore approximate on a variable bitrate — which is what
 * it is for: a prefetch that puts the swarm to work on roughly the right place
 * while the plan and the session are still being built. The encoder's own read
 * asks for the exact bytes a moment later and corrects it.
 *
 * A position past the end is clamped to the end rather than refused: a resume
 * position can outlive the file it was recorded against, and reading the last
 * bytes is harmless where reading past them is an error.
 *
 * @param {number} fileLength
 * @param {number} durationSeconds
 * @param {number} positionSeconds
 * @returns {number}
 */
export function resumeByteOffset(fileLength, durationSeconds, positionSeconds) {
  if (!(fileLength > 0) || !(durationSeconds > 0) || !(positionSeconds > 0)) {
    return 0;
  }
  const within = Math.min(positionSeconds, durationSeconds);
  return Math.min(fileLength - 1, Math.floor((fileLength * within) / durationSeconds));
}

/**
 * Start fetching the region a viewer is about to resume at.
 *
 * Where that region IS can only be worked out from two numbers the file itself
 * holds — its length and its duration — so this belongs beside the container
 * read rather than in the route: the route knows a position in seconds and
 * nothing else. The conversion is proportional and therefore approximate on a
 * variable bitrate; it is a prefetch, and the encoder's own read corrects it.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @param {number} positionSeconds
 * @param {{ prefetchEdges?: () => Promise<unknown>, fetchRegion?: (start: number, bytes: number) => Promise<unknown> }} options
 * @returns {Promise<boolean>} Whether a region was asked for.
 */
export async function warmResumePosition(torrent, fileIndex, sourceKey, positionSeconds, options = {}) {
  const file = torrent?.files?.[fileIndex];
  if (!file || !(positionSeconds > 0) || typeof options.fetchRegion !== "function") {
    return false;
  }
  // TOLD, not worked out here. How long a file runs is what the file states
  // about itself, and that is read on the main thread now; this one turns a
  // position into a byte offset and fetches the region under it, which is all
  // of the job that is actually the torrent's.
  const duration = Number(options.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    logger.info(
      `warm ${sourceKey.slice(0, 8)}: "${String(file.name).slice(0, 40)}" does not declare its ` +
      "duration, so where the viewer's position falls in it cannot be worked out — " +
      "the region under it is left to the encoder's own read"
    );
    return false;
  }
  const at = resumeByteOffset(file.length, duration, positionSeconds);
  logger.info(
    `warm ${sourceKey.slice(0, 8)}: fetching ${(RESUME_REGION_BYTES / (1024 * 1024)).toFixed(0)}MB under the ` +
    `viewer's position ${positionSeconds.toFixed(1)}s of ${duration.toFixed(1)}s, which is ` +
    `${(at / (1024 * 1024)).toFixed(1)}MB into "${String(file.name).slice(0, 40)}"`
  );
  await options.fetchRegion(at, RESUME_REGION_BYTES);
  return true;
}


