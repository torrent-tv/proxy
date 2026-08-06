/**
 * @file fMP4 (CMAF) segment format — `.mp4` media segments plus one shared
 * `init.mp4` referenced by `#EXT-X-MAP`.
 *
 * Codec configuration (SPS/PPS) lives once in the init segment instead of being
 * repeated per segment. That is what makes hardware encoders which do not
 * repeat parameter sets — notably the CM4 / HA-Yellow `h264_v4l2m2m` — produce
 * independently usable segments, and it lowers container overhead.
 *
 * See {@link SegmentFormat} in `./index.js` for the interface contract.
 */

import { readTrackTimescales, stampSegmentStartTime, walkBoxes } from "./mp4-boxes.js";

/**
 * How many distinct tracks have a fragment in this segment.
 *
 * @param {Buffer} bytes
 * @returns {number}
 */
function countFragmentTracks(bytes) {
  const tracks = new Set();
  walkBoxes(bytes, (type, bodyStart) => {
    if (type === "tfhd" && bodyStart + 8 <= bytes.length) {
      tracks.add(bytes.readUInt32BE(bodyStart + 4));
    }
  });
  return tracks.size;
}

/**
 * Where the fragments begin and where the trailing index starts, as offsets of
 * whole boxes at the TOP level.
 *
 * Deliberately not `walkBoxes`: that reports the start of a box's *body* and
 * descends into containers, so it cannot say where a box begins — and cutting a
 * file at the wrong offset by eight bytes produces something that parses as
 * garbage rather than failing outright.
 *
 * @param {Buffer} bytes
 * @returns {{ firstFragment: number, trailingIndex: number }} Offsets, or -1.
 */
function findFragmentBounds(bytes) {
  let firstFragment = -1;
  let trailingIndex = -1;
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > bytes.length) {
        break;
      }
      size = Number(bytes.readBigUInt64BE(offset + 8));
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < 8) {
      break;
    }
    if (firstFragment === -1 && (type === "moof" || type === "sidx")) {
      firstFragment = offset;
    }
    if (type === "mfra") {
      trailingIndex = offset;
    }
    offset += size;
  }
  return { firstFragment, trailingIndex };
}

const INIT_FILE_NAME = "init.mp4";
const SEGMENT_PATTERN = /^segment-(\d{5})\.mp4$/;

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
      "segment-%05d.mp4"
    ];
  },

  /**
   * Cut at times we choose rather than times ffmpeg picks.
   *
   * The `segment` muxer writes each fMP4 piece as a **self-contained** file:
   * `ftyp moov moof mdat … mfra`, verified on the field host. That is not what
   * HLS wants — it wants one init segment named by `#EXT-X-MAP` and media
   * segments carrying only fragments — so the pieces are split on serve:
   * {@link extractInit} takes the header off the first one to serve as the init,
   * and {@link stripInit} removes it from every one.
   *
   * The timestamps still need stamping, exactly as before: measured on the
   * field host, all three pieces of a run reported a start time of 0.080 s,
   * i.e. each carries its own zero. That is the same defect the shared-init
   * path already corrects, so `prepareSegmentBytes` handles both.
   *
   * @returns {string[]}
   */
  explicitTimesMuxerArgs() {
    return [
      "-segment_format",
      "mp4",
      // `empty_moov` is what makes each piece self-describing, which is what
      // lets the init be lifted out of it; `default_base_moof` keeps fragment
      // offsets relative, so removing the header does not invalidate them.
      //
      // `delay_moov` is not optional here. The MP4 muxer builds a copied AC-3
      // track's `dac3` box out of the bitstream, so it cannot write `moov`
      // until the first audio packet has arrived — while `empty_moov` asks for
      // it at header time. Without this flag ffmpeg exits before producing
      // anything: "Cannot write moov atom before AC3 packets", which is exactly
      // how fMP4 playback died in the field on 2.9.84/2.9.85. The `hls` muxer
      // sets this flag itself, which is why the fault only appeared once the
      // muxing moved here. Delaying `moov` does not change the piece layout —
      // measured: still `ftyp moov moof mdat … mfra`.
      "-segment_format_options",
      "movflags=+frag_keyframe+empty_moov+default_base_moof+delay_moov"
    ];
  },

  /** The output path template for the `segment` muxer. */
  segmentFileNameTemplate() {
    return "segment-%05d.mp4";
  },

  /**
   * The init part of a self-contained piece: everything before the first
   * fragment.
   *
   * @param {Buffer} bytes
   * @returns {Buffer | null} `null` when the piece carries no fragment, which
   *   means it is not one of these and must not be cut up.
   */
  extractInit(bytes) {
    const { firstFragment } = findFragmentBounds(bytes);
    return firstFragment > 0 ? bytes.subarray(0, firstFragment) : null;
  },

  /**
   * A piece with its init header removed, and the trailing random-access index
   * dropped — a player reading a media segment has no use for either, and
   * `mfra` describes offsets that stop being true once the header is gone.
   *
   * @param {Buffer} bytes
   * @returns {Buffer}
   */
  stripInit(bytes) {
    const { firstFragment, trailingIndex } = findFragmentBounds(bytes);
    if (firstFragment < 0) {
      return bytes;
    }
    const end = trailingIndex > firstFragment ? trailingIndex : bytes.length;
    return bytes.subarray(firstFragment, end);
  },

  playlistHeaderLines() {
    return [
      // The init segment (codec config). Fetched once; applies to every media
      // segment in the playlist.
      `#EXT-X-MAP:URI="${INIT_FILE_NAME}"`
    ];
  },

  segmentFileName(index) {
    return `segment-${String(index).padStart(5, "0")}.mp4`;
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

  /**
   * Whether a segment carries every track the init promises.
   *
   * A run that is TERMINATED closes its current output file properly — trailing
   * index and all — but the file holds only what had been muxed by then, which
   * after a seek-restart is routinely one track of two. Nothing about it looks
   * unfinished: the file exists, the next one exists, so the readiness rule
   * calls it done and it is served. The player then cannot use it and the seek
   * never completes. Measured 2026-08-06: segment #133 carried one `tfdt`
   * where its neighbours carried two, and a viewer sat on a spinner while the
   * proxy answered every request in 98 ms.
   *
   * Cheap to check: the fragments are already walked to stamp them.
   *
   * @param {Buffer} bytes - The media segment, init header already removed.
   * @param {Buffer | null} initBytes
   * @returns {boolean} False only when a track is provably missing.
   */
  hasEveryTrack(bytes, initBytes) {
    if (!initBytes || initBytes.length === 0) {
      return true;
    }
    const expected = readTrackTimescales(initBytes);
    if (expected.size === 0) {
      return true;
    }
    return countFragmentTracks(bytes) >= expected.size;
  },

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
