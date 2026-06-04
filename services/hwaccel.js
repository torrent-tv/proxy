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
import { readdirSync } from "node:fs";

const SOFTWARE_PRESET = "superfast";
const SOFTWARE_CRF = "24";
const TRANSCODE_FPS = 24;

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
    buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec }) {
      const { w, h } = safeDimensions(targetWidth, targetHeight);
      return [
        "-vf",
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${TRANSCODE_FPS}`,
        "-c:v", "libx264",
        "-preset", SOFTWARE_PRESET,
        "-crf", SOFTWARE_CRF,
        "-pix_fmt", "yuv420p",
        ...keyFrameArgs(segmentDurationSec)
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
    buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec }) {
      const { w, h } = safeDimensions(targetWidth, targetHeight);
      return [
        "-vf",
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${TRANSCODE_FPS}`,
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
  // ARM SoC (e.g. Raspberry Pi) stateful M2M encoder. No GPU scaler — scale in
  // software, then hand YUV420 frames to the hardware encoder.
  return {
    name: "h264_v4l2m2m",
    kind: "v4l2m2m",
    device: null,
    inputArgs: [],
    buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec }) {
      const { w, h } = safeDimensions(targetWidth, targetHeight);
      return [
        "-vf",
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${TRANSCODE_FPS},format=yuv420p`,
        "-c:v", "h264_v4l2m2m",
        "-b:v", "3M",
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
 * Kind-specific test-encode args that verify the encoder initialises and
 * encodes a few frames from a synthetic source.
 *
 * @param {VideoEncoderDescriptor} descriptor
 * @returns {string[]}
 */
function testEncodeArgs(descriptor) {
  const src = ["-f", "lavfi", "-i", "color=c=black:s=320x240:r=15:d=0.4"];
  switch (descriptor.kind) {
    case "vaapi":
      return [
        "-hide_banner", "-loglevel", "error",
        "-vaapi_device", String(descriptor.device),
        ...src,
        "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi",
        "-f", "null", "-"
      ];
    case "qsv":
      return [
        "-hide_banner", "-loglevel", "error",
        "-qsv_device", String(descriptor.device),
        ...src,
        "-vf", "hwupload=extra_hw_frames=16,format=qsv", "-c:v", "h264_qsv",
        "-f", "null", "-"
      ];
    case "nvenc":
      return ["-hide_banner", "-loglevel", "error", ...src, "-c:v", "h264_nvenc", "-f", "null", "-"];
    case "v4l2m2m":
      return [
        "-hide_banner", "-loglevel", "error",
        ...src, "-pix_fmt", "yuv420p", "-c:v", "h264_v4l2m2m", "-f", "null", "-"
      ];
    default:
      return [
        "-hide_banner", "-loglevel", "error",
        ...src, "-c:v", "libx264", "-preset", "ultrafast", "-f", "null", "-"
      ];
  }
}

/**
 * Detect the best usable H.264 encoder. Always resolves (falls back to
 * software libx264). Each hardware candidate is verified with a real
 * test-encode before being selected.
 *
 * @param {{ ffmpegBin: string, logger?: { info: (m: string) => void, warn: (m: string) => void } }} options
 * @returns {Promise<VideoEncoderDescriptor>}
 */
export async function detectVideoEncoder({ ffmpegBin, logger }) {
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
  if (has("h264_v4l2m2m") && hasV4l2Device()) {
    candidates.push(v4l2m2mDescriptor());
  }

  for (const candidate of candidates) {
    const result = await runFfmpeg(ffmpegBin, testEncodeArgs(candidate), 12000);
    if (result.code === 0) {
      log.info(
        `hwaccel: using hardware encoder ${candidate.name}` +
          `${candidate.device ? ` (${candidate.device})` : ""}`
      );
      return candidate;
    }
    log.warn(`hwaccel: ${candidate.name} present but test-encode failed; skipping`);
  }

  log.info("hwaccel: no working hardware encoder; using software libx264");
  return software;
}
