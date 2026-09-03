/**
 * @file h264_qsv — Intel QuickSync.
 */

import { Encoder } from "./Encoder.js";
import { keyFrameArgs, safeDimensions } from "./args.js";

export class QsvEncoder extends Encoder {
  /**
   * @param {string} device
   */
  constructor(device) {
    super({
      name: "h264_qsv",
      kind: "qsv",
      device,
      inputArgs: ["-hwaccel", "qsv", "-qsv_device", device]
    });
  }

  /** @returns {import("./Encoder.js").SpeedLadder} */
  get speedLadder() {
    return {
      flag: "-preset",
      // NOT read from a live ffmpeg: the build on the addon host is ARM and
      // carries no QSV encoder, so there was nothing to ask. These are the
      // names ffmpeg documents for `h264_qsv`, ordered slowest first, and they
      // are to be confirmed against a host that actually has one before
      // anything uses them.
      values: ["veryslow", "slower", "slow", "medium", "fast", "faster", "veryfast"],
      measured: false,
      note:
        "Declared, not verified: no host here has a QSV encoder to ask. " +
        "Nothing passes a preset today, so a QSV encode runs at its default."
    };
  }

  buildVideoArgs({ targetWidth, targetHeight, segmentDurationSec, forcedKeyframeTimes }) {
    const { w, h } = safeDimensions(targetWidth, targetHeight);
    return [
      "-vf", `scale_qsv=w=${w}:h=${h}`,
      "-c:v", "h264_qsv",
      "-global_quality", "24",
      ...keyFrameArgs(segmentDurationSec, forcedKeyframeTimes)
    ];
  }
}
