/**
 * @file What this proxy has seen its own admitted encodes do, kept between
 * runs and used only on the configuration it was seen on (roadmap item 97,
 * step 14).
 *
 * NOT A TABLE OF QUALITY, and not a condition for anything. The proxy selects,
 * admits and serves with nothing kept here at all: the startup calibration is
 * what qualifies a mode and prices it, and the admission is what decides
 * whether there is room. What is kept here makes three of those figures more
 * exact on THIS machine once it has done the work for real:
 *
 * 1. how fast an encode of this mode, at this size, actually ran alone on this
 *    kind of source — used in place of the startup prediction when an output
 *    of that mode is priced;
 * 2. what the segments of an output of this mode and rate control actually
 *    carried, average and peak — used as the peak of an encoder that states no
 *    bound of its own (a hardware encoder has no `maxrate`), which otherwise
 *    has no figure at all;
 * 3. how long an output of this mode took to have the piece a viewer needed
 *    after it was asked for, and what that viewer held when they moved — used
 *    as the time to ready when deciding whether a draining buffer is a threat.
 *
 * WHAT IS NEVER KEPT: a picture, a clip, a segment, anything about a viewer
 * beyond the seconds they held, and anything that leaves this machine.
 *
 * WHAT DECIDES WHETHER A FIGURE APPLIES is the configuration it was seen on:
 * every key starts with the configuration key of the encoder that made it
 * (`fingerprint.js`). A figure seen on another ffmpeg, another libx264, another
 * processor or thread count, another device or driver matches nothing and is
 * dropped when the file is read — not converted, not scaled.
 *
 * AND WHETHER IT IS COMPARABLE. A speed is used only for a source of the same
 * codec, bit depth and frame, whose bitrate is no higher than the one it was
 * seen on — a slower reading on harder material is safe to apply to easier
 * material, the reverse is not — and it is the SLOWEST such reading that is
 * used. The largest peak and the longest preparation are used, for the same
 * reason: each errs toward the viewer.
 *
 * Written when something is noted — a run ending, a move completing — which
 * is rare, so a process that is killed loses at most what it was doing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { configurationKeyOf, kindOfEncoderName } from "./fingerprint.js";

/**
 * How many readings are kept per key. A history window, not a figure about the
 * machine: long enough that one run cannot decide, short enough that the
 * figure follows the host as it changes. The same length the host timings keep
 * (`quality/HostTimings.js`).
 */
const READINGS_KEPT = 20;

/** The version of the file's shape; a file of another shape is not read. */
const FILE_VERSION = 1;

/**
 * @typedef {object} ContentDescriptor
 * @property {string} codec
 * @property {number | null} bitDepth
 * @property {number} width
 * @property {number} height
 * @property {number} megabitsPerSecond
 */

export class LocalObservations {
  /** @type {import("./fingerprint.js").HostFingerprint} */
  #fingerprint;

  /** @type {string} */
  #filePath;

  /** @type {{ info: (m: string) => void, warn: (m: string) => void }} */
  #logger;

  /** @type {() => number} */
  #now;

  /** @type {{ speed: Record<string, object[]>, rates: Record<string, object[]>, preparation: Record<string, object[]> }} */
  #entries = { speed: {}, rates: {}, preparation: {} };

  /**
   * @param {object} params
   * @param {import("./fingerprint.js").HostFingerprint} params.fingerprint
   * @param {string} params.filePath - Where the readings are kept; empty keeps
   *   them for this process only.
   * @param {{ info: (m: string) => void, warn: (m: string) => void }} [params.logger]
   * @param {() => number} [params.now]
   */
  constructor({ fingerprint, filePath, logger = null, now = Date.now }) {
    if (!fingerprint || typeof fingerprint !== "object") {
      throw new TypeError("LocalObservations requires the host's fingerprint");
    }
    this.#fingerprint = fingerprint;
    this.#filePath = typeof filePath === "string" ? filePath : "";
    this.#logger = logger ?? { info: () => {}, warn: () => {} };
    this.#now = now;
  }

  /**
   * The key of the MODE an output is encoded in: the configuration, the
   * encoder, the frame and rate, the speed setting and whether it tone-maps.
   * Null for an output that re-encodes no picture.
   *
   * @param {import("./output/OutputSpec.js").OutputSpec | null | undefined} spec
   * @returns {string | null}
   */
  modeKeyOf(spec) {
    const encode = spec?.video?.encode;
    if (!encode) {
      return null;
    }
    const configuration = configurationKeyOf(this.#fingerprint, {
      name: encode.encoder,
      kind: kindOfEncoderName(encode.encoder)
    });
    return `${configuration}|${encode.encoder}/${encode.width}x${encode.height}@${encode.fps}/` +
      `${encode.preset ?? "-"}/${encode.tonemap ? "tonemap" : "none"}`;
  }

  /**
   * The mode's key with its rate control, which is what bounds what its
   * segments carry.
   *
   * @param {import("./output/OutputSpec.js").OutputSpec | null | undefined} spec
   * @returns {string | null}
   */
  rateKeyOf(spec) {
    const mode = this.modeKeyOf(spec);
    if (mode === null) {
      return null;
    }
    const rate = spec.video.encode.rateControl;
    return `${mode}/vbv=${rate ? `${rate.maxrateKbps}k-${rate.bufsizeKbps}k@${rate.level ?? "-"}` : "-"}`;
  }

  /**
   * Read what an earlier run kept, dropping whatever no current configuration
   * matches.
   *
   * @param {string[]} currentConfigurations - The configuration keys of every
   *   encoder this process may use.
   * @returns {void}
   */
  load(currentConfigurations) {
    if (!this.#filePath) {
      return;
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.#filePath, "utf8"));
    } catch {
      return; // no file yet, or unreadable: nothing is known, which is the base case
    }
    if (raw?.version !== FILE_VERSION || !raw.entries || typeof raw.entries !== "object") {
      this.#logger.info(`local observations: ${this.#filePath} is of another shape; starting afresh`);
      return;
    }
    const allowed = new Set(currentConfigurations);
    let kept = 0;
    let dropped = 0;
    for (const kind of ["speed", "rates", "preparation"]) {
      const section = raw.entries[kind] && typeof raw.entries[kind] === "object" ? raw.entries[kind] : {};
      for (const [key, readings] of Object.entries(section)) {
        const configuration = key.split("|")[0];
        if (!allowed.has(configuration) || !Array.isArray(readings)) {
          dropped += 1;
          continue;
        }
        this.#entries[kind][key] = readings.slice(-READINGS_KEPT);
        kept += 1;
      }
    }
    this.#logger.info(
      `local observations: ${kept} key(s) kept from ${this.#filePath}` +
      (dropped > 0 ? `, ${dropped} dropped because they were seen on a configuration this host no longer has` : "")
    );
    if (dropped > 0) {
      this.#save();
    }
  }

  /**
   * An encode of this output has ended: keep how fast it ran alone and what
   * its segments carried.
   *
   * @param {object} params
   * @param {import("./output/OutputSpec.js").OutputSpec} params.spec
   * @param {ContentDescriptor | null} params.content - What it was encoded from.
   * @param {number | null} params.aloneSpeedX - Seconds of film per second,
   *   measured with nothing else encoding.
   * @param {{ averageKbps: number, peakKbps: number } | null} params.segmentKbps
   * @returns {void}
   */
  noteEncode({ spec, content, aloneSpeedX, segmentKbps }) {
    const modeKey = this.modeKeyOf(spec);
    if (modeKey === null) {
      return;
    }
    let changed = false;
    if (Number.isFinite(aloneSpeedX) && aloneSpeedX > 0 && LocalObservations.#usableContent(content)) {
      this.#push("speed", modeKey, { content, speedX: aloneSpeedX, at: this.#now() });
      changed = true;
    }
    const rateKey = this.rateKeyOf(spec);
    if (
      segmentKbps &&
      Number.isFinite(segmentKbps.averageKbps) && segmentKbps.averageKbps > 0 &&
      Number.isFinite(segmentKbps.peakKbps) && segmentKbps.peakKbps > 0
    ) {
      this.#push("rates", rateKey, {
        averageKbps: segmentKbps.averageKbps,
        peakKbps: segmentKbps.peakKbps,
        at: this.#now()
      });
      changed = true;
    }
    if (changed) {
      this.#save();
    }
  }

  /**
   * A viewer has been moved onto an output that was being prepared for them:
   * keep how long it took and what they held when they moved.
   *
   * @param {object} params
   * @param {import("./output/OutputSpec.js").OutputSpec} params.spec - The output moved onto.
   * @param {number} params.seconds - From the preparation starting to the move.
   * @param {number | null} params.bufferedSec - What the viewer held at the move.
   * @returns {void}
   */
  notePreparation({ spec, seconds, bufferedSec }) {
    const modeKey = this.modeKeyOf(spec);
    if (modeKey === null || !(Number.isFinite(seconds) && seconds >= 0)) {
      return;
    }
    this.#push("preparation", modeKey, {
      seconds,
      bufferedSec: Number.isFinite(bufferedSec) ? bufferedSec : null,
      at: this.#now()
    });
    this.#save();
  }

  /**
   * The slowest this mode has been seen running alone on comparable material,
   * or null where nothing comparable has been seen.
   *
   * @param {import("./output/OutputSpec.js").OutputSpec} spec
   * @param {ContentDescriptor | null} content
   * @returns {number | null}
   */
  slowestAloneSpeed(spec, content) {
    const modeKey = this.modeKeyOf(spec);
    if (modeKey === null || !LocalObservations.#usableContent(content)) {
      return null;
    }
    let slowest = null;
    for (const reading of this.#entries.speed[modeKey] ?? []) {
      const seen = reading.content;
      if (
        seen?.codec === content.codec &&
        (seen?.bitDepth ?? null) === (content.bitDepth ?? null) &&
        seen?.width === content.width &&
        seen?.height === content.height &&
        seen?.megabitsPerSecond >= content.megabitsPerSecond
      ) {
        slowest = slowest === null ? reading.speedX : Math.min(slowest, reading.speedX);
      }
    }
    return slowest;
  }

  /**
   * The largest peak an output of this mode and rate control has been seen
   * carrying, in megabits per second, or null.
   *
   * @param {import("./output/OutputSpec.js").OutputSpec} spec
   * @returns {number | null}
   */
  peakMbps(spec) {
    const rateKey = this.rateKeyOf(spec);
    const readings = rateKey === null ? [] : (this.#entries.rates[rateKey] ?? []);
    return readings.length === 0 ? null : Math.max(...readings.map((reading) => reading.peakKbps)) / 1000;
  }

  /**
   * The longest an output of this mode has been seen taking to be ready for a
   * viewer moving onto it, in seconds, or null.
   *
   * @param {import("./output/OutputSpec.js").OutputSpec} spec
   * @returns {number | null}
   */
  longestPreparationSec(spec) {
    const modeKey = this.modeKeyOf(spec);
    const readings = modeKey === null ? [] : (this.#entries.preparation[modeKey] ?? []);
    return readings.length === 0 ? null : Math.max(...readings.map((reading) => reading.seconds));
  }

  /**
   * @param {"speed" | "rates" | "preparation"} kind
   * @param {string} key
   * @param {object} reading
   * @returns {void}
   */
  #push(kind, key, reading) {
    const readings = [...(this.#entries[kind][key] ?? []), reading].slice(-READINGS_KEPT);
    this.#entries[kind][key] = readings;
  }

  /** @returns {void} */
  #save() {
    if (!this.#filePath) {
      return;
    }
    try {
      writeFileSync(this.#filePath, JSON.stringify({ version: FILE_VERSION, entries: this.#entries }));
    } catch (error) {
      // A read-only install keeps what it learned for this process only.
      this.#logger.warn(
        `local observations: could not write ${this.#filePath} (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }

  /**
   * @param {ContentDescriptor | null} content
   * @returns {boolean}
   */
  static #usableContent(content) {
    return Boolean(content) &&
      typeof content.codec === "string" && content.codec.length > 0 &&
      content.width > 0 && content.height > 0 &&
      Number.isFinite(content.megabitsPerSecond) && content.megabitsPerSecond > 0;
  }
}

/**
 * What an observation of an encode is filed as having been made FROM.
 *
 * @param {{ width: number | null, height: number | null, decode: { codec: string, bitDepth: number | null, megabitsPerSecond: number } | null } | null} file
 * @returns {ContentDescriptor | null}
 */
export function contentOf(file) {
  const decode = file?.decode ?? null;
  const width = Number(file?.width) || 0;
  const height = Number(file?.height) || 0;
  if (!decode || width <= 0 || height <= 0) {
    return null;
  }
  return {
    codec: decode.codec,
    bitDepth: decode.bitDepth ?? null,
    width,
    height,
    megabitsPerSecond: decode.megabitsPerSecond
  };
}
