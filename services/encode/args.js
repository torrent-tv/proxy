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

/**
 * The rate a re-encoded soundtrack is asked for, in kbit/s: stereo AAC. A
 * TARGET, not a bound — ffmpeg's AAC encoder lets single frames run above it
 * from its bit reservoir. Stated once because two places need the same figure —
 * the ffmpeg arguments that ask for it, and the viewer's link that has to carry
 * it, which counts it as an estimate (`quality/link-budget.js`).
 */
export const AUDIO_TRANSCODE_KBPS = 128;
const CAP_MAXRATE_FACTOR = 1.3;
const CAP_BUFSIZE_FACTOR = 1.5;

/**
 * Nominal video rate for an output frame, scaled from the measured source
 * picture rate by pixel area. Missing source facts mean no safe ceiling.
 *
 * @param {{ width: number, height: number }} frame
 * @param {{ width: number, height: number, pictureKbps: number | null } | null} source
 * @returns {number | null}
 */
export function nominalKbpsFor(frame, source) {
  const width = Number(frame?.width);
  const height = Number(frame?.height);
  const sourceWidth = Number(source?.width);
  const sourceHeight = Number(source?.height);
  const pictureKbps = Number(source?.pictureKbps);
  if (![width, height, sourceWidth, sourceHeight, pictureKbps].every(Number.isFinite) ||
      width <= 0 || height <= 0 || sourceWidth <= 0 || sourceHeight <= 0 || pictureKbps <= 0) {
    return null;
  }
  const nominal = pictureKbps * (width * height) / (sourceWidth * sourceHeight);
  return Number.isFinite(nominal) && nominal > 0 ? Math.round(nominal) : null;
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
 * @param {{ width: number, height: number, fps: number, source: object | null, capKbps?: number | null }} params
 *   `source` supplies source dimensions and measured picture rate. `capKbps`
 *   is an explicit nominal limit; absent, the source-scaled rate is used.
 * @returns {{ maxrateKbps: number, bufsizeKbps: number, level: string | null } | null}
 */
export function softwareRateControlFor({ width, height, fps, source = null, capKbps = null }) {
  const nominal = nominalKbpsFor({ width, height }, source);
  if (nominal === null && (capKbps === null || capKbps === undefined)) {
    return null;
  }
  if (nominal === null) {
    throw new RangeError(`a bitrate limit for ${width}x${height} needs a measured source picture rate`);
  }
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
