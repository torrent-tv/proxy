/**
 * @file Canonical identity for a torrent source: its own infohash.
 *
 * A magnet URI and a `.torrent` file for the same content are different
 * bytes, so naming a source by a hash of those bytes gave the same film two
 * unrelated keys — one from a magnet, another from a `.torrent` — sharing
 * neither the swarm, nor a cache, nor any work already done. Measured
 * 2026-08-19: `a518ff46…` and `7ab2fb5d…` for one infohash `11f09299…`.
 *
 * The infohash is the one thing both forms carry for the same content, and
 * both carry it synchronously — a magnet's `btih` needs no network, and a
 * `.torrent` file's SHA-1 of its own `info` dictionary needs no metadata
 * exchange either. `parse-torrent` (already in the dependency tree via
 * `webtorrent`) reads either form without touching the network.
 */

import parseTorrent from "parse-torrent";

/**
 * @param {"magnet" | "torrent"} sourceType
 * @param {string} source - Magnet URI, or base64-encoded `.torrent` bytes.
 * @returns {Promise<string>} `torrent:<infohash>` — identical for a magnet
 *   and a `.torrent` file describing the same content.
 */
export async function deriveSourceKey(sourceType, source) {
  const torrentId = sourceType === "torrent" ? Buffer.from(source, "base64") : source;
  let parsed;
  try {
    parsed = await parseTorrent(torrentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read an infohash from this ${sourceType}: ${message}`);
  }
  if (!parsed?.infoHash) {
    throw new Error(`Could not read an infohash from this ${sourceType}.`);
  }
  return `torrent:${parsed.infoHash}`;
}
