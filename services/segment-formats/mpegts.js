/**
 * @file MPEG-TS segment format — self-contained `.ts` segments, no init segment.
 *
 * This is the pre-fMP4 behaviour (recovered from the switch commit `dd1ce09`),
 * kept as a selectable alternative rather than deleted. Each segment carries
 * its own parameter sets and its own timestamps, so it is valid on its own —
 * there is no shared init segment that a seek-restart can invalidate, and
 * therefore none of the timeline problems the fMP4 path has to correct for.
 *
 * Trade-off vs fMP4: higher container overhead, and encoders that do not repeat
 * SPS/PPS (CM4 `h264_v4l2m2m`) emit segments after the first with no parameter
 * sets, which is exactly why fMP4 became the default.
 *
 * See {@link SegmentFormat} in `./index.js` for the interface contract.
 */

const SEGMENT_PATTERN = /^segment-(\d{5})\.ts$/;

/**
 * @type {import("./index.js").SegmentFormat}
 */
export const mpegtsFormat = {
  id: "mpegts",
  // No init segment: every `.ts` segment is self-describing.
  initFileName: null,
  initContentType: null,
  segmentContentType: "video/mp2t",
  playlistVersion: 3,

  muxerArgs() {
    return ["-hls_segment_filename", "segment-%05d.ts"];
  },

  playlistHeaderLines() {
    return []; // no `#EXT-X-MAP`
  },

  segmentFileName(index) {
    return `segment-${String(index).padStart(5, "0")}.ts`;
  },

  isSegmentFileName(fileName) {
    return SEGMENT_PATTERN.test(fileName);
  },

  segmentIndexFromName(fileName) {
    const match = SEGMENT_PATTERN.exec(fileName);
    return match ? Number(match[1]) : -1;
  },

  /**
   * MPEG-TS segments carry their own timestamps and need no correction, so they
   * are streamed straight from disk (no read-into-memory step).
   */
  needsSegmentRewrite: false,

  prepareSegmentBytes(bytes) {
    return bytes;
  }
};
