/**
 * @file One way to print bytes (torrent-tv/meta#294).
 *
 * Data and rates are printed in decimal units (`MB`, `MB/s`, 10^6 bytes);
 * memory is printed in binary units under its own label (`MiB`, 2^20 bytes), so
 * the same label never means two sizes.
 */

const MEGABYTE = 1_000_000;
const MEBIBYTE = 1_048_576;

/**
 * @param {number} bytes
 * @returns {string} e.g. "123MB"; negative bytes read as 0.
 */
export function megabytes(bytes) {
  return `${Math.round(Math.max(0, bytes) / MEGABYTE)}MB`;
}

/**
 * @param {number} bytes
 * @returns {string} e.g. "123MiB"; negative bytes read as 0.
 */
export function mebibytes(bytes) {
  return `${Math.round(Math.max(0, bytes) / MEBIBYTE)}MiB`;
}

/**
 * @param {number | null | undefined} bytesPerSecond
 * @returns {string} e.g. "1.05 MB/s"; "? MB/s" when the rate is not a finite number.
 */
export function megabytesPerSecond(bytesPerSecond) {
  return typeof bytesPerSecond === "number" && Number.isFinite(bytesPerSecond)
    ? `${(bytesPerSecond / MEGABYTE).toFixed(2)} MB/s` : "? MB/s";
}
