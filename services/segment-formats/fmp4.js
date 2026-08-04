/**
 * @file fMP4 (CMAF) segment format — `.m4s` media segments plus one shared
 * `init.mp4` referenced by `#EXT-X-MAP`.
 *
 * Codec configuration (SPS/PPS) lives once in the init segment instead of being
 * repeated per segment. That is what makes hardware encoders which do not
 * repeat parameter sets — notably the CM4 / HA-Yellow `h264_v4l2m2m` — produce
 * independently usable segments, and it lowers container overhead.
 *
 * See {@link SegmentFormat} in `./index.js` for the interface contract.
 */

import { readTrackTimescales, stampSegmentStartTime } from "./mp4-boxes.js";

const INIT_FILE_NAME = "init.mp4";
const SEGMENT_PATTERN = /^segment-(\d{5})\.m4s$/;

/**
 * @type {import("./index.js").SegmentFormat}
 */
export const fmp4Format = {
  id: "fmp4",
  initFileName: INIT_FILE_NAME,
  initContentType: "video/mp4",
  segmentContentType: "video/mp4",
  // Version 7 is the minimum that allows fMP4 media segments + `#EXT-X-MAP`.
  playlistVersion: 7,

  muxerArgs() {
    return [
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
      INIT_FILE_NAME,
      "-hls_segment_filename",
      "segment-%05d.m4s"
    ];
  },

  /**
   * Not supported on this format — deliberately, for now.
   *
   * The `segment` muxer can produce fMP4 (verified: explicit times cut exactly
   * where asked), but only as self-contained fragments carrying their own
   * `moov`. That removes the shared init segment this format is built around —
   * `#EXT-X-MAP`, and with it the whole `tfdt` rewriting that took a field
   * failure to get right. Changing all of that at once, on a path no current
   * deployment exercises and that cannot be verified without a real browser, is
   * how the last round of regressions happened. MPEG-TS, which is what runs in
   * the field, gets the fix first.
   *
   * @returns {null}
   */
  explicitTimesMuxerArgs() {
    return null;
  },

  playlistHeaderLines() {
    return [
      // The init segment (codec config). Fetched once; applies to every media
      // segment in the playlist.
      `#EXT-X-MAP:URI="${INIT_FILE_NAME}"`
    ];
  },

  segmentFileName(index) {
    return `segment-${String(index).padStart(5, "0")}.m4s`;
  },

  isSegmentFileName(fileName) {
    return SEGMENT_PATTERN.test(fileName);
  },

  segmentIndexFromName(fileName) {
    const match = SEGMENT_PATTERN.exec(fileName);
    return match ? Number(match[1]) : -1;
  },

  /**
   * fMP4 segments must be read into memory and corrected before being served —
   * see {@link stampSegmentStartTime} for the full reasoning. Without this a
   * seek is permanently broken: ffmpeg leaves every segment claiming to start
   * at 0 and puts the real offset in the per-run init, which we do not serve
   * (the player fetches the session's first init once and keeps it).
   *
   * Segments are a few hundred KB, so reading one whole is cheap next to the
   * transcode itself; the box walk never descends into `mdat`.
   */
  needsSegmentRewrite: true,

  prepareSegmentBytes(bytes, { startSeconds, initBytes }) {
    if (!initBytes || initBytes.length === 0) {
      // No init cached yet — nothing to read timescales from. The player always
      // fetches `#EXT-X-MAP` before any segment, so this is not reachable in
      // practice; serve unmodified rather than guess a timescale.
      return bytes;
    }
    return stampSegmentStartTime(bytes, startSeconds, readTrackTimescales(initBytes));
  }
};
