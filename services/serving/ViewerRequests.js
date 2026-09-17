/**
 * What a viewer asks of this proxy, one request at a time.
 *
 * Open an output of a file — the one that already exists when its parameters
 * agree — and be placed on it; state a new position; ask how far the material
 * in front of them has got. Each request states a fact about the viewer and
 * returns; where encoders go follows from those facts and is the plan's.
 */

import { logger } from "../../utils/logger.js";
import { probeVideoKeyframeTimes } from "../media/keyframe-probe.js";
import { minimumBufferFrom } from "../supply-margin.js";
import { ENCODE_RUN_STATE, wireState } from "../encode/encode-run-state.js";
import { chooseOutputFps } from "../hwaccel.js";
import { resolveSegmentFormat, SEGMENT_FORMAT_IDS } from "../segment-formats/index.js";
import { AudioOutput, CutGrid, isOutputName, OutputSpec, VideoOutput } from "../output/index.js";
import { Timeline, Timelines } from "../output/Timeline.js";
import { computeCutGrid } from "../output/cut-grid.js";
import { Output } from "../output/Output.js";
import { mediaPlaylistText } from "../output/playlists.js";
import { SourceFiles } from "../source/SourceFile.js";
import { viewersOf } from "../viewer/Viewer.js";
import { activeOutputFor } from "../viewer/active-output.js";
import { viewerSecondsOn } from "../viewer/positions.js";
import { isFamilyConsumerId } from "../encode/Renditions.js";
import { formatSeconds } from "../encode/EncodeRuns.js";
import { EncodedOutput } from "../output/EncodedOutput.js";
import { decideOutputFormat } from "../quality/output-format.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { parseFfmpegBitrateKbps, parseFfmpegDurationSeconds, parseFfmpegStartTimeSeconds, parseFfmpegStreamCounts, parseFfmpegVideoDimensions, parseFfmpegVideoFps, parseFfmpegHdr } from "../media/ffmpeg-banner.js";
/** Own package version, stamped onto session-start log lines. */
const PROXY_VERSION = createRequire(import.meta.url)("../../package.json").version;
/**
 * Run a short ffmpeg probe to extract the total duration AND video resolution
 * of a stream from the container header. Both are printed almost immediately
 * (before any decoding), so this returns as soon as they are seen; an 8 s
 * timeout guards the rest.
 *
 * @param {string} ffmpegBin - Path to the ffmpeg executable.
 * @param {string | URL} inputUrl - URL of the stream to probe.
 * @returns {Promise<{ durationSeconds: number | null, width: number | null, height: number | null, fps: number | null, startTime: number, isHdr: boolean }>}
 */
async function probeInputMediaInfo(ffmpegBin, inputUrl) {
  return new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegBin, ["-hide_banner", "-loglevel", "info", "-i", inputUrl, "-f", "null", "-"], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      const dims = parseFfmpegVideoDimensions(stderr);
      resolve({
        durationSeconds: parseFfmpegDurationSeconds(stderr),
        bitrateKbps: parseFfmpegBitrateKbps(stderr),
        width: dims.width,
        height: dims.height,
        fps: parseFfmpegVideoFps(stderr),
        startTime: parseFfmpegStartTimeSeconds(stderr),
        // Only ever read when a run fails, and read HERE because by then the
        // banner is long gone: this probe is the one place the source says what
        // it holds.
        streamCounts: parseFfmpegStreamCounts(stderr),
        isHdr: parseFfmpegHdr(stderr)
      });
    };
    const timeoutId = setTimeout(() => {
      if (!ffmpeg.killed) {
        ffmpeg.kill("SIGTERM");
      }
      finish();
    }, 8_000);
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      // The header ("Duration:" then the "Video: … WxH" stream line) is printed
      // before any decoding. Bail as soon as both are present instead of letting
      // `-f null -` decode the whole stream until the 8 s timeout.
      //
      // This probe asks about the PICTURE and nothing else now: a file with no
      // video track is read by the container layer, which answers from 64 KB of
      // header. It used to take an `expectVideo: false` for exactly that case,
      // and the branch cost 8121 ms of every cold start (2026-09-03) because
      // the exit still waited for a parsed DURATION, which a partly downloaded
      // file prints as `N/A`.
      const duration = parseFfmpegDurationSeconds(stderr);
      const dims = parseFfmpegVideoDimensions(stderr);
      if (duration != null && dims.width != null) {
        clearTimeout(timeoutId);
        if (!ffmpeg.killed) {
          ffmpeg.kill("SIGTERM");
        }
        finish();
      }
    });
    ffmpeg.on("error", () => {
      clearTimeout(timeoutId);
      finish();
    });
    ffmpeg.on("exit", () => {
      clearTimeout(timeoutId);
      finish();
    });
  });
}
function isWarmupTimeoutError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message === "HLS playlist is still warming up.";
}

export class ViewerRequests {
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /**
   * @param {object} host - `disposeSession`, `expectedFirstSegmentMs`, `expectedSessionCreateMs`, `planEncodersSoon`, `waitUntilReady`, `decodeCostModel`, `enabled`, `encodeCost`, `encodeRuns`, `ffmpegBin`, `getCachedMediaInfo`, `hostLoad`, `hostTimings`, `keyframeTables`, `localBaseUrl`, `outputTimes`, `outputs`, `quality`, `qualityOffer`, `renditions`, `returns`, `segmentDurationSec`, `segmentFormat`, `segmentStore`, `softwarePresetBenchmark`, `sourceFiles`, `startupWaitMs`, `timelines`, `tonemapSupported`, `videoEncoder`, `viewers`
   */
  constructor(host) {
    this.#host = host;
  }

  /**
   * Return an existing HLS session for the given source/settings, or create
   * one by spawning a new ffmpeg process.
   *
   * Throws with `error.code === "TRANSCODE_DISABLED"` when transcoding is
   * disabled on this proxy instance.
   *
   * @param {object} options
   * @param {string}  options.sourceKey      - Registry source key.
   * @param {number}  options.fileIndex      - Zero-based file index in the torrent.
   * @param {boolean} [options.transcodeVideo=false]
   * @param {boolean} [options.transcodeAudio=false]
   * @param {string}  [options.consumerId=""]            - Caller ID for reference counting.
   * @param {string}  [options.fileName=""]              - Display name for log output.
   * @param {number}  [options.targetWidth=0]            - Target video width (0 = keep source).
   * @param {number}  [options.targetHeight=0]           - Target video height (0 = keep source).
   * @param {number}  [options.startPositionSeconds=0]   - Seek start position in seconds.
   * @param {number}  [options.audioTrackIndex=0]        - Type-relative audio track to map (0:a:N).
   * @param {boolean} [options.exactSize=false]           - Produce the target box exactly (capped to source), with no budget downscale and no runtime downswitch. Says nothing about who asked: every rung of a master sets it.
   * @returns {Promise<HlsSession>}
   */
  async createOrGetSession({
    sourceKey,
    fileIndex,
    transcodeVideo = false,
    transcodeAudio = false,
    consumerId = "",
    fileName = "",
    targetWidth = 0,
    targetHeight = 0,
    startPositionSeconds = 0,
    audioTrackIndex = 0,
    exactSize = false,
    // The caller takes its audio from a rendition group, so the picture is
    // encoded without it and each audio track is encoded once for the file
    // instead of once per rung. Off unless asked for: a browser that does not
    // know about renditions must still get its audio in the stream.
    audioRenditions = false,
    // This session IS one of those renditions: one audio track, no picture, cut
    // on the same grid as the video it accompanies.
    audioOnly = false,
    // The arrangement decided by the session this one belongs to — a variant or
    // a rendition of it. Every session of one master must agree about where the
    // audio is, and only the base is in a position to decide: a variant asked on
    // its own would answer about the rungs IT would be offered at, which is a
    // different list. Null means "decide it here", which is what a base does.
    inheritedAudioSeparate = null,
    segmentFormatId = "",
    // The cut grid of the session this one is a quality variant of: its
    // keyframe times and which container they were read from. Present only for
    // a variant of a session cut at the source's keyframes, and it is what
    // makes the two interchangeable.
    inheritedGrid = null,
    // "manual" when the viewer chose this size by hand, "auto" when it is the
    // automatic choice; left out, a size produced exactly counts as chosen by
    // hand. Decides whether an output already here may serve them instead.
    servingMode = null,
    // What the requesting viewer's link measured, or null.
    viewerLinkMbps = null
  }) {
    if (!this.#host.enabled) {
      const error = new Error("Audio transcoding is disabled on this proxy.");
      error.code = "TRANSCODE_DISABLED";
      throw error;
    }

    // The container is the viewer's to choose, because the viewer's browser is
    // what has to decode the result and only it knows what its media stack
    // accepts. A copied MP3 track is the case that forced this: hls.js demuxes
    // MPEG-TS itself and hands raw MP3 to an `audio/mpeg` buffer, which every
    // browser supports, while an fMP4 segment goes to MSE untouched and
    // `audio/mp4; codecs="mp3"` is refused — measured false in Chromium, where
    // `canPlayType` cheerfully answers "probably". Same file, same browser:
    // plays as MPEG-TS, silent loop as fMP4. The proxy's `--segment-format`
    // stays the default for a client that expresses no preference.
    // An unrecognised value falls back to the operator's choice rather than to
    // the library default — `resolveSegmentFormat` cannot tell the two apart,
    // and this value arrives from a client.
    const segmentFormat = SEGMENT_FORMAT_IDS.includes(segmentFormatId)
      ? resolveSegmentFormat(segmentFormatId)
      : this.#host.segmentFormat;

    const normalizedTargetWidth = Number.isInteger(targetWidth) && targetWidth > 0 ? targetWidth : 0;
    const normalizedTargetHeight = Number.isInteger(targetHeight) && targetHeight > 0 ? targetHeight : 0;
    // Round seek position to the nearest 10 s so that two consumers seeking
    // to similar positions can share the same ffmpeg session.
    const normalizedStartPosition =
      Number.isFinite(startPositionSeconds) && startPositionSeconds > 0
        ? Math.round(startPositionSeconds / 10) * 10
        : 0;
    const normalizedAudioTrack =
      Number.isInteger(audioTrackIndex) && audioTrackIndex > 0 ? audioTrackIndex : 0;
    // Which FILE the chosen soundtrack lives in, and which track it is inside
    // that file. A release often ships its dub as a file of its own beside the
    // picture, and the number that travels between the browser, this route and
    // the `a/<n>/` address is flat across both — see `audio-inventory.js`. This
    // is the one place that resolves it, so nothing downstream carries two
    // vocabularies.
    const audioSource = this.#host.renditions.resolveAudioSource(sourceKey, fileIndex, normalizedAudioTrack);
    // The file itself, held once for every session of it. Its name, its key and
    // the facts a probe of it returned used to be copied onto each session, so
    // two viewers of one film held two copies of numbers that cannot differ —
    // and twenty places assembled its key by hand to reach the caches that are
    // keyed by a file.
    const file = this.#host.sourceFiles.get(sourceKey, fileIndex, fileName);
    const forceExactSize = exactSize === true && transcodeVideo;
    // Whether this output carries its sound at all — decided HERE, before the
    // key, and never derived a second time.
    //
    // It used to be settled after the session had already been put in the map,
    // which was survivable only while the key carried the audio parameters
    // unconditionally: the key could say "no sound in this output" while the
    // output muxed it, and two viewers who chose different languages would then
    // have shared one encode and one of them would have heard the other's.
    const audioSeparate = inheritedAudioSeparate === null
      ? this.#host.renditions.audioTravelsSeparately({
          sourceKey,
          fileIndex,
          audioRenditions,
          // The rung this session will be NAMED by. The budget may still
          // downscale the encode below it, and that cannot change the answer:
          // what it picks is a rung of the same ladder, already in the set.
          ownHeight: normalizedTargetHeight
        })
      : inheritedAudioSeparate === true;
    // A rendition IS the sound, so it carries it whatever the arrangement says;
    // a picture carries it only when the browser is not taking it separately.
    const carriesAudio = audioOnly === true || !audioSeparate;
    const carriesVideo = audioOnly !== true;
    const createEntryMs = Date.now();
    // The directory belongs to the OUTPUT, not to this session: two sessions
    // whose parameters agree produce interchangeable segments, so they write
    // into one place and each serves what the other has already made. The start
    // position is deliberately not part of it — segment 42 covers the same span
    // whoever began where.
    // The file this session's encoder READS. A soundtrack shipped as its own
    // file is encoded FROM that file, and an audio rendition carries nothing
    // else — so it reads the sidecar directly and needs no second input at all.
    // The muxed case, where a browser takes its audio inside the picture's own
    // stream, is the one that reads two files.
    //
    // Which of the two this is used to be a boolean on the session
    // (`readsSidecarAlone`) beside a string URL built from it. It is the same
    // statement as "the file it reads is not the file of the picture", so it is
    // that comparison now and there is nothing to keep in step.
    const audioFile = this.#host.sourceFiles.get(sourceKey, audioSource.fileIndex, audioSource.name);
    const inputFile = audioOnly === true && audioSource.isSidecar ? audioFile : file;
    // Media info (duration/resolution/fps/startTime/HDR) up front, so we can
    // serve a complete VOD playlist (#EXT-X-ENDLIST) with the correct total
    // duration and a fully seekable timeline before a single segment exists.
    // Reuse the planner's probe when it is available and complete — the plan
    // request just ran the same ffmpeg scan over the same input. Fall back to
    // a fresh probe otherwise (proxy restarted between plan and session, or a
    // critical field is missing).
    const mediaInfoStartMs = Date.now();
    const cachedMediaInfo = this.#host.getCachedMediaInfo?.({ sourceKey, fileIndex }) ?? null;
    const cachedUsable =
      cachedMediaInfo &&
      Number.isFinite(cachedMediaInfo.durationSeconds) &&
      cachedMediaInfo.durationSeconds > 0 &&
      Number.isFinite(cachedMediaInfo.width) &&
      cachedMediaInfo.width > 0 &&
      Number.isFinite(cachedMediaInfo.height) &&
      cachedMediaInfo.height > 0;
    // Always the PICTURE's, even when this session reads a soundtrack from
    // another file: the timeline, the duration and the cut grid are the
    // picture's, and a rendition exists to be played WITH it. Only where the
    // sidecar's own timeline begins is read from the sidecar, just below.
    // No session id on it: this read is a probe of the picture, not this
    // session's own delivery, and counting it against the session would tell a
    // waiting browser that its film is arriving when what arrived was a header.
    const pictureUrl = file.streamUrl(this.#host.localBaseUrl);
    const mediaInfo = cachedUsable
      ? cachedMediaInfo
      : await probeInputMediaInfo(this.#host.ffmpegBin, pictureUrl.toString());
    const mediaInfoMs = Date.now() - mediaInfoStartMs;
    const mediaInfoSource = cachedUsable ? "cached" : "probed";
    // The file takes in what the probe said. It is the same answer for every
    // session of this file — a quality step, a soundtrack, a second viewer — so
    // it is kept once instead of being copied into each. A later session with a
    // fresher reading updates it: on a cold torrent the first probe can come
    // back without a duration, and the second is the one that has it.
    file.learn(mediaInfo);
    const durationSeconds = file.durationSeconds ?? 0;
    const sourceWidth = file.width;
    const sourceHeight = file.height;
    const sourceStartTime = file.startTime;
    // Where the timeline of a soundtrack shipped as its own file begins.
    //
    // A soundtrack in another file has a start time of its own, and it is the
    // one that must be subtracted when the output is relabelled onto a
    // zero-based timeline: subtract the picture's instead and the sound sits at
    // a fixed offset from it for the whole film. Read from the file rather than
    // assumed to be zero, because assuming it is exactly the fault being
    // avoided.
    //
    // NOT awaited. Creating a session used to stop here until the answer came
    // back, and on a cold start the answer needs the sidecar's header off the
    // swarm — 8121 ms of every session created, measured three times out of
    // three on 2026-09-03. What is known now is used now, and the reading runs
    // behind; when it lands it lands on the FILE, which every session of that
    // soundtrack shares, so the spawn path sees it without re-reading anything.
    //
    // Unknown means "no difference between the two timelines", not "the
    // soundtrack starts at zero". The shift exists to correct a difference
    // between two containers; asserting one that has not been read is inventing
    // a number, while assuming none leaves the sound exactly where a release
    // remuxed from a single source puts it.
    if (audioSource.isSidecar) {
      this.#host.renditions.warmFileStartTime(audioFile);
    }
    // Tone-map an HDR source to SDR only when re-encoding video on the software
    // path and this ffmpeg has the filters. Hardware encoders keep their own
    // (untone-mapped) path for now; when unavailable, HDR falls back to a plain
    // 8-bit convert (washed-out but playable).
    const applyTonemap =
      transcodeVideo === true &&
      mediaInfo.isHdr === true &&
      this.#host.tonemapSupported &&
      this.#host.videoEncoder?.kind === "software";
    // Output frame rate inherited from the source (integer, capped) so 25/30
    // fps content is not resampled to 24. Fixed-GOP encoders keep the fps↔GOP
    // relationship exact; time-based-keyframe encoders just use it as the rate.
    const outputFps = chooseOutputFps(mediaInfo.fps);
    const hasDuration = Number.isFinite(durationSeconds) && durationSeconds > 0;
    const logName = file.name;

    // Size the reader's window in seconds of playback rather than bytes. Needs
    // the file's own average byte rate, which is size ÷ duration; the size
    // comes from the same stats call the realtime budget uses. Best effort —
    // without it the reader keeps its own byte default.
    //
    // Sized for the file being READ, which for a soundtrack shipped separately
    // is that file: it is a twentieth of the picture's size over the same
    // duration, so the picture's byte rate would buy a window twenty times
    // wider than the seconds it is meant to represent, and the piece store
    // would hold it.
    const readWindowBytes = await this.#host.hostLoad.readWindowBytesFor(
      inputFile.sourceKey,
      inputFile.fileIndex,
      durationSeconds
    );
    if (!hasDuration) {
      logger.warn(
        `transcode "${logName}": could not probe duration; falling back to ` +
          "ffmpeg-managed (growing) playlist"
      );
    }

    // For the video-copy path we cannot insert keyframes, so the playlist's
    // segment boundaries must match the source's real keyframes (otherwise the
    // player sees gaps on seek). Re-encoded video uses a uniform grid for
    // segment boundaries instead (its fixed GOP makes the cuts land there —
    // computeSegmentBoundaries ignores keyframeTimes when transcodeVideo).
    //
    // But the probe is ALSO used for something both branches need: choosing a
    // SOURCE seek position ffmpeg can actually land on. `-ss` before `-i` trusts
    // the container's own on-the-fly seek/index, which for some containers
    // (observed: AVI with VBR MP3 audio) can point at a position with no valid
    // frame boundary at all — ffmpeg then fails outright ("Seek failed" /
    // "Header missing"), not just imprecisely. Snapping the seek to the nearest
    // KNOWN real keyframe (see #startEncodeRun) avoids that. So probe for both
    // branches; on failure both fall back to their current behaviour (uniform
    // grid for boundaries, raw target for seeking) — no regression.
    // The file's own table — the object every reader of this file holds, so a
    // read that answers after this session was made still reaches it.
    const keyframes = this.#host.keyframeTables.of({ sourceKey, fileIndex });
    let keyframeMs = -1; // -1 = not run (skipped), -2 = running in the background
    // A quality variant of a session whose cuts are the source's keyframes must
    // be cut at exactly those same times, or its segments cannot stand where
    // the other's would have. Nothing has to be handed over for that: the table
    // is the FILE's, and a variant is a session of the same file, so it reads
    // the one answer. What the inherited grid still carries is the CORRECTED
    // boundaries and the published playlist, which are properties of the family
    // rather than of the file.
    if (inheritedGrid) {
      // Nothing to read: the table above IS the file's, corrections included.
    } else if (hasDuration && !transcodeVideo && !audioOnly) {
      // Video-COPY path: the keyframe times are REQUIRED to build correct
      // segment boundaries (the playlist itself), so this MUST block session
      // creation — an incorrect playlist is worse than a slower start.
      //
      // The wait is bounded, and the bound is what the read costs on a real
      // host rather than a figure picked here (`KEYFRAME_TABLE_BUDGET_MS`). A
      // comment in this place used to promise a short timeout and "never more
      // than ~6 s to session start" when no timeout existed at all; the file
      // comes off a torrent, so the bytes the table lives in may still be
      // arriving, and a session used to wait for them without limit.
      //
      // What is read is the container's OWN table (Cues/stss) rather than a
      // scan of the media. On the copy path ffmpeg can only cut at the source's
      // existing keyframes, so these times ARE the segment boundaries —
      // declaring an even grid instead is a falsehood the player punishes: it
      // walks the whole file to rebuild the timeline, or presents audio with no
      // picture because a segment starts with nothing decodable (both
      // field-observed 2026-08-02). Scanning cannot supply them here — the file
      // comes off a torrent, and a full packet scan of 5.5 GB found 77
      // keyframes in 45 s without finishing, while the container index yields
      // all 570 in 0.8 s from two point reads (16 KB).
      const keyframeStartMs = Date.now();
      const { arrived } = await this.#host.keyframeTables.within({ sourceKey, fileIndex, logName });
      keyframeMs = Date.now() - keyframeStartMs;
      if (!arrived) {
        // A read that ran out of its budget is still running, and the table is
        // still unanswered — which is not the same as a file with no keyframes,
        // and the distinction is the table's own (`answered` against
        // `readable`). Recorded as an absence it would make a passing shortage
        // of bytes look like a property of the bytes, and every later session
        // of the file would re-encode a picture that can be copied.
        logger.warn(
          `transcode: the keyframe table for "${logName}" has not arrived in ` +
            `${Math.round(this.#host.keyframeTables.budgetMs / 1000)}s, so this session re-encodes the picture ` +
            "instead of copying it; the read goes on and the next session of this file gets the copy"
        );
      }
      if (!keyframes.readable) {
        // No index, so there is no honest grid for a COPY: a copied picture can
        // only be cut at the source's own keyframes, and we do not know where
        // they are. Declaring an even grid instead is a falsehood the player
        // punishes — it walks the whole file to rebuild the timeline, or shows
        // audio with no picture because a segment begins with nothing
        // decodable (both field-observed 2026-08-02).
        //
        // Re-encoding is the honest answer and costs an encoder: keyframes are
        // then PLACED at our own cut times rather than found, so the grid is
        // correct by construction whatever the container. MPEG-TS is the case
        // this exists for — measured 2026-08-21, 669 real keyframes and no
        // index of any kind to read them from — and a container whose index
        // could not be read in the budget lands here too, which is right for
        // the same reason.
        transcodeVideo = true;
        if (keyframes.answered) {
          logger.warn(
            `transcode: no keyframe index in the ${keyframes.format} container for ` +
              `"${logName}" — a copied picture has no honest grid without one, so the video is ` +
              "re-encoded instead and its keyframes are placed on our own cuts"
          );
        }
      }
    } else if (hasDuration && transcodeVideo) {
      // Re-encode path: keyframeTimes are ONLY used to snap a LATER seek (see
      // #startEncodeRun) — segment boundaries stay on the uniform grid either
      // way. So this does NOT need to block session creation / the first
      // segment's start. Run it in the background with a FULL budget instead of
      // the 6 s cap: AVI-class containers need a full packet scan, which 6 s can
      // never afford without delaying playback start — that starved budget is
      // exactly why the probe kept missing on the container where the seek bug
      // was field-diagnosed. A run reads the file's table on every call, so a
      // seek that happens AFTER this finishes picks it up automatically; one
      // that happens before falls back to the existing circuit breaker as a
      // safety net (no regression either way).
      keyframeMs = -2;
      const backgroundStartedAt = Date.now();
      void probeVideoKeyframeTimes(this.#host.ffmpegBin, inputFile.streamUrl(this.#host.localBaseUrl).toString(), 25_000).then((times) => {
        // Into the FILE's table, which the picture, its quality steps and a
        // second viewer's session all hold — so nothing has to be alive for the
        // answer to be kept, and the session this probe was started for may
        // long since have gone. It used to be written onto whichever session
        // was still there, and dropped outright when none was.
        this.#host.keyframeTables.learn({ sourceKey, fileIndex }, { times, format: "packet probe" });
        const elapsedMs = Date.now() - backgroundStartedAt;
        logger.info(
          times
            ? `transcode: background keyframe probe found ${times.length} keyframes ` +
                `(${elapsedMs}ms) for "${logName}" — later seeks will snap to them`
            : `transcode: background keyframe probe unavailable (${elapsedMs}ms) for "${logName}" ` +
                `— seeks keep using the raw target (falls back to the circuit breaker on failure)`
        );
      });
    }
    logger.info(
      `cold-start "${logName}": media-info=${mediaInfoMs}ms (${mediaInfoSource}) ` +
        `keyframes=${keyframeMs === -1 ? "skipped" : keyframeMs === -2 ? "background" : `${keyframeMs}ms`} ` +
        `create-total=${Date.now() - createEntryMs}ms`
    );
    // Which grid this session is cut on. A copy has no choice: only where the
    // source already has a keyframe. A re-encode normally takes the even grid —
    // it produces every frame and may put keyframes where it likes — unless it
    // is a variant of a keyframe-cut session, in which case it must land on the
    // same times to be interchangeable with it.
    // An audio rendition carries no picture, so it has no keyframes of its own
    // to be cut at: it takes the grid of the video it accompanies, whatever that
    // is. Handed one, it uses it; handed none, the base is on the even grid and
    // so is this. Falling into the COPY branch instead — which is what
    // `transcodeVideo: false` means everywhere else — would put the audio of a
    // re-encoded stream on the source's keyframe times while the player was
    // told the even grid, and the two drift further apart with every segment.
    const useKeyframeGrid = hasDuration &&
      keyframes.readable &&
      (audioOnly ? inheritedGrid != null : (!transcodeVideo || inheritedGrid != null));
    // A rung takes the grid it was handed, rather than working one out again
    // from the same index. The two are not the same table: the one it is handed
    // has been CORRECTED wherever a produced segment showed the index to be
    // wrong, and it is those corrected times the copy actually cuts at. Building
    // it afresh here would put the rung back on the index's fiction and undo the
    // alignment it exists for.
    // The file's own table, made once and shared by every session of it. A
    // quality step is a different OUTPUT and the same cuts — which is exactly
    // the agreement `inheritedGrid` used to arrange by handing a copy to each
    // new session — so it is keyed by the file and the kind of grid, and
    // nothing else.
    const timeline = this.#host.timelines.get(
      Timelines.keyFor(sourceKey, fileIndex, useKeyframeGrid ? "keyframe" : "uniform"),
      () => {
        const cut = hasDuration
          ? computeCutGrid({
              useKeyframeGrid,
              durationSeconds,
              segDur: this.#host.segmentDurationSec,
              keyframeTimes: keyframes.times,
              startTime: sourceStartTime
            })
          : { boundaries: [], sourceTimes: [] };
        const inherited = Array.isArray(inheritedGrid?.boundaries) && inheritedGrid.boundaries.length > 1;
        return new Timeline({
          boundaries: inherited ? [...inheritedGrid.boundaries] : cut.boundaries,
          // The file's own clock for those cuts. An inherited table brings its
          // boundaries and not this, so the seek falls back to searching there.
          sourceTimes: inherited ? null : cut.sourceTimes,
          cutGrid: useKeyframeGrid ? "keyframe" : "uniform"
        });
      }
    );
    // What this session will PUBLISH. A member of a family takes its base's
    // published table verbatim; a session with no base publishes what it cuts
    // at. The two differ exactly by the corrections made since the family's
    // first playlist was written, and that difference is what must never reach
    // the player as two different timelines.
    const publishedGrid = timeline.published.length > 1 ? timeline.published : null;
    const segmentCount = timeline.segmentCount;

    // THE FORMAT, decided before the output is named, and possibly an output
    // already here instead (`quality/output-format.js`).
    const decided = decideOutputFormat({
      encodesPicture: transcodeVideo && carriesVideo,
      exact: forceExactSize,
      target: { width: normalizedTargetWidth, height: normalizedTargetHeight },
      source: { width: sourceWidth, height: sourceHeight, megabitsPerSecond: file.decode?.megabitsPerSecond ?? null, decode: file.decode },
      fps: outputFps,
      encoder: this.#host.videoEncoder,
      benchmark: this.#host.softwarePresetBenchmark,
      cost: {
        decodeModel: this.#host.decodeCostModel,
        observedDecodeCostSec: this.#host.encodeCost.decodeCostFor(SourceFiles.keyFor(sourceKey, fileIndex))?.costSec ?? null,
        requiredSpeed: this.#host.hostLoad.requiredSpeedFor(sourceKey, fileIndex)
      },
      chooseBudget: (params) => this.#host.encodeCost.chooseEncodeBudget(params),
      tonemap: applyTonemap,
      specWith: (encode) => new OutputSpec({
        sourceKey,
        segmentFormatId: segmentFormat.id,
        // Where it is ACTUALLY cut: a copy whose container states no keyframes
        // is re-encoded onto the even grid, and is named so.
        grid: new CutGrid({ kind: useKeyframeGrid ? "keyframe" : "uniform", fileIndex }),
        video: carriesVideo ? new VideoOutput({ fileIndex, encode }) : null,
        audio: carriesAudio
          ? new AudioOutput({ fileIndex: audioSource.fileIndex, trackIndex: audioSource.sourceTrackIndex, transcode: transcodeAudio === true })
          : null
      }),
      serving: {
        mode: servingMode ?? (forceExactSize ? "manual" : "auto"),
        linkMbps: viewerLinkMbps,
        keys: [...this.#host.outputs.values()].map((other) => other.outputKey).concat(this.#host.segmentStore.addresses()),
        readyAt: (key) => this.#host.segmentStore.isClosed(key, timeline.indexForTime(Math.max(0, startPositionSeconds)))
      }
    });
    const spec = decided.spec;
    const budget = decided.budget;
    if (decided.servedBy) {
      logger.info(`transcode "${logName}": served by an output already here, ${decided.servedBy}, instead of ${decided.wantedKey}`);
    }
    transcodeVideo = carriesVideo ? spec.transcodesVideo : transcodeVideo;
    const width = spec.video?.encode?.width ?? 0;
    const height = spec.video?.encode?.height ?? 0;
    const outputKey = spec.toKey();
    // THE NAME FOLLOWS FROM THE KEY, so there is nothing to look it up in. A
    // second table held key → name, which is a fact that can go out of step
    // with the thing it points at: a session disposed without the table being
    // cleared leaves a name pointing at nothing, and the next viewer of that
    // output is handed it.
    const existingId = spec.toName();
    if (existingId) {
      const existing = this.#host.outputs.get(existingId);
      if (existing) {
        const internalClaim = isFamilyConsumerId(consumerId);
        const joined = Boolean(consumerId) && (internalClaim
          ? !existing.claims.has(consumerId)
          : !viewersOf(existing).has(consumerId));
        if (internalClaim) {
          existing.claims.add(consumerId);
        } else if (consumerId) {
          // What THIS viewer wants of the sound, which the session they are
          // joining knows nothing about: they may have chosen another language,
          // and their browser may need a track re-encoded that the first
          // viewer's could decode as it stands.
          const joining = this.#host.viewers.of(existing, consumerId);
          joining.audio = {
            trackIndex: normalizedAudioTrack,
            transcode: transcodeAudio === true
          };
          // And WHERE they are, which their own request names and this session
          // cannot guess: a viewer joining a session already playing at 40:00
          // may be opening the film from a link that carries 05:00. Placed now,
          // because a viewer who has not yet been placed states no want and an
          // output all of whose viewers state nothing has every encoder on it
          // stopped.
          this.placeViewer(existing, joining, startPositionSeconds);
        } else {
          const joining = this.#host.viewers.of(existing, "");
          joining.audio = {
            trackIndex: normalizedAudioTrack,
            transcode: transcodeAudio === true
          };
          this.placeViewer(existing, joining, startPositionSeconds);
        }
        // Reuse said nothing at all before this, so a session serving two
        // viewers looked exactly like a session serving one — and the whole
        // question this key exists to answer is which of the two happened.
        if (joined) {
          logger.info(
            `transcode ${existing.id} joined by ${consumerId} ` +
            `(${viewersOf(existing).size} viewer(s)) key=${outputKey}`
          );
        }
        // A run of their own where they opened the film is the plan's to place:
        // `#placeViewer` above states where they are and the plan reads it. This
        // used to start one here, deciding for itself that nothing was being
        // made there — a second party answering the one question the plan
        // exists for, and answering it from a session's own runs rather than
        // from the output's coverage.
        this.#host.outputs.touch(existing);
        try {
          await this.#host.waitUntilReady(existing);
        } catch (error) {
          if (!isWarmupTimeoutError(error)) {
            throw error;
          }
          // Keep session reusable while ffmpeg is still warming up.
        }
        return existing;
      }
    }

    // Only a session actually made is timed: a viewer joining one costs none
    // of what this figure predicts for the next viewer who has to wait.
    this.#host.hostTimings.rememberSessionCreateLatency(Date.now() - createEntryMs);
    const sessionId = spec.toName();
    const output = new Output({
      encodeWidth: width,
      encodeHeight: height,
      outputFps,
      softwarePreset: spec.video?.encode?.preset ?? null,
      applyTonemap: spec.video?.encode?.tonemap === true
    });

    // Only now, when nothing above can still throw. Everything from the probe
    // to the keyframe index used to run with the directory already made, so a
    // failure between the two left it behind: nothing tracks a directory whose
    // session was never registered, and no sweep looks for one. Proxy
    // 2.9.101-2.9.102 failed here on every single request and the leftovers
    // were the only trace of it on disk.
    // A RETURN, if this output was held before — and its age, which is the one
    // term of the keeping period that nothing measures. Read BEFORE the
    // directory is claimed, since claiming it is what marks it read.
    this.#host.returns.note({ lastReadAt: this.#host.segmentStore.lastReadAt(spec.toKey()), now: Date.now() });
    this.#host.segmentStore.directoryFor(spec.toKey());
    this.#host.segmentStore.useFormat(spec.toKey(), segmentFormat);

    const session = new EncodedOutput({
      id: sessionId,
      spec,
      file,
      keyframes,
      timeline,
      segmentFormat,
      output,
      useSyntheticPlaylist: hasDuration,
      playlistText: hasDuration ? mediaPlaylistText({ boundaries: publishedGrid, segmentFormat }) : "",
      variantHeight: forceExactSize && height > 0 ? height : undefined,
      claims: isFamilyConsumerId(consumerId) ? [consumerId] : []
    });
    session.createEntryMs = createEntryMs;
    session.readWindowBytes = readWindowBytes;
    session.predictedSpeedWhenOffered = this.#host.encodeCost.lastPredictedByHeight?.get(output.encodeHeight) ?? null;
    // The viewer who asked for this session, so a browser that names itself
    // never has to have requested a segment first for its own soundtrack choice
    // to be known — nor for its own POSITION to be known, which is the same
    // request's `startPositionSeconds` and is therefore knowledge this process
    // already has before a single byte is encoded.
    //
    // A session made on behalf of the family — a quality step, a soundtrack —
    // is created under a made-up name, and that name is not a person. It stays
    // out of the viewer registry: given a position it would count as present
    // for ever, and nothing would ever stop the output it was created for.
    if (consumerId && !isFamilyConsumerId(consumerId)) {
      const first = this.#host.viewers.of(session, consumerId);
      first.audio = {
        trackIndex: normalizedAudioTrack,
        transcode: transcodeAudio === true
      };
      this.placeViewer(session, first, startPositionSeconds);
    } else if (!consumerId) {
      const first = this.#host.viewers.of(session, "");
      first.audio = {
        trackIndex: normalizedAudioTrack,
        transcode: transcodeAudio === true
      };
      this.placeViewer(session, first, startPositionSeconds);
    }
    this.#host.outputs.set(sessionId, session);
    // Decided before the key was built and only recorded here. Whether the audio
    // travels separately decides the ffmpeg arguments, what the master says,
    // whether the rendition route answers at all AND what the session is keyed
    // on, and those four must agree for the whole life of the session — a
    // session whose picture was encoded without audio cannot start muxing it in
    // at the next restart without either playing it twice or refusing the
    // append, and one keyed as carrying no sound must never mux somebody else's
    // language into a picture two viewers share.
    //
    // It must not be asked a second time, because the answer moves: the offered
    // list is recomputed as the host learns what this source costs, and
    // crossing "two rungs" would flip the arrangement under a stream that is
    // playing.
    logger.info(
      // Proxy version on the session-start line: a field report always includes
      // one of these, so "is the host actually running the build I published?"
      // is answered by the log itself instead of a round trip to the machine.
      `transcode ${sessionId} start (proxy ${PROXY_VERSION}) "${logName}" ` +
        // Where the browser asked the encoder to begin. A resume that reaches
        // hls.js but not this call makes the player request a segment nobody
        // was told to produce: measured 2026-08-06, the session began at #0
        // while the player asked for #127 and gave up 45.6 s later. Neither
        // side saying what it meant is why that took three attempts to place.
        `start=${Math.round(normalizedStartPosition)}s ` +
        `video=${transcodeVideo ? `${this.#host.videoEncoder.name}${output.softwarePreset ? `/${output.softwarePreset}` : ""}` : "copy"} ` +
        `audio=${transcodeAudio ? "aac" : "copy"} ` +
        // Branch tag for log correlation: A = video re-encode (fixed GOP, grid
        // aligned, ts-offset); B = video copy (cut at source keyframes, copyts).
        `branch=${transcodeVideo ? "A(reencode,fixed-gop)" : "B(copy,copyts)"} ` +
        `seg=${timeline.cutGrid} ` +
        `${sourceWidth && sourceHeight ? `src=${sourceWidth}x${sourceHeight} ` : ""}` +
        // The size produced, and how it was arrived at: exactly as asked, the
        // budget's rung of the viewer's own ladder, or the box asked for where
        // there is no ladder to choose from.
        `${transcodeVideo
          ? `enc=${output.encodeWidth || "src"}x${output.encodeHeight || "src"}@${output.outputFps} ` +
            `size=${forceExactSize ? "exact" : budget ? `budget rung ${budget.rungIndex + 1}/${budget.ladder.length}` : "asked"} `
          : ""}` +
        // HDR source and whether the tone-map chain was applied (vs washed-out
        // fallback when the filters are missing or on a hardware encoder).
        `${transcodeVideo && mediaInfo.isHdr ? `hdr=1 tonemap=${applyTonemap ? "on" : "off"} ` : ""}` +
        `${sourceStartTime ? `start=${sourceStartTime.toFixed(3)} ` : ""}` +
        `duration=${hasDuration ? formatSeconds(durationSeconds) : "unknown"} segments=${segmentCount} ` +
        // What this session was keyed on, which is what decides whether the next
        // viewer joins it or starts a second encoder beside it. Printed because
        // a fork was undiagnosable without it: on 2026-09-03 two viewers of one
        // copied picture got two sessions with identical descriptions and
        // byte-identical output, both create requests were 265 bytes, and
        // nothing anywhere said what the two had been told apart by.
        `key=${outputKey}`
    );

    // WHERE THE FIRST ENCODER GOES IS THE PLAN'S, and it is placed by the same
    // arithmetic as every later one. `#placeViewer` above put this person at the
    // second they asked for, and where a viewer stands is the whole of what
    // decides an encoder's position.
    //
    // It used to be started here, from the viewer's position worked out a second
    // time, and the two workings-out did not agree: this one floored the
    // requested seconds onto the cut grid while the plan read the priority map,
    // so a session opened mid-film had an encoder placed twice within one turn.
    // A session created on the family's behalf — a quality step, a soundtrack —
    // registers no viewer at all, and got one here regardless.
    this.#host.planEncodersSoon();

    try {
      await this.#host.waitUntilReady(session);
      return session;
    } catch (error) {
      if (this.#host.encodeRuns.runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED) {
        await this.#host.disposeSession(session.id);
        throw error;
      }
      // Do not fail session creation on warmup timeout; the synthetic playlist
      // is already available and segments appear as ffmpeg produces them.
      return session;
    }
  }

  /**
   * Put a viewer where their own request says they are.
   *
   * A viewer arrives by asking for a POSITION — zero, or the time an address
   * bar carried — so "we do not know where they are" is not a state a viewer
   * can be in. Before 2026-09-05 it was: position was written only by a segment
   * request, so a viewer counted as placeless until they had asked for a
   * segment, and an output whose viewers were all placeless had every encoder
   * on it stopped for having nobody. The soundtrack that failed that day could
   * not have asked: the segment it would have asked for needed an `init.mp4`
   * that the stopped encoder was going to make.
   *
   * Only ever places a viewer who has none. A viewer already placed is being
   * kept current by their own requests and seeks, and a fresh create request
   * carries a default of zero that must not drag them back to the beginning.
   *
   * @param {HlsSession} session
   * @param {import("./viewer/Viewer.js").Viewer} viewer
   * @param {number} positionSeconds
   * @returns {void}
   */
  placeViewer(session, viewer, positionSeconds) {
    if (viewer.position !== null) {
      return;
    }
    const seconds = Number.isFinite(positionSeconds) && positionSeconds > 0 ? positionSeconds : 0;
    let segment = 0;
    try {
      const index = this.#host.outputTimes.segmentIndexForTime(session, seconds);
      if (Number.isInteger(index) && index >= 0) {
        segment = index;
      }
    } catch {
      // A session whose cut table is not built yet places its viewer at the
      // beginning, which is where the run starts anyway.
    }
    viewer.position = { segment, seconds, at: Date.now(), seeked: null };
    this.#host.planEncodersSoon();
  }

  /**
   * The viewer seeked. Called from POST /api/transcode-sessions/:id/seek with
   * the position the browser read off its own player once the scrub ended.
   *
   * This is the ONLY thing that repositions the encoder. It replaces inferring
   * the target from segment requests, which cannot work: a single seek leaves
   * ~25 concurrent requests outstanding across a wide span (measured), so no
   * rule over them can recover which one the viewer meant.
   *
   * The existing settle/cooldown/first-segment guards still apply — they
   * protect against restarting too eagerly, which is orthogonal to knowing
   * WHERE to restart.
   *
   * @param {string} sessionId
   * @param {number} positionSeconds - Absolute position on the source timeline.
   * @returns {boolean} False when the session is unknown or disposed.
   */
  requestSeek(sessionId, positionSeconds, consumerId = "") {
    const named = this.#host.outputs.get(sessionId);
    if (!named) {
      return false;
    }
    // A SEEK DOES ONE THING: it puts the viewer where they now are.
    //
    // It used to do eleven, and wrote that position into five places: two
    // fields on this session, two more on the soundtrack's, and the viewer. It
    // also asked whether the jump would drag another viewer back, started an
    // encoder itself, cancelled outstanding requests, backed off a segment to
    // the preceding keyframe, and set a timer to restart ffmpeg. So it was a
    // third authority over the encoders beside the plan and the start path, and
    // not one of its branches ever asked what had already been made — a viewer
    // jumping into a stretch that was finished and on disk got a fresh encoder
    // for it.
    //
    // What follows from the move happens by itself: the priority map is built
    // from where the viewers are, and both orchestrators read the map.
    // A TRANSPORT THAT CANNOT NAME THE VIEWER STILL HAS ONE. Recorded only for
    // a named viewer, an unnamed one's seek was written nowhere at all: the
    // registry keeps them under the empty name, on the session they are
    // watching, and everything that asks where a viewer is already looks there
    // first. The one difference is that such a viewer belongs to the session
    // rather than to a person, which is what a transport with no id means.
    this.#host.viewers.of(named, consumerId).moveTo(positionSeconds);
    this.#host.outputs.touch(named);
    this.#host.planEncodersSoon();
    return true;
  }

  /**
   * Where the viewer of this session is, in seconds.
   *
   * Exists so a refusal can name it. A log line that says only "superseded"
   * cannot be read afterwards: it does not say what was refused or against what
   * position, which is exactly what the 2026-08-18 investigation lacked.
   *
   * Named per viewer, because that is what the refusal is about: a request is
   * refused for being behind where THAT viewer is, and a line naming the
   * furthest viewer of a shared session would explain a refusal by somebody
   * else's position.
   *
   * @param {string} sessionId
   * @param {string} [consumerId]
   * @returns {number} Zero when the session is gone or nothing has been reported.
   */
  viewerPositionOf(sessionId, consumerId = "") {
    const session = isOutputName(sessionId) ? this.#host.outputs.get(sessionId) : null;
    if (!session) {
      return 0;
    }
    return viewerSecondsOn(session, consumerId);
  }

  /**
   * Count bytes the swarm has delivered to one session's own input read.
   *
   * Called by the `/stream` route for every fragment it writes to an encoder.
   * Cheap on purpose — one addition, no clock, no log — because it runs per
   * fragment on the path that feeds ffmpeg.
   *
   * @param {string} sessionId
   * @param {number} bytes
   * @returns {void}
   */
  noteInputBytes(sessionId, bytes) {
    if (!sessionId || !(bytes > 0)) {
      return;
    }
    const session = this.#host.outputs.get(sessionId);
    if (!session) {
      return;
    }
    session.inputBytes = (session.inputBytes ?? 0) + bytes;
  }

  async getSessionProgress(sessionId, consumerId = "") {
    if (!isOutputName(sessionId)) {
      return null;
    }
    const named = this.#host.outputs.get(sessionId);
    if (!named) {
      return null;
    }
    this.#host.outputs.touch(named);
    // Progress is asked about the stream on screen, which after a quality
    // change is another session. Touching the named one as well is what keeps
    // the family alive: only the ACTIVE variant gets segment requests, so
    // without this the base session would idle out from under its own variants.
    const session = activeOutputFor({ base: named, consumerId, outputs: this.#host.outputs });
    this.#host.outputs.touch(session);
    const warmupTotalSeconds = this.#host.startupWaitMs / 1000;
    const warmupElapsedSeconds = Math.max(
      0,
      (Date.now() - (this.#host.outputs.startedAt(session) ?? Date.now())) / 1000
    );
    // One question, one answer. Run state comes only from the encoding layer.
    const isWarmupPhase = wireState(this.#host.encodeRuns.runStateOf(session)) === "starting";
    const warmupPercent = isWarmupPhase
      ? Math.max(0, Math.min(100, (warmupElapsedSeconds / warmupTotalSeconds) * 100))
      : null;
    const warmupRemainingSeconds = isWarmupPhase
      ? Math.max(0, warmupTotalSeconds - warmupElapsedSeconds)
      : null;
    // Observed OUTPUT bitrate (Mbit/s) from recently completed segment sizes —
    // already computed for the viewer-link budget check (#checkLinkBudget); also
    // exposed here so the browser can turn its OWN measured link throughput into
    // a "content-seconds delivered per wall-clock second" rate for the unified
    // three-stage ETA (download / transcode / delivery), the same way the
    // transcode's own `speed` already is one. Null when not enough segments yet.
    const outputMbps = await this.#host.quality.observedStreamMbps(session);
    const progress = this.#host.encodeRuns.progressOf(session);
    return {
      // The id the caller asked about, not the variant it was answered from —
      // the browser tracks its sessions by the id it was given.
      sessionId: named.id,
      state: wireState(this.#host.encodeRuns.runStateOf(session)),
      // The smallest buffer at which no interruption reaches the viewer, from
      // THIS file's own recent interruptions: one whole segment — the one being
      // played — plus the worst wait that can arrive before the buffer refills.
      // On the field torrent that is 7-9 s where the browser waits for a
      // hand-chosen 25, which is sixteen seconds of staring at a spinner that
      // nothing had shown to be necessary. Null until the reader has seen two
      // interruptions; the browser keeps its own figure until then.
      minimumBufferSeconds: minimumBufferFrom({
        segmentSeconds: this.#host.segmentDurationSec,
        worstSupplyWaitSec: session.supplyFigures?.worstWaitSec
      })?.seconds ?? null,
      processedSeconds: progress.processedSeconds,
      // Bytes this session's own reads have received from the swarm.
      //
      // The second proof that a session is alive, and the only one available
      // before its first frame exists: `processedSeconds` cannot move until the
      // decoder has a frame, so on a cold start it stands at the start position
      // for as long as the first piece takes to arrive. Field 2026-09-03 — one
      // piece took 46.3 s while the swarm delivered 55.9 MB across the torrent,
      // `processedSeconds` frozen at 171.3 throughout, and the browser declared
      // the proxy dead 0.4 s before the piece landed.
      //
      // Counted per SESSION and not per torrent, deliberately: in that same
      // episode the torrent received 55.9 MB while the picture's own reads
      // received 4.5 MB of it, so a torrent-wide figure would have called a
      // starved session healthy.
      inputBytes: session.inputBytes ?? 0,
      startPositionSeconds: progress.startPositionSeconds ?? 0,
      totalSeconds: progress.totalSeconds,
      percent: progress.percent,
      remainingSeconds: progress.remainingSeconds,
      warmupPercent,
      warmupRemainingSeconds,
      // Segment length, so the browser can show progress toward the FIRST
      // segment (the only thing it waits for before playback starts) instead
      // of a percentage of the whole-file transcode.
      segmentDurationSec: this.#host.segmentDurationSec,
      speed: progress.speed,
      outputMbps,
      // The height the viewer is WATCHING right now, which is what the menu
      // has to say next to "Auto". When the video is re-encoded that is the
      // rung the proxy has settled on — it steps down when the host cannot keep
      // up or the link cannot carry the stream. When the video is COPIED it is
      // the source's own height, and reporting zero there was simply wrong:
      // most sessions copy the video, so the menu read a bare "Auto" almost
      // always, which is exactly the question it was supposed to answer.
      currentHeight: session.spec.transcodesVideo
        ? (session.output.encodeHeight ?? session.file.height ?? 0)
        : (session.file.height ?? 0),
      // The rungs still worth offering, as they stand NOW. The list the browser
      // was given when the file opened came from the startup benchmarks; this
      // one is corrected by what the encoder has since been seen to do with
      // this very source, so a rung that turns out to be beyond the host
      // disappears from the menu instead of being discovered by switching to it.
      offeredHeights: this.#host.qualityOffer.offeredHeights(session),
      // The variant this proxy would rather serve, or 0 when it is content.
      //
      // A REQUEST, not an instruction — this side cannot move a player between
      // variants and must not pretend to. The browser honours it only in
      // automatic mode: a height the viewer picked by hand is theirs, and the
      // rule that automatic quality changes belong to automatic mode alone is
      // enforced where the viewer's choice actually lives.
      //
      // This is what replaced rewriting the picture's size underneath a running
      // session. Every height is published in the master with its own init, so
      // asking the player to move is the only form of the act that a decoder
      // can follow.
      requestedHeight: this.#host.quality.standingAskFor(named),
      // What this host takes to create a session and to make a first segment.
      // Also on the playback plan, but the browser reads that once per file:
      // measured 2026-08-06 across four seeks, a proxy that had just restarted
      // answered null for both, and every later seek then computed its estimate
      // with one term of four — the figure hit zero after 3.5 s of an 11.8 s
      // wait and read "starting now" for the remaining 8.4 s. This response is
      // polled about every 1.5 s, so carrying them here keeps them current.
      expectedSessionCreateMs: this.#host.expectedSessionCreateMs(),
      expectedFirstSegmentMs: this.#host.expectedFirstSegmentMs(),
      updatedAt: progress.updatedAt,
      error: this.#host.encodeRuns.runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED ? this.#host.encodeRuns.lastErrorOf(session) : ""
    };
  }
}
