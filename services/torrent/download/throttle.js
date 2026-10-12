/**
 * @file Setting WebTorrent's download limit so that lowering it cannot fail a
 * peer's data (torrent-tv/meta#178).
 *
 * WebTorrent's limit is a `speed-limiter` ThrottleGroup over `limiter`'s
 * TokenBucket. The group cuts what a peer sends into slices of `rate / 10`
 * at the moment a slice is cut, and a slice that waits for tokens asks for
 * its full length again when it retries. `setRate` makes the bucket as large
 * as the new rate, and the bucket refuses any request larger than itself
 * ("exceeds bucket size"), which ends that peer's stream. So a slice cut at
 * 47 MB/s (4.7 MB) that is still waiting when the limit falls to 0.6 MB/s
 * fails — checked in `test/no-torrent/download-throttle.test.js`.
 *
 * The slice is kept at one BitTorrent block, 16 KiB, the length a peer's
 * request asks for, whatever the rate: no slice can then outgrow a bucket of
 * at least one block. Below one block the slice is the limit itself, as the
 * group requires; the processor share never sets a limit that low, since it
 * never falls below what the watched films play.
 */

/** The length of one request in the BitTorrent wire protocol (BEP 3). */
const BLOCK_BYTES = 16 * 1024;

/**
 * @param {{ throttleDownload: (rate: number) => unknown, throttleGroups?: { down?: { setChunksize: (bytes: number) => void } } }} client
 * @param {number} rate - Bytes per second; -1 lifts the limit.
 */
export function applyDownloadRate(client, rate) {
  client.throttleDownload(rate);
  if (rate >= 1) client.throttleGroups?.down?.setChunksize(Math.min(BLOCK_BYTES, Math.floor(rate)));
}
