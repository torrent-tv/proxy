/**
 * @file Which files of a torrent somebody is using, for the sweep that writes
 * whole files out and removes a torrent that has nothing left to fetch.
 *
 * Two facts, and both are needed. A file somebody has stated a need for is in
 * use. So is a file being read: a read whose pieces are all here waits for
 * nothing, and so states nothing in the demand register. Field 2026-10-04: a
 * torrent was removed under such a read, ffmpeg's input ended with "Piece store
 * is closed" 277 MB in, and the copied picture lost 2.6 s that the readiness
 * forecast then refused as a timestamp gap (torrent-tv/meta#105).
 */

/** Claimants that keep pieces coming without anybody reading. */
const NOT_A_READER = ["file-edges:", "torrent-fill:", "background-fill:"];

/**
 * @param {object} options
 * @param {object} options.torrent
 * @param {Array<{ claimant: unknown, fileIndex: number }>} options.windows - The demand register's windows.
 * @param {Iterable<{ torrent: object, fileIndex: number }>} options.openReads - Reads in flight.
 * @returns {Set<number>} File indices in use.
 */
export function filesInUse({ torrent, windows, openReads }) {
  const used = new Set(
    windows
      .filter((window) => !NOT_A_READER.some((prefix) => String(window.claimant).startsWith(prefix)))
      .map((window) => window.fileIndex)
  );
  for (const read of openReads) {
    if (read.torrent === torrent) {
      used.add(read.fileIndex);
    }
  }
  return used;
}
