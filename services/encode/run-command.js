/**
 * @file The full argument list for one encoder run.
 *
 * What a run is given is a fact about WHAT is being produced and WHERE it
 * begins, and about nothing else — not the session it belongs to, not who is
 * watching, not how many viewers there are. It was a 377-line method of the
 * session manager reading fifteen of its fields, which is why a run could only
 * ever be built by that class, for the one session it holds.
 *
 * Stated here, over the material and the stretch alone, a run can be built by
 * whoever needs one. That is what lets an output have more than a single
 * encoder.
 *
 * **Nothing in this file runs anything.** It returns an argument list; spawning,
 * killing and resuming belong to whoever owns the process.
 */

/** The name ffmpeg writes its own playlist to, and the name that is served. */
export const PLAYLIST_FILE_NAME = "index.m3u8";

/**
 * What ffmpeg's own CLI subtracts from an input seek, and therefore what has to
 * be added back to land where we asked.
 *
 * `fftools/ffmpeg_demux.c`, in `ifile_open`: when the container does not
 * declare `AVFMT_SEEK_TO_PTS` — Matroska does not — and any stream carries
 * B-frames, the seek target is moved back by `3*AV_TIME_BASE / 23` before
 * `avformat_seek_file` is called. Its purpose is sound: such containers seek in
 * decode order while the caller asks in presentation order, and with B-frames
 * the two differ, so it backs off far enough to be sure of reaching the frame
 * asked for.
 *
 * The consequence for a COPY is that asking for a keyframe lands on the one
 * BEFORE it — deterministically, every time. Measured 2026-08-21 on a Matroska
 * file with keyframes every 2 s: `-ss 10` produced a first segment starting at
 * 8.000; `-ss 10.130435` produced one starting at 10.000. On MP4, where the
 * heuristic does not fire, all of 10, 10.130435 and 10.2 produced 10.000 — so
 * adding this is right in one case and harmless in the other.
 *
 * That landing is what `-segment_times` is measured from, while this code
 * computes those offsets from the time it ASKED for. One keyframe interval
 * apart, inherited by every cut of the run: 119 of 125 segments arriving a
 * uniform 2.002 s early in the field, four times what a player bridges.
 *
 * Not applied when the picture is re-encoded: a re-encode decodes from the
 * keyframe and discards frames up to the requested time, so its output already
 * begins exactly where asked (measured the same day: `-ss 11` copied starts at
 * 10.000, re-encoded at 11.000).
 */
export const SEEK_LANDING_OFFSET_SEC = 3 / 23;

/**
 * A number of seconds as ffmpeg will accept it.
 *
 * `String(n)` switches to exponential notation below 1e-6, and ffmpeg's
 * duration parser rejects that outright: a field session died on
 * `Invalid duration for option ss: 3.3333333249174757e-7`, after which the
 * transcode was in state `failed` and every segment request answered 500 for
 * as long as the viewer kept trying. Anything under a millisecond is also not a
 * real offset — it is the residue of subtracting two nearly equal floats — so
 * it is dropped rather than passed on.
 *
 * @param {number} value
 * @returns {string}
 */
export function ffmpegSeconds(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.001) {
    return "0";
  }
  // Microsecond resolution, fixed notation, no trailing zero noise.
  return value.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * Which timeline an output's own ffmpeg works on.
 *
 * True — the COPY branch: the source's timestamps are kept (`-copyts`) and the
 * output is re-labelled 0-based. Everything handed to the muxer is therefore
 * stated in the source's terms, and everything read back out of a produced
 * piece is 0-based.
 *
 * False — the re-encode branch: the output is labelled from the run's start on
 * the 0-based timeline, and the muxer is addressed in those same terms.
 *
 * One predicate for both callers, because the two used to answer it separately
 * and a disagreement between them is exactly what desynced picture from sound.
 *
 * @param {{ audioOnly?: boolean, timeline?: { cutGrid?: string }, transcodeVideo?: boolean }} material
 * @returns {boolean}
 */
export function onKeyframeGridFor(material) {
  return material?.audioOnly === true
    ? material?.timeline?.cutGrid === "keyframe"
    : material?.transcodeVideo !== true;
}

/**
 * The boundary table the player is working from: the one its playlist was
 * written from, falling back to the live table when no playlist was built from
 * a table at all (no duration, so no synthetic playlist — and then nothing the
 * player holds contradicts it).
 *
 * @param {{ published?: number[], boundaries?: number[] }} timeline
 * @returns {number[]}
 */
export function publishedGridFor(timeline) {
  return Array.isArray(timeline?.published) && timeline.published.length > 0
    ? timeline.published
    : (timeline?.boundaries ?? []);
}

/**
 * Where a run beginning at `index` must be positioned: the time the PLAYER was
 * told that segment starts at.
 *
 * Two tables, deliberately: the live one is corrected as produced segments
 * reveal where the file's cuts truly are, and those corrections are what let a
 * re-encoded rung be forced onto a copied stream's real grid. But the playlist
 * a player is holding was written once and never changes, so a position taken
 * from the corrected table describes a timeline nobody sent the player. That is
 * not a subtlety: it cost ten minutes of a dead film on 2026-08-17, the browser
 * asking for two segments 1908 times each.
 *
 * @param {{ published?: number[], boundaries?: number[] }} timeline
 * @param {number} index
 * @param {number} segmentDurationSec - Used only when the file has no table at
 *   all, where a segment is a plain multiple of the nominal length.
 * @returns {number}
 */
export function publishedStartTime(timeline, index, segmentDurationSec) {
  const published = Array.isArray(timeline?.published) && timeline.published.length > 0 ? timeline.published : null;
  const table = published ?? (Array.isArray(timeline?.boundaries) ? timeline.boundaries : []);
  if (table.length === 0) {
    return index * segmentDurationSec;
  }
  const clamped = Math.max(0, Math.min(index, table.length - 1));
  return table[clamped];
}

/**
 * The cut times to hand ffmpeg for a run that starts at `startIndex`.
 *
 * Two adjustments, both of which cost a broken session to learn:
 *
 *  - **Rebased.** `-segment_times` is measured from the start of the run, not
 *    of the file. Measured: starting at 12 s and asking for a cut at 18 s put
 *    it at 29.4 s — 12 + 18. So every boundary has the run's own start
 *    subtracted.
 *  - **Interior only.** The first boundary is where the run begins and the last
 *    is where the file ends; neither is a cut. Sending them would produce an
 *    empty leading segment and a spurious trailing one.
 *
 * @param {number[]} boundaries
 * @param {number} startIndex
 * @returns {number[] | null}
 */
export function segmentCutTimesFrom(boundaries, startIndex) {
  if (!Array.isArray(boundaries) || boundaries.length < 2) {
    return null;
  }
  const index = Number.isInteger(startIndex) && startIndex > 0 ? startIndex : 0;
  if (index >= boundaries.length - 1) {
    return null;
  }
  const base = boundaries[index];
  const times = [];
  for (let at = index + 1; at < boundaries.length - 1; at += 1) {
    times.push(Number((boundaries[at] - base).toFixed(6)));
  }
  return times;
}

/**
 * The largest keyframe time that does not exceed `target`, from a SORTED
 * (ascending) array of keyframe times. Null when `target` is before the first
 * keyframe or the array is empty — the caller then falls back to its unsnapped
 * target.
 *
 * @param {number[]} keyframeTimes - Sorted ascending.
 * @param {number} target
 * @returns {number | null}
 */
export function nearestKeyframeAtOrBefore(keyframeTimes, target) {
  let result = null;
  for (const time of keyframeTimes) {
    if (time > target) {
      break;
    }
    result = time;
  }
  return result;
}

/**
 * How much later than a keyframe to ASK, so that ffmpeg lands on that keyframe.
 *
 * Bounded by half the distance to the next keyframe, which matters only where
 * keyframes stand closer together than twice the offset. There no single value
 * can satisfy both worlds — asking too little lands a keyframe early when the
 * heuristic fires, asking too much lands a keyframe late when it does not — and
 * the bound picks the smaller error, which is then under one keyframe interval
 * and therefore under what a player bridges.
 *
 * @param {{ transcodeVideo?: boolean, file?: { keyframeTimes?: number[], keyframeTolerance?: number } }} material
 * @param {number} keyframe - A real keyframe time the run is to begin at.
 * @returns {number} Seconds to add to the request.
 */
export function seekLandingOffsetFor(material, keyframe) {
  // A re-encode trims to the requested time itself, so it needs no help and
  // must not be pushed past what it was asked for.
  if (material?.transcodeVideo === true) {
    return 0;
  }
  // A grid whose times are approximate needs that error added on top, or a name
  // sitting just below its real keyframe seeks to before it and lands on the
  // one before that. Only AVI declares one.
  const tolerance = Number.isFinite(material?.file?.keyframeTolerance)
    ? Math.max(0, material.file.keyframeTolerance)
    : 0;
  const wanted = SEEK_LANDING_OFFSET_SEC + tolerance;
  const times = Array.isArray(material?.file?.keyframeTimes) ? material.file.keyframeTimes : [];
  const next = times.find((time) => time > keyframe + 0.001);
  if (next === undefined) {
    return wanted;
  }
  return Math.min(wanted, (next - keyframe) / 2);
}

/**
 * Everything ffmpeg is told for one run.
 *
 * @param {object} params
 * @param {{ keyframeTimes?: number[], keyframeTolerance?: number }} params.file - The
 *   PICTURE's file: whose keyframes a seek snaps to.
 * @param {{ startTime: number }} params.inputFile - The file this run reads.
 * @param {{ startTime: number }} params.audioFile - The file the chosen
 *   soundtrack lives in, which for a dub shipped beside the picture is not the
 *   picture's own.
 * @param {string} params.inputUrl
 * @param {string} params.audioInputUrl - Empty unless a browser that takes its
 *   audio muxed is watching a release whose soundtrack is a file of its own.
 * @param {{ published?: number[], boundaries?: number[], cutGrid?: string }} params.timeline
 * @param {{ encodeWidth: number, encodeHeight: number, outputFps: number, softwarePreset: string | null, applyTonemap: boolean }} params.output
 * @param {object} params.segmentFormat
 * @param {boolean} params.transcodeVideo
 * @param {boolean} params.transcodeAudio
 * @param {boolean} params.audioOnly - An audio rendition: one track, no picture.
 * @param {boolean} params.audioSeparate - The picture's sound is published as a
 *   rendition, so this output carries none.
 * @param {number} params.audioSourceTrackIndex - `0:a:N` within its own file.
 * @param {number | null} params.rateCapKbps
 * @param {number} params.startIndex - First segment number this run makes.
 * @param {number} params.endIndex - Last it makes, inclusive; below the start
 *   means it has no end.
 * @param {number | undefined} params.positionSecondsOverride - Where to begin,
 *   when the caller knows better than the table.
 * @param {object} params.videoEncoder
 * @param {number} params.segmentDurationSec
 * @returns {{ args: string[], safeIndex: number, startSeconds: number, cutTimes: number[] | null }}
 */
export function buildRunCommand({
  file,
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
  rateCapKbps,
  startIndex,
  endIndex,
  positionSecondsOverride,
  videoEncoder,
  segmentDurationSec
}) {
  const safeIndex = Number.isInteger(startIndex) && startIndex > 0 ? startIndex : 0;
  // 0-based output time of this segment, from the table the PLAYER holds —
  // the same one the cut list below is taken from.
  //
  // These two were read from different tables until 2026-08-21, and that is
  // one fault, not two: `-segment_times` are measured from wherever the run
  // really began, so any distance between the position and the cut list moves
  // EVERY cut of that run by it. The live table keeps being corrected as
  // produced segments reveal where the file's cuts truly are, and those
  // corrections run backwards, so each restart began a little earlier than
  // the grid the cuts were stated on — and since the corrections accumulate,
  // so did the distance. Measured on `JUFD665.mp4`: after one seek restart a
  // produced segment held the boundary two places before its own number
  // (16.684 s, exactly 2.0000 segments), after the next it held the one four
  // places before (33.5 s). The player's buffer then stops extending at all,
  // because the content of every fragment lands before the time its playlist
  // entry names: `bufferEnd` stood still at 4571.1 s through four `frag-far`
  // warnings until hls.js gave up and jumped the viewer 16.8 s forward.
  //
  // 2.45.0 moved the CUT LIST onto the published table for this same reason
  // and left the position on the live one. Both belong on the published
  // table: a run must begin where the player was told the segment begins.
  const startSeconds = Number.isFinite(positionSecondsOverride)
    ? positionSecondsOverride
    : publishedStartTime(timeline, safeIndex, segmentDurationSec);
  // Where each of the two timelines begins, asked of the files themselves.
  // Fresh by construction: the session may have been created before the
  // soundtrack file's header could be read, and the reading lands on the file
  // object this session holds — so there is nothing to re-read and nothing
  // that can be stale. Same property as `file.keyframeTimes`,
  // which is one table shared by every session of the file.
  // Which timeline this run works on. Asked once, because the closure that
  // adds the second input reads it too, and two readings of one predicate is
  // how the picture and the sound came apart before.
  const keyframeGrid = onKeyframeGridFor({ audioOnly, timeline, transcodeVideo });
  const servesAudioSeparately = audioOnly !== true && audioSeparate === true;
  const audioFileStartTime = audioFile.startTime;
  // The start time of the file this run READS, which is the picture's own for
  // every session except one whose soundtrack is a separate file.
  const sourceStartTime = inputFile.startTime;
  // Cut where this session's grid says, whoever is producing the frames. The
  // times are measured from the start of THIS run; the same list serves as
  // the cut points and, when re-encoding, as the keyframes to force — one
  // list, so the two cannot drift apart.
  const explicitTimes = segmentFormat.explicitTimesMuxerArgs?.() ?? null;
  // A COPY is cut by this list whatever grid it ended up on. Even when no
  // keyframe index could be read and the boundaries are a plain grid, saying
  // them outright is what keeps the playlist and the muxer agreeing — ffmpeg
  // moves each cut forward to the first real keyframe, and serving reads back
  // where the piece truly begins. Requiring a keyframe grid here dropped a
  // copy with no index onto the `hls` muxer, which takes no cut list and
  // writes no self-contained pieces, so nothing could read a true start and
  // segments were stamped with times the file does not have — the 4.17 s
  // speech-against-subtitles drift, back again.
  //
  // Cut on the grid the PLAYER WAS GIVEN, not on the corrected one. A player
  // places a fragment by the playlist it holds, and that text was written
  // once and never changes; the live table keeps moving as produced segments
  // reveal where the file's cuts really are. Cutting on the moved table makes
  // every run faithful to a timeline nobody sent the player — measured
  // 2026-08-20, the picture's segments arriving a uniform 2.002 s before the
  // times the playlist named for them, which is four times what hls.js will
  // bridge, so the fragment does not land and is asked for again.
  //
  // The corrections keep their purpose: they describe the file, and a variant
  // created later inherits the corrected table and PUBLISHES it, so its own
  // playlist and its own cuts agree from the start. What they may not do is
  // move the cuts of a session whose playlist is already being read.
  const gridCutTimes = explicitTimes && (!transcodeVideo || timeline.cutGrid === "keyframe")
    ? segmentCutTimesFrom(publishedGridFor(timeline), safeIndex)
    : null;
  // Cut times are stated on the grid, for both branches.
  //
  // 2.28.0 added `sourceStartTime` to them on the copy branch, reasoning that
  // the muxer decides its cuts before the output is relabelled. The field
  // measured it the next session and the reasoning was wrong: of 75 pieces
  // the picture produced, only NINE began at a time the container's own
  // keyframe table names (the soundtrack, untouched by the change, scored 70
  // of 75). Before it, every piece began exactly on a named keyframe and it
  // was the PLAYLIST that disagreed with them. So the shift moved the cuts
  // OFF the keyframes rather than onto them, and it is gone.
  //
  // What remains true, and is what that measurement is really about: the
  // picture cuts where the source's keyframes are, and the playlist must be
  // built from those same times. That is the correction path's job, not the
  // cut list's.
  const cutTimes = gridCutTimes;

  // Video: re-encode only when required, using the detected encoder
  // (hardware-accelerated or software). The descriptor builds the filter +
  // codec args (including keyframe alignment on segment boundaries).
  const videoCodecArgs = transcodeVideo
    ? videoEncoder.buildVideoArgs({
        // Budget-selected encode box (may be below the client target on weak
        // software hosts); falls back to the client target for hardware.
        targetWidth: output.encodeWidth,
        targetHeight: output.encodeHeight,
        segmentDurationSec: segmentDurationSec,
        // Source-inherited output rate (integer, capped); descriptors that
        // use time-based keyframes just apply it as the frame rate.
        fps: output.outputFps,
        // Software-only; hardware descriptors ignore it.
        preset: output.softwarePreset ?? undefined,
        // HDR→SDR tone map (software path only; gated on filter availability).
        tonemap: output.applyTonemap === true,
        // On the source's grid the cuts are not evenly spaced, so no frame
        // count can describe them: the encoder is told the times outright,
        // the same ones the muxer will cut at.
        forcedKeyframeTimes: cutTimes,
        // A ceiling the VIEWER's measured link put on this picture, when one
        // has been measured. Null means the rung's own nominal rate stands.
        nominalKbps: rateCapKbps ?? null
      })
    : ["-c:v", "copy"];
  const audioCodecArgs = transcodeAudio
    ? ["-c:a", "aac", "-ac", "2", "-b:a", "128k"]
    : ["-c:a", "copy"];

  const args = ["-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1"];
  // Hardware decode/encode setup (e.g. VAAPI device) must precede -i, and
  // only applies when we actually re-encode the video track.
  if (transcodeVideo && Array.isArray(videoEncoder.inputArgs)) {
    args.push(...videoEncoder.inputArgs);
  }
  // Seek position in SOURCE time. On the keyframe grid `startSeconds` is a
  // real keyframe's offset from zero, so the container's own start time goes
  // back on to reach it; on the uniform grid it is a plain offset. This
  // follows the GRID, not whether the video is re-encoded — a variant cut on
  // the source's keyframes has to seek to them like the copy it accompanies.
  const seekSeconds = timeline.cutGrid === "keyframe"
    ? startSeconds + sourceStartTime
    : startSeconds;
  // Two-step seek when we have a real keyframe map: jump to a KNOWN-valid
  // keyframe (coarse, before -i — safe because WE sourced it from ffprobe,
  // not the container's own on-the-fly seek/index) and trim the short
  // residual (bounded by the keyframe interval) precisely AFTER -i, which is
  // always frame-accurate regardless of -accurate_seek.
  //
  // Root cause this works around: `-accurate_seek -ss X` before -i trusts the
  // CONTAINER's own seek to land near X. For some containers (observed: AVI
  // with VBR MP3 audio) that on-the-fly seek can point at a position with no
  // valid frame boundary at all — ffmpeg fails outright ("Seek failed" /
  // "Header missing"), not just imprecisely, and repeatedly so since every
  // retry re-tries the SAME bad container-computed position. A keyframe we
  // read directly from the packet list is a position ffmpeg has already
  // proven it can decode.
  const snappedKeyframe = Array.isArray(file.keyframeTimes) && file.keyframeTimes.length > 0
    ? nearestKeyframeAtOrBefore(file.keyframeTimes, seekSeconds)
    : null;
  // A second input, and it exists for exactly one case: a browser that takes
  // its audio muxed into the picture, watching a release whose soundtrack is a
  // file of its own. An audio RENDITION reads that file as its only input and
  // has none of this — which is why the ordinary path, and every browser that
  // understands rendition groups, still runs on a single input.
  const audioInputUrl =
    typeof audioInputUrlGiven === "string" && audioInputUrlGiven.length > 0
      ? audioInputUrlGiven
      : "";
  // Where the picture's own start sits on the soundtrack file's timeline. Both
  // files begin at their own container start time, and those need not be the
  // same number; the difference is what keeps the two aligned.
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
    // `-itsoffset` states the soundtrack's timestamps on the picture's
    // timeline, so everything after this point — `-copyts`, the output offset,
    // the cut list — goes on treating the two as one timeline, unchanged.
    //
    // ONLY on the branch that keeps the source's own timestamps. Without
    // `-copyts` ffmpeg rebases each input from its own seek point, and both
    // inputs are seeked to the same instant just below — so the two are
    // already aligned and adding the offset would pull them apart by exactly
    // the amount it exists to remove.
    if (audioTimelineShift !== 0 && keyframeGrid) {
      args.push("-itsoffset", ffmpegSeconds(-audioTimelineShift));
    }
    const audioSeek = Math.max(0, inputSeekSeconds + audioTimelineShift);
    if (audioSeek > 0) {
      // No keyframe to snap to and none needed: every audio frame is a sync
      // point, so the seek can be accurate outright.
      args.push("-accurate_seek", "-ss", ffmpegSeconds(audioSeek));
    }
    args.push("-i", audioInputUrl);
  };

  if (snappedKeyframe !== null) {
    const residualSeconds = Math.max(0, seekSeconds - snappedKeyframe);
    if (snappedKeyframe > 0) {
      args.push("-ss", ffmpegSeconds(snappedKeyframe + seekLandingOffsetFor({ transcodeVideo, file }, snappedKeyframe)));
    }
    args.push("-i", inputUrl);
    // The coarse landing, not the exact target: the residual below is discarded
    // from the OUTPUT and so takes the same slice off every stream. Seeking the
    // soundtrack to the exact target as well would take that slice twice and
    // leave the sound running ahead of the picture by it.
    pushAudioInput(snappedKeyframe);
    if (residualSeconds > 0) {
      args.push("-ss", ffmpegSeconds(residualSeconds));
    }
  } else {
    if (seekSeconds > 0) {
      // No keyframe map (probe failed/timed out) — fall back to the previous
      // behaviour: trust the container's own accurate seek.
      args.push("-accurate_seek", "-ss", ffmpegSeconds(seekSeconds));
    }
    args.push("-i", inputUrl);
    pushAudioInput(seekSeconds);
  }
  // Which timeline the output is labelled on. An audio rendition has no
  // picture of its own to follow, so it follows the grid it was given — the
  // same one the video it plays with is on. Deciding by `transcodeVideo`, as
  // everything else here does, would put the audio of a re-encoded stream on
  // the copy branch: `-copyts` and a shift by the container's start time,
  // against a picture labelled from zero. The two would be offset by
  // `sourceStartTime` for the whole file.
  if (!keyframeGrid) {
    // Branch A (re-encode): fixed GOP makes keyframes land exactly on the
    // segment grid; relabel output onto the original timeline so segment N
    // carries PTS = N × segmentDuration.
    if (startSeconds > 0) {
      args.push("-output_ts_offset", ffmpegSeconds(startSeconds));
    }
  } else {
    // Branch B (video copied — only audio is transcoded): we cannot insert
    // keyframes, so segments are cut at the source's own keyframes (the
    // playlist boundaries were built from those keyframes). Keep the source's
    // real timestamps (`-copyts`) so copied frames stay continuous across
    // boundaries/seeks, and shift by -startTime so the output timeline is
    // 0-based (a non-zero container start otherwise puts a hole at the very
    // beginning and desyncs audio/video). Audio is transcoded on this timeline.
    args.push("-copyts");
    if (sourceStartTime !== 0) {
      args.push("-output_ts_offset", ffmpegSeconds(-sourceStartTime));
    }
  }
  // Where this run STOPS. Until now a run had a start and no end — neither
  // `-to` nor `-t` appeared anywhere in the arguments this proxy builds — so
  // every stop was a kill from outside, and two runs on one output could only
  // be kept apart by giving each its own directory. With an end they cannot
  // reach each other's numbers at all, and a run that finishes its stretch
  // exits by itself instead of having to be noticed and killed.
  //
  // WHICH argument states it is a property of the branch, and it is measured
  // rather than reasoned (2026-09-04, `research/encoder-layer-2026-09-04.md`
  // §11): `-t` is a duration on the output's own clock, and `-to` a point on
  // the input's. The copy branch runs with `-copyts`, where the input's clock
  // IS the source's, so `-to` takes the absolute time; the re-encode branch
  // has no `-copyts` and takes the duration. Swapping them is not a near
  // miss — on the copy branch `-t` produced one segment where five were
  // wanted, because the time it names is already past when the run starts.
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
    // An audio RENDITION: one track, no picture. Published as its own
    // `#EXT-X-MEDIA` and shared by every video variant, so the track is
    // encoded once for the file instead of once per rung, and changing it is
    // the player switching rendition rather than this proxy rebuilding the
    // session. Cut on the same grid as the video it accompanies, which is
    // what lets the two be played together.
    // `0:` because a rendition's only input IS the file its track lives in —
    // the picture's own file, or the one beside it that carries this dub.
    args.push("-vn", "-map", `0:a:${audioSourceTrackIndex}?`, ...audioCodecArgs);
  } else if (servesAudioSeparately) {
    // The other half of the same arrangement: the picture alone, because its
    // audio is published as a rendition and would otherwise play twice.
    args.push("-an", "-map", "0:v:0?", ...videoCodecArgs);
  } else {
    args.push(
      "-map",
      "0:v:0?",
      "-map",
      // The audio track the viewer chose: input 1 when their choice is a
      // soundtrack shipped as its own file, input 0 when it is one of the
      // picture's own. Type-relative within that input, which is what
      // `audioSourceTrackIndex` holds — the number the browser sent is flat
      // across both files and was resolved when the session was made.
      `${audioInputUrl ? 1 : 0}:a:${audioSourceTrackIndex}?`,
      ...videoCodecArgs,
      ...audioCodecArgs
    );
  }

  // Where the cuts come from. On the copy path they are the source's own
  // keyframes, and until now they were only ever GUESSED: ffmpeg got a target
  // duration and chose its own cut points, while the playlist was built from
  // the container index — two independent calculations with nothing tying
  // them together but the hope that they agree. They do not. The index is a
  // navigation table and is not obliged to list every keyframe; for a field
  // file it held 1902 while ffmpeg found roughly twice as many and cut twice
  // as often. Segment #876 then meant 1:26:50 to the player and about minute
  // 58 to ffmpeg, which is why a seek landed nowhere near where it was aimed
  // and the reported duration drifted.
  //
  // So stop guessing and say it: the `segment` muxer takes the list of times
  // outright. Passing the very boundaries the playlist was built from makes
  // the two agree by construction. Only cut points already known to be real
  // keyframes are sent, so ffmpeg never has to move one forward.
  //
  // The list is built above, before the encoder args, because a re-encoded
  // variant of a copied stream needs the same times twice over: once as the
  // cuts, once as the keyframes to force at them.
  if (cutTimes && cutTimes.length > 0) {
    args.push(
      "-f",
      "segment",
      // Times are measured from the START OF THIS RUN, not from the start of
      // the file — verified: starting at 12 s and asking for a cut at 18 s
      // produced one at 29.4 s. `segmentCutTimesFrom` rebases them.
      "-segment_times",
      cutTimes.join(","),
      // A cut lands on the first keyframe at or after its time, so a boundary
      // recorded a hair late would skip to the next one and double the
      // segment. The tolerance absorbs that rounding.
      "-segment_time_delta",
      "0.05",
      "-segment_start_number",
      String(safeIndex),
      // THE ENCODER SAYS WHEN A PIECE IS FINISHED, on a channel of its own.
      //
      // Measured on the addon host 2026-09-05: a name appears in this list when
      // the file is CLOSED, not when it is created — at the third sample
      // `seg-000.mp4` was on disk and absent from the list, and it appeared at
      // the fourth, in the same moment `seg-001.mp4` came into being. So a name
      // here is the writer's own statement that the piece is whole.
      //
      // Without it, a finished file is indistinguishable from one still being
      // written, and the only proof available was the existence of the NEXT
      // one — which never comes for the last piece of every run.
      "-segment_list",
      "pipe:3",
      "-segment_list_flags",
      "+live",
      ...explicitTimes,
      segmentFormat.segmentFileNameTemplate()
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
      // Container selection + segment naming, from the active format module.
      ...segmentFormat.muxerArgs(),
      "-start_number",
      String(safeIndex),
      // ffmpeg writes its own playlist here; we ignore it and serve the
      // synthetic VOD playlist instead (see getFileStream).
      PLAYLIST_FILE_NAME
    );
  }
  return { args, safeIndex, startSeconds, cutTimes };

}
