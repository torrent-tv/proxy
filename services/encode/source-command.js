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
  inputOpenArgs = [],
  audioInputOpenArgs = [],
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
  // Under `-copyts` FFmpeg trims a decoded stream at `-ss` PLUS its own idea of
  // the file's start, ignoring `-seek_timestamp` (ffmpeg_demux.c, n8.1.2,
  // `trim_start_us`): an absolute seek would be trimmed a second start later.
  // On the keyframe grid its trim is therefore switched off on every input and
  // the decoded soundtrack is cut here, on the picture file's clock, which is
  // the clock every stream carries there.
  const inputSeekArgs = keyframeGrid ? ["-noaccurate_seek"] : ["-accurate_seek"];

  const args = ["-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1"];
  if (transcodeVideo && Array.isArray(videoEncoder.inputArgs)) {
    args.push(...videoEncoder.inputArgs);
  }
  const inputStartSeconds = inputIndex === safeIndex ? startSeconds :
    publishedStartTime(timeline, inputIndex, segmentDurationSec);
  // ONE CLOCK FOR EVERY INPUT SEEK. Each `-ss` below is an absolute timestamp
  // of the file it seeks, given with `-seek_timestamp 1`: without it FFmpeg
  // adds its own idea of the file's start time to the value, which is a second
  // copy of a start this code already knows. Published positions begin at
  // zero, so the picture's instant is the published time plus the picture
  // file's start; keyframe times are on the same file clock; a soundtrack in
  // another file is the same instant on that file's clock. Whether the cuts
  // follow the source's keyframes or an even grid changes how the run ENDS
  // and what its output timestamps are, never where its input is.
  const seekAt = inputStartSeconds + sourceStartTime;
  const carriedKeyframe = timeline.cutGrid === "keyframe" && typeof timeline.sourceStartOf === "function"
    ? timeline.sourceStartOf(inputIndex)
    : null;
  const snappedKeyframe = Number.isFinite(carriedKeyframe)
    ? carriedKeyframe
    : (Array.isArray(keyframes?.times) && keyframes.times.length > 0
      ? nearestKeyframeAtOrBefore(keyframes.times, seekAt)
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
   * @param {number} inputSeekSeconds - Where to start, on the PICTURE
   *   file's clock. Translated to the soundtrack file's own here.
   */
  const pushAudioInput = (inputSeekSeconds) => {
    if (!audioInputUrl) {
      return;
    }
    if (audioTimelineShift !== 0 && keyframeGrid) {
      args.push("-itsoffset", ffmpegSeconds(-audioTimelineShift));
    }
    const audioSeek = inputSeekSeconds + audioTimelineShift;
    if (audioSeek > audioFileStartTime) {
      args.push("-seek_timestamp", "1", ...inputSeekArgs, "-ss", ffmpegSeconds(audioSeek));
    }
    args.push(...audioInputOpenArgs, "-i", audioInputUrl);
  };

  // Whether an output `-ss` already cuts at the interval's start.
  let trimmedAtStart = false;
  if (snappedKeyframe !== null) {
    const residualSeconds = Math.max(0, seekAt - snappedKeyframe);
    if (snappedKeyframe > sourceStartTime) {
      args.push("-seek_timestamp", "1", ...inputSeekArgs, "-ss", ffmpegSeconds(snappedKeyframe + seekLandingOffsetFor({ audioOnly, transcodeVideo, keyframes, reorderDepth }, snappedKeyframe)));
    }
    args.push(...inputOpenArgs, "-i", inputUrl);
    pushAudioInput(snappedKeyframe);
    if (residualSeconds > 0 && !keyframeGrid) {
      args.push("-ss", ffmpegSeconds(residualSeconds));
      trimmedAtStart = true;
    }
  } else {
    if (seekAt > sourceStartTime) {
      args.push("-seek_timestamp", "1", ...inputSeekArgs, "-ss", ffmpegSeconds(seekAt));
    }
    args.push(...inputOpenArgs, "-i", inputUrl);
    pushAudioInput(seekAt);
  }
  // An input seek lands on the picture's keyframe at or before the time asked
  // for, in every stream (AVI `avi_read_seek`, Matroska Cues). `-accurate_seek`
  // trims only what is decoded, so a copied soundtrack began at that keyframe
  // and `-t` counted its length from there: a piece of a LostFilm AVI with a
  // keyframe every 11 s carried the film's first four seconds (torrent-tv/meta#159).
  // Without `-copyts` the time asked for is zero on the output's input clock.
  if (!keyframeGrid && !servesAudioSeparately && !transcodeAudio && !trimmedAtStart) {
    args.push("-ss", "0");
  }
  if (!keyframeGrid) {
    if (startSeconds > 0) {
      args.push("-output_ts_offset", ffmpegSeconds(startSeconds));
    }
  } else {
    args.push("-copyts");
    // Audio's output seek removes demux preroll and subtracts that absolute
    // seek from packet timestamps. Restore the published position explicitly;
    // positive copied AAC timestamps alone are not retained by every movenc.
    const offset = audioOnly ? startSeconds : -sourceStartTime;
    if (offset !== 0) {
      args.push("-output_ts_offset", ffmpegSeconds(offset));
    }
  }
  const runEnd = Number.isInteger(endIndex) ? endIndex : -1;
  const publishedGrid = publishedGridFor(timeline);
  if (runEnd >= safeIndex && Array.isArray(publishedGrid) && publishedGrid[runEnd + 1] > 0) {
    const endsAt = publishedGrid[runEnd + 1];
    if (keyframeGrid) {
      // `-copyts` keeps the input's own clock up to the muxer, and an output
      // `-to` is compared there, before `-output_ts_offset` moves it.
      args.push("-to", ffmpegSeconds(endsAt + sourceStartTime));
    } else {
      // The output clock starts at zero where this run begins, so the end is
      // a length; an output `-to` would be read as a length from zero too and
      // run past the interval by its own start.
      args.push("-t", ffmpegSeconds(Math.max(0.1, endsAt - startSeconds)));
    }
  }
  if (keyframeGrid && transcodeAudio && !servesAudioSeparately) {
    audioCodecArgs.push("-af", `atrim=start=${ffmpegSeconds(seekAt)}`);
  }
  if (audioOnly === true) {
    // Input seeking locates bytes; copied audio also needs an output trim.
    if (keyframeGrid) args.push("-ss", ffmpegSeconds(seekAt));
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

/**
 * One finite original-source run over the stretch its input holds, `startIndex`
 * through `endIndex`, preserving the published intervals and track choice.
 *
 * The command works on a local timeline holding the stretch's own boundaries
 * plus one beyond its end, so every published boundary inside it, the end
 * included, is a cut, and what the muxer flushes after the end is a piece
 * nobody publishes. Numbering continues from `startIndex`.
 */
export function buildOriginalCommand(params) {
  const { admittedInput, timeline, startIndex, inputToken, baseUrl, audioOnly } = params;
  const endIndex = Number.isInteger(params.endIndex) && params.endIndex >= startIndex ? params.endIndex : startIndex;
  const grid = publishedGridFor(timeline);
  const stretch = grid.slice(startIndex, endIndex + 2);
  const from = stretch[0], to = stretch.at(-1);
  if (stretch.length !== endIndex - startIndex + 2 || !stretch.every((at, index) => index === 0 || at > stretch[index - 1])) {
    throw new Error("Original-source encoding requires a finite published interval.");
  }
  const last = stretch.at(-2);
  const sourceFor = kind => admittedInput.sources.find(source => source.input.selections.some(selection => selection.track.type === kind));
  const primary = sourceFor(audioOnly ? "audio" : "video");
  const audio = sourceFor("audio") ?? primary;
  if (!primary) throw new Error("The selected source track is absent from original input.");
  const url = source => new URL(`/encode-input/${inputToken}/${source.fileIndex}`, baseUrl).href;
  // The container named the bytes FFmpeg's stream search reads for this much
  // media time; the search is told the same, whatever its own default.
  const openArgs = source => Number.isFinite(source.input.streamSearchSeconds)
    ? ["-analyzeduration", String(Math.round(source.input.streamSearchSeconds * 1_000_000))] : [];
  const local = [...stretch, to + (to - last)];
  const localTimeline = { ...timeline, published: local,
    boundaries: local, sourceStartOf: () => primary.input.from ?? from + primary.timeShiftSeconds };
  const command = buildRunCommand({ ...params, startIndex: 0, endIndex: endIndex - startIndex, timeline: localTimeline,
    videoSourceTrackIndex: primary.input.selections.find(selection => selection.track.type === "video")?.index ?? 0,
    reorderDepth: primary.input.selections.find(selection => selection.track.type === "video")?.track.reorderDepth ?? 0,
    inputFile: { startTime: primary.timeShiftSeconds }, audioFile: { startTime: audio.timeShiftSeconds },
    inputUrl: url(primary), audioInputUrl: audio !== primary && !audioOnly ? url(audio) : "",
    inputOpenArgs: openArgs(primary), audioInputOpenArgs: openArgs(audio),
    audioSourceTrackIndex: audio.input.selections.find(selection => selection.track.type === "audio")?.index ?? 0 });
  const args = command.args;
  // The segment muxer otherwise shifts negative initial DTS to zero before
  // the inner muxer writes its edit list, moving B-picture PTS off the source.
  args.splice(args.indexOf("-f"), 0, "-avoid_negative_ts", "disabled");
  const formatOptions = args.indexOf("-segment_format_options");
  if (formatOptions >= 0) args[formatOptions + 1] += ":avoid_negative_ts=disabled:movie_timescale=1000000";
  const numbering = args.indexOf("-segment_start_number");
  if (numbering < 0) throw new Error("The format cannot produce finite original-source segments.");
  args[numbering + 1] = String(startIndex);
  args[args.length - 1] = params.segmentFormat.makingFileNameTemplate(admittedInput.runTag);
  if (audioOnly) args[args.indexOf("-segment_time_delta") + 1] = "0";
  return { ...command, safeIndex: startIndex, inputIndex: startIndex };
}
