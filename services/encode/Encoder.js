/**
 * @file One kind of encoder: what it is called, how it is fed, how its
 * arguments are built, and what its own setting for speed is.
 *
 * Until 2026-09-04 each kind was an object literal returned by a factory in
 * `hwaccel.js`, and everything a kind knows beyond its arguments was either
 * absent or spread into conditions elsewhere. The clearest case is the ladder
 * of speed settings: `pickSoftwarePreset` walks one for libx264, and the four
 * hardware kinds have none at all — NVENC is given a hardcoded `-preset p4`,
 * QSV and VAAPI are given no speed setting whatever. That is not a decision
 * anybody took; it is a gap that had nowhere to be written down.
 *
 * So a kind states its own ladder here, and says whether that ladder has been
 * MEASURED on a host or only read out of ffmpeg's option list. Nothing consumes
 * it yet: benchmarking the hardware ladders is its own work, and a hardware
 * encoder that passes the strict startup test at one setting is not thereby
 * correct at another — `h264_v4l2m2m` on the CM4 is the standing reminder.
 * Stating it is what makes the gap visible instead of invisible.
 */

/**
 * A kind's own setting for trading picture against speed.
 *
 * @typedef {object} SpeedLadder
 * @property {string} flag - The ffmpeg option, e.g. `-preset`.
 * @property {string[]} values - Ordered slowest first, fastest last. Empty when
 *   the kind has no such setting at all.
 * @property {boolean} measured - Whether a host has ever been benchmarked
 *   across these values. False means the values were read from ffmpeg's own
 *   option list and nothing here knows what they cost.
 * @property {string} note - What is known and what is not, in words.
 */

export class Encoder {
  /**
   * @param {object} params
   * @param {string} params.name - ffmpeg's own name for it, e.g. `libx264`.
   * @param {"software"|"vaapi"|"qsv"|"nvenc"|"v4l2m2m"} params.kind
   * @param {string|null} [params.device] - The render node or device path, for
   *   the kinds that take one.
   * @param {string[]} [params.inputArgs] - Arguments that belong BEFORE the
   *   input, because they decide how frames are decoded and where they land.
   */
  constructor({ name, kind, device = null, inputArgs = [] }) {
    this.name = name;
    this.kind = kind;
    this.device = device;
    this.inputArgs = inputArgs;
  }

  /**
   * Whether frames are encoded by dedicated silicon rather than by the
   * processor. It decides what a runtime failure means: a hardware encode that
   * fails takes this proxy down to software for the rest of the process, and a
   * software encode that fails has nowhere to fall.
   *
   * @returns {boolean}
   */
  get isHardware() {
    return this.kind !== "software";
  }

  /**
   * @returns {SpeedLadder}
   */
  get speedLadder() {
    return {
      flag: "",
      values: [],
      measured: false,
      note: "This kind has not stated a speed setting."
    };
  }

  /**
   * The arguments that produce the picture. Every kind states its own.
   *
   * @param {{ targetWidth: number, targetHeight: number, segmentDurationSec: number, preset?: string, fps?: number, tonemap?: boolean, forcedKeyframeTimes?: number[] | null, nominalKbps?: number | null }} _options
   * @returns {string[]}
   */
  buildVideoArgs(_options) {
    throw new Error(`${this.name} does not say how to build its video arguments.`);
  }
}
