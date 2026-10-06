/**
 * @file The OpenSubtitles file hash ("moviehash", "oshash").
 *
 * The size of the file plus its first 64 KiB and its last 64 KiB, each read as
 * little-endian 64-bit words and added modulo 2^64; written as 16 hexadecimal
 * digits. Databases of releases (OpenSubtitles, StashDB, ThePornDB) keep it per
 * file, so a match names this exact release; nothing else about the file is
 * needed, which is why it can be computed from the two edges the proxy downloads
 * first.
 */

/** Bytes read from each end of the file. */
export const OSHASH_EDGE_BYTES = 65536;

/**
 * Whether a file is long enough to have the hash: both edges must be whole and
 * distinct, as the format of the hash requires.
 *
 * @param {number} size
 * @returns {boolean}
 */
export function hasOshash(size) {
  return Number.isInteger(size) && size >= OSHASH_EDGE_BYTES * 2;
}

/**
 * @param {number} size - The size of the file in bytes.
 * @param {Uint8Array} head - Its first {@link OSHASH_EDGE_BYTES} bytes.
 * @param {Uint8Array} tail - Its last {@link OSHASH_EDGE_BYTES} bytes.
 * @returns {string} Sixteen lowercase hexadecimal digits.
 */
export function oshash(size, head, tail) {
  if (!hasOshash(size)) throw new RangeError("a file shorter than 128 KiB has no oshash");
  if (head.byteLength !== OSHASH_EDGE_BYTES || tail.byteLength !== OSHASH_EDGE_BYTES) throw new RangeError("each edge must be 64 KiB");
  let sum = BigInt(size);
  for (const edge of [head, tail]) {
    const words = new DataView(edge.buffer, edge.byteOffset, edge.byteLength);
    for (let at = 0; at < OSHASH_EDGE_BYTES; at += 8) sum += words.getBigUint64(at, true);
  }
  return BigInt.asUintN(64, sum).toString(16).padStart(16, "0");
}
