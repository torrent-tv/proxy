/**
 * @file Which configuration a measurement of encoding was taken on (roadmap
 * item 97, step 14).
 *
 * A figure about encoding is a figure about ONE configuration: this ffmpeg
 * build, this libx264, this processor with this many threads, or this device
 * with this driver. The same film encoded on another build or another driver
 * is not the same measurement, and a figure kept across such a change would be
 * applied to something it was never taken on.
 *
 * So every figure this proxy keeps between runs is filed under the key of the
 * configuration it describes, and a figure whose key no longer matches is not
 * used — not converted, not scaled, simply not matched.
 *
 * The key is per ENCODER, not per host. A host whose graphics driver changes
 * keeps what it knows about its software encoder: that encoder has not
 * changed, so nothing it was measured doing has changed either.
 *
 * WHAT IS READ, and where. None of it is chosen:
 *
 * 1. the ffmpeg build — the first line of `ffmpeg -version`;
 * 2. the libx264 build — the version string x264 writes into every stream it
 *    produces (`x264 - core N rNNNN hash`), read from one encoded frame;
 * 3. the processor model and the thread count the encoder is given
 *    (`CPU_THREADS`, which is the core count);
 * 4. for a device-backed encoder, the device model and its driver: NVIDIA's
 *    own tool where it exists, and otherwise what the kernel publishes under
 *    `/sys` for the render node or the video device.
 *
 * A part that cannot be read is recorded as `unknown`. That is still a key:
 * two runs that both could not read it are told apart by everything else, and
 * a run that later can read it has a different key and starts afresh.
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CPU_THREADS } from "./args.js";

/** What an unreadable part of a fingerprint is written as. */
export const UNKNOWN = "unknown";

/**
 * The ffmpeg build, from the first line `ffmpeg -version` prints.
 *
 * @param {string} text - Standard output of `ffmpeg -version`.
 * @returns {string}
 */
export function parseFfmpegVersion(text) {
  const match = /^ffmpeg version (\S+)/m.exec(String(text ?? ""));
  return match ? match[1] : UNKNOWN;
}

/**
 * The libx264 build, from the text x264 writes into the stream it produces.
 *
 * @param {Buffer | string} bytes - An encoded H.264 stream.
 * @returns {string}
 */
export function parseX264Version(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("latin1") : String(bytes ?? "");
  const match = /x264 - core (\d+)(?: (r\d+ [0-9a-f]+))?/.exec(text);
  if (!match) {
    return UNKNOWN;
  }
  return match[2] ? `core ${match[1]} ${match[2]}` : `core ${match[1]}`;
}

/**
 * NVIDIA's own answer about the device and its driver.
 *
 * @param {string} text - `nvidia-smi --query-gpu=name,driver_version --format=csv,noheader`.
 * @returns {{ model: string, driver: string }}
 */
export function parseNvidiaSmi(text) {
  const line = String(text ?? "").split(/\r?\n/).find((row) => row.includes(","));
  if (!line) {
    return { model: UNKNOWN, driver: UNKNOWN };
  }
  const [model, driver] = line.split(",").map((value) => value.trim());
  return { model: model || UNKNOWN, driver: driver || UNKNOWN };
}

/** ffmpeg's name for each encoder kind, as the kinds state it (`encode/*Encoder.js`). */
const KIND_BY_NAME = Object.freeze({
  libx264: "software",
  h264_nvenc: "nvenc",
  h264_qsv: "qsv",
  h264_vaapi: "vaapi",
  h264_v4l2m2m: "v4l2m2m"
});

/**
 * Which kind an encoder of this name is, as an output's key names it.
 *
 * @param {string} name
 * @returns {string}
 */
export function kindOfEncoderName(name) {
  return KIND_BY_NAME[name] ?? UNKNOWN;
}

/**
 * The part of a fingerprint that decides whether a figure about THIS encoder
 * still applies. Stable text, so it can be compared and stored.
 *
 * @param {HostFingerprint} fingerprint
 * @param {{ name: string, kind: string }} encoder
 * @returns {string}
 */
export function configurationKeyOf(fingerprint, encoder) {
  const common = [`ffmpeg=${fingerprint?.ffmpeg ?? UNKNOWN}`, `encoder=${encoder?.name ?? UNKNOWN}`];
  if (encoder?.kind === "software") {
    return [
      ...common,
      `x264=${fingerprint?.x264 ?? UNKNOWN}`,
      `cpu=${fingerprint?.cpu ?? UNKNOWN}`,
      `threads=${fingerprint?.threads ?? UNKNOWN}`
    ].join(";");
  }
  const device = fingerprint?.devices?.[encoder?.kind] ?? null;
  return [
    ...common,
    `device=${device?.model ?? UNKNOWN}`,
    `driver=${device?.driver ?? UNKNOWN}`
  ].join(";");
}

/**
 * @typedef {object} DeviceFingerprint
 * @property {string} model
 * @property {string} driver
 *
 * @typedef {object} HostFingerprint
 * @property {string} ffmpeg
 * @property {string} x264
 * @property {string} cpu
 * @property {number} threads
 * @property {Record<string, DeviceFingerprint>} devices - By encoder kind.
 */

/**
 * Run a program and hand back what it wrote to standard output.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<Buffer | null>} Null when it could not be run or failed.
 */
function capture(command, args, timeoutMs) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let settled = false;
    let child;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(null);
    }, timeoutMs);
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      finish(null);
      return;
    }
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? Buffer.concat(chunks) : null));
  });
}

/**
 * Read a small text file, or `unknown`.
 *
 * @param {string} filePath
 * @returns {string}
 */
function readText(filePath) {
  try {
    const text = readFileSync(filePath, "utf8").trim();
    return text.length > 0 ? text : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/**
 * The name of the kernel driver bound to a device under `/sys`.
 *
 * @param {string} sysDevice - e.g. `/sys/class/drm/renderD128/device`.
 * @returns {string}
 */
function driverOf(sysDevice) {
  try {
    return path.basename(readlinkSync(path.join(sysDevice, "driver")));
  } catch {
    return UNKNOWN;
  }
}

/**
 * The version of a kernel driver. A driver built into the kernel publishes no
 * version of its own, and then the kernel release IS its version.
 *
 * @param {string} driver
 * @returns {string}
 */
function driverVersionOf(driver) {
  if (driver === UNKNOWN) {
    return UNKNOWN;
  }
  const own = readText(`/sys/module/${driver}/version`);
  return own !== UNKNOWN ? `${driver} ${own}` : `${driver} (kernel ${os.release()})`;
}

/**
 * A render node's device: the PCI vendor and device ids, and its driver.
 *
 * @param {string | null} renderNode - e.g. `/dev/dri/renderD128`.
 * @returns {DeviceFingerprint}
 */
function renderNodeDevice(renderNode) {
  if (!renderNode) {
    return { model: UNKNOWN, driver: UNKNOWN };
  }
  const sysDevice = `/sys/class/drm/${path.basename(renderNode)}/device`;
  const vendor = readText(path.join(sysDevice, "vendor"));
  const device = readText(path.join(sysDevice, "device"));
  const model = vendor === UNKNOWN && device === UNKNOWN ? UNKNOWN : `${vendor}:${device}`;
  return { model, driver: driverVersionOf(driverOf(sysDevice)) };
}

/**
 * The memory-to-memory video devices, by the names the kernel gives them.
 *
 * @returns {DeviceFingerprint}
 */
function videoDevices() {
  let names = [];
  try {
    names = readdirSync("/sys/class/video4linux")
      .sort()
      .map((entry) => readText(`/sys/class/video4linux/${entry}/name`))
      .filter((name) => name !== UNKNOWN);
  } catch {
    names = [];
  }
  let driver = UNKNOWN;
  try {
    const first = readdirSync("/sys/class/video4linux").sort()[0];
    driver = first ? driverVersionOf(driverOf(`/sys/class/video4linux/${first}/device`)) : UNKNOWN;
  } catch {
    driver = UNKNOWN;
  }
  return { model: names.length > 0 ? [...new Set(names)].join("+") : UNKNOWN, driver };
}

/**
 * NVIDIA's device and driver, from its own tool and otherwise from the file
 * its kernel module publishes.
 *
 * @returns {Promise<DeviceFingerprint>}
 */
async function nvidiaDevice() {
  const smi = await capture("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"], 5000);
  if (smi) {
    return parseNvidiaSmi(smi.toString("utf8"));
  }
  const version = readText("/proc/driver/nvidia/version");
  const driver = /Kernel Module\s+(\S+)/.exec(version)?.[1] ?? UNKNOWN;
  return { model: UNKNOWN, driver };
}

/**
 * Read this host's fingerprint. Always resolves: an unreadable part is
 * `unknown`, never a refusal to start.
 *
 * @param {{ ffmpegBin: string, encoder?: { kind: string, device: string | null } | null }} params
 * @returns {Promise<HostFingerprint>}
 */
export async function readHostFingerprint({ ffmpegBin, encoder = null }) {
  const versionText = await capture(ffmpegBin, ["-hide_banner", "-version"], 5000);
  // `-hide_banner` does not hide the version line itself: it is the answer.
  const ffmpeg = parseFfmpegVersion(versionText ? versionText.toString("utf8") : "");
  // One frame through libx264, written to standard output: the stream carries
  // x264's own statement of its build.
  const oneFrame = await capture(ffmpegBin, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=64x64:r=1:d=1",
    "-frames:v", "1", "-c:v", "libx264", "-f", "h264", "-"
  ], 10000);
  const x264 = oneFrame ? parseX264Version(oneFrame) : UNKNOWN;
  /** @type {Record<string, DeviceFingerprint>} */
  const devices = {};
  if (encoder?.kind === "nvenc") {
    devices.nvenc = await nvidiaDevice();
  } else if (encoder?.kind === "vaapi" || encoder?.kind === "qsv") {
    devices[encoder.kind] = renderNodeDevice(encoder.device);
  } else if (encoder?.kind === "v4l2m2m") {
    devices.v4l2m2m = videoDevices();
  }
  return {
    ffmpeg,
    x264,
    cpu: os.cpus()[0]?.model?.trim() || UNKNOWN,
    threads: CPU_THREADS,
    devices
  };
}
