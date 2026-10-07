import { AUDIO_TRANSCODE_KBPS } from "./args.js";
import { ffmpegSeconds, publishedStartTime, publishedGridFor } from "./run-command.js";
import { SEGMENT_CUT_TIME_DELTA_SECONDS } from "./output/index.js";

/** One held Matroska stdin, with no container seek or second input. */
export function buildAdmittedCommand({ admittedInput, timeline, output, segmentFormat, transcodeVideo,
  transcodeAudio, audioOnly, audioSeparate, rateControl, startIndex, endIndex, videoEncoder, segmentDurationSec }) {
  const safeIndex = Math.max(0, Number.isInteger(startIndex) ? startIndex : 0);
  const startSeconds = publishedStartTime(timeline, safeIndex, segmentDurationSec);
  const grid = publishedGridFor(timeline);
  const endSeconds = grid?.[endIndex + 1];
  if (!(endSeconds > startSeconds)) throw new Error("An admitted run requires a complete finite output interval.");
  const origin = admittedInput.originSeconds;
  const relativeStart = Math.max(0, startSeconds - origin);
  const relativeEnd = endSeconds - origin;
  // segment.c adds the first reference packet's PTS to every relative cut.
  // Copied audio can start after the published boundary; price cuts from its
  // actual first packet rather than adding that delay to every segment end.
  const firstAudio = audioOnly && !transcodeAudio
    ? admittedInput.tracks.find(input => input.track.type === "audio")?.packets[0]?.pts : null;
  const cutOrigin = Number.isFinite(firstAudio) ? firstAudio : startSeconds;
  const cutTimes = grid.slice(safeIndex + 1, endIndex + 1).map(time => time - cutOrigin);
  const args = ["-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1"];
  if (transcodeVideo && Array.isArray(videoEncoder.inputArgs)) args.push(...videoEncoder.inputArgs);
  args.push("-f", "matroska", "-i", "pipe:0", "-copyts", "-avoid_negative_ts", "disabled", "-output_ts_offset", ffmpegSeconds(origin));
  const video = transcodeVideo ? videoEncoder.buildVideoArgs({
    targetWidth: output.encodeWidth, targetHeight: output.encodeHeight, segmentDurationSec,
    fps: output.outputFps, preset: output.softwarePreset ?? undefined, tonemap: output.applyTonemap === true,
    forcedKeyframeTimes: [relativeStart, ...cutTimes.map(time => relativeStart + time)], rateControl: rateControl ?? null
  }) : ["-c:v", "copy"];
  if (transcodeVideo) {
    video.push("-fps_mode:v", "passthrough", "-enc_time_base:v", "1:1000000");
    const existing = video.indexOf("-vf");
    const trim = `trim=start=${ffmpegSeconds(relativeStart)}:end=${ffmpegSeconds(relativeEnd)}`;
    if (existing >= 0) {
      // Anchor the frame cadence at the requested interval, rather than the
      // earlier audio preroll that determined the shared stdin origin.
      const filters = video[existing + 1].replace(/fps=(\d+)(?=,|$)/g,
        (_match, fps) => `setpts=PTS+${ffmpegSeconds(origin)}/TB,fps=${fps}:start_time=${ffmpegSeconds(startSeconds)},settb=1/1000000,setpts=PTS-${ffmpegSeconds(origin)}/TB`);
      video[existing + 1] = `${trim},${filters},${trim}`;
    }
    else video.push("-vf", trim);
  }
  const audio = transcodeAudio ? ["-c:a", "aac", "-ac", "2", "-b:a", `${AUDIO_TRANSCODE_KBPS}k`,
    "-af", `atrim=start=${ffmpegSeconds(relativeStart)}:end=${ffmpegSeconds(relativeEnd)}`] : ["-c:a", "copy"];
  if (audioOnly) args.push("-vn", "-map", "0:a:0", ...audio);
  else if (audioSeparate) args.push("-an", "-map", "0:v:0", ...video);
  else args.push("-map", "0:v:0", "-map", "0:a:0?", ...video, ...audio);
  args.push("-to", ffmpegSeconds(relativeEnd), "-f", "segment");
  if (cutTimes.length) args.push("-segment_times", cutTimes.join(","));
  else args.push("-segment_time", ffmpegSeconds(endSeconds - cutOrigin));
  const formatArgs = segmentFormat.explicitTimesMuxerArgs?.();
  if (!Array.isArray(formatArgs)) throw new Error("The segment format cannot publish admitted packet input.");
  const muxOptions = formatArgs.indexOf("-segment_format_options");
  const muxFormat = formatArgs.indexOf("-segment_format");
  if (muxFormat >= 0 && formatArgs[muxFormat + 1] === "mp4" && muxOptions >= 0) {
    // Millisecond movie edits cannot retain a sample-accurate AAC origin.
    formatArgs[muxOptions + 1] += ":movie_timescale=1000000";
  }
  // Audio has no keyframe rounding: the video tolerance can remove several
  // audio frames from the declared interval before the requested cut.
  args.push("-segment_time_delta", String(audioOnly ? 0 : SEGMENT_CUT_TIME_DELTA_SECONDS), "-segment_start_number", String(safeIndex),
    "-segment_list", "pipe:3", "-segment_list_flags", "+live", ...formatArgs,
    segmentFormat.makingFileNameTemplate(admittedInput.runTag ?? `${safeIndex}-${admittedInput.fingerprint.slice(0, 12)}`));
  return { args, safeIndex, startSeconds, cutTimes };
}
