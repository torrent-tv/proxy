/**
 * @file What this proxy would cut a file at, read from a real torrent.
 *
 * The keyframe readers take two short ranged reads, so the index of a 7 GB film
 * can be examined over the swarm in seconds without downloading it. Run against
 * a `.torrent` file to see what the container's own table says, per track, and
 * what the reader hands to the cut list.
 *
 *   node scripts/read-container-index.mjs path/to/film.torrent [more.torrent …]
 *
 * Developer tool: nothing here runs in a session, and no viewer is involved.
 */

import fs from "node:fs";
import path from "node:path";
import MemoryChunkStore from "memory-chunk-store";
import WebTorrent from "webtorrent";
import { readMatroskaKeyframeTimes } from "../services/container-index/matroska.js";
import { readMp4KeyframeTimes } from "../services/container-index/mp4.js";
import { readAviKeyframeTimes } from "../services/container-index/avi.js";

const torrents = process.argv.slice(2);
if (torrents.length === 0) {
  console.error("usage: node scripts/read-container-index.mjs <file.torrent> [...]");
  process.exit(1);
}

/**
 * Collect one byte range of a torrent file.
 *
 * @param {import("webtorrent").TorrentFile} file
 * @param {number} start
 * @param {number} end - Inclusive.
 * @returns {Promise<Buffer>}
 */
function readRangeOf(file, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = file.createReadStream({ start, end });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * Say what a set of times looks like: how many, where it starts, how far apart.
 *
 * @param {string} label
 * @param {number[] | null} times
 * @returns {void}
 */
function describe(label, times) {
  if (!times || times.length === 0) {
    console.log(`${label}: no index`);
    return;
  }
  const gaps = times.slice(1).map((time, index) => time - times[index]).sort((left, right) => left - right);
  const median = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 0;
  console.log(
    `${label}: ${times.length} times, first ${times.slice(0, 4).map((time) => time.toFixed(3)).join(" ")}, ` +
    `median gap ${median.toFixed(3)}s, last ${times[times.length - 1].toFixed(3)}`
  );
}

for (const torrentPath of torrents) {
  // uTP is off: binding its socket needs a permission this does not have on
  // every developer machine, and TCP peers are enough to read an index.
  const client = new WebTorrent({ utp: false });
  console.log(`\n=== ${path.basename(torrentPath)} ===`);
  await new Promise((resolve) => {
    // In memory, deliberately. The file store creates the whole file on disk at
    // its full length before a byte of it is wanted — reading the index of four
    // films that way filled 34 GB and then failed with the disk full. Only two
    // short ranges are ever read here, so they can simply be held.
    client.add(fs.readFileSync(torrentPath), { store: MemoryChunkStore }, async (torrent) => {
      try {
        // Nothing is wanted up front; the ranged reads below select what they need.
        torrent.deselect(0, torrent.pieces.length - 1, 0);
        const file = torrent.files
          .filter((candidate) => /\.(mkv|mp4|avi)$/i.test(candidate.name))
          .sort((left, right) => right.length - left.length)[0];
        if (!file) {
          console.log("no video file in this torrent");
          return resolve();
        }
        console.log(`file: ${file.name} (${(file.length / 1e9).toFixed(2)} GB)`);
        const readRange = async (start, end) => {
          const last = Math.min(end, file.length - 1);
          return start > last ? null : readRangeOf(file, start, last);
        };
        if (/\.mkv$/i.test(file.name)) {
          describe("matroska", await readMatroskaKeyframeTimes(readRange, file.length));
        } else if (/\.mp4$/i.test(file.name)) {
          describe("mp4", await readMp4KeyframeTimes(readRange, file.length));
        } else {
          describe("avi", await readAviKeyframeTimes(readRange, file.length));
        }
      } catch (error) {
        console.log(`failed: ${error?.message ?? error}`);
      } finally {
        resolve();
      }
    });
  });
  await new Promise((done) => client.destroy(done));
}
process.exit(0);
