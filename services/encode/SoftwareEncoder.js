/**
 * @file libx264 — the encoder every host has and the only one whose ladder of
 * speed settings is measured at startup.
 */

import { Encoder } from "./Encoder.js";
import {
  bitrateCapArgs,
  CPU_THREADS,
  hasForcedTimes,
  keyFrameArgs,
  safeDimensions,
  SOFTWARE_CRF,
  SOFTWARE_PRESET,
  TONEMAP_FILTER_CHAIN,
  TRANSCODE_FPS
} from "./args.js";

/**
 * The presets the startup benchmark walks, slowest first.
 *
 * The same list `benchmarkSoftwarePresets` measures and `pickSoftwarePreset`
 * chooses from; it is stated here because it is a property of this kind, and
 * the four hardware kinds beside it show what its absence looks like.
 */
const PRESETS = ["fast", "faster", "veryfast", "superfast", "ultrafast"];

export class SoftwareEncoder extends Encoder {
  constructor() {
    super({ name: "libx264", kind: "software", device: null, inputArgs: [] });
  }

  /** @returns {import("./Encoder.js").SpeedLadder} */
  get speedLadder() {
    return {
      flag: "-preset",
      values: PRESETS,
      measured: true,
      note:
        "Measured on every host at startup by `benchmarkSoftwarePresets`, in " +
        "pixels per second per preset, and chosen from by `pickSoftwarePreset`."
    };
  }

  buildVideoArgs({
    targetWidth,
    targetHeight,
    segmentDurationSec,
    preset,
    fps,
    tonemap,
    forcedKeyframeTimes,
    nominalKbps = null
  }) {
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
      ...bitrateCapArgs(h, nominalKbps),
      "-threads", String(CPU_THREADS),
      "-pix_fmt", "yuv420p",
      // Fixed GOP: a keyframe exactly every (segmentDurationSec × fps) frames,
      // scene-cut keyframes disabled. This is frame-count based, so it is
      // independent of the PTS offset used on seek-restart — every HLS segment
      // is exactly segmentDurationSec long and starts on a keyframe, so segment
      // boundaries line up with the synthetic playlist with no gaps. (The old
      // the OLD `expr:` form of -force_key_frames broke after a seek, because
      // the `t` it reads is shifted by `-output_ts_offset`.)
      //
      // An explicit cut LIST is a different thing and does work: verified by
      // running it, its times are on the run's own timeline — the same one
      // `-segment_times` is measured on — so both are given one list and
      // cannot drift apart. It replaces the frame-count GOP, which cannot
      // describe the source's keyframes because they are not evenly spaced.
      // `-g` stays as an upper bound on the interval: an extra keyframe
      // inside a segment costs a little bitrate and cuts nothing, while
      // leaving the interval unbounded means a driver that ignores the list
      // produces one enormous segment instead of a wrong but cut one.
      // `-keyint_min` goes, since a MINIMUM interval is the one thing that
      // could argue with a forced keyframe.
      "-g", String(segmentDurationSec * outFps),
      ...(hasForcedTimes(forcedKeyframeTimes)
        ? keyFrameArgs(segmentDurationSec, forcedKeyframeTimes)
        : ["-keyint_min", String(segmentDurationSec * outFps)]),
      "-sc_threshold", "0"
    ];
  }
}
