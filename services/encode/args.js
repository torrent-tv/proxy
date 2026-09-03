/**
 * @file The arithmetic every encoder kind is built from: the output frame rate,
 * the bitrate ladder and its caps, the frame box, and the keyframe arguments.
 *
 * Taken out of `hwaccel.js` so the kind classes beside this file do not have to
 * import the detection and benchmarking that happen to live there. The
 * dependency runs one way — `hwaccel.js` imports this, never the reverse — and
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

// Bitrate caps (constrained CRF). CRF stays the quality driver; -maxrate/
// -bufsize only bound the peaks. Field evidence (iPhone on cellular,
// 2026-07-10): uncapped complex scenes produced 4 s segments of ~18 Mbit/s
// against a 1-6 Mbit/s viewer link — 45 s prebuffer, draining buffer.
// Nominal H.264 rates per rung height; multipliers from webtor's production
// ladder (content-transcoder): maxrate = 1.3x nominal, bufsize = 1.5x.
const RUNG_NOMINAL_KBPS = [
  [1080, 5000],
  [720, 2800],
  [480, 1400],
  [360, 800],
  [240, 400]
];
const CAP_MAXRATE_FACTOR = 1.3;
const CAP_BUFSIZE_FACTOR = 1.5;

/**
 * Nominal kbps for an encode height: nearest rung wins (odd heights snap to
 * the closest standard rung; anything above the top rung uses the top one).
 *
 * @param {number} height
 * @returns {number}
 */
export function nominalKbpsForHeight(height) {
  const h = Number.isFinite(height) && height > 0 ? height : 720;
  let best = RUNG_NOMINAL_KBPS[0];
  for (const rung of RUNG_NOMINAL_KBPS) {
    if (Math.abs(rung[0] - h) < Math.abs(best[0] - h)) {
      best = rung;
    }
  }
  return best[1];
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
 * The nominal rate whose cap is a given peak — the inverse of
 * {@link maxrateKbpsFor}.
 *
 * Used to turn a MEASURED limit into the figure the cap arithmetic takes. The
 * viewer's usable link is a peak the stream must not exceed, and the encoder is
 * configured from a nominal rate, so the two are converted through the one
 * factor rather than through a second constant invented for the purpose.
 *
 * @param {number} maxrateKbps
 * @returns {number}
 */
export function nominalKbpsForMaxrate(maxrateKbps) {
  return Math.round(maxrateKbps / CAP_MAXRATE_FACTOR);
}

/**
 * `-maxrate`/`-bufsize` args for an encode height (constrained CRF).
 *
 * `nominalKbps` overrides the height's own nominal rate. It is how a measured
 * limit — the viewer's link, the only figure that bounds an encode from
 * outside this host — reaches the encoder without touching the picture's SIZE.
 * That distinction is the whole point: `-maxrate`, `-bufsize` and CRF do not
 * appear in the SPS (x264 writes no HRD parameters by default), so they can be
 * moved in the middle of a session while one init segment goes on describing
 * every fragment. The size cannot.
 *
 * @param {number} height
 * @param {number | null} [nominalKbps=null]
 * @returns {string[]}
 */
export function bitrateCapArgs(height, nominalKbps = null) {
  const nominal = Number.isFinite(nominalKbps) && nominalKbps > 0
    ? nominalKbps
    : nominalKbpsForHeight(height);
  return [
    "-maxrate", `${maxrateKbpsFor(nominal)}k`,
    "-bufsize", `${Math.round(nominal * CAP_BUFSIZE_FACTOR)}k`
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
