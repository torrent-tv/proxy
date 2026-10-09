/**
 * @file Which encoding modes this machine may use, and what each costs at
 * every size it may be asked for — measured at startup, before any viewer
 * (roadmap item 97, step 14).
 *
 * A MODE is one encoder at one of the settings the proxy can actually select:
 * every libx264 preset the offer chooses from, and the one setting a hardware
 * encoder is driven at. A mode is usable only if it has been shown here to do
 * two things on THIS machine:
 *
 * 1. produce a correct stream through the product's own arguments — the same
 *    `buildVideoArgs` a real output is encoded with, into fMP4 segments, each
 *    of which must then decode with no error. A device being present, or one
 *    of its settings passing, qualifies nothing else;
 * 2. encode at a known speed at the size it is asked for.
 *
 * WHY SEVERAL SIZES. The speed used to be read at 640x360 alone and scaled to
 * every other size by pixel count. Measured 2026-08-22, cost per pixel is not
 * constant: 1280x720 came back at 0.445x the predicted throughput on
 * `ultrafast` and 0.725x on `fast` (`research/preset-benchmark-size-scaling-
 * 2026-08-22.md`). So each mode is read at a set of sizes that spans the
 * ladder, and a size between two readings is priced by interpolating between
 * them — never beyond the smallest or the largest one read. A frame outside
 * what was read is a mode this machine has not shown it can do, and is not
 * offered.
 *
 * HOW FAR AN INTERPOLATION MAY BE TRUSTED is measured too, not assumed: where
 * three consecutive sizes were read, the middle one is predicted from the two
 * outside it and compared with its own reading. The largest such error for the
 * mode is its error bound, and every interpolated figure is lowered by it. A
 * mode with fewer than three sizes read has no bound, and is then used only at
 * the sizes it was read at.
 *
 * WHAT IS NOT READ, so the startup stays short. Sizes are read from the
 * smallest up and, at each size, modes from the fastest down. A mode that
 * cannot keep up at a size ends that size: every slower mode is slower still.
 * A size at which even the fastest mode cannot keep up ends the walk: every
 * larger size is larger still. What is left unread is unavailable, which is
 * the answer it would have got anyway.
 */

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { softwareRateControlFor, TRANSCODE_FPS } from "./args.js";
import {
  CALIBRATION_DIR,
  CALIBRATION_REFERENCE_CLIP,
  decodeToRawFrames,
  measureEncodeSlope,
  runFfmpeg,
  verifySegmentsDecodeCleanly
} from "./hwaccel.js";
import { interpolationErrorOf } from "./throughput.js";

export { throughputAt, interpolationErrorOf } from "./throughput.js";

/**
 * The sizes a mode is read at, smallest first.
 *
 * The smallest is below every frame the ladder produces — its lowest row is
 * 426x240, and a 4:3 or narrower source gives less area than that at the same
 * height. The largest is the 2160 row. The two between are the 720 and 1080
 * rows, where most films are watched. 640x360 is the reference size every
 * earlier reading was taken at, so the figures stay comparable with them.
 */
export const CALIBRATION_FRAMES = Object.freeze([
  Object.freeze({ width: 256, height: 144 }),
  Object.freeze({ width: 640, height: 360 }),
  Object.freeze({ width: 1280, height: 720 }),
  Object.freeze({ width: 1920, height: 1080 }),
  Object.freeze({ width: 3840, height: 2160 })
]);

/** The size the correctness check encodes at, and every earlier reading was taken at. */
const CHECK_FRAME = Object.freeze({ width: 640, height: 360 });
// Measured from the bundled 1920x1080 calibration clip with ffprobe. It has no
// audio streams, so its whole-file rate is its picture rate.
const CALIBRATION_SOURCE = Object.freeze({ width: 1920, height: 1080, pictureKbps: 19653 });

/**
 * @typedef {object} SizeReading
 * @property {number} width
 * @property {number} height
 * @property {number} pixelsPerSec
 *
 * @typedef {object} CalibratedMode
 * @property {string} preset - The setting, or the encoder's name where it has one setting.
 * @property {number} pixelsPerSec - At 640x360, for everything that has always read that figure.
 * @property {SizeReading[]} bySize - Smallest first.
 * @property {number | null} interpolationError - The largest measured relative
 *   error of an interpolation between two readings, or null where it could not
 *   be measured.
 * @property {{ averageKbps: number, peakKbps: number } | null} segmentKbps -
 *   What the correctness check's segments carried.
 */

/**
 * The settings a mode is known by, as text, for the log and for the key its
 * later observations are filed under.
 *
 * @param {{ benchmarkArgs: (rung: string | null) => string[] }} encoder
 * @param {string | null} rung
 * @returns {string}
 */
export function settingsOf(encoder, rung) {
  return encoder.benchmarkArgs(rung).join(" ");
}

/**
 * Encode the calibration clip through the product's own arguments for this
 * mode, and check every segment decodes on its own.
 *
 * @param {{ ffmpegBin: string, encoder: object, rung: string | null, segmentDurationSec: number }} params
 * @returns {Promise<{ ok: boolean, reason: string, segmentKbps: { averageKbps: number, peakKbps: number } | null }>}
 */
export async function checkModeProducesCorrectSegments({ ffmpegBin, encoder, rung, segmentDurationSec }) {
  let directory;
  try {
    directory = mkdtempSync(path.join(os.tmpdir(), "tt-modecheck-"));
  } catch (error) {
    return { ok: false, reason: `no writable temp directory (${error instanceof Error ? error.message : String(error)})`, segmentKbps: null };
  }
  // Three segments' worth, so at least two are cut and each is checked alone.
  const seconds = segmentDurationSec * 3;
  const rateControl = encoder.kind === "software"
    ? softwareRateControlFor({ ...CHECK_FRAME, fps: TRANSCODE_FPS, source: CALIBRATION_SOURCE })
    : null;
  const args = [
    "-hide_banner", "-loglevel", "error",
    ...encoder.inputArgs,
    "-stream_loop", "-1",
    "-i", path.join(CALIBRATION_DIR, CALIBRATION_REFERENCE_CLIP),
    "-t", String(seconds),
    "-map", "0:v:0", "-an",
    ...encoder.buildVideoArgs({
      targetWidth: CHECK_FRAME.width,
      targetHeight: CHECK_FRAME.height,
      segmentDurationSec,
      preset: rung ?? undefined,
      fps: TRANSCODE_FPS,
      tonemap: false,
      forcedKeyframeTimes: null,
      rateControl
    }),
    "-f", "hls",
    "-hls_time", String(segmentDurationSec),
    "-hls_list_size", "0",
    "-hls_flags", "independent_segments",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", path.join(directory, "seg-%03d.m4s"),
    path.join(directory, "index.m3u8")
  ];
  try {
    const encoded = await runFfmpeg(ffmpegBin, args, 60_000);
    if (encoded.code !== 0) {
      const line = encoded.stderr.trim().split(/\r?\n/).pop() ?? "";
      return { ok: false, reason: `the encode failed (exit ${encoded.code}${line ? `: ${line}` : ""})`, segmentKbps: null };
    }
    if (!(await verifySegmentsDecodeCleanly(ffmpegBin, directory))) {
      return { ok: false, reason: "a segment it produced does not decode on its own", segmentKbps: null };
    }
    const sizes = readdirSync(directory)
      .filter((name) => /^seg-\d+\.m4s$/.test(name))
      .sort()
      .map((name) => statSync(path.join(directory, name)).size);
    // The last segment may be short; only whole ones say what a segment carries.
    const whole = sizes.slice(0, Math.max(1, sizes.length - 1));
    const kbps = whole.map((bytes) => (bytes * 8) / segmentDurationSec / 1000);
    return {
      ok: true,
      reason: "",
      segmentKbps: {
        averageKbps: kbps.reduce((sum, value) => sum + value, 0) / kbps.length,
        peakKbps: Math.max(...kbps)
      }
    };
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A temp directory the operating system will clear.
    }
  }
}

/**
 * Qualify and measure every selectable mode of one encoder.
 *
 * Always resolves. A mode that fails either half is left out, with the reason
 * logged; an encoder none of whose modes qualify comes back with no modes,
 * and nothing on this host is then re-encoded with it.
 *
 * @param {object} params
 * @param {string} params.ffmpegBin
 * @param {object} params.encoder - An `Encoder`.
 * @param {{ info: (m: string) => void, warn: (m: string) => void }} [params.logger]
 * @param {number} [params.segmentDurationSec]
 * @param {Array<{ width: number, height: number }>} [params.frames]
 * @param {object} [params.measure] - Replaces the three readings, for a check
 *   that must not run ffmpeg: `check`, `rawFrames`, `speed`. `speed` answers a
 *   number, or `{ speed, freeShare }` as `measureEncodeSlope` does.
 * @returns {Promise<{ modes: CalibratedMode[], refused: Array<{ preset: string, reason: string }> }>}
 */
export async function calibrateEncoder({
  ffmpegBin,
  encoder,
  logger,
  segmentDurationSec = 4,
  frames = CALIBRATION_FRAMES,
  measure = null
}) {
  const log = logger ?? { info: () => {}, warn: () => {} };
  const check = measure?.check ?? checkModeProducesCorrectSegments;
  const rawFrames = measure?.rawFrames ?? ((frame) => decodeToRawFrames(ffmpegBin, log, frame));
  const speed = measure?.speed ?? ((rung, rawPath, frame) => measureEncodeSlope(ffmpegBin, encoder, rung, rawPath, frame));
  const release = measure?.release ?? ((rawPath) => {
    try {
      rmSync(path.dirname(rawPath), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A temp directory the operating system will clear.
    }
  });
  const rungs = Array.isArray(encoder.selectableRungs) && encoder.selectableRungs.length > 0
    ? encoder.selectableRungs
    : [null];
  const startedAt = Date.now();

  /** @type {Map<string | null, { ok: boolean, reason: string, segmentKbps: object | null }>} */
  const checked = new Map();
  for (const rung of rungs) {
    const answer = await check({ ffmpegBin, encoder, rung, segmentDurationSec });
    checked.set(rung, answer);
    if (!answer.ok) {
      log.warn(`calibration: ${encoder.name} "${rung ?? "as it comes"}" is not used on this host — ${answer.reason}`);
    }
  }
  const qualified = rungs.filter((rung) => checked.get(rung)?.ok === true);

  /** @type {Map<string | null, SizeReading[]>} */
  const readings = new Map(qualified.map((rung) => [rung, []]));
  // Each preset remains in the size walk until its own reading falls below
  // realtime. A faster preset's result says nothing reliable about a slower
  // preset when readings vary with load.
  const activeRungs = new Set(qualified);
  /** The share of the machine other work left each reading. @type {number[]} */
  const freeShares = [];
  const sortedFrames = [...frames].sort((left, right) => left.width * left.height - right.width * right.height);
  for (const frame of sortedFrames) {
    if (qualified.length === 0) {
      break;
    }
    const rawPath = await rawFrames(frame);
    if (rawPath === null) {
      log.warn(`calibration: no frames at ${frame.width}x${frame.height}; ${encoder.name} is not read there or above`);
      break;
    }
    let fastestKeptUp = false;
    try {
      // Fastest first: the ladder is slowest first, so walk it backwards.
      for (let index = qualified.length - 1; index >= 0; index -= 1) {
        const rung = qualified[index];
        if (!activeRungs.has(rung)) continue;
        const reading = await speed(rung, rawPath, frame);
        // A number from a check that replaces the reading; the reading itself
        // carries the share of the machine other work left it.
        const realtimes = typeof reading === "number" ? reading : (reading?.speed ?? null);
        if (Number.isFinite(reading?.freeShare)) {
          freeShares.push(reading.freeShare);
        }
        if (realtimes === null) {
          log.warn(`calibration: ${encoder.name} "${rung ?? "as it comes"}" gave no reading at ${frame.width}x${frame.height}`);
          activeRungs.delete(rung);
          continue;
        }
        readings.get(rung).push({
          width: frame.width,
          height: frame.height,
          pixelsPerSec: frame.width * frame.height * TRANSCODE_FPS * realtimes
        });
        if (index === qualified.length - 1) {
          fastestKeptUp = realtimes >= 1;
        }
        if (realtimes < 1) {
          activeRungs.delete(rung);
        }
      }
    } finally {
      release(rawPath);
    }
    if (!fastestKeptUp) {
      // Every larger size is larger still.
      break;
    }
  }

  /** @type {CalibratedMode[]} */
  const modes = [];
  /** @type {Array<{ preset: string, reason: string }>} */
  const refused = [];
  for (const rung of rungs) {
    const preset = rung ?? encoder.name;
    if (checked.get(rung)?.ok !== true) {
      refused.push({ preset, reason: checked.get(rung)?.reason ?? "not checked" });
      continue;
    }
    const bySize = readings.get(rung) ?? [];
    if (bySize.length === 0) {
      refused.push({ preset, reason: "no size was read" });
      continue;
    }
    const reference = bySize.find((reading) => reading.width === CHECK_FRAME.width && reading.height === CHECK_FRAME.height) ?? bySize[0];
    const interpolationError = interpolationErrorOf(bySize);
    modes.push({
      preset,
      pixelsPerSec: reference.pixelsPerSec,
      bySize,
      interpolationError,
      segmentKbps: checked.get(rung).segmentKbps
    });
    log.info(
      `calibration: ${encoder.name} "${preset}" ` +
      bySize.map((reading) => `${reading.width}x${reading.height}=${(reading.pixelsPerSec / 1e6).toFixed(1)}Mpx/s`).join(" ") +
      ` interpolation error ${interpolationError === null ? "not measured, used only at the sizes read" : `${(interpolationError * 100).toFixed(1)}%`}` +
      (checked.get(rung).segmentKbps
        ? ` segments ${Math.round(checked.get(rung).segmentKbps.averageKbps)}kbps average, ${Math.round(checked.get(rung).segmentKbps.peakKbps)}kbps peak at ${CHECK_FRAME.width}x${CHECK_FRAME.height}`
        : "")
    );
  }
  log.info(
    `calibration: ${encoder.name} ${modes.length} of ${rungs.length} mode(s) usable ` +
    `(${((Date.now() - startedAt) / 1000).toFixed(1)}s)` +
    (freeShares.length > 0
      ? `; other work took ${Math.round((1 - Math.max(...freeShares)) * 100)}-${Math.round((1 - Math.min(...freeShares)) * 100)}% ` +
        "of the machine during the readings, and the figures are for a machine with nothing else running"
      : encoder.kind === "software" ? "; the machine's load during the readings was not readable, so the figures are as read" : "") +
    (refused.length > 0 ? `; not usable: ${refused.map((one) => `${one.preset} (${one.reason})`).join(", ")}` : "")
  );
  return { modes, refused };
}

/**
 * What every encoder this proxy may use was measured to do, by kind: the one
 * detection chose, and software, which is where a failing hardware encoder
 * falls back to for the rest of the process.
 */
export class HostCalibration {
  /** @type {Map<string, CalibratedMode[]>} */
  #byKind;

  /**
   * @param {object} params
   * @param {Record<string, CalibratedMode[]>} params.byKind
   * @param {import("./fingerprint.js").HostFingerprint | null} [params.fingerprint]
   */
  constructor({ byKind, fingerprint = null }) {
    this.#byKind = new Map(Object.entries(byKind ?? {}).map(([kind, modes]) => [kind, Array.isArray(modes) ? modes : []]));
    this.fingerprint = fingerprint;
  }

  /**
   * The usable modes of one encoder kind, slowest first — the shape the offer
   * and the preset choice have always read. Null where that kind was not
   * calibrated at all.
   *
   * @param {string | null | undefined} kind
   * @returns {CalibratedMode[] | null}
   */
  modesFor(kind) {
    return kind && this.#byKind.has(kind) ? this.#byKind.get(kind) : null;
  }

  /**
   * Every kind that was calibrated.
   *
   * @returns {string[]}
   */
  kinds() {
    return [...this.#byKind.keys()];
  }
}
