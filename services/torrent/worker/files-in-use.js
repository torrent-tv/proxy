/**
 * @file Which files of a torrent somebody is using, for the sweep that writes
 * whole files out and removes a torrent that has nothing left to fetch, and
 * the two decisions that sweep makes with it.
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

/**
 * Which downloaded files to write out whole now.
 *
 * WHILE SOMEBODY WATCHES IT, and only then (user, 2026-10-09,
 * torrent-tv/meta#173): as soon as a media file is downloaded it becomes a file
 * and is read from that file. Written after its last viewer has left, it serves
 * nobody — field 2026-10-09: a film re-encoded at 0.56x reached 100 % while it
 * played, stayed 667 spilled pieces for the whole showing because the encoder
 * read it without a pause, and was written a minute after the tab closed.
 *
 * @param {object} options
 * @param {Array<{ done?: boolean }>} options.files - The torrent's files.
 * @param {(fileIndex: number) => boolean} options.isKept - Already a file, or being written.
 * @param {Set<number>} options.inUse - {@link filesInUse}.
 * @returns {number[]} File indices.
 */
export function filesToKeep({ files, isKept, inUse }) {
  const indices = [];
  for (const [fileIndex, file] of files.entries()) {
    if (file?.done === true && inUse.has(fileIndex) && !isKept(fileIndex)) {
      indices.push(fileIndex);
    }
  }
  return indices;
}

/**
 * Whether a torrent downloaded whole may be removed now.
 *
 * Every file of it is a file on disk, so a viewer's stated need is answered
 * from those files and does not keep the torrent (torrent-tv/meta#173). A read
 * still running on the piece store does, because removing the torrent closes
 * that store under it (torrent-tv/meta#105). Nor in the sweep that announced a
 * file: the main thread learns of it from that announcement, and a read it
 * sent to this thread before then would find the torrent gone.
 *
 * @param {object} options
 * @param {object} options.torrent
 * @param {(fileIndex: number) => boolean} options.isKept - Already a file.
 * @param {Iterable<{ torrent: object, fileIndex: number }>} options.openReads - Reads in flight, read just now.
 * @param {boolean} options.announcedNow - A file of it was announced in this sweep.
 * @returns {boolean}
 */
export function mayRemoveWholeTorrent({ torrent, isKept, openReads, announcedNow }) {
  if (torrent?.done !== true || !Array.isArray(torrent.files) || announcedNow) {
    return false;
  }
  if (!torrent.files.every((unused, fileIndex) => isKept(fileIndex))) {
    return false;
  }
  return filesInUse({ torrent, windows: [], openReads }).size === 0;
}

/** Range admission owns its read before any asynchronous storage operation. */
export async function readWhileInUse(openReads, id, torrent, fileIndex, read) {
  if (!torrent) return read();
  const entry = { torrent, fileIndex };
  openReads.set(id, entry);
  try { return await read(); }
  finally { if (openReads.get(id) === entry) openReads.delete(id); }
}
