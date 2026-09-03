/**
 * @file h264_v4l2m2m — the stateful memory-to-memory encoder on an ARM board
 * (Raspberry Pi, HA Yellow).
 */

import { Encoder } from "./Encoder.js";
import { keyFrameArgs, safeDimensions, TRANSCODE_FPS } from "./args.js";

export class V4l2m2mEncoder extends Encoder {
  constructor() {
    // ARM SoC (e.g. Raspberry Pi / HA Yellow) stateful M2M encoder. No GPU
    // scaler — scale in software, hand YUV420 frames to the hardware encoder.
    super({ name: "h264_v4l2m2m", kind: "v4l2m2m", device: null, inputArgs: [] });
  }

  /** @returns {import("./Encoder.js").SpeedLadder} */
  get speedLadder() {
    return {
      flag: "",
      values: [],
      measured: false,
      note:
        "This kind has no speed setting at all — its levers are the bitrate " +
        "and the number of capture buffers, which are not a trade of picture " +
        "against speed. So there is nowhere to step, and a host that cannot " +
        "keep up on it has to change something else."
    };
  }

  // `-g` aligns the GOP to the segment length so an IDR lands on every segment
  // boundary; this is verified by the keyframe-alignment test before use,
  // because v4l2m2m does not always honour these hints.
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
}
