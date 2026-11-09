/**
 * @file The one reading of an HTTP `Range` header (RFC 9110 §14.1.2, §14.2;
 * one range only).
 */

/**
 * @typedef {{ kind: "whole" } | { kind: "range", start: number, end: number } | { kind: "unsatisfiable" }} ParsedRange
 */

const WHOLE = Object.freeze({ kind: "whole" });
const UNSATISFIABLE = Object.freeze({ kind: "unsatisfiable" });

/**
 * Read a `Range` header against the length of the representation it asks for.
 *
 * - `whole`: no header, another unit, several ranges, or invalid syntax — the
 *   header is ignored, as RFC 9110 allows.
 * - `range`: one inclusive range, `0 <= start <= end <= length - 1`; an end
 *   past the last byte is clamped, `bytes=-N` is the last N bytes.
 * - `unsatisfiable`: a valid range that holds no byte of the representation.
 *
 * @param {unknown} header - Value of the `Range` request header.
 * @param {number} length  - Size of the representation in bytes (a non-negative safe integer).
 * @returns {ParsedRange}
 */
export function parseRange(header, length) {
  if (typeof header !== "string") return WHOLE;
  const equals = header.indexOf("=");
  if (equals < 0) return WHOLE;
  if (header.slice(0, equals).trim().toLowerCase() !== "bytes") return WHOLE;
  const spec = header.slice(equals + 1).trim();
  if (spec.includes(",")) return WHOLE;
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (!match[1] && !match[2])) return WHOLE;

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix)) return WHOLE;
    if (suffix === 0 || length === 0) return UNSATISFIABLE;
    return { kind: "range", start: Math.max(0, length - suffix), end: length - 1 };
  }

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  if (!Number.isSafeInteger(start) || (end !== null && !Number.isSafeInteger(end))) return WHOLE;
  if (end !== null && end < start) return WHOLE;
  if (start >= length) return UNSATISFIABLE;
  return { kind: "range", start, end: end === null ? length - 1 : Math.min(end, length - 1) };
}
