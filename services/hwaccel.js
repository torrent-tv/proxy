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
// Require the encoder to be this much faster than realtime for the target
// resolution. The benchmark runs at startup with an idle CPU; during playback
// ffmpeg competes with in-process WebTorrent (download + hashing) and delivery,
// so real throughput is lower. A generous margin keeps playback above 1× under
// that real load and absorbs complex scenes.
const PRESET_SPEED_MARGIN = 1.8;

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
 * independently decodable and exactly `segmentDurationSec` long.
 *
 * @param {number} segmentDurationSec
 * @returns {string[]}
 */
function keyFrameArgs(segmentDurationSec) {
  return ["-force_key_frames", `expr:gte(t,n_forced*${segmentDurationSec})`];
}

/** @returns {import("./hwaccel.js").VideoEncoderDescriptor} */
export function softwareDescriptor() {
  return {
    name: "libx264",
    kind: "software",
    device: null,
    inputArgs: [],
    buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec, preset, fps, tonemap }) {
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
        // `-force_key_frames expr:gte(t,n_forced*SEG)` broke after a seek because
        // `t` is offset by `-output_ts_offset`, forcing keyframes at the wrong
        // places.)
        "-g", String(segmentDurationSec * outFps),
        "-keyint_min", String(segmentDurationSec * outFps),
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
    buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec }) {
      const { w, h } = safeDimensions(targetWidth, targetHeight);
      return [
        "-vf",
        `scale_vaapi=w=${w}:h=${h}:force_original_aspect_ratio=decrease`,
        "-c:v", "h264_vaapi",
        "-qp", "24",
        ...keyFrameArgs(segmentDurationSec)
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
    buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec }) {
      const { w, h } = safeDimensions(targetWidth, targetHeight);
      return [
        "-vf", `scale_qsv=w=${w}:h=${h}`,
        "-c:v", "h264_qsv",
        "-global_quality", "24",
        ...keyFrameArgs(segmentDurationSec)
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
    buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec }) {
      const { w, h } = safeDimensions(targetWidth, targetHeight);
      return [
        "-vf",
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        "-c:v", "h264_nvenc",
        "-preset", "p4",
        "-cq", "24",
        "-pix_fmt", "yuv420p",
        ...keyFrameArgs(segmentDurationSec)
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
    buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec, fps }) {
      const { w, h } = safeDimensions(targetWidth, targetHeight);
      const outFps = Number.isInteger(fps) && fps > 0 ? fps : TRANSCODE_FPS;
      return [
        "-vf",
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${outFps},format=yuv420p`,
        "-c:v", "h264_v4l2m2m",
        "-b:v", "3M",
        "-g", String(outFps * segmentDurationSec),
        ...keyFrameArgs(segmentDurationSec)
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
 * @property {(opts: { targetWidth: number, targetHeight: number, segmentDurationSec: number }) => string[]} buildVideoArgs
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
      encode = ["-pix_fmt", "yuv420p", "-c:v", "h264_v4l2m2m", "-b:v", "3M", "-g", String(TRANSCODE_FPS * segmentDurationSec), ...kf];
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
    "-hls_segment_filename", path.join(outDir, "seg-%03d.ts"),
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
    files = readdirSync(outDir).filter((n) => /^seg-\d+\.ts$/.test(n)).sort();
  } catch {
    return false;
  }
  if (files.length < 2) {
    return false;
  }
  for (const file of files) {
    const result = await runFfmpeg(
      ffmpegBin,
      ["-hide_banner", "-loglevel", "error", "-i", path.join(outDir, file), "-f", "null", "-"],
      8000
    );
    if (result.code !== 0 || result.stderr.trim().length > 0) {
      return false;
    }
  }
  return true;
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
 * @returns {string}
 */
export function pickSoftwarePreset(benchmark, pixelsPerSecNeeded) {
  if (!Array.isArray(benchmark) || benchmark.length === 0) {
    return "ultrafast";
  }
  for (const entry of benchmark) {
    if (entry.pixelsPerSec >= pixelsPerSecNeeded * PRESET_SPEED_MARGIN) {
      return entry.preset;
    }
  }
  return benchmark[benchmark.length - 1].preset;
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
 * @returns {{ width: number, height: number, preset: string, ladder: Array<{ width: number, height: number }>, rungIndex: number } | null}
 */
export function chooseSoftwareEncodeSettings(benchmark, ceiling, outputFps) {
  if (!Array.isArray(benchmark) || benchmark.length === 0) {
    return null;
  }
  const fps = Number.isFinite(outputFps) && outputFps > 0 ? outputFps : TRANSCODE_FPS;
  const ladder = buildResolutionLadder(ceiling?.width, ceiling?.height);
  if (ladder.length === 0) {
    return null;
  }
  const fastest = benchmark[benchmark.length - 1].pixelsPerSec; // ultrafast throughput
  let chosenIndex = ladder.length - 1; // default: lowest rung (best effort)
  for (let i = 0; i < ladder.length; i += 1) {
    const needed = ladder[i].width * ladder[i].height * fps;
    if (fastest >= needed * PRESET_SPEED_MARGIN) {
      chosenIndex = i;
      break;
    }
  }
  const chosen = ladder[chosenIndex];
  const preset = pickSoftwarePreset(benchmark, chosen.width * chosen.height * fps);
  return { width: chosen.width, height: chosen.height, preset, ladder, rungIndex: chosenIndex };
}
