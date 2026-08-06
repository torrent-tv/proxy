/**
 * @file Whether a torrent handle can still be read from.
 *
 * Its own module so it can be tested: importing the worker starts a torrent
 * client and a piece pool, which a unit test has no business doing.
 */

/**
 * Whether a torrent handle can still be read from.
 *
 * `destroyed` is WebTorrent's own flag and the earliest signal. The empty file
 * list is the symptom that actually reaches a reader — it is what produced
 * `File 0 not found` in the field — and it is also true of a handle whose
 * metadata has not arrived yet, in which case adding the source again is
 * equally right: the add de-duplicates and yields the same torrent once it is
 * ready.
 *
 * @param {{ destroyed?: boolean, files?: unknown[] } | null | undefined} torrent
 * @returns {boolean}
 */
export function isUsableTorrentHandle(torrent) {
  return Boolean(torrent) && torrent.destroyed !== true && (torrent.files?.length ?? 0) > 0;
}
