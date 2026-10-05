/**
 * @file A torrent reduced to what the subtitle walk may know about one file.
 *
 * Built from the REAL two functions the torrent thread answers with
 * (`torrent/worker/held-bytes.js`), so a check that walks cues exercises both
 * sides of the seam rather than a stand-in for one of them: the bitfield
 * becoming a list of ranges, and a range read that never fetches.
 *
 * The file's container is the one a `ContainerOrchestrator` builds, over a
 * reader that FETCHES — the fake file's own stream, which serves any range —
 * because the head and the Cues table are read that way in the product.
 */

import { heldRangesOf, readHeldBytes } from "../../../services/torrent/worker/held-bytes.js";
import { ContainerOrchestrator } from "../../../services/media/ContainerOrchestrator.js";

/**
 * Every byte of a range from the fake file's stream.
 *
 * @param {object} file
 * @param {number} start
 * @param {number} end
 * @returns {Promise<Buffer>}
 */
async function readThroughStream(file, start, end) {
  const chunks = [];
  for await (const chunk of file.createReadStream({ start, end })) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** One orchestrator for the checks that do not bring their own. */
const sharedContainers = new ContainerOrchestrator();

/**
 * @param {object} torrent - The fake a check builds: `pieceLength`, `bitfield`,
 *   `files[]` with `offset`, `length`, `name`, `createReadStream`.
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @param {{ containers?: ContainerOrchestrator, readRange?: (start: number, end: number) => Promise<Buffer | null>, wantedSeconds?: () => number[], portionBytes?: number }} [options]
 * @returns {import("../../../services/media/SubtitleCues.js").HeldFile}
 */
export function heldFileOver(torrent, fileIndex, sourceKey, options = {}) {
  const file = torrent?.files?.[fileIndex] ?? {};
  // This fake storage serves the prepared file bytes without a torrent client.
  // Production reads storage directly; streams here only expose the test data.
  if (!torrent.store) {
    torrent.store = {
      protectedRanges: () => [],
      locationOf: (index) => torrent.bitfield.get(index) ? "memory" : "missing",
      holdAvailable: (indexes) => indexes.every((index) => torrent.bitfield.get(index)) ? () => {} : null,
      get(index, { offset, length }, callback) {
        const from = index * torrent.pieceLength + offset;
        const to = from + length - 1;
        const read = async () => {
          const chunks = [];
          for (const item of torrent.files) {
            const start = Math.max(from, item.offset);
            const end = Math.min(to, item.offset + item.length - 1);
            if (end >= start) chunks.push(await readThroughStream(item, start - item.offset, end - item.offset));
          }
          return Buffer.concat(chunks);
        };
        read().then((bytes) => callback(null, bytes), (error) => callback(error));
      }
    };
  }
  const containers = options.containers ?? sharedContainers;
  const readRange = options.readRange ?? ((start, end) => readThroughStream(file, start, end));
  return {
    sourceKey,
    fileIndex,
    name: String(file.name ?? ""),
    length: Number(file.length) || 0,
    portionBytes: options.portionBytes,
    container: () =>
      containers.containerFor({
        sourceKey,
        fileIndex,
        readRange,
        fileSize: Number(file.length) || 0,
        label: String(file.name ?? ""),
        portionBytes: options.portionBytes
      }),
    heldRanges: async () => heldRangesOf(torrent, fileIndex),
    readHeld: (start, end) => readHeldBytes(torrent, fileIndex, start, end),
    wantedSeconds: options.wantedSeconds
  };
}

/**
 * Forget what the shared orchestrator built for a source.
 *
 * @param {string} sourceKey
 * @returns {void}
 */
export function forgetContainers(sourceKey) {
  sharedContainers.forget(sourceKey);
}
