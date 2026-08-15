/**
 * @file Hardware-accelerated H.264 encoder auto-detection.
 *
 * Probes the ffmpeg build and the host for a usable hardware H.264 encoder
 * (NVENC / QSV / VAAPI / V4L2 M2M), verifying each candidate with a real
 * test-encode before selecting it. Falls back to software libx264 when no
 * hardware encoder is present or working.
 *
 * Deployment-agnostic: relies only on ffmpeg, the filesystem and
 * `process.platform`; makes no assumptions about Home Assistant or any
 * specific host. A garbled or unsupported hardware path simply fails its
 * test-encode and is skipped, so the worst case is software encoding.
 *
 * A descriptor exposes:
 *   - `name`        human-readable encoder id (e.g. "h264_vaapi")
 *   - `kind`        "software" | "vaapi" | "qsv" | "nvenc" | "v4l2m2m"
 *   - `device`      device node path or null
 *   - `inputArgs`   ffmpeg args inserted before `-i` (decode/hwaccel setup)
 *   - `buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec })`
 *                   ffmpeg video filter + encoder args inserted after `-map`s
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseFfmpegBitrateKbps,
  parseFfmpegDurationSeconds,
  parseFfmpegVideoDimensions,
  parseFfmpegVideoFps
} from "./ffmpeg-banner.js";

const SOFTWARE_PRESET = "ultrafast";
const SOFTWARE_CRF = "24";
// HDR→SDR tone-map chain (software). Converts a BT.2020 PQ/HLG source to BT.709
// 8-bit SDR so the re-encode is not washed-out/desaturated. Requires the
// `zscale` (libzimg) and `tonemap` filters — gated by detectTonemapSupport;
// when unavailable the encode falls back to a plain 8-bit convert (no tonemap).
// npl=100 targets ~100-nit SDR; hable is a well-behaved tone-mapping operator.
const TONEMAP_FILTER_CHAIN =
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
const CPU_THREADS = Math.max(1, os.cpus().length);

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
 * `-maxrate`/`-bufsize` args for an encode height (constrained CRF).
 *
 * @param {number} height
 * @returns {string[]}
 */
function bitrateCapArgs(height) {
  const nominal = nominalKbpsForHeight(height);
  return [
    "-maxrate", `${Math.round(nominal * CAP_MAXRATE_FACTOR)}k`,
    "-bufsize", `${Math.round(nominal * CAP_BUFSIZE_FACTOR)}k`
  ];
}

// libx264 presets to benchmark, ordered slowest/highest-quality → fastest.
const BENCHMARK_PRESETS = ["fast", "faster", "veryfast", "superfast", "ultrafast"];
const BENCHMARK_REF_W = 640;
const BENCHMARK_REF_H = 360;
const BENCHMARK_DURATION_SEC = 3;
// Require the predicted speed to clear realtime by this much. The benchmarks
// run at startup with an idle CPU; during playback ffmpeg competes with
// in-process WebTorrent (download + hashing) and delivery, so real throughput
// is lower, and the margin covers that plus complex scenes.
//
// It was 1.8 while the prediction counted ENCODING only and was therefore
// several times too optimistic on a re-encode; with the decode term the
// prediction is within ~13 % of measured, so the margin no longer has to stand
// in for a missing term as well as for load.
const PRESET_SPEED_MARGIN = 1.5;
// The bar for a prediction that has NO decode term — a host whose calibration
// clips are missing, or whose fit was rejected. That figure is the one the
// margin was 1.8 for, and lowering it there would make an uncalibrated host
// more permissive than it was before any of this existed.
const ENCODE_ONLY_SPEED_MARGIN = 1.8;

/**
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @returns {{ w: number, h: number }}
 */
function safeDimensions(targetWidth, targetHeight) {
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
function keyFrameArgs(segmentDurationSec, forcedTimes = null) {
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
function hasForcedTimes(forcedTimes) {
  return Array.isArray(forcedTimes) && forcedTimes.length > 0;
}

/** @returns {import("./hwaccel.js").VideoEncoderDescriptor} */
export function softwareDescriptor() {
  return {
    name: "libx264",
    kind: "software",
    device: null,
    inputArgs: [],
    buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec, preset, fps, tonemap, forcedKeyframeTimes }) {
      const { w, h } = safeDimensions(targetWidth, targetHeight);
      const chosenPreset = typeof preset === "string" && preset.length > 0 ? preset : SOFTWARE_PRESET;
      // Output frame rate: inherited from the source (rounded/capped) by the
      // session manager, TRANSCODE_FPS by default. MUST be an integer and MUST
      // equal the value used in the GOP below, or keyframes drift off the grid.
      const outFps = Number.isInteger(fps) && fps > 0 ? fps : TRANSCODE_FPS;
      // HDR→SDR tone-map, inserted AFTER the downscale so it runs on the smaller
      // frame (cheaper on ARM); only when the source is HDR and the filters are
      // present (session manager gates on both).
      const tonemapPart = tonemap === true ? `,${TONEMAP_FILTER_CHAIN}` : "";
      return [
        // Never upscale: cap the target box to the source size (min with
        // iw/ih), so a small source (e.g. 720x400) is encoded at its own
        // resolution instead of being scaled up to the viewport — far fewer
        // pixels, much faster on ARM. force_original_aspect_ratio keeps aspect.
        "-vf",
        `scale='min(${w},iw)':'min(${h},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2${tonemapPart},fps=${outFps}`,
        "-c:v", "libx264",
        // Preset is chosen per stream by the session manager from the startup
        // benchmark (highest quality that still encodes the source resolution
        // faster than realtime); falls back to the static default.
        "-preset", chosenPreset,
        "-crf", SOFTWARE_CRF,
        // Constrained CRF: bound peak bitrate per rung so a complex scene
        // cannot produce segments a thin viewer link (cellular) can't
        // download in time. Sized by the TARGET box height (the rung the
        // budget/manual selection chose).
        ...bitrateCapArgs(h),
        "-threads", String(CPU_THREADS),
        "-pix_fmt", "yuv420p",
        // Fixed GOP: a keyframe exactly every (segmentDurationSec × fps) frames,
        // scene-cut keyframes disabled. This is frame-count based, so it is
        // independent of the PTS offset used on seek-restart — every HLS segment
        // is exactly segmentDurationSec long and starts on a keyframe, so segment
        // boundaries line up with the synthetic playlist with no gaps. (The old
        // the OLD `expr:` form of -force_key_frames broke after a seek, because
        // the `t` it reads is shifted by `-output_ts_offset`.)
        //
        // An explicit cut LIST is a different thing and does work: verified by
        // running it, its times are on the run's own timeline — the same one
        // `-segment_times` is measured on — so both are given one list and
        // cannot drift apart. It replaces the frame-count GOP, which cannot
        // describe the source's keyframes because they are not evenly spaced.
        // `-g` stays as an upper bound on the interval: an extra keyframe
        // inside a segment costs a little bitrate and cuts nothing, while
        // leaving the interval unbounded means a driver that ignores the list
        // produces one enormous segment instead of a wrong but cut one.
        // `-keyint_min` goes, since a MINIMUM interval is the one thing that
        // could argue with a forced keyframe.
        "-g", String(segmentDurationSec * outFps),
        ...(hasForcedTimes(forcedKeyframeTimes)
          ? keyFrameArgs(segmentDurationSec, forcedKeyframeTimes)
          : ["-keyint_min", String(segmentDurationSec * outFps)]),
        "-sc_threshold", "0"
      ];
    }
  };
}

/**
 * @param {string} device
 * @returns {import("./hwaccel.js").VideoEncoderDescriptor}
 */
function vaapiDescriptor(device) {
  return {
    name: "h264_vaapi",
    kind: "vaapi",
    device,
    // Decode on the GPU into VAAPI surfaces; scale and encode stay on-GPU.
    inputArgs: ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", "-vaapi_device", device],
    // No fps filter: VAAPI inherits the source rate and keeps keyframes on the
    // grid via time-based -force_key_frames, so it already honours source fps.
    buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec, forcedKeyframeTimes }) {
      const { w, h } = safeDimensions(targetWidth, targetHeight);
      return [
        "-vf",
        `scale_vaapi=w=${w}:h=${h}:force_original_aspect_ratio=decrease`,
        "-c:v", "h264_vaapi",
        "-qp", "24",
        ...keyFrameArgs(segmentDurationSec, forcedKeyframeTimes)
      ];
    }
  };
}

/**
 * @param {string} device
 * @returns {import("./hwaccel.js").VideoEncoderDescriptor}
 */
function qsvDescriptor(device) {
  return {
    name: "h264_qsv",
    kind: "qsv",
    device,
    inputArgs: ["-hwaccel", "qsv", "-qsv_device", device],
    buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec, forcedKeyframeTimes }) {
      const { w, h } = safeDimensions(targetWidth, targetHeight);
      return [
        "-vf", `scale_qsv=w=${w}:h=${h}`,
        "-c:v", "h264_qsv",
        "-global_quality", "24",
        ...keyFrameArgs(segmentDurationSec, forcedKeyframeTimes)
      ];
    }
  };
}

/** @returns {import("./hwaccel.js").VideoEncoderDescriptor} */
function nvencDescriptor() {
  return {
    name: "h264_nvenc",
    kind: "nvenc",
    device: null,
    inputArgs: [],
    // No fps filter: NVENC is fast and places keyframes by time-based
    // -force_key_frames, so it inherits the exact source rate (fractional
    // included) with no need to round or cap. Same rationale as VAAPI/QSV.
    buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec, forcedKeyframeTimes }) {
      const { w, h } = safeDimensions(targetWidth, targetHeight);
      return [
        "-vf",
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        "-c:v", "h264_nvenc",
        "-preset", "p4",
        "-cq", "24",
        "-pix_fmt", "yuv420p",
        ...keyFrameArgs(segmentDurationSec, forcedKeyframeTimes)
      ];
    }
  };
}

/** @returns {import("./hwaccel.js").VideoEncoderDescriptor} */
function v4l2m2mDescriptor() {
  // ARM SoC (e.g. Raspberry Pi / HA Yellow) stateful M2M encoder. No GPU
  // scaler — scale in software, hand YUV420 frames to the hardware encoder.
  // `-g` aligns the GOP to the segment length so an IDR lands on every segment
  // boundary; this is verified by the keyframe-alignment test before use,
  // because v4l2m2m does not always honour these hints.
  return {
    name: "h264_v4l2m2m",
    kind: "v4l2m2m",
    device: null,
    inputArgs: [],
    buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec, fps, forcedKeyframeTimes }) {
      const { w, h } = safeDimensions(targetWidth, targetHeight);
      const outFps = Number.isInteger(fps) && fps > 0 ? fps : TRANSCODE_FPS;
      return [
        "-vf",
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${outFps},format=yuv420p`,
        "-c:v", "h264_v4l2m2m",
        // More capture buffers than the default 4 — the default deadlocks /
        // drops frames on the CM4 encoder ("All capture buffers returned to
        // userspace").
        "-num_capture_buffers", "32",
        "-b:v", "3M",
        // Kept even with an explicit cut list, as an upper bound on the
        // interval: this encoder is the one known not always to honour keyframe
        // hints, and without any bound a list it ignores yields one segment for
        // the whole file rather than a wrongly-cut one.
        "-g", String(outFps * segmentDurationSec),
        ...keyFrameArgs(segmentDurationSec, forcedKeyframeTimes)
      ];
    }
  };
}


/**
 * @typedef {Object} VideoEncoderDescriptor
 * @property {string} name
 * @property {"software"|"vaapi"|"qsv"|"nvenc"|"v4l2m2m"} kind
 * @property {string|null} device
 * @property {string[]} inputArgs
 * @property {(opts: { targetWidth: number, targetHeight: number, segmentDurationSec: number, preset?: string, fps?: number, tonemap?: boolean, forcedKeyframeTimes?: number[] | null }) => string[]} buildVideoArgs
 */

/**
 * Run ffmpeg and resolve with its exit code and captured output.
 *
 * @param {string} ffmpegBin
 * @param {string[]} args
 * @param {number} [timeoutMs=12000]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runFfmpeg(ffmpegBin, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    const finish = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ code, stdout, stderr });
    };
    try {
      child = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      finish(-1);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish(-1);
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(-1);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish(code ?? -1);
    });
  });
}

/** @returns {string[]} /dev/dri/renderD* nodes (VAAPI/QSV). */
function listRenderNodes() {
  try {
    return readdirSync("/dev/dri")
      .filter((n) => n.startsWith("renderD"))
      .map((n) => `/dev/dri/${n}`)
      .sort();
  } catch {
    return [];
  }
}

/** @returns {boolean} Whether any /dev/nvidia* node exists (NVENC). */
function hasNvidiaDevice() {
  try {
    return readdirSync("/dev").some((n) => /^nvidia(\d+)?$/.test(n));
  } catch {
    return false;
  }
}

/** @returns {boolean} Whether any /dev/video* node exists (V4L2 M2M). */
function hasV4l2Device() {
  try {
    return readdirSync("/dev").some((n) => /^video\d+$/.test(n));
  } catch {
    return false;
  }
}

/**
 * Build a full ffmpeg command that encodes a short, *moving* synthetic clip
 * (testsrc2 — far more representative than a static black frame) through the
 * candidate encoder into real HLS segments in `outDir`, with keyframes forced
 * on segment boundaries. Verifying the resulting segments (see
 * {@link verifySegmentsDecodeCleanly}) catches encoders that silently produce
 * a corrupted or non-IDR-aligned stream (e.g. some V4L2 M2M builds).
 *
 * @param {VideoEncoderDescriptor} descriptor
 * @param {number} segmentDurationSec
 * @param {string} outDir
 * @returns {string[]}
 */
function buildEncoderTestArgs(descriptor, segmentDurationSec, outDir) {
  const durationSec = Math.max(8, segmentDurationSec * 3);
  const source = ["-f", "lavfi", "-i", `testsrc2=s=640x360:r=${TRANSCODE_FPS}:d=${durationSec}`];
  const kf = keyFrameArgs(segmentDurationSec);

  /** @type {string[]} */
  let pre = ["-hide_banner", "-loglevel", "error"];
  /** @type {string[]} */
  let encode;
  switch (descriptor.kind) {
    case "vaapi":
      pre = [...pre, "-vaapi_device", String(descriptor.device)];
      encode = ["-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-qp", "24", ...kf];
      break;
    case "qsv":
      pre = [...pre, "-qsv_device", String(descriptor.device)];
      encode = ["-vf", "hwupload=extra_hw_frames=16,format=qsv", "-c:v", "h264_qsv", "-global_quality", "24", ...kf];
      break;
    case "nvenc":
      encode = ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "24", "-pix_fmt", "yuv420p", ...kf];
      break;
    case "v4l2m2m":
      encode = ["-pix_fmt", "yuv420p", "-c:v", "h264_v4l2m2m", "-num_capture_buffers", "32", "-b:v", "3M", "-g", String(TRANSCODE_FPS * segmentDurationSec), ...kf];
      break;
    default:
      encode = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...kf];
      break;
  }

  const hlsOut = [
    "-f", "hls",
    "-hls_time", String(segmentDurationSec),
    "-hls_list_size", "0",
    "-hls_flags", "independent_segments",
    // fMP4 (CMAF) — matches the runtime pipeline (hls-session-manager).
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", path.join(outDir, "seg-%03d.m4s"),
    path.join(outDir, "index.m3u8")
  ];
  return [...pre, ...source, ...encode, ...hlsOut];
}

/**
 * Verify the HLS segments produced by the test encode are valid: at least two
 * segments exist, and each decodes standalone without errors. A segment that
 * does not begin with a keyframe (broken/corrupted output) emits decode errors
 * when read on its own, which fails this check.
 *
 * @param {string} ffmpegBin
 * @param {string} outDir
 * @returns {Promise<boolean>}
 */
async function verifySegmentsDecodeCleanly(ffmpegBin, outDir) {
  let files;
  try {
    files = readdirSync(outDir).filter((n) => /^seg-\d+\.m4s$/.test(n));
  } catch {
    return false;
  }
  if (files.length < 2) {
    return false;
  }
  // fMP4: parameter sets (SPS/PPS) live in init.mp4, not in each segment.
  // Decode the whole playlist (ffmpeg's own, which references init.mp4 via
  // #EXT-X-MAP), so every segment is exercised together with the init. Any
  // corrupt / non-conformant segment (e.g. some V4L2 M2M builds emit a stray
  // no-picture access unit) surfaces as a decode error here.
  const result = await runFfmpeg(
    ffmpegBin,
    ["-hide_banner", "-loglevel", "error", "-i", path.join(outDir, "index.m3u8"), "-f", "null", "-"],
    12000
  );
  return result.code === 0 && result.stderr.trim().length === 0;
}

/**
 * Detect the best usable H.264 encoder. Always resolves (falls back to
 * software libx264). Each hardware candidate is verified with a real
 * test-encode before being selected.
 *
 * @param {{ ffmpegBin: string, logger?: { info: (m: string) => void, warn: (m: string) => void }, segmentDurationSec?: number }} options
 * @returns {Promise<VideoEncoderDescriptor>}
 */
export async function detectVideoEncoder({ ffmpegBin, logger, segmentDurationSec = 4 }) {
  const log = logger ?? { info: () => {}, warn: () => {} };
  const software = softwareDescriptor();

  const { code, stdout } = await runFfmpeg(ffmpegBin, ["-hide_banner", "-encoders"], 10000);
  if (code !== 0) {
    log.warn("hwaccel: could not list ffmpeg encoders; using software libx264");
    return software;
  }
  const has = (name) => stdout.includes(name);

  /** @type {VideoEncoderDescriptor[]} */
  const candidates = [];
  const renderNodes = listRenderNodes();
  if (has("h264_nvenc") && hasNvidiaDevice()) {
    candidates.push(nvencDescriptor());
  }
  if (has("h264_qsv") && renderNodes.length > 0) {
    candidates.push(qsvDescriptor(renderNodes[0]));
  }
  if (has("h264_vaapi") && renderNodes.length > 0) {
    candidates.push(vaapiDescriptor(renderNodes[0]));
  }
  // h264_v4l2m2m (ARM SoC / Raspberry Pi / HA Yellow). It is gated behind the
  // strict keyframe-alignment test below, because some V4L2 M2M builds silently
  // emit a corrupted / non-IDR-aligned stream; the test rejects those and the
  // host falls back to software libx264.
  if (has("h264_v4l2m2m") && hasV4l2Device()) {
    candidates.push(v4l2m2mDescriptor());
  }

  for (const candidate of candidates) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tt-hwtest-"));
    let ok = false;
    try {
      const encoded = await runFfmpeg(
        ffmpegBin,
        buildEncoderTestArgs(candidate, segmentDurationSec, dir),
        25000
      );
      if (encoded.code === 0) {
        ok = await verifySegmentsDecodeCleanly(ffmpegBin, dir);
      }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    if (ok) {
      log.info(
        `hwaccel: using hardware encoder ${candidate.name}` +
          `${candidate.device ? ` (${candidate.device})` : ""}`
      );
      return candidate;
    }
    log.warn(`hwaccel: ${candidate.name} failed the HLS keyframe-alignment test; skipping`);
  }

  log.info("hwaccel: no working hardware encoder; using software libx264");
  return software;
}

/**
 * Detect whether this ffmpeg build has the filters needed for the HDR→SDR
 * tone-map chain (`zscale`, from libzimg, and `tonemap`). Both are required;
 * when either is missing, HDR sources are re-encoded without tone mapping
 * (washed-out but playable). Always resolves.
 *
 * @param {{ ffmpegBin: string, logger?: { info: (m: string) => void, warn: (m: string) => void } }} options
 * @returns {Promise<boolean>}
 */
export async function detectTonemapSupport({ ffmpegBin, logger }) {
  const log = logger ?? { info: () => {}, warn: () => {} };
  const { code, stdout } = await runFfmpeg(ffmpegBin, ["-hide_banner", "-filters"], 10000);
  if (code !== 0) {
    log.warn("hwaccel: could not list ffmpeg filters; HDR tone mapping disabled");
    return false;
  }
  // `-filters` prints one filter per line: "... zscale  ...", "... tonemap ...".
  const hasZscale = /\bzscale\b/.test(stdout);
  const hasTonemap = /\btonemap\b/.test(stdout);
  const supported = hasZscale && hasTonemap;
  log.info(
    `hwaccel: HDR tone mapping ${supported ? "available" : "unavailable"} ` +
      `(zscale=${hasZscale} tonemap=${hasTonemap})`
  );
  return supported;
}

/**
 * Solve a 3×3 linear system by Gaussian elimination with partial pivoting.
 *
 * @param {number[][]} rows - Three rows of [c0, c1, c2, rhs].
 * @returns {number[] | null} The three unknowns, or null when singular.
 */
function solveLinear3(rows) {
  const m = rows.map((row) => [...row]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(m[pivot][col]) < 1e-12) {
      return null;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = 0; row < 3; row += 1) {
      if (row === col) {
        continue;
      }
      const factor = m[row][col] / m[col][col];
      for (let k = col; k < 4; k += 1) {
        m[row][k] -= factor * m[col][k];
      }
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

// The clips the decode cost is solved from. They ship with the package
// (`assets/calibration/`), cut from Netflix Open Content "Meridian" (CC-BY 4.0)
// — real, grainy live action, because a generated `testsrc2` clip decodes 158 %
// away from a real film where these are 11 % away (measured 2026-08-14). Two
// share a pixel count and differ 11.7× in bitrate, the third has the same
// bitrate class at fewer pixels: three points, three unknowns.
const CALIBRATION_CLIPS = ["cal-1080-hi.mp4", "cal-1080-lo.mp4", "cal-720.mp4"];
const CALIBRATION_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "calibration");
// How wide the measured window must be before the slope is trusted, and how
// long to wait for it at most. A second of decoding is thousands of frames on a
// quick host and dozens on a weak one; both give a slope, and neither costs the
// startup more than a second per clip.
const DECODE_WINDOW_MIN_SEC = 1;
const DECODE_WINDOW_MAX_MS = 8000;

/**
 * Read what a calibration clip IS from the decode run's own output: the
 * dimensions, the frame rate and the bitrate ffmpeg reports for it. Read rather
 * than declared, so replacing a clip cannot silently invalidate the fit.
 *
 * @param {string} stderr
 * @returns {{ megapixelsPerSecond: number, megabitsPerSecond: number, durationSeconds: number } | null}
 */
function parseClipCharacteristics(stderr) {
  // The same readers the session manager uses on the same banner — one parser
  // per fact, so a second copy cannot drift from the first.
  const { width, height } = parseFfmpegVideoDimensions(stderr);
  const rate = parseFfmpegVideoFps(stderr);
  const seconds = parseFfmpegDurationSeconds(stderr);
  const kbps = parseFfmpegBitrateKbps(stderr);
  if (!(width > 0) || !(height > 0) || !(rate > 0) || !(seconds > 0) || !(kbps > 0)) {
    return null;
  }
  return {
    megapixelsPerSecond: (width * height * rate) / 1e6,
    megabitsPerSecond: kbps / 1000,
    durationSeconds: seconds
  };
}

/**
 * Measure what DECODING costs on this host, as seconds of work per second of
 * video, and solve it into three host constants:
 *
 *   decodeCost = a × Mpixel/s + b × Mbit/s + c
 *
 * Why it exists: the preset benchmark below measures ENCODING only, and a
 * re-encode pays for both halves. Measured 2026-08-14 on the addon host, that
 * omission made the budget offer a 240p rung it then ran at 0.39-0.95× — the
 * benchmark said the host cleared the bar 2.5× over. With the decode term the
 * same file predicts within 4.8 %; without it the error on that rung was 209 %.
 *
 * The constants are properties of the HOST, so this runs once at startup (about
 * 5 s on a CM4) and any source is then priced from figures the probe already
 * has — nothing is added to a session's cold start.
 *
 * They are also properties of the CODEC, and the clips are H.264: HEVC, AV1 and
 * 10-bit decode dearer per pixel on the same machine, and a source that has to
 * be re-encoded is by definition one this browser could not play, which is
 * usually not H.264. So the fit is optimistic exactly there. Closing that needs
 * clips in those codecs, and is its own roadmap item.
 *
 * @param {{ ffmpegBin: string, logger?: { info: (m: string) => void, warn: (m: string) => void }, clipsDir?: string }} options
 * @returns {Promise<{ pixelTerm: number, bitrateTerm: number, constantTerm: number } | null>}
 */
export async function benchmarkDecodeCost({ ffmpegBin, logger, clipsDir = CALIBRATION_DIR }) {
  const log = logger ?? { info: () => {}, warn: () => {} };
  const startedAllAt = Date.now();
  /** @type {number[][]} */
  const equations = [];
  for (const clip of CALIBRATION_CLIPS) {
    const measured = await measureDecodeSlope(ffmpegBin, path.join(clipsDir, clip));
    if (!measured) {
      log.warn(`hwaccel: decode benchmark "${clip}" failed or said nothing; decode cost unknown`);
      return null;
    }
    const cost = 1 / measured.speed;
    equations.push([measured.megapixelsPerSecond, measured.megabitsPerSecond, 1, cost]);
    log.info(
      `hwaccel: decode "${clip}" ${measured.megapixelsPerSecond.toFixed(1)} Mpx/s ` +
        `${measured.megabitsPerSecond.toFixed(2)} Mbit/s -> ${measured.speed.toFixed(1)}x ` +
        `(cost ${cost.toFixed(4)} s/s, over ${measured.windowSec.toFixed(1)}s of decoding)`
    );
  }
  const fitted = fitDecodeCost(equations);
  if (!fitted) {
    log.warn("hwaccel: decode cost could not be fitted to these measurements; decode cost unknown");
    return null;
  }
  log.info(
    `hwaccel: decode cost = ${fitted.pixelTerm.toFixed(6)} × Mpx/s + ${fitted.bitrateTerm.toFixed(6)} × Mbit/s ` +
      `+ ${fitted.constantTerm.toFixed(4)} s/s (${fitted.shape}, measured in ${((Date.now() - startedAllAt) / 1000).toFixed(1)}s)`
  );
  return { pixelTerm: fitted.pixelTerm, bitrateTerm: fitted.bitrateTerm, constantTerm: fitted.constantTerm };
}

/**
 * Measure how fast this host DECODES a clip, from ffmpeg’s own report of how
 * much video it has processed.
 *
 * Wall-clock around the process cannot answer this: starting ffmpeg costs about
 * a second, and on a quick machine a five-second clip decodes in a tenth of
 * that, so the measurement would be of the program starting. Progress lines
 * arrive twice a second AFTER it has started, and the slope between two of them
 * — video processed against time taken — contains no part of the startup by
 * construction.
 *
 * The clip is looped forever and the process killed as soon as the window is
 * wide enough, so the cost is bounded by the clock rather than by the clip:
 * roughly a second of measurement on any host, quick or slow.
 *
 * @param {string} ffmpegBin
 * @param {string} clipPath
 * @returns {Promise<{ speed: number, windowSec: number, megapixelsPerSecond: number, megabitsPerSecond: number } | null>}
 */
function measureDecodeSlope(ffmpegBin, clipPath) {
  return new Promise((resolve) => {
    const args = [
      "-hide_banner", "-loglevel", "info", "-nostats",
      "-stream_loop", "-1",
      "-i", clipPath,
      "-an", "-f", "null", "-",
      "-progress", "pipe:1"
    ];
    /** @type {Array<{ wallSec: number, outSec: number }>} */
    const samples = [];
    let stderr = "";
    let stdout = "";
    let settled = false;
    let child;
    const startedAt = Date.now();
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
      // The first sample is the one that still carries the startup — it reports
      // whatever was processed while the process was coming up. Everything is
      // measured from the second onwards.
      const first = samples[1];
      const last = samples[samples.length - 1];
      const clipInfo = parseClipCharacteristics(stderr);
      if (!first || !last || !clipInfo) {
        resolve(null);
        return;
      }
      const windowSec = last.wallSec - first.wallSec;
      const producedSec = last.outSec - first.outSec;
      if (!(windowSec >= DECODE_WINDOW_MIN_SEC) || !(producedSec > 0)) {
        resolve(null);
        return;
      }
      resolve({
        speed: producedSec / windowSec,
        windowSec,
        megapixelsPerSecond: clipInfo.megapixelsPerSecond,
        megabitsPerSecond: clipInfo.megabitsPerSecond
      });
    };
    const timer = setTimeout(finish, DECODE_WINDOW_MAX_MS);
    try {
      child = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      // The timer would otherwise hold the event loop for its full wait and
      // then run against a child that was never created.
      clearTimeout(timer);
      settled = true;
      resolve(null);
      return;
    }
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line.startsWith("out_time_ms=")) {
          const microseconds = Number(line.slice("out_time_ms=".length));
          if (Number.isFinite(microseconds)) {
            samples.push({ wallSec: (Date.now() - startedAt) / 1000, outSec: microseconds / 1e6 });
          }
        }
        newline = stdout.indexOf("\n");
      }
      if (samples.length >= 2 && samples[samples.length - 1].wallSec - samples[1].wallSec >= DECODE_WINDOW_MIN_SEC) {
        finish();
      }
    });
    child.on("error", () => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      resolve(null);
    });
    child.on("close", finish);
  });
}

/**
 * Fit the three measurements, and say which shape the data supported.
 *
 * The three-term fit is exact — three points, three unknowns — and is used
 * whenever every term comes out non-negative. A negative term is not a host
 * being odd; it says the difference it was solved from is smaller than the
 * noise between runs, which is what a fast machine produces: measured on a
 * desktop, the 720p clip took LONGER per second than the low-bitrate 1080p one,
 * because process startup is a large share of a decode that takes a second.
 *
 * When that happens the bitrate term — the weak one, and the one solved from a
 * single difference — is dropped and the remaining two are fitted by least
 * squares over all three points. If even the pixel slope comes out non-positive
 * there is no measurable dependence on the source at all, and inventing one is
 * worse than having none: the caller then prices the encoder alone and refuses
 * nothing.
 *
 * @param {number[][]} equations - Rows of [Mpixel/s, Mbit/s, 1, cost].
 * @returns {{ pixelTerm: number, bitrateTerm: number, constantTerm: number, shape: string } | null}
 */
function fitDecodeCost(equations) {
  const exact = solveLinear3(equations);
  if (exact && exact[0] > 0 && exact[1] >= 0 && exact[2] >= 0) {
    return { pixelTerm: exact[0], bitrateTerm: exact[1], constantTerm: exact[2], shape: "pixels+bitrate+constant" };
  }
  const count = equations.length;
  const meanPixels = equations.reduce((sum, row) => sum + row[0], 0) / count;
  const meanCost = equations.reduce((sum, row) => sum + row[3], 0) / count;
  let covariance = 0;
  let variance = 0;
  for (const row of equations) {
    covariance += (row[0] - meanPixels) * (row[3] - meanCost);
    variance += (row[0] - meanPixels) ** 2;
  }
  if (!(variance > 0)) {
    return null;
  }
  const pixelTerm = covariance / variance;
  const constantTerm = meanCost - pixelTerm * meanPixels;
  if (pixelTerm > 0 && constantTerm >= 0) {
    return { pixelTerm, bitrateTerm: 0, constantTerm, shape: "pixels+constant" };
  }
  // A negative constant is the line crossing below zero where no clip was
  // measured — every clip is 22 Mpixel/s or more, and nothing here says what a
  // tiny picture costs. Rather than carry a term that would price a small
  // source as free work, fit through the origin: cost proportional to pixels,
  // which is the relationship the measurements do support.
  let weighted = 0;
  let squares = 0;
  for (const row of equations) {
    weighted += row[0] * row[3];
    squares += row[0] ** 2;
  }
  const throughOrigin = squares > 0 ? weighted / squares : 0;
  if (!(throughOrigin > 0)) {
    return null;
  }
  return { pixelTerm: throughOrigin, bitrateTerm: 0, constantTerm: 0, shape: "pixels only" };
}

/**
 * How many times realtime this host can DECODE a source of these
 * characteristics, from the startup fit. `null` when the fit is unavailable or
 * the source figures are not known.
 *
 * @param {{ pixelTerm: number, bitrateTerm: number, constantTerm: number } | null} model
 * @param {{ megapixelsPerSecond: number, megabitsPerSecond: number }} source
 * @returns {number | null}
 */
export function decodeSpeedFor(model, source) {
  if (!model) {
    return null;
  }
  const pixels = Number(source?.megapixelsPerSecond);
  const bits = Number(source?.megabitsPerSecond);
  if (!Number.isFinite(pixels) || pixels <= 0 || !Number.isFinite(bits) || bits < 0) {
    return null;
  }
  const cost = model.pixelTerm * pixels + model.bitrateTerm * bits + model.constantTerm;
  if (!(cost > 0)) {
    return null;
  }
  return 1 / cost;
}

/**
 * How many times realtime a re-encode of this source at this output pixel rate
 * would run: decoding and encoding share the machine, so their costs add and
 * their speeds combine as
 *
 *   1 / (1/decodeSpeed + 1/encodeSpeed)
 *
 * Checked 2026-08-14 on the rung that broke playback: 1/(1/2.31 + 1/5.99) =
 * 1.67× against 1.48× measured. With no decode fit this falls back to the
 * encode speed alone — which is what the budget did before, and which
 * overestimated that rung five to eleven times.
 *
 * @param {{ decodeModel: { pixelTerm: number, bitrateTerm: number, constantTerm: number } | null, encodePixelsPerSec: number, outputPixelsPerSec: number, source: { megapixelsPerSecond: number, megabitsPerSecond: number } | null }} params
 * @returns {number | null}
 */
export function predictedRealtimeSpeed({
  decodeModel,
  encodePixelsPerSec,
  outputPixelsPerSec,
  source,
  observedDecodeCostSec = null
}) {
  if (!Number.isFinite(encodePixelsPerSec) || encodePixelsPerSec <= 0) {
    return null;
  }
  if (!Number.isFinite(outputPixelsPerSec) || outputPixelsPerSec <= 0) {
    return null;
  }
  const encodeSpeed = encodePixelsPerSec / outputPixelsPerSec;
  // What this very file has been seen to cost, when it has been: the clips are
  // H.264 and a source that has to be re-encoded usually is not, so a figure
  // taken from the encoder actually running on THIS source beats any model of
  // a stand-in. It arrives seconds into playback and replaces the estimate.
  const decodeSpeed = Number.isFinite(observedDecodeCostSec) && observedDecodeCostSec > 0
    ? 1 / observedDecodeCostSec
    : (source ? decodeSpeedFor(decodeModel, source) : null);
  if (decodeSpeed === null) {
    return encodeSpeed;
  }
  return 1 / (1 / decodeSpeed + 1 / encodeSpeed);
}

/**
 * Whether this host can hold realtime, with the margin, while re-encoding this
 * source to this output pixel rate — and the predicted speed either way, so a
 * refusal can say what it refused on.
 *
 * The encoder figure is the FASTEST benchmarked preset: it is the best this
 * host can do, so a rung it cannot hold cannot be held at any quality setting.
 *
 * @param {{ benchmark: Array<{ preset: string, pixelsPerSec: number }>, decodeModel?: object | null, source?: { megapixelsPerSecond: number, megabitsPerSecond: number } | null, outputPixelsPerSec: number }} params
 * @returns {{ speed: number | null, sustainable: boolean }}
 */
export function canSustainOutput({
  benchmark,
  decodeModel = null,
  source = null,
  outputPixelsPerSec,
  observedDecodeCostSec = null
}) {
  if (!Array.isArray(benchmark) || benchmark.length === 0) {
    // Nothing measured on this host: the budget cannot refuse what it cannot
    // price, and refusing everything would leave a viewer with no rung at all.
    return { speed: null, sustainable: true };
  }
  const observed = Number.isFinite(observedDecodeCostSec) && observedDecodeCostSec > 0
    ? observedDecodeCostSec
    : null;
  if (observed === null && !isDecodePriced({ decodeModel, source })) {
    // An encoder-only figure was several times too optimistic on the rung this
    // check exists for, so it is not fit to refuse anything. Without the decode
    // term the ladder is offered whole, exactly as it was before.
    return { speed: null, sustainable: true };
  }
  const speed = predictedRealtimeSpeed({
    decodeModel,
    encodePixelsPerSec: benchmark[benchmark.length - 1].pixelsPerSec,
    outputPixelsPerSec,
    source,
    observedDecodeCostSec: observed
  });
  if (speed === null) {
    return { speed: null, sustainable: true };
  }
  return { speed, sustainable: speed >= PRESET_SPEED_MARGIN };
}

/** The margin a predicted speed must clear to be offered. */
export const REALTIME_SPEED_MARGIN = PRESET_SPEED_MARGIN;

/**
 * Benchmark software libx264 presets on this host. Encodes a short synthetic
 * clip at a fixed reference resolution with each preset and measures encoder
 * throughput in pixels/second. The session manager uses this to pick, per
 * stream, the highest-quality preset that still encodes the actual
 * (source-capped) resolution faster than realtime.
 *
 * Runs once at startup; bounded by a per-encode timeout. Presets that fail are
 * omitted from the result.
 *
 * @param {{ ffmpegBin: string, logger?: { info: (m: string) => void, warn: (m: string) => void } }} options
 * @returns {Promise<Array<{ preset: string, pixelsPerSec: number }>>} Ordered slowest→fastest.
 */
export async function benchmarkSoftwarePresets({ ffmpegBin, logger }) {
  const log = logger ?? { info: () => {}, warn: () => {} };
  const totalPixels = BENCHMARK_REF_W * BENCHMARK_REF_H * TRANSCODE_FPS * BENCHMARK_DURATION_SEC;
  /** @type {Array<{ preset: string, pixelsPerSec: number }>} */
  const results = [];
  for (const preset of BENCHMARK_PRESETS) {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc2=s=${BENCHMARK_REF_W}x${BENCHMARK_REF_H}:r=${TRANSCODE_FPS}:d=${BENCHMARK_DURATION_SEC}`,
      "-c:v", "libx264", "-preset", preset, "-crf", SOFTWARE_CRF, "-pix_fmt", "yuv420p",
      "-f", "null", "-"
    ];
    const startedAt = Date.now();
    const { code } = await runFfmpeg(ffmpegBin, args, 30000);
    const elapsedSec = (Date.now() - startedAt) / 1000;
    if (code !== 0 || elapsedSec <= 0) {
      log.warn(`hwaccel: preset benchmark "${preset}" failed; skipping`);
      continue;
    }
    const pixelsPerSec = totalPixels / elapsedSec;
    results.push({ preset, pixelsPerSec });
    log.info(
      `hwaccel: preset "${preset}" ~= ${(pixelsPerSec / 1e6).toFixed(1)} Mpx/s ` +
        `(${(BENCHMARK_DURATION_SEC / elapsedSec).toFixed(2)}x @ ${BENCHMARK_REF_W}x${BENCHMARK_REF_H})`
    );
  }
  return results;
}

/**
 * Pick the highest-quality (slowest) benchmarked preset that can encode
 * `pixelsPerSecNeeded` with the speed margin. Falls back to the fastest
 * benchmarked preset, or `"ultrafast"` when no benchmark is available.
 *
 * @param {Array<{ preset: string, pixelsPerSec: number }>} benchmark - slowest→fastest
 * @param {number} pixelsPerSecNeeded
 * @param {{ decodeModel?: object | null, source?: { megapixelsPerSecond: number, megabitsPerSecond: number } | null }} [cost]
 * @returns {string}
 */
export function pickSoftwarePreset(benchmark, pixelsPerSecNeeded, cost = {}) {
  if (!Array.isArray(benchmark) || benchmark.length === 0) {
    return "ultrafast";
  }
  const observed = Number.isFinite(cost?.observedDecodeCostSec) && cost.observedDecodeCostSec > 0
    ? cost.observedDecodeCostSec
    : null;
  const priced = isDecodePriced(cost);
  const bar = priced ? PRESET_SPEED_MARGIN : ENCODE_ONLY_SPEED_MARGIN;
  for (const entry of benchmark) {
    const speed = predictedRealtimeSpeed({
      decodeModel: cost.decodeModel ?? null,
      encodePixelsPerSec: entry.pixelsPerSec,
      outputPixelsPerSec: pixelsPerSecNeeded,
      source: cost.source ?? null,
      observedDecodeCostSec: observed
    });
    if (speed !== null && speed >= bar) {
      return entry.preset;
    }
  }
  return benchmark[benchmark.length - 1].preset;
}

/**
 * Whether a cost description can actually price decoding — a fit AND a source
 * to apply it to. Without both, every prediction is encoder-only.
 *
 * @param {{ decodeModel?: object | null, source?: object | null }} cost
 * @returns {boolean}
 */
function isDecodePriced(cost) {
  if (Number.isFinite(cost?.observedDecodeCostSec) && cost.observedDecodeCostSec > 0) {
    return true; // measured on the source itself, which needs no fit to stand on
  }
  return Boolean(cost?.decodeModel) && Boolean(cost?.source);
}

// Resolution-ladder heights (output height rungs), high→low. The ladder is
// derived per-stream from the ceiling (the client-requested, source-capped
// output box): only rungs at or below the ceiling height are used, so the
// budget never upscales past what the client asked for. Standard heights keep
// the downscaled output at familiar resolutions.
const RESOLUTION_LADDER_HEIGHTS = [2160, 1440, 1080, 720, 540, 480, 360, 240];

/**
 * Build the resolution ladder for a ceiling box. Returns candidate output
 * dimensions from the ceiling downward, preserving the ceiling's aspect ratio,
 * each even-sized. The ceiling itself is always the top rung; ladder heights
 * at or above it are skipped (never upscale). Deduped by height.
 *
 * @param {number} ceilingWidth
 * @param {number} ceilingHeight
 * @returns {Array<{ width: number, height: number }>} high→low
 */
export function buildResolutionLadder(ceilingWidth, ceilingHeight) {
  const cw = Number.isInteger(ceilingWidth) && ceilingWidth > 0 ? ceilingWidth : 0;
  const ch = Number.isInteger(ceilingHeight) && ceilingHeight > 0 ? ceilingHeight : 0;
  if (!cw || !ch) {
    return [];
  }
  const even = (v) => {
    const r = Math.round(v);
    return Math.max(2, r - (r % 2));
  };
  /** @type {Array<{ width: number, height: number }>} */
  const rungs = [{ width: cw, height: ch }];
  for (const h of RESOLUTION_LADDER_HEIGHTS) {
    if (h >= ch) {
      continue; // at/above the ceiling — the ceiling rung already covers it
    }
    rungs.push({ width: even(cw * (h / ch)), height: h });
  }
  const seen = new Set();
  return rungs.filter((rung) => {
    if (seen.has(rung.height)) {
      return false;
    }
    seen.add(rung.height);
    return true;
  });
}

/**
 * Choose the software encode settings (resolution + preset) that fit the
 * realtime budget on this host. From the resolution ladder (ceiling downward),
 * pick the HIGHEST rung whose encode throughput — predicted from the startup
 * benchmark's fastest preset — clears realtime × PRESET_SPEED_MARGIN. Then, at
 * that resolution, pick the highest-quality preset that still clears the
 * margin. When even the lowest rung cannot clear it, use the lowest rung with
 * the fastest preset (best effort — a smaller picture beats sub-realtime
 * playback at full size). Returns null when no benchmark or ceiling is
 * available (the caller keeps the ceiling resolution and the default preset).
 *
 * @param {Array<{ preset: string, pixelsPerSec: number }>} benchmark - slowest→fastest
 * @param {{ width: number, height: number }} ceiling
 * @param {number} outputFps
 * @param {{ decodeModel?: object | null, source?: { megapixelsPerSecond: number, megabitsPerSecond: number } | null }} [cost]
 * @returns {{ width: number, height: number, preset: string, ladder: Array<{ width: number, height: number }>, rungIndex: number } | null}
 */
export function chooseSoftwareEncodeSettings(benchmark, ceiling, outputFps, cost = {}) {
  if (!Array.isArray(benchmark) || benchmark.length === 0) {
    return null;
  }
  const fps = Number.isFinite(outputFps) && outputFps > 0 ? outputFps : TRANSCODE_FPS;
  const ladder = buildResolutionLadder(ceiling?.width, ceiling?.height);
  if (ladder.length === 0) {
    return null;
  }
  const fastest = benchmark[benchmark.length - 1].pixelsPerSec; // ultrafast throughput
  const bar = isDecodePriced(cost) ? PRESET_SPEED_MARGIN : ENCODE_ONLY_SPEED_MARGIN;
  let chosenIndex = ladder.length - 1; // default: lowest rung (best effort)
  for (let i = 0; i < ladder.length; i += 1) {
    const speed = predictedRealtimeSpeed({
      decodeModel: cost.decodeModel ?? null,
      encodePixelsPerSec: fastest,
      outputPixelsPerSec: ladder[i].width * ladder[i].height * fps,
      source: cost.source ?? null
    });
    if (speed !== null && speed >= bar) {
      chosenIndex = i;
      break;
    }
  }
  const chosen = ladder[chosenIndex];
  const preset = pickSoftwarePreset(benchmark, chosen.width * chosen.height * fps, cost);
  return { width: chosen.width, height: chosen.height, preset, ladder, rungIndex: chosenIndex };
}
