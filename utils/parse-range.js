/**
 * @file HTTP Range header parser.
 */

/**
 * Parse an HTTP `Range` header value into a byte range clamped to the file size.
 * Only the `bytes=<start>-<end>` form is supported.
 *
 * @param {string | undefined} rangeHeader - Value of the `Range` request header.
 * @param {number} fileLength              - Total file size in bytes.
 * @returns {{ start: number, end: number } | null} Byte range, or `null` if the
 *   header is absent, malformed, or uses an unsupported unit.
 */
export function parseRange(rangeHeader, fileLength) {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return null;
  }
  const [startRaw, endRaw] = rangeHeader.slice("bytes=".length).split("-");
  const start = startRaw.length > 0 ? Number(startRaw) : 0;
  const end = endRaw && endRaw.length > 0 ? Number(endRaw) : fileLength - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return null;
  }
  return { start, end: Math.min(end, fileLength - 1) };
}
