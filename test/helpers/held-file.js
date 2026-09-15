/**
 * @file A torrent reduced to what the subtitle walk may know about one file.
 *
 * Built from the REAL two functions the torrent thread answers with
 * (`torrent-worker/held-bytes.js`), so a check that walks cues exercises both
 * sides of the seam rather than a stand-in for one of them: the bitfield
 * becoming a list of ranges, and a range read that never fetches.
 */

import { heldRangesOf, readHeldBytes } from "../../services/torrent-worker/held-bytes.js";

/**
 * @param {object} torrent - The fake a check builds: `pieceLength`, `bitfield`,
 *   `files[]` with `offset`, `length`, `name`, `createReadStream`.
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @returns {import("../../services/media/SubtitleCues.js").HeldFile}
 */
export function heldFileOver(torrent, fileIndex, sourceKey) {
  const file = torrent?.files?.[fileIndex] ?? {};
  return {
    sourceKey,
    fileIndex,
    name: String(file.name ?? ""),
    length: Number(file.length) || 0,
    heldRanges: async () => heldRangesOf(torrent, fileIndex),
    readHeld: (start, end) => readHeldBytes(torrent, fileIndex, start, end)
  };
}
