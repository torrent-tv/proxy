/**
 * @file Reading one piece of a torrent out of the files it has already been
 * assembled into.
 *
 * THE KEYSTONE OF KEEPING WHOLE FILES AT ALL. Without it a whole file is a
 * second copy of bytes the piece store is also holding, and neither copy can be
 * dropped: the store cannot drop its own because it is what every piece read
 * goes to, and the file cannot be dropped because it is what a torrent-free read
 * goes to. With it the store has a place to fall back to, so
 *
 *   1. the spilled copy of a whole file is redundant and can go — the film stops
 *      being on the disk twice, which on the field host of 2026-09-11 was
 *      1417 MB of segments plus 1424 MB of spilled pieces for one episode;
 *   2. the torrent can be destroyed with its store and added again later
 *      without fetching a byte: what it verifies, it reads from here.
 *
 * A piece is a byte range of the torrent, and the torrent's files are laid end
 * to end in that same space — so a piece belongs to one file, or straddles the
 * boundary between two. Both cases are the same walk.
 */

import fs from "node:fs/promises";

/**
 * Read one piece out of whole files, or answer null.
 *
 * Null when any part of the piece is in a file this proxy does not hold whole:
 * a piece half read is worse than a piece not read, because the layer above
 * would hash it and mark the piece bad.
 *
 * @param {object} params
 * @param {number} params.index - The piece.
 * @param {number} params.pieceLength - Every piece but the last is this long.
 * @param {number} params.length - What the whole torrent weighs.
 * @param {Array<{ offset: number, length: number }>} params.files - The
 *   torrent's files in order, as it lays them out.
 * @param {(fileIndex: number) => { path: string, length: number } | null} params.wholeFileAt
 * @returns {Promise<Buffer | null>}
 */
export async function pieceFromWholeFiles({ index, pieceLength, length, files, wholeFileAt }) {
  if (!Array.isArray(files) || files.length === 0 || !(pieceLength > 0)) {
    return null;
  }
  const pieceStart = index * pieceLength;
  const pieceEnd = Math.min(pieceStart + pieceLength, length) - 1;
  if (pieceStart > pieceEnd) {
    return null;
  }
  const piece = Buffer.allocUnsafe(pieceEnd - pieceStart + 1);
  let filled = 0;
  for (const [fileIndex, file] of files.entries()) {
    const fileStart = Number(file?.offset ?? 0);
    const fileEnd = fileStart + Number(file?.length ?? 0) - 1;
    const from = Math.max(pieceStart, fileStart);
    const to = Math.min(pieceEnd, fileEnd);
    if (from > to) {
      continue;
    }
    const whole = wholeFileAt(fileIndex);
    if (!whole) {
      // Part of this piece is in a file this proxy does not hold whole.
      return null;
    }
    let handle = null;
    try {
      handle = await fs.open(whole.path, "r");
      const { bytesRead } = await handle.read(piece, from - pieceStart, to - from + 1, from - fileStart);
      if (bytesRead !== to - from + 1) {
        return null;
      }
      filled += bytesRead;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return filled === piece.length ? piece : null;
}

/**
 * Whether every byte of one piece is in files this proxy holds whole.
 *
 * Asked before dropping a spilled copy, and answered without reading anything.
 *
 * @param {object} params
 * @param {number} params.index
 * @param {number} params.pieceLength
 * @param {number} params.length
 * @param {Array<{ offset: number, length: number }>} params.files
 * @param {(fileIndex: number) => { path: string, length: number } | null} params.wholeFileAt
 * @returns {boolean}
 */
export function pieceIsInWholeFiles({ index, pieceLength, length, files, wholeFileAt }) {
  if (!Array.isArray(files) || files.length === 0 || !(pieceLength > 0)) {
    return false;
  }
  const pieceStart = index * pieceLength;
  const pieceEnd = Math.min(pieceStart + pieceLength, length) - 1;
  if (pieceStart > pieceEnd) {
    return false;
  }
  let covered = 0;
  for (const [fileIndex, file] of files.entries()) {
    const fileStart = Number(file?.offset ?? 0);
    const fileEnd = fileStart + Number(file?.length ?? 0) - 1;
    const from = Math.max(pieceStart, fileStart);
    const to = Math.min(pieceEnd, fileEnd);
    if (from > to) {
      continue;
    }
    if (!wholeFileAt(fileIndex)) {
      return false;
    }
    covered += to - from + 1;
  }
  return covered === pieceEnd - pieceStart + 1;
}
