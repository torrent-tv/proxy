import { PLAYLIST_FILE_NAME } from "./output/playlists.js";
import { AUDIO_TRANSCODE_KBPS } from "./args.js";
import { cutsAtGivenTimes, SEGMENT_CUT_TIME_DELTA_SECONDS } from "./output/index.js";
import { ffmpegSeconds, onKeyframeGridFor, publishedGridFor, publishedStartTime, segmentCutTimesFrom, nearestKeyframeAtOrBefore } from "./run-command.js";

/** Account for FFmpeg's Matroska B-frame input-seek adjustment (ffmpeg_demux.c). */
function seekLandingOffsetFor(material, keyframe) {
  if (material.transcodeVideo || material.audioOnly || !(material.reorderDepth > 0)) return 0;
  const wanted = 3 / 23 + Math.max(0, material.keyframes?.tolerance ?? 0);
  const next = material.keyframes?.times?.find(time => time > keyframe + 0.001);
  return next === undefined ? wanted : Math.min(wanted, (next - keyframe) / 2);
}

export function buildRunCommand({
  keyframes,
  inputFile,
  audioFile,
  inputUrl,
  audioInputUrl: audioInputUrlGiven,
  timeline,
  output,
  segmentFormat,
  transcodeVideo,
  transcodeAudio,
  audioOnly,
  audioSeparate,
  audioSourceTrackIndex,
  videoSourceTrackIndex = 0,
  rateControl,
  startIndex,
  endIndex,
  positionSecondsOverride,
  videoEncoder,
  segmentDurationSec,
  reorderDepth = 0
}) {
  const safeIndex = Number.isInteger(startIndex) && startIndex > 0 ? startIndex : 0;
  const startSeconds = Number.isFinite(positionSecondsOverride)
    ? positionSecondsOverride
    : publishedStartTime(timeline, safeIndex, segmentDurationSec);
  const keyframeGrid = onKeyframeGridFor({ audioOnly, timeline, transcodeVideo });
  const servesAudioSeparately = audioOnly !== true && audioSeparate === true;
  const audioFileStartTime = audioFile.startTime;
  const sourceStartTime = inputFile.startTime;
  const explicitTimes = segmentFormat.explicitTimesMuxerArgs?.() ?? null;
  const inputIndex = !transcodeVideo && !audioOnly && explicitTimes && safeIndex > 0
    ? safeIndex - 1 : safeIndex;
  const gridCutTimes = cutsAtGivenTimes({ segmentFormat, timeline })
    ? segmentCutTimesFrom(publishedGridFor(timeline), inputIndex)
    : null;
  const cutTimes = gridCutTimes;
  const videoCodecArgs = transcodeVideo
    ? videoEncoder.buildVideoArgs({
        targetWidth: output.encodeWidth,
        targetHeight: output.encodeHeight,
        segmentDurationSec: segmentDurationSec,
        fps: output.outputFps,
        preset: output.softwarePreset ?? undefined,
        tonemap: output.applyTonemap === true,
        forcedKeyframeTimes: cutTimes,
        rateControl: rateControl ?? null
      })
    : ["-c:v", "copy"];
  const audioCodecArgs = transcodeAudio
    ? ["-c:a", "aac", "-ac", "2", "-b:a", `${AUDIO_TRANSCODE_KBPS}k`]
    : ["-c:a", "copy"];

  const args = ["-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1"];
  if (transcodeVideo && Array.isArray(videoEncoder.inputArgs)) {
    args.push(...videoEncoder.inputArgs);
  }
  const inputStartSeconds = inputIndex === safeIndex ? startSeconds :
    publishedStartTime(timeline, inputIndex, segmentDurationSec);
  const seekSeconds = timeline.cutGrid === "keyframe"
    ? inputStartSeconds + sourceStartTime
    : inputStartSeconds;
  const carriedKeyframe = timeline.cutGrid === "keyframe" && typeof timeline.sourceStartOf === "function"
    ? timeline.sourceStartOf(inputIndex)
    : null;
  const snappedKeyframe = Number.isFinite(carriedKeyframe)
    ? carriedKeyframe
    : (Array.isArray(keyframes?.times) && keyframes.times.length > 0
      ? nearestKeyframeAtOrBefore(keyframes.times, seekSeconds)
      : null);
  const audioInputUrl =
    typeof audioInputUrlGiven === "string" && audioInputUrlGiven.length > 0
      ? audioInputUrlGiven
      : "";
  const audioTimelineShift = audioInputUrl
    ? audioFileStartTime - sourceStartTime
    : 0;
  /**
   * Add the second input, if there is one, with its own seek.
   *
   * Called between the first `-i` and any OUTPUT option, because ffmpeg reads
   * these positionally: an option written after the last `-i` applies to the
   * output, and the residual seek below is exactly such an option. Getting the
   * order wrong would silently turn the audio file's seek into a trim of the
   * finished stream.
   *
   * @param {number} inputSeekSeconds - Where to start, on the PICTURE's
   *   timeline. Translated to the soundtrack file's own here.
   */
  const pushAudioInput = (inputSeekSeconds) => {
    if (!audioInputUrl) {
      return;
    }
    if (audioTimelineShift !== 0 && keyframeGrid) {
      args.push("-itsoffset", ffmpegSeconds(-audioTimelineShift));
    }
    const audioSeek = Math.max(0, inputSeekSeconds + audioTimelineShift);
    if (audioSeek > 0) {
      args.push("-accurate_seek", "-ss", ffmpegSeconds(audioSeek));
    }
    args.push("-i", audioInputUrl);
  };

  if (snappedKeyframe !== null) {
    const residualSeconds = Math.max(0, seekSeconds - snappedKeyframe);
    if (snappedKeyframe > 0) {
      args.push("-ss", ffmpegSeconds(snappedKeyframe + seekLandingOffsetFor({ audioOnly, transcodeVideo, keyframes, reorderDepth }, snappedKeyframe)));
    }
    args.push("-i", inputUrl);
    pushAudioInput(snappedKeyframe);
    if (residualSeconds > 0 && !keyframeGrid) {
      args.push("-ss", ffmpegSeconds(residualSeconds));
    }
  } else {
    if (seekSeconds > 0) {
      args.push("-accurate_seek", "-ss", ffmpegSeconds(seekSeconds));
    }
    args.push("-i", inputUrl);
    pushAudioInput(seekSeconds);
  }
  if (!keyframeGrid) {
    if (startSeconds > 0) {
      args.push("-output_ts_offset", ffmpegSeconds(startSeconds));
    }
  } else {
    args.push("-copyts");
    if (sourceStartTime !== 0) {
      args.push("-output_ts_offset", ffmpegSeconds(-sourceStartTime));
    }
  }
  const runEnd = Number.isInteger(endIndex) ? endIndex : -1;
  const publishedGrid = publishedGridFor(timeline);
  if (runEnd >= safeIndex && Array.isArray(publishedGrid) && publishedGrid[runEnd + 1] > 0) {
    const endsAt = publishedGrid[runEnd + 1];
    if (transcodeVideo) {
      args.push("-t", ffmpegSeconds(Math.max(0.1, endsAt - publishedGrid[safeIndex])));
    } else {
      args.push("-to", ffmpegSeconds(endsAt));
    }
  }
  if (audioOnly === true) {
    args.push("-vn", "-map", `0:a:${audioSourceTrackIndex}?`, ...audioCodecArgs);
  } else if (servesAudioSeparately) {
    args.push("-an", "-map", `0:v:${videoSourceTrackIndex}?`, ...videoCodecArgs);
  } else {
    args.push(
      "-map",
      `0:v:${videoSourceTrackIndex}?`,
      "-map",
      `${audioInputUrl ? 1 : 0}:a:${audioSourceTrackIndex}?`,
      ...videoCodecArgs,
      ...audioCodecArgs
    );
  }
  if (cutTimes && cutTimes.length > 0) {
    args.push(
      "-f",
      "segment",
      "-segment_times",
      cutTimes.join(","),
      "-segment_time_delta",
      String(SEGMENT_CUT_TIME_DELTA_SECONDS),
      "-segment_start_number",
      String(inputIndex),
      "-segment_list",
      "pipe:3",
      "-segment_list_type",
      "csv",
      "-segment_list_flags",
      "+live",
      ...explicitTimes,
      segmentFormat.makingFileNameTemplate(String(safeIndex))
    );
  } else {
    args.push(
      "-f",
      "hls",
      "-hls_time",
      String(segmentDurationSec),
      "-hls_list_size",
      "0",
      "-hls_flags",
      "independent_segments+temp_file",
      ...segmentFormat.muxerArgs(),
      "-start_number",
      String(safeIndex),
      PLAYLIST_FILE_NAME
    );
  }
  return { args, safeIndex, inputIndex, startSeconds, cutTimes };

}

/** One finite original-source run, preserving the published interval and track choice. */
export function buildOriginalCommand(params) {
  const { admittedInput, timeline, startIndex, inputToken, baseUrl, audioOnly } = params;
  const grid = publishedGridFor(timeline);
  const from = grid[startIndex], to = grid[startIndex + 1];
  if (!(to > from)) throw new Error("Original-source encoding requires a finite published interval.");
  const sourceFor = kind => admittedInput.sources.find(source => source.input.selections.some(selection => selection.track.type === kind));
  const primary = sourceFor(audioOnly ? "audio" : "video");
  const audio = sourceFor("audio") ?? primary;
  if (!primary) throw new Error("The selected source track is absent from original input.");
  const url = source => new URL(`/encode-input/${inputToken}/${source.fileIndex}`, baseUrl).href;
  const localTimeline = { ...timeline, published: [from, to, to + (to - from)],
    boundaries: [from, to, to + (to - from)], sourceStartOf: () => timeline.sourceStartOf?.(startIndex) ?? from + primary.timeShiftSeconds };
  const command = buildRunCommand({ ...params, startIndex: 0, endIndex: 0, timeline: localTimeline,
    videoSourceTrackIndex: primary.input.selections.find(selection => selection.track.type === "video")?.index ?? 0,
    reorderDepth: primary.input.selections.find(selection => selection.track.type === "video")?.track.reorderDepth ?? 0,
    inputFile: { startTime: primary.timeShiftSeconds }, audioFile: { startTime: audio.timeShiftSeconds },
    inputUrl: url(primary), audioInputUrl: audio !== primary && !audioOnly ? url(audio) : "",
    audioSourceTrackIndex: audio.input.selections.find(selection => selection.track.type === "audio")?.index ?? 0 });
  const args = command.args;
  // The segment muxer otherwise shifts negative initial DTS to zero before
  // the inner muxer writes its edit list, moving B-picture PTS off the source.
  args.splice(args.indexOf("-f"), 0, "-avoid_negative_ts", "disabled");
  const formatOptions = args.indexOf("-segment_format_options");
  if (formatOptions >= 0) args[formatOptions + 1] += ":avoid_negative_ts=disabled";
  const numbering = args.indexOf("-segment_start_number");
  if (numbering < 0) throw new Error("The format cannot produce finite original-source segments.");
  args[numbering + 1] = String(startIndex);
  args[args.length - 1] = params.segmentFormat.makingFileNameTemplate(admittedInput.runTag);
  if (audioOnly) args[args.indexOf("-segment_time_delta") + 1] = "0";
  return { ...command, safeIndex: startIndex, inputIndex: startIndex };
}
