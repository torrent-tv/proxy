/**
 * @file What the torrent thread holds beyond the bytes it accounts for: live
 * and destroyed torrents, and the uTP sockets and connections behind them.
 *
 * These are the objects the heap snapshot of 2026-10-04 found holding the
 * growth: 957 uTP sockets whose close never completed, 2101 of their 128 KB
 * read buffers, and through their listeners 595 torrents destroyed long
 * before. None of it was in any figure this proxy printed. Read on the same
 * line as the memory, so the count and the mass are the same instant.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * The uTP module's own count of what it holds open, or null where the module is
 * not built or is a version that does not count.
 *
 * Required by name, which resolves to the same copy WebTorrent loads: the image
 * removes every nested copy and refuses to build if one survives.
 *
 * @returns {{ sockets: number, connections: number, closing: number } | null}
 */
export function readUtpOpenCount() {
  try {
    const utp = require("utp-native");
    return typeof utp?.openCount === "function" ? utp.openCount() : null;
  } catch {
    // silent-ok: no uTP on this host means TCP peers only, and nothing to count.
    return null;
  }
}

/**
 * One clause for the memory line.
 *
 * @param {object} held
 * @param {number} held.liveTorrents - Torrents the client has now.
 * @param {{ total: number, notCollected: number }} held.destroyed
 * @param {{ sockets: number, connections: number, closing: number } | null} held.utp
 * @returns {string}
 */
export function describeHeldObjects({ liveTorrents, destroyed, utp }) {
  const torrents =
    `torrents ${liveTorrents} live, ${destroyed.notCollected} destroyed and not collected ` +
    `(${destroyed.total} destroyed in all)`;
  if (!utp) {
    return torrents;
  }
  return (
    `${torrents}; uTP ${utp.sockets} socket(s), ${utp.connections} connection(s), ` +
    `${utp.closing} destroyed and still closing`
  );
}
