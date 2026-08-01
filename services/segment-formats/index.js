/**
 * @file Selectable HLS segment container formats.
 *
 * Everything that differs between fMP4/CMAF and MPEG-TS output lives behind one
 * interface, so `hls-session-manager` never branches on the container: it holds
 * a format object and asks it. Adding a container means adding a module here,
 * not editing the session manager.
 *
 * The choice is per-proxy (CLI `--segment-format`), mirroring how Jellyfin lets
 * the operator pick the transcoding container. fMP4 is the default; MPEG-TS is
 * the fallback for hosts or players where fMP4 misbehaves.
 */

import { fmp4Format } from "./fmp4.js";
import { mpegtsFormat } from "./mpegts.js";

/**
 * @typedef {Object} PrepareSegmentContext
 * @property {number} startSeconds - Position of this segment on the 0-based
 *   output timeline, from the session's segment-boundary table.
 * @property {Buffer | null} initBytes - The init segment being served for this
 *   session, when the format has one (fMP4 needs it to read track timescales).
 */

/**
 * One container format's complete behaviour.
 *
 * @typedef {Object} SegmentFormat
 * @property {string} id - Stable identifier, also the CLI value ("fmp4" | "mpegts").
 * @property {string | null} initFileName - Init segment name, or null when the
 *   format has none (MPEG-TS).
 * @property {string | null} initContentType - MIME type for the init segment.
 * @property {string} segmentContentType - MIME type for a media segment.
 * @property {number} playlistVersion - `#EXT-X-VERSION` the playlist must declare.
 * @property {() => string[]} muxerArgs - ffmpeg arguments selecting this
 *   container (including `-hls_segment_filename`).
 * @property {() => string[]} playlistHeaderLines - Extra playlist header lines
 *   (e.g. `#EXT-X-MAP` for fMP4); empty for formats that need none.
 * @property {(index: number) => string} segmentFileName - File name for a
 *   zero-based segment index.
 * @property {(fileName: string) => boolean} isSegmentFileName - Whether a name
 *   is one of this format's media segments.
 * @property {(fileName: string) => number} segmentIndexFromName - Index encoded
 *   in a segment file name, or -1.
 * @property {boolean} needsSegmentRewrite - Whether a segment must be read into
 *   memory and passed through `prepareSegmentBytes` before being served. False
 *   lets the caller stream straight from disk.
 * @property {(bytes: Buffer, context: PrepareSegmentContext) => Buffer}
 *   prepareSegmentBytes - Correct a segment before serving. Identity for
 *   formats that need nothing.
 */

/** @type {Readonly<Record<string, SegmentFormat>>} */
const FORMATS = Object.freeze({
  [fmp4Format.id]: fmp4Format,
  [mpegtsFormat.id]: mpegtsFormat
});

/** The container used unless the operator selects otherwise. */
export const DEFAULT_SEGMENT_FORMAT_ID = fmp4Format.id;

/** Identifiers accepted by {@link resolveSegmentFormat}, for CLI help/validation. */
export const SEGMENT_FORMAT_IDS = Object.freeze(Object.keys(FORMATS));

/**
 * Resolve a format by id, falling back to the default for an unknown or absent
 * value (a bad CLI value must not stop the proxy from starting).
 *
 * @param {string | undefined | null} id
 * @returns {SegmentFormat}
 */
export function resolveSegmentFormat(id) {
  if (typeof id === "string" && Object.hasOwn(FORMATS, id)) {
    return FORMATS[id];
  }
  return FORMATS[DEFAULT_SEGMENT_FORMAT_ID];
}
