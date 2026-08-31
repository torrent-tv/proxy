/**
 * Fetch a whole file that nobody is playing yet, using only the room the viewer
 * is not using.
 *
 * WHAT IT IS FOR. A release ships its dub and its subtitles as separate files,
 * and a viewer who switches to one waits for the swarm to deliver its first
 * pieces — 27.7 s in the field on 2026-08-31, which is longer than the switch is
 * willing to wait. These files are small beside the picture (30 MB against 566
 * MB, about a twentieth), so having them on disk before anyone asks turns every
 * later switch into a local read.
 *
 * THE ORDERING, WHICH IS THE WHOLE DESIGN. What plays now comes first: the
 * picture at the playhead, the soundtrack being heard, the subtitles being
 * shown. The other soundtracks and subtitle files come next. Reading the film
 * far ahead comes last. This module implements the middle tier, and it stays
 * below the first by a condition that is measured rather than chosen: it fetches
 * only while NO reader on the torrent is inside a wait. A reader blocked on a
 * piece is the viewer's own reading starving, and that is exactly the moment
 * this must not be asking the swarm for anything.
 *
 * WHY IT IS A READ AND NOT A SELECTION. `file.select()` claims every piece of a
 * file at once. `#syncSelections` in `torrent-pool.js` records what that cost
 * when it was done alongside the readers' own moving windows: a claim covering
 * everything always outranked the window, and a seek to 89.1 % of a 4.7 GB film
 * waited 93 s while the swarm fetched 2.47 GB in file order. So this walks the
 * file a piece at a time through an ordinary bounded read, which claims what it
 * is reading and gives it back.
 */

import { logger } from "../../utils/logger.js";
import { readersAreBlockedOn, stallsSeenOn } from "./piece-reader.js";

/**
 * How long to stand aside after finding the viewer's own reading blocked.
 *
 * Not a measurement of anything: it is how often the question "is the viewer
 * still starving?" is asked, and it is answered by the reader count, which is
 * exact. Short enough that room is used soon after it appears, long enough that
 * asking costs nothing.
 */
const STAND_ASIDE_MS = 1_000;

/** Files being filled, by `sourceKey:fileIndex`, so one runs per file. */
const running = new Map();

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function pause(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Read one byte range, letting the torrent fetch what is missing.
 *
 * @param {object} file
 * @param {number} start
 * @param {number} end - Inclusive.
 * @returns {Promise<number>} Bytes read; 0 on failure.
 */
function readRange(file, start, end) {
  return new Promise((resolve) => {
    let stream;
    try {
      stream = file.createReadStream({ start, end });
    } catch {
      resolve(0);
      return;
    }
    let bytes = 0;
    let settled = false;
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    stream.on("data", (chunk) => {
      bytes += chunk.length;
    });
    stream.on("end", () => settle(bytes));
    stream.on("error", () => {
      stream.destroy?.();
      settle(0);
    });
  });
}

/**
 * Fetch a file whole, in the room the viewer leaves.
 *
 * Returns as soon as the work is under way; the caller is not waiting for it.
 * One fill per file — a second request while one is running is ignored rather
 * than doubling the reads.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @param {{ chunkBytes?: number, isBlocked?: (infoHash: string) => boolean, stallsSeen?: (infoHash: string) => number }} [options]
 *   `isBlocked` answers "is the viewer's own reading starving right now"; it is
 *   the tier boundary, and it is a parameter so it can be exercised without a
 *   swarm.
 * @returns {boolean} Whether a fill was started by this call.
 */
export function fillFileInBackground(torrent, fileIndex, sourceKey, options = {}) {
  const key = `${sourceKey}:${fileIndex}`;
  if (running.has(key)) {
    return false;
  }
  const file = torrent?.files?.[fileIndex];
  if (!file || !Number.isFinite(file.length) || file.length <= 0) {
    return false;
  }
  // One piece at a time: the smallest unit the swarm actually delivers, so the
  // gap between two checks of "is the viewer starving?" is as short as it can
  // usefully be.
  const chunkBytes = Number.isFinite(options.chunkBytes) && options.chunkBytes > 0
    ? options.chunkBytes
    : (Number(torrent?.pieceLength) || 4 * 1024 * 1024);
  const isBlocked = typeof options.isBlocked === "function" ? options.isBlocked : readersAreBlockedOn;
  const stallsSeen = typeof options.stallsSeen === "function" ? options.stallsSeen : stallsSeenOn;
  const work = fill(torrent, file, fileIndex, chunkBytes, isBlocked, stallsSeen).finally(() => {
    running.delete(key);
  });
  running.set(key, work);
  return true;
}

/**
 * @param {object} torrent
 * @param {object} file
 * @param {number} fileIndex
 * @param {number} chunkBytes
 * @param {(infoHash: string) => boolean} isBlocked
 * @param {(infoHash: string) => number} stallsSeen
 * @returns {Promise<void>}
 */
async function fill(torrent, file, fileIndex, chunkBytes, isBlocked, stallsSeen) {
  const startedAt = Date.now();
  const infoHash = String(torrent?.infoHash ?? "");
  let read = 0;
  let stoodAsideMs = 0;
  // The stall count this fill last saw. A chunk is fetched only when it has not
  // moved since the previous one.
  let quietSince = stallsSeen(infoHash);
  logger.info(
    `background-fill: "${String(file.name).slice(0, 40)}" (${(file.length / 1e6).toFixed(1)}MB) will be ` +
      "fetched whole while the viewer's own reading leaves room"
  );
  for (let start = 0; start < file.length; start += chunkBytes) {
    // Stand aside while anything the viewer is watching is waiting on the
    // swarm — AND for as long after it as it takes for a quiet stretch to
    // pass. Pausing only DURING a stall is not enough: on a swarm delivering
    // exactly what the film needs, this still takes bandwidth between stalls,
    // and the stalls themselves are the proof there was none to spare. Field
    // 2026-08-31, the case that forced this: 200-600 KB/s delivered against
    // the 399 KB/s the film eats, one piece waited 101 s, and the picture
    // stood still 145.6 s.
    //
    // "A quiet stretch" is measured, not chosen: the stall counter must not
    // have moved while the previous chunk was being fetched. On a starving
    // swarm it moves constantly and this stops altogether, which is the right
    // answer — there is no spare room to use.
    while (isBlocked(infoHash) || stallsSeen(infoHash) !== quietSince) {
      stoodAsideMs += STAND_ASIDE_MS;
      await pause(STAND_ASIDE_MS);
      // Re-baselined after the pause, so a stretch that passes without a new
      // stall lets the fill go on. Without this it could never resume.
      quietSince = stallsSeen(infoHash);
    }
    // The torrent may have been destroyed under us — a viewer who left, the
    // disk sweep, a restart. Reading a destroyed file throws, and there is
    // nothing here worth an error.
    if (!torrent?.files?.[fileIndex]) {
      return;
    }
    // Taken BEFORE the read, and deliberately not refreshed after it: a stall
    // that happens while this chunk is in flight must still be visible to the
    // next iteration. Refreshing afterwards erased exactly that evidence, which
    // is the defect a test caught here.
    quietSince = stallsSeen(infoHash);
    const bytes = await readRange(file, start, Math.min(start + chunkBytes, file.length) - 1);
    if (bytes === 0) {
      logger.info(
        `background-fill: "${String(file.name).slice(0, 40)}" stopped at ` +
          `${(start / 1e6).toFixed(1)}MB — the read returned nothing`
      );
      return;
    }
    read += bytes;
  }
  logger.info(
    `background-fill: "${String(file.name).slice(0, 40)}" is on disk — ${(read / 1e6).toFixed(1)}MB in ` +
      `${((Date.now() - startedAt) / 1000).toFixed(0)}s, of which ${(stoodAsideMs / 1000).toFixed(0)}s ` +
      "was spent standing aside for the viewer; a switch to it will not wait for the swarm"
  );
}

/**
 * Whether a file is being filled right now. For tests and for the log.
 *
 * @param {string} sourceKey
 * @param {number} fileIndex
 * @returns {boolean}
 */
export function fillIsRunning(sourceKey, fileIndex) {
  return running.has(`${sourceKey}:${fileIndex}`);
}
