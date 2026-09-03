/**
 * @file h264_nvenc — NVIDIA's encoder.
 */

import { Encoder } from "./Encoder.js";
import { keyFrameArgs, safeDimensions } from "./args.js";

export class NvencEncoder extends Encoder {
  constructor() {
    super({ name: "h264_nvenc", kind: "nvenc", device: null, inputArgs: [] });
  }

  /** @returns {import("./Encoder.js").SpeedLadder} */
  get speedLadder() {
    return {
      flag: "-preset",
      // NOT read from a live ffmpeg: the build on the addon host is ARM and
      // carries no NVENC. `p1`…`p7` is NVENC's own ladder, `p1` fastest, so
      // stated slowest first here to match every other kind. To be confirmed on
      // a host that has one.
      values: ["p7", "p6", "p5", "p4", "p3", "p2", "p1"],
      measured: false,
      note:
        "Declared, not verified: no host here has an NVIDIA encoder to ask. " +
        "`p4` is passed unconditionally by `buildVideoArgs` — one rung in the " +
        "middle of a ladder nobody has measured."
    };
  }

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
}
