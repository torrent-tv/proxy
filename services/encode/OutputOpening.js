/**
 * @file Which output answers a request for a file, made if it is not here yet.
 *
 * A request names a file, the tracks wanted and a size; what answers it is an
 * OUTPUT, and deciding which is the encoding component's: the arrangement of
 * the sound, the cut grid, the format the budget settles on, and whether an
 * output already here serves the request instead. Two requests whose outputs
 * agree ARE one output. Who asked is not a parameter: placing the requester on
 * the output is the server operation's business (`server/ViewerRequests.js`),
 * and nothing about a viewer enters what is decided here.
 *
 * What the file says about itself is read by the media component and handed in
 * (`probeMediaInfo`, `probeKeyframeTimes`), as is everything else this reads.
 */

import { createRequire } from "node:module";
import { buildResolutionLadder, chooseOutputFps } from "./hwaccel.js";
import { resolveSegmentFormat, SEGMENT_FORMAT_IDS } from "./segment-formats/index.js";
import { AudioOutput, CutGrid, OUTPUT_NO_CAPACITY, OUTPUT_UNAVAILABLE, OutputSpec, VideoOutput } from "./output/index.js";
import { Timeline, Timelines } from "./output/Timeline.js";
import { computeCutGrid } from "./output/cut-grid.js";
import { Output } from "./output/Output.js";
import { mediaPlaylistText } from "./output/playlists.js";
import { formatSeconds } from "./EncodeRuns.js";
import { EncodedOutput } from "./output/EncodedOutput.js";
import { decideOutputFormat } from "./quality/output-format.js";
import { rungForVisiblePicture } from "./quality/visible-rung.js";
import { SOUNDTRACK_MODE_CAUSE, chooseSoundtrackMode, linkAnswerFigures as linkFiguresOf, soundtrackLoadOf } from "./quality/link-budget.js";

/**
 * @typedef {Object} SegmentOutputFiles
 * @property {() => string[]} addresses
 * @property {(address: string, index: number) => boolean} isClosed
 * @property {(address: string) => number | null} lastReadAt
 * @property {(address: string) => string} directoryFor
 * @property {(address: string, format: object) => void} useFormat
 */

/** Own package version, stamped onto output-start log lines. */
const PROXY_VERSION = createRequire(import.meta.url)("../../package.json").version;

export class OutputOpening {
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /**
   * @param {object} host - `logger`, `probeMediaInfo`, `probeKeyframeTimes`, `enabled`, `segmentFormat`, `renditions`, `sourceFiles`, `getCachedMediaInfo`, `localBaseUrl`, `tonemapSupported`, `videoEncoder`, `hostLoad`, `keyframeTables`, `timelines`, `segmentDurationSec`, `softwarePresetBenchmark`, `decodeCostModel`, `encodeCost`, `admission`, `outputs`, `segmentOutputFiles`, `hostTimings`, `returns`, `encodeRuns`
   * @param {SegmentOutputFiles} host.segmentOutputFiles - The storage
   *   operations needed while selecting or opening an output.
   */
  constructor(host) {
    this.#host = host;
  }

  /**
   * The box a re-encoded picture is fitted into.
   *
   * A box the request names is the box (a quality step names its height). With
   * none named, the picture the viewer sees decides: the smallest rung of the
   * source's ladder whose frame is not smaller than it (roadmap item 98). With
   * neither, zeroes — the source's own size.
   *
   * @param {{ normalizedTargetWidth: number, normalizedTargetHeight: number, visiblePicture: { width: number, height: number } | null, sourceWidth: number, sourceHeight: number }} params
   * @returns {{ width: number, height: number }}
   */
  #targetFor({ normalizedTargetWidth, normalizedTargetHeight, visiblePicture, sourceWidth, sourceHeight }) {
    if (normalizedTargetWidth > 0 || normalizedTargetHeight > 0) {
      return { width: normalizedTargetWidth, height: normalizedTargetHeight };
    }
    const rung = rungForVisiblePicture(
      buildResolutionLadder(Math.round(Number(sourceWidth) || 0), Math.round(Number(sourceHeight) || 0)),
      visiblePicture
    );
    return rung ? { width: rung.width, height: rung.height } : { width: 0, height: 0 };
  }

  /**
   * Ask the requester's call whether they may be put on this output, and throw
   * the refusal the way the route answers it.
   *
   * @param {((output: object) => { admitted: boolean, reason: string, speedX: number | null }) | null} claim
   * @param {object} output
   * @param {string} logName
   * @returns {void}
   */
  #claimOrRefuse(claim, output, logName) {
    if (typeof claim !== "function") {
      return;
    }
    const answer = claim(output);
    if (answer?.admitted) {
      return;
    }
    const reason = answer?.reason || "this machine has no place for one more encoder";
    this.#host.logger.info(`transcode "${logName}": not opened for this viewer — ${reason} (key=${output.outputKey})`);
    const error = new Error(`This proxy cannot take this video now: ${reason}.`);
    error.code = OUTPUT_NO_CAPACITY;
    error.details = {
      reason,
      figures: { speedX: Number.isFinite(answer?.speedX) ? Number(answer.speedX.toFixed(3)) : null, outputKey: output.outputKey }
    };
    throw error;
  }

  /**
   * The output that answers this request: one already here, or one made now.
   * No encoder is started here — where encoders go is the plan's.
   *
   * Throws with `error.code === "TRANSCODE_DISABLED"` when transcoding is
   * disabled on this proxy instance.
   *
   * @param {object} options
   * @param {string}  options.sourceKey      - Registry source key.
   * @param {number}  options.fileIndex      - Zero-based file index in the torrent.
   * @param {boolean} [options.transcodeVideo=false]
   * @param {boolean} [options.transcodeAudio=false]
   * @param {string}  [options.fileName=""]              - Display name for log output.
   * @param {number}  [options.targetWidth=0]            - Target video width (0 = keep source).
   * @param {number}  [options.targetHeight=0]           - Target video height (0 = keep source).
   * @param {number}  [options.startPositionSeconds=0]   - Seek start position in seconds.
   * @param {number}  [options.audioTrackIndex=0]        - Type-relative audio track to map (0:a:N).
   * @param {boolean} [options.exactSize=false]           - Produce the target box exactly (capped to source), with no budget downscale and no runtime downswitch. Says nothing about who asked: every rung of a master sets it.
   * @param {number | null} [options.capKbps=null]        - Nominal bitrate limit in kbit/s; null for the size's own. Above the size's own it is refused.
   * @param {{ width: number, height: number } | null} [options.visiblePicture=null] - The picture as the requesting viewer sees it, in physical pixels. With no target box given, a re-encoded picture's box is the smallest rung whose frame is not smaller than this (roadmap item 98).
   * @returns {Promise<{ output: EncodedOutput, existed: boolean, audio: { trackIndex: number, transcode: boolean }, verdict: object | null }>}
   */
  async open({
    sourceKey,
    fileIndex,
    transcodeVideo = false,
    transcodeAudio = false,
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
    viewerLinkMbps = null,
    // The nominal bitrate limit asked for, in kbit/s, or null for the size's
    // own. Part of the output's identity: another limit is another output.
    capKbps = null,
    // The soundtrack THIS viewer receives with the picture — from this output
    // or beside it — as `{ transcode, entry }`. Left out, the one this
    // request names is theirs. A step opened on a viewer's behalf passes the
    // track they chose, which need not be the one the picture was opened with.
    viewerAudio = undefined,
    visiblePicture = null,
    // WHETHER THE REQUESTER MAY BE PUT ON THE OUTPUT, and putting them there,
    // in one synchronous call (roadmap item 97, step 14). Called with the
    // output the moment it answers the request — a new one registered, or one
    // already here — and before anything else can run, so that the place it
    // takes on this machine is counted before the next opening is asked.
    // Returns `{ admitted, reason, speedX }`; a refusal is thrown as
    // OUTPUT_NO_CAPACITY and a new output made for it is withdrawn. Who the
    // requester is stays with the caller: this is handed an opaque call.
    // Absent — a step or a soundtrack opened on a viewer's behalf, whose place
    // the preparation already holds — nothing is asked.
    claim = null
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
    // HOW the soundtrack is produced, decided here, before anything is named by
    // it, by the rule every choice of a track uses (`chooseSoundtrackMode`):
    // the request says whether the browser plays the track as it is, and the
    // inventory whether anything states what a copy of it weighs. A track with
    // no figure is re-encoded even for a browser that would play it, because a
    // copy of it is a load no link can be asked about. Whatever is decided is
    // what the output IS — its key, its ffmpeg arguments, the link's question —
    // and what the viewer is recorded as receiving.
    const soundtrackMode = chooseSoundtrackMode({
      entry: audioSource.entry,
      browserPlays: transcodeAudio !== true,
      // Nothing reaches this line on a proxy whose transcoding is off: the
      // opening refuses every request above, so here re-encoding is allowed.
      transcodeAllowed: true
    });
    const audioTranscoded = soundtrackMode.transcode === true;
    if (soundtrackMode.cause === SOUNDTRACK_MODE_CAUSE.NO_FIGURE) {
      this.#host.logger.info(
        `transcode "${fileName || `file ${fileIndex}`}": audio track ${normalizedAudioTrack} — ${soundtrackMode.cause}; it is sent as AAC`
      );
    }
    // What the requester receives of the sound, handed back so the viewer who
    // asked can be told apart from another viewer of the same output.
    const audio = { trackIndex: normalizedAudioTrack, transcode: audioTranscoded };
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
      : await this.#host.probeMediaInfo(pictureUrl.toString());
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
      this.#host.logger.warn(
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
        // A read that ran out of its budget is still running, and one that
        // found its bytes not downloaded yet is made again when they arrive;
        // either way the table is still unanswered — which is not the same as a file with no keyframes,
        // and the distinction is the table's own (`answered` against
        // `readable`). Recorded as an absence it would make a passing shortage
        // of bytes look like a property of the bytes, and every later session
        // of the file would re-encode a picture that can be copied.
        this.#host.logger.warn(
          `transcode: the keyframe table for "${logName}" has not arrived after ${keyframeMs}ms ` +
            `(budget ${Math.round(this.#host.keyframeTables.budgetMs / 1000)}s), so this session re-encodes the picture ` +
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
          this.#host.logger.warn(
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
      void this.#host.probeKeyframeTimes(inputFile.streamUrl(this.#host.localBaseUrl).toString(), 25_000).then((times) => {
        // Into the FILE's table, which the picture, its quality steps and a
        // second viewer's session all hold — so nothing has to be alive for the
        // answer to be kept, and the session this probe was started for may
        // long since have gone. It used to be written onto whichever session
        // was still there, and dropped outright when none was.
        this.#host.keyframeTables.learn({ sourceKey, fileIndex }, { times, format: "packet probe" });
        const elapsedMs = Date.now() - backgroundStartedAt;
        this.#host.logger.info(
          times
            ? `transcode: background keyframe probe found ${times.length} keyframes ` +
                `(${elapsedMs}ms) for "${logName}" — later seeks will snap to them`
            : `transcode: background keyframe probe unavailable (${elapsedMs}ms) for "${logName}" ` +
                `— seeks keep using the raw target (falls back to the circuit breaker on failure)`
        );
      });
    }
    this.#host.logger.info(
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
    // already here instead (`encode/quality/output-format.js`).
    const decided = decideOutputFormat({
      encodesPicture: transcodeVideo && carriesVideo,
      exact: forceExactSize,
      target: this.#targetFor({ normalizedTargetWidth, normalizedTargetHeight, visiblePicture, sourceWidth, sourceHeight }),
      source: { width: sourceWidth, height: sourceHeight, megabitsPerSecond: file.decode?.megabitsPerSecond ?? null, decode: file.decode },
      fps: outputFps,
      encoder: this.#host.videoEncoder,
      benchmark: this.#host.softwarePresetBenchmark,
      cost: {
        decodeModel: this.#host.decodeCostModel,
        observedDecodeCostSec: this.#host.encodeCost.decodeCostFor(file.key)?.costSec ?? null,
        requiredSpeed: this.#host.hostLoad.requiredSpeedFor(sourceKey, fileIndex)
      },
      chooseBudget: (params) => this.#host.encodeCost.chooseEncodeBudget(params),
      machineAdmission: this.#host.admission
        ? (candidate) => this.#host.admission.previewCandidate(candidate, file)
        : null,
      tonemap: applyTonemap,
      capKbps,
      limitsFor: (frame) => this.#host.limitsFor(frame),
      audioLoad: viewerAudio !== undefined
        ? soundtrackLoadOf(viewerAudio?.entry ?? null, viewerAudio ? viewerAudio.transcode : null)
        : soundtrackLoadOf(audioSource.entry, audioTranscoded),
      specWith: (encode) => new OutputSpec({
        sourceKey,
        segmentFormatId: segmentFormat.id,
        // Where it is ACTUALLY cut: a copy whose container states no keyframes
        // is re-encoded onto the even grid, and is named so.
        grid: new CutGrid({ kind: useKeyframeGrid ? "keyframe" : "uniform", fileIndex }),
        video: carriesVideo ? new VideoOutput({ fileIndex, encode }) : null,
        audio: carriesAudio
          ? new AudioOutput({ fileIndex: audioSource.fileIndex, trackIndex: audioSource.sourceTrackIndex, transcode: audioTranscoded })
          : null
      }),
      serving: {
        mode: servingMode ?? (forceExactSize ? "manual" : "auto"),
        linkMbps: viewerLinkMbps,
        keys: [...this.#host.outputs.values()].map((other) => other.outputKey).concat(this.#host.segmentOutputFiles.addresses()),
        readyAt: (key) => this.#host.segmentOutputFiles.isClosed(key, timeline.indexForTime(Math.max(0, startPositionSeconds))),
        observedPeakMbps: (candidate) => this.#host.observedPeakMbps?.(candidate) ?? null
      }
    });
    if (decided.unavailable) {
      this.#host.logger.info(
        `transcode "${logName}": no output suits this viewer — ${decided.unavailable.reason} ` +
        `${JSON.stringify(decided.unavailable.figures)} (wanted ${decided.wantedKey})`
      );
      const error = new Error(`No output suits this viewer: ${decided.unavailable.reason}.`);
      // Bound by the MACHINE rather than by the viewer's link, for the output a
      // viewer is opening: another proxy is the answer, found before anything
      // plays. A step asked for on their behalf stays "unavailable", which is
      // how every caller of a step already reads a refusal.
      error.code = decided.unavailable.bound === "machine" && typeof claim === "function"
        ? OUTPUT_NO_CAPACITY
        : OUTPUT_UNAVAILABLE;
      error.details = {
        reason: decided.unavailable.reason,
        // How many soundtracks the viewer could choose instead, so the page can
        // offer another one only where there is one to offer.
        figures: decided.unavailable.figures
          ? { ...decided.unavailable.figures, soundtracks: this.#host.renditions.offeredSoundtrackCount(sourceKey, fileIndex) }
          : null,
        wantedKey: decided.wantedKey
      };
      throw error;
    }
    if (decided.answer) {
      this.#host.logger.info(
        `transcode "${logName}": ${decided.answer.verdict} for this viewer ${JSON.stringify(linkFiguresOf(decided.answer))}`
      );
    }
    const spec = decided.spec;
    const budget = decided.budget;
    if (decided.reusedKey) {
      this.#host.logger.info(`transcode "${logName}": served by an output already here, ${decided.reusedKey}, instead of ${decided.wantedKey}`);
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
        this.#claimOrRefuse(claim, existing, logName);
        return { output: existing, existed: true, audio, verdict: decided.answer ? linkFiguresOf(decided.answer) : null };
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
      variantHeight: forceExactSize && height > 0 ? height : undefined
    });
    this.#host.outputs.set(sessionId, session);
    // THE PLACE ON THIS MACHINE, taken in the same synchronous stretch as the
    // registration: priced as registered, and withdrawn whole if refused, so a
    // refused opening leaves nothing behind — no directory, no timing.
    try {
      this.#claimOrRefuse(claim, session, logName);
    } catch (error) {
      this.#host.outputs.delete(sessionId);
      throw error;
    }

    // Only now, when nothing above can still throw. Everything from the probe
    // to the keyframe index used to run with the directory already made, so a
    // failure between the two left it behind: nothing tracks a directory whose
    // session was never registered, and no sweep looks for one. Proxy
    // 2.9.101-2.9.102 failed here on every single request and the leftovers
    // were the only trace of it on disk.
    // A RETURN, if this output was held before — and its age, which is the one
    // term of the keeping period that nothing measures. Read BEFORE the
    // directory is claimed, since claiming it is what marks it read.
    this.#host.returns.note({ lastReadAt: this.#host.segmentOutputFiles.lastReadAt(spec.toKey()), now: Date.now() });
    this.#host.segmentOutputFiles.directoryFor(spec.toKey());
    this.#host.segmentOutputFiles.useFormat(spec.toKey(), segmentFormat);
    this.#host.hostTimings.noteOutputCreated(session, createEntryMs);
    this.#host.encodeRuns.setReadWindow(session, readWindowBytes);
    this.#host.encodeCost.notePredictionFor(session, output.encodeHeight);
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
    this.#host.logger.info(
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
        `audio=${audioTranscoded ? "aac" : "copy"} ` +
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

    // Where the first encoder goes is the plan's, placed by the same arithmetic
    // as every later one from where the viewers stand; the requester is placed
    // by the operation that asked for this output.
    return { output: session, existed: false, audio, verdict: decided.answer ? linkFiguresOf(decided.answer) : null };
  }
}
