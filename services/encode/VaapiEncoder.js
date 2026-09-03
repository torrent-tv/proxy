/**
 * @file h264_vaapi — encode on a VAAPI device, with the scale on the same
 * device so frames never leave it.
 */

import { Encoder } from "./Encoder.js";
import { keyFrameArgs, safeDimensions } from "./args.js";

export class VaapiEncoder extends Encoder {
  /**
   * @param {string} device - Render node, e.g. `/dev/dri/renderD128`.
   */
  constructor(device) {
    super({
      name: "h264_vaapi",
      kind: "vaapi",
      device,
      // Decode on the GPU into VAAPI surfaces; scale and encode stay on-GPU.
      inputArgs: ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", "-vaapi_device", device]
    });
  }

  /** @returns {import("./Encoder.js").SpeedLadder} */
  get speedLadder() {
    return {
      flag: "-quality",
      // Read from ffmpeg's own option list on the addon host 2026-09-04:
      // "Set encode quality (trades off against speed, higher is faster)
      // (from -1 to INT_MAX) (default -1)". The upper end is the driver's, not
      // the encoder's, so there is no list to state — only the name of the
      // setting and the direction.
      values: [],
      measured: false,
      note:
        "The setting is `-quality`, higher is faster, and its range belongs to " +
        "the driver rather than to ffmpeg. Nothing here has benchmarked it, " +
        "and nothing passes it: a VAAPI encode runs at the driver's default."
    };
  }

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
}
