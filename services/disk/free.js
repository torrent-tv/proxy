/**
 * @file How much room the disk holding a directory has.
 *
 * Separate from the plain `statfs` reading because of one case that is the
 * normal one, not an edge: the directory may not exist yet. The segments live
 * under `os.tmpdir()/torrent-tv-hls`, which is made when the first session is
 * created and removed when the proxy stops — so at every start, and after every
 * clean exit, `statfs` on it fails. Field 2026-09-10: the first reading said
 * `disk: 0MB free` on a host with 103 GB, and zero means "no room" to everything
 * that reads it.
 *
 * The disk is the same disk whether or not that directory has been made yet, so
 * the answer is the nearest ancestor that exists.
 */

import { statfs } from "node:fs/promises";
import path from "node:path";

/**
 * @param {string} directory
 * @returns {Promise<number | null>} Bytes free, or null where nothing answered.
 */
export async function freeBytesFor(directory) {
  let at = path.resolve(directory);
  for (let depth = 0; depth < 16; depth += 1) {
    try {
      const stats = await statfs(at);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      const up = path.dirname(at);
      if (up === at) {
        return null;
      }
      at = up;
    }
  }
  return null;
}
