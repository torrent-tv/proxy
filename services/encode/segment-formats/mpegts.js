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

// What a piece is called while it is still being written. See
// `makingFileNameTemplate`.
const MAKING_PATTERN = /^making-([0-9a-z]+)-(\d{5})\.ts$/;
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

  /**
   * Arguments for cutting at times we choose rather than times ffmpeg picks.
   *
   * The `hls` muxer takes only a target duration and finds its own cut points,
   * which is why the playlist and the real segments drifted apart; the `segment`
   * muxer takes the list. Self-contained segments make this straightforward
   * here: no init segment to reconcile, so the only difference is the container
   * and the file name template.
   *
   * @returns {string[]}
   */
  explicitTimesMuxerArgs() {
    return ["-segment_format", "mpegts"];
  },

  /** The output path template for the `segment` muxer. */
  /**
   * The name ffmpeg is told to write a piece under WHILE IT IS MAKING IT.
   *
   * Not the name it is served under. A piece being written is not a piece, and
   * under its final name it is indistinguishable from one — which is how half a
   * segment came to be served: the proof of completeness was "the next file
   * exists", true of one writer walking forward and false the moment two runs
   * share an output, because the next file is then written by another process.
   * Field 2026-09-08: `segment-00057.mp4` served at 2 268 361 bytes and then at
   * 4 510 940, and the browser refused the whole one for the rest of the session.
   *
   * With a working name, the served name appears only when the encoder has said
   * the piece is closed, and existence under it IS the proof — one rule, the
   * same for every branch, and true whether or not our own process is alive.
   *
   * @returns {string}
   */
  makingFileNameTemplate(tag) {
    return `making-${String(tag ?? "0").replace(/[^0-9a-z]/g, "")}-%05d.ts`;
  },

  /**
   * Which run is writing this working name, or null when the name is not one.
   *
   * The tag is what makes clearing up after a dead run possible without
   * guessing: several runs write into one directory, so "the unfinished pieces"
   * is only a well-formed question per run. It used to be answered by looking
   * for the highest SERVED name inside the stretch the ended run was given and
   * judging its bytes — a guess, and under the naming rule above it would remove
   * a complete piece somebody else had closed.
   *
   * @param {string} name
   * @returns {string | null}
   */
  makingTagOf(name) {
    const match = MAKING_PATTERN.exec(String(name ?? "").trim());
    return match ? match[1] : null;
  },

  /**
   * The name a piece just closed under a working name is served as, or null when
   * the name is not one of ours.
   *
   * @param {string} makingName
   * @returns {string | null}
   */
  servedNameOf(makingName) {
    const match = MAKING_PATTERN.exec(String(makingName ?? "").trim());
    return match ? this.segmentFileName(Number(match[2])) : null;
  },

  segmentFileNameTemplate() {
    return "segment-%05d.ts";
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
