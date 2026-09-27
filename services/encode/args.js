/**
 * @file The arithmetic every encoder kind is built from: the output frame rate,
 * the bitrate ladder and its caps, the frame box, and the keyframe arguments.
 *
 * Taken out of `encode/hwaccel.js` so the kind classes beside this file do not have to
 * import the detection and benchmarking that happen to live there. The
 * dependency runs one way — `encode/hwaccel.js` imports this, never the reverse — and
 * everything here is a calculation, with no process, no filesystem and no clock
 * behind it.
 *
 * Moved verbatim on 2026-09-04. Every comment is the reasoning it was written
 * with and every field case it cites is unchanged.
 */

import os from "node:os";
import { LADDER_HEIGHTS } from "./output/ladder.js";

export const SOFTWARE_PRESET = "ultrafast";
export const SOFTWARE_CRF = "24";
// HDR→SDR tone-map chain (software). Converts a BT.2020 PQ/HLG source to BT.709
// 8-bit SDR so the re-encode is not washed-out/desaturated. Requires the
// `zscale` (libzimg) and `tonemap` filters — gated by detectTonemapSupport;
// when unavailable the encode falls back to a plain 8-bit convert (no tonemap).
// npl=100 targets ~100-nit SDR; hable is a well-behaved tone-mapping operator.
export const TONEMAP_FILTER_CHAIN =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709," +
  "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";
// Default output frame rate when the source rate is unknown, and the rate used
// by the synthetic startup test-encode / preset benchmark. The real encode
// inherits the source rate (rounded to an integer, capped) — see
// chooseOutputFps — so 25/30 fps content no longer plays resampled to 24.
export const TRANSCODE_FPS = 24;
// Upper bound on the output frame rate: 50/60 fps sources are halved-in-effort
// by capping to 30, protecting the realtime encode budget on weak hosts.
export const MAX_OUTPUT_FPS = 30;

/**
 * Choose an INTEGER output frame rate from the (possibly fractional) source
 * rate, for the frame-count-GOP encoders ONLY (software libx264, v4l2m2m).
 * Those place keyframes with `-g = segmentDur × fps` (frame count), so the
 * `fps=` filter value must be an integer that makes seg×fps an exact whole
 * number of frames per segment — otherwise segments drift off the synthetic
 * playlist's uniform grid and seek accuracy degrades over a long file. Film
 * rates (23.976) round to 24, 25 stays 25, 29.97 rounds to 30; the cap clamps
 * high rates (the cap is a SPEED guard for the weak software/v4l2m2m path).
 *
 * Time-based-keyframe encoders (nvenc, vaapi, qsv) do NOT use this — they
 * inherit the exact source rate untouched (their keyframes are forced by
 * output time, so any rate segments correctly).
 *
 * @param {number | null | undefined} sourceFps
 * @param {number} [cap=MAX_OUTPUT_FPS]
 * @returns {number}
 */
export function chooseOutputFps(sourceFps, cap = MAX_OUTPUT_FPS) {
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) {
    return TRANSCODE_FPS;
  }
  const rounded = Math.round(sourceFps);
  if (rounded < 1) {
    return TRANSCODE_FPS;
  }
  return Math.min(cap, rounded);
}
// Software x264 on weak ARM hosts is the transcode bottleneck — use all cores.
export const CPU_THREADS = Math.max(1, os.cpus().length);

// Bitrate caps (constrained CRF). CRF stays the quality driver; -maxrate/
// -bufsize only bound the peaks. Field evidence (iPhone on cellular,
// 2026-07-10): uncapped complex scenes produced 4 s segments of ~18 Mbit/s
// against a 1-6 Mbit/s viewer link — 45 s prebuffer, draining buffer.
// Nominal H.264 rates per row; multipliers from webtor's production ladder
// (content-transcoder): maxrate = 1.3x nominal, bufsize = 1.5x. The nominal
// figures themselves came with no source when they were written (2026-07-10,
// openspec `adaptive-bitrate`) and stand as an assumption until roadmap item
// 97, step 14 measures them.
const NOMINAL_KBPS_BY_ROW = new Map([
  [1080, 5000],
  [720, 2800],
  [480, 1400],
  [360, 800],
  [240, 400]
]);
// The picture every row is named after: a 16:9 frame of the row's height, as
// the encode itself would size one (`computeOutputDimensions` from a 16:9
// source), so the reference is the frame the product makes and not a width
// written down beside it.
const ROW_REFERENCE_SOURCE = Object.freeze({ width: 3840, height: 2160 });
/**
 * The rate a re-encoded soundtrack is produced at, in kbit/s: stereo AAC,
 * constant. Stated once because two places need the same figure — the ffmpeg
 * arguments that produce it, and the viewer's link that has to carry it.
 */
export const AUDIO_TRANSCODE_KBPS = 128;
const CAP_MAXRATE_FACTOR = 1.3;
const CAP_BUFSIZE_FACTOR = 1.5;

/**
 * The rows of limits, one per height of the ladder, each with the area of the
 * frame it is named after.
 *
 * @type {{ height: number, area: number }[] | null}
 */
let limitRows = null;

/**
 * @returns {{ height: number, area: number }[]}
 */
function rows() {
  if (limitRows === null) {
    limitRows = LADDER_HEIGHTS.map((height) => {
      const frame = computeOutputDimensions(
        ROW_REFERENCE_SOURCE.width,
        height,
        ROW_REFERENCE_SOURCE.width,
        ROW_REFERENCE_SOURCE.height
      );
      return { height, area: frame.w * frame.h };
    });
  }
  return limitRows;
}

/**
 * The row whose frame area is nearest to this one, measured as a ratio rather
 * than a difference (decided with the user 2026-09-24): a rate grows with the
 * number of points multiplicatively, and the rows stand at uneven distances, so
 * the border between two rows is the geometric mean of their areas. On the
 * border itself the row with the larger area wins, so the choice has one answer.
 *
 * Keyed by area and not by height because a height alone names the wrong
 * frame for any picture that is not 16:9: a 2.4:1 film in a 1080 box is
 * encoded at about 1920x800, 1.54 million points, which a height puts in the
 * 720 row (0.92 million) although it is nearer the 1080 row (2.07 million).
 *
 * @param {{ width: number, height: number }} frame
 * @returns {number} The height the row is named after.
 */
export function limitRowFor({ width, height }) {
  const area = Number(width) * Number(height);
  if (!(Number.isFinite(area) && area > 0)) {
    throw new RangeError(`a limit row is chosen for a frame, not for ${width}x${height}`);
  }
  return nearestByArea(rows(), area).height;
}

/**
 * @param {{ height: number, area: number }[]} candidates
 * @param {number} area
 * @returns {{ height: number, area: number }}
 */
function nearestByArea(candidates, area) {
  // The larger area over the smaller: the same order as the distance of the
  // logarithms, without a logarithm. Taken as log(a / b) the two sides of a
  // border come out one last digit apart — log(2/3) is not exactly -log(3/2) —
  // and the tie rule below would never be reached.
  const ratioTo = (rowArea) => Math.max(area, rowArea) / Math.min(area, rowArea);
  let best = candidates[0];
  let bestDistance = ratioTo(best.area);
  for (const row of candidates.slice(1)) {
    const distance = ratioTo(row.area);
    if (distance < bestDistance || (distance === bestDistance && row.area > best.area)) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Nominal kbps for a frame: the nominal of the row its area falls in. A row
 * that has no nominal of its own yet (540, 1440 and 2160 today) takes the one
 * of the nearest row by area that has one, by the same rule, until step 14
 * measures it.
 *
 * @param {{ width: number, height: number }} frame
 * @returns {number}
 */
export function nominalKbpsFor(frame) {
  const row = limitRowFor(frame);
  const own = NOMINAL_KBPS_BY_ROW.get(row);
  if (own !== undefined) {
    return own;
  }
  const named = rows().filter((candidate) => NOMINAL_KBPS_BY_ROW.has(candidate.height));
  const rowArea = rows().find((candidate) => candidate.height === row).area;
  return NOMINAL_KBPS_BY_ROW.get(nearestByArea(named, rowArea).height);
}

/**
 * The peak this encode may reach, in kbit/s, for a nominal rate.
 *
 * Exported because the same figure answers a second question: whether a rung
 * fits the viewer's measured link. The budget compares the link against what
 * the encode is ALLOWED to peak at rather than against what it happened to
 * produce in the last few segments, so a rung is judged by the bound we impose
 * on it and not by a quiet stretch of the film.
 *
 * @param {number} nominalKbps
 * @returns {number}
 */
export function maxrateKbpsFor(nominalKbps) {
  return Math.round(nominalKbps * CAP_MAXRATE_FACTOR);
}

/**
 * H.264 levels, Table A-1 of ITU-T H.264: the level name, then MaxMBPS
 * (macroblocks per second), MaxFS (macroblocks per frame), MaxBR (kbit/s) and
 * MaxCPB (kbit). The bit rate and buffer limits are the Baseline/Main figures;
 * the High profile, which libx264 produces for 8-bit 4:2:0, allows 1.25 times
 * both (Table A-2, `cpbBrVclFactor` 1250 against 1000).
 */
const H264_LEVELS = [
  ["1", 1485, 99, 64, 175],
  ["1.1", 3000, 396, 192, 500],
  ["1.2", 6000, 396, 384, 1000],
  ["1.3", 11880, 396, 768, 2000],
  ["2", 11880, 396, 2000, 2000],
  ["2.1", 19800, 792, 4000, 4000],
  ["2.2", 20250, 1620, 4000, 4000],
  ["3", 40500, 1620, 10000, 10000],
  ["3.1", 108000, 3600, 14000, 14000],
  ["3.2", 216000, 5120, 20000, 20000],
  ["4", 245760, 8192, 20000, 25000],
  ["4.1", 245760, 8192, 50000, 62500],
  ["4.2", 522240, 8704, 50000, 62500],
  ["5", 589824, 22080, 135000, 135000],
  ["5.1", 983040, 36864, 240000, 240000],
  ["5.2", 2073600, 36864, 240000, 240000],
  ["6", 4177920, 139264, 240000, 240000],
  ["6.1", 8355840, 139264, 480000, 480000],
  ["6.2", 16711680, 139264, 800000, 800000]
];
const HIGH_PROFILE_RATE_FACTOR = 1.25;

/**
 * The lowest H.264 level whose limits hold this picture and this rate control,
 * or null when none does.
 *
 * What the DPB needs is not checked here: it depends on the reference count,
 * which the speed setting decides, and at the presets this proxy runs (one or
 * two references) no size it produces reaches that limit. Whether this answer
 * is the level x264 would pick by itself is checked before a release
 * (`stand/segment-compat/level-check.mjs`), which is the check that would catch
 * the DPB, or anything else, deciding differently.
 *
 * @param {{ width: number, height: number, fps: number, maxrateKbps: number, bufsizeKbps: number }} picture
 * @returns {string | null}
 */
export function h264LevelFor({ width, height, fps, maxrateKbps, bufsizeKbps }) {
  const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  for (const [name, maxMbps, maxFs, maxBr, maxCpb] of H264_LEVELS) {
    if (
      frameMbs <= maxFs &&
      frameMbs * fps <= maxMbps &&
      maxrateKbps <= maxBr * HIGH_PROFILE_RATE_FACTOR &&
      bufsizeKbps <= maxCpb * HIGH_PROFILE_RATE_FACTOR
    ) {
      return name;
    }
  }
  return null;
}

/**
 * The rate control of a software encode at this size, and the level it is
 * declared at.
 *
 * THE LEVEL BELONGS TO THE NOMINAL OUTPUT OF THIS SIZE, not to the limit asked
 * for (decided with the user 2026-09-23). A level is a ceiling a decoder must
 * be able to handle, not a description of the stream, so a stream held below
 * the nominal limit is correctly declared at the nominal output's level. What
 * that buys is the whole point: every limit at one size then writes the same
 * header, so moving a viewer between two of them is serving another output's
 * pieces under the address they already play, with nothing asked of the
 * player. Declared by the stream's own limit, a lower limit could land on a
 * lower level, the header would differ, and the move would need a new address.
 *
 * A limit ABOVE the nominal one is refused rather than lowered: it would need a
 * higher level than the one every other output of this size declares, and the
 * request would then be answered with something other than what it asked for.
 *
 * @param {{ width: number, height: number, fps: number, capKbps?: number | null }} params
 *   `capKbps` is the nominal rate asked for; absent, the size's own.
 * @returns {{ maxrateKbps: number, bufsizeKbps: number, level: string | null }}
 */
export function softwareRateControlFor({ width, height, fps, capKbps = null }) {
  const nominal = nominalKbpsFor({ width, height });
  const asked = capKbps === null || capKbps === undefined ? nominal : Number(capKbps);
  if (!(Number.isFinite(asked) && asked > 0)) {
    throw new RangeError(`a bitrate limit must be a positive number of kbit/s, not ${capKbps}`);
  }
  if (asked > nominal) {
    throw new RangeError(
      `a bitrate limit of ${asked}kbps is above the ${nominal}kbps a ${width}x${height} picture is sized for, ` +
      "and would need a higher level than every other output of this size declares"
    );
  }
  return {
    maxrateKbps: maxrateKbpsFor(asked),
    bufsizeKbps: bufsizeKbpsFor(asked),
    level: h264LevelFor({
      width,
      height,
      fps,
      maxrateKbps: maxrateKbpsFor(nominal),
      bufsizeKbps: bufsizeKbpsFor(nominal)
    })
  };
}

/**
 * The buffer an encode may fill, in kbit, for a nominal rate.
 *
 * @param {number} nominalKbps
 * @returns {number}
 */
export function bufsizeKbpsFor(nominalKbps) {
  return Math.round(nominalKbps * CAP_BUFSIZE_FACTOR);
}

/**
 * `-maxrate`/`-bufsize`/`-level` for an encode, exactly as its output states
 * them (constrained CRF: CRF drives quality, these bound the peaks).
 *
 * Nothing is computed here: the figures are part of what the output IS, and
 * its key names them, so the arguments are read off the output rather than
 * worked out again beside it.
 *
 * @param {{ maxrateKbps: number, bufsizeKbps: number, level: string | null } | null} rateControl
 * @returns {string[]}
 */
export function rateControlArgs(rateControl) {
  if (!rateControl) {
    return [];
  }
  return [
    "-maxrate", `${rateControl.maxrateKbps}k`,
    "-bufsize", `${rateControl.bufsizeKbps}k`,
    ...(rateControl.level ? ["-level:v", rateControl.level] : [])
  ];
}

/**
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @returns {{ w: number, h: number }}
 */
export function safeDimensions(targetWidth, targetHeight) {
  const w = Number.isInteger(targetWidth) && targetWidth > 0 ? targetWidth : 1280;
  const h = Number.isInteger(targetHeight) && targetHeight > 0 ? targetHeight : 720;
  return { w, h };
}

/**
 * Force a keyframe on every segment boundary so each HLS segment is
 * independently decodable.
 *
 * Two grids exist. The usual one is even — a keyframe every
 * `segmentDurationSec` — and the encoder is free to place them because it is
 * producing every frame anyway. The other is the SOURCE's own keyframe times,
 * used when this encode has to be interchangeable with a stream that is
 * COPIED: a copy can only be cut where the source already has a keyframe, so a
 * rung meant to splice into it must be cut at exactly those times and nowhere
 * else. Then the times are given outright.
 *
 * @param {number} segmentDurationSec
 * @param {number[] | null} [forcedTimes] - Run-relative seconds, ascending.
 * @returns {string[]}
 */
export function keyFrameArgs(segmentDurationSec, forcedTimes = null) {
  if (Array.isArray(forcedTimes) && forcedTimes.length > 0) {
    return ["-force_key_frames", forcedTimes.join(",")];
  }
  return ["-force_key_frames", `expr:gte(t,n_forced*${segmentDurationSec})`];
}

/**
 * Whether an explicit cut list was supplied.
 *
 * @param {number[] | null | undefined} forcedTimes
 * @returns {boolean}
 */
export function hasForcedTimes(forcedTimes) {
  return Array.isArray(forcedTimes) && forcedTimes.length > 0;
}

/**
 * Compute the actual output resolution ffmpeg will produce: the target box
 * capped to the source (never upscaled), preserving aspect, divisible by 2.
 * Mirrors the `scale='min(w,iw)':'min(h,ih)':force_original_aspect_ratio=decrease`
 * filter built below, which is why it lives beside it: two statements of one
 * rule, and the day they disagree the quality offer prices a picture ffmpeg is
 * not making. Returns `null` when the source size is unknown.
 *
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @param {number | null} sourceWidth
 * @param {number | null} sourceHeight
 * @returns {{ w: number, h: number } | null}
 */
export function computeOutputDimensions(targetWidth, targetHeight, sourceWidth, sourceHeight) {
  const sw = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : 0;
  const sh = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 0;
  if (!sw || !sh) {
    return null;
  }
  const tw = Number.isInteger(targetWidth) && targetWidth > 0 ? targetWidth : sw;
  const th = Number.isInteger(targetHeight) && targetHeight > 0 ? targetHeight : sh;
  const scale = Math.min(tw / sw, th / sh, 1);
  let w = Math.round(sw * scale);
  let h = Math.round(sh * scale);
  w -= w % 2;
  h -= h % 2;
  return { w: Math.max(2, w), h: Math.max(2, h) };
}
