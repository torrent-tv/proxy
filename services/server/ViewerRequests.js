/**
 * What a viewer asks of this proxy, one request at a time.
 *
 * Open an output of a file — the one that already exists when its parameters
 * agree — and be placed on it; state a new position; ask how far the material
 * in front of them has got. Each request states a fact about the viewer and
 * returns; where encoders go follows from those facts and is the plan's.
 */

import { logger } from "../../utils/logger.js";
import { isOutputName } from "../encode/output/index.js";
import { withSubtitleReadiness } from "./subtitle-readiness.js";

function isWarmupTimeoutError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message === "HLS playlist is still warming up.";
}

/**
 * The segment number an assignment is recorded under for this file, −1 for the
 * init, or null for anything that is neither (a playlist).
 *
 * @param {object} output
 * @param {string} fileName
 * @returns {number | null}
 */
function segmentAddressOf(output, fileName) {
  const format = output.segmentFormat;
  if (!format) {
    return null;
  }
  if (format.initFileName !== null && fileName === format.initFileName) {
    return -1;
  }
  if (format.isSegmentFileName(fileName)) {
    return format.segmentIndexFromName(fileName);
  }
  return null;
}

export class ViewerRequests {
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;
  /** @type {WeakMap<object, Map<string, object>>} */
  #rateStateBySession = new WeakMap();

  /**
   * @param {object} host - `opening`, `activeOutputFor`, `viewerSecondsOn`, `minimumBufferSecondsFor`, `getSourceStats`, `disposeSession`, `planEncodersSoon`, `waitUntilReady`, `encodeRuns`, `encodeSpeedReadingOf`, `outputTimes`, `outputs`, `lookaheadSeconds`, `quality`, `qualityOffer`, `renditions`, `segmentDurationSec`, `segmentStore`, `sourceFiles`, `startupWaitMs`, `viewers`, `acceptsGeneration`, `generationOfRequest`, `noteGivenOutput`, `holdForResponse`, `noteServingVerdict`, `servingVerdictOf`
   */
  constructor(host) {
    this.#host = host;
  }

  /**
   * Open an output of a file for this viewer and put them on it.
   *
   * Which output answers is the encoding component's decision
   * (`encode/OutputOpening.js`), made without knowing who asked. What is this
   * operation's is the requester: they are registered on the output with the
   * sound they chose and placed where their request says they are, and the
   * answer waits for the output to be ready to play.
   *
   * Throws with `error.code === "TRANSCODE_DISABLED"` when transcoding is
   * disabled on this proxy instance.
   *
   * @param {object} request - What `OutputOpening.open` takes, plus the viewer.
   * @param {string} [request.consumerId] - Who asks. Empty for an output a
   *   picture opens on its own behalf (a quality step, a soundtrack), which
   *   places nobody on it.
   * @returns {Promise<import("../encode/output/EncodedOutput.js").EncodedOutput>}
   */
  async createOrGetSession({ consumerId = "", ...request }) {
    request.signal?.throwIfAborted();
    const requestStartedAt = Date.now();
    // What this viewer's link last measured, where the request does not say:
    // a viewer who comes back to open another film has a link this proxy has
    // already measured, and the output they are given is judged by it.
    const known = consumerId ? this.#host.viewers.get(consumerId) : null;
    const viewerLinkMbps = request.viewerLinkMbps ?? known?.linkReading()?.linkMbps ?? null;
    const startPositionSeconds = request.startPositionSeconds ?? 0;
    // Whether they were already on the output this request lands on, read at
    // the moment they are put on it.
    let alreadyOn = false;
    // THE PLACE ON THIS MACHINE, AND THE VIEWER IN IT, in one synchronous call
    // the opening makes the moment it has the output (roadmap item 97, step 14).
    // Asked and placed together, so the next viewer to open anything is asked
    // with this one counted: two openings cannot both be told there is room
    // for one. Placed now for the second reason it always was — a viewer who
    // has not been placed states no want, and an output all of whose viewers
    // state nothing has every encoder on it stopped.
    const claim = consumerId
      ? (candidate) => {
          request.signal?.throwIfAborted();
          alreadyOn = this.#host.viewers.forOutput(candidate).has(consumerId);
          const answer = alreadyOn
            ? { admitted: true, reason: "already watching it", speedX: null }
            : this.#host.admitsWatching(candidate);
          if (answer.admitted) {
            this.placeViewer(candidate, this.#host.viewers.of(candidate, consumerId), startPositionSeconds);
          }
          return answer;
        }
      : null;
    const { output, existed, audio, verdict } = await this.#host.opening.open({
      ...request,
      viewerLinkMbps,
      claim
    });
    request.signal?.throwIfAborted();
    if (consumerId) {
      const joined = existed && !alreadyOn;
      // What THIS viewer wants of the sound, which an output they are joining
      // knows nothing about: they may have chosen another language, and their
      // browser may need a track re-encoded that the first viewer's could
      // decode as it stands.
      const viewer = this.#host.viewers.of(output, consumerId);
      viewer.audio = audio;
      // The picture as their page sees it, which bounds the height made for
      // them from here on (roadmap item 98).
      viewer.noteVisiblePicture(request.visiblePicture);
      if (!alreadyOn) {
        const measuredAge = Number(request.linkSampleAgeMs);
        viewer.report({
          linkMbps: viewerLinkMbps,
          linkSampleMbps: request.linkSampleMbps,
          linkSampleAt: request.linkSampleAt,
          linkSampleAgeMs: Number.isFinite(measuredAge) && measuredAge >= 0
            ? measuredAge + Date.now() - requestStartedAt
            : null,
          bufferedAheadSec: request.bufferedAheadSec,
          bufferLimitSeconds: request.bufferLimitSeconds,
          positionSeconds: startPositionSeconds,
          waiting: true,
          playing: false,
          visiblePicture: request.visiblePicture
        });
      }
      // On what their output was judged. Recorded where the output is opened
      // for them; a step opened on their behalf is recorded by `Renditions`.
      this.#host.noteServingVerdict(consumerId, verdict ? { ...verdict, outputKey: output.outputKey } : null);
      // WHERE they are was stated when they were put on it, by `claim` above:
      // a viewer joining an output already playing at 40:00 may be opening the
      // film from a link that carries 05:00.
      // Reuse said nothing at all once, so an output serving two viewers looked
      // exactly like one serving a single viewer — and the whole question its
      // key exists to answer is which of the two happened.
      if (joined) {
        logger.info(
          `transcode ${output.id} joined by ${consumerId} ` +
          `(${this.#host.viewers.forOutput(output).size} viewer(s)) key=${output.outputKey}`
        );
      }
    }
    this.#host.outputs.touch(output);
    if (!existed) {
      // Where the first encoder goes is the plan's, from where the viewers stand.
      this.#host.planEncodersSoon();
    }
    try {
      await this.#host.waitUntilReady(output);
    } catch (error) {
      if (!existed && this.#host.encodeRuns.hasFailed(output)) {
        await this.#host.disposeSession(output.id);
        throw error;
      }
      if (existed && !isWarmupTimeoutError(error)) {
        throw error;
      }
      // Not a failure of the request: the synthetic playlist is already there
      // and segments appear as the encoder produces them.
    }
    return output;
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
   * @param {import("../viewer/Viewer.js").Viewer} viewer
   * @param {number} positionSeconds
   * @returns {void}
   */
  /**
   * Put a viewer named by id onto this output, where they have no position yet.
   *
   * The same operation as {@link placeViewer}, addressed the way another
   * component may address it: by name. Encoding asks for this when a request
   * for any file of an output is the first sign of the person behind it, and it
   * must not be handed the viewer to do it — a viewer's record has one writer,
   * and that is the viewer layer.
   *
   * @param {object} output
   * @param {string} consumerId
   * @param {number} positionSeconds
   * @returns {void}
   */
  placeViewerOn(output, consumerId, positionSeconds) {
    if (!output || !consumerId) {
      return;
    }
    this.placeViewer(output, this.#host.viewers.of(output, consumerId), positionSeconds);
  }

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
   * @param {string} [consumerId] - Who moved.
   * @param {number} [generation] - Which viewing their requests now belong to,
   *   as the page states it. Not a number this side counts: see below.
   * @returns {boolean} False when the session is unknown or disposed.
   */
  requestSeek(sessionId, positionSeconds, consumerId = "", generation = Number.NaN) {
    const named = this.#host.outputs.get(sessionId);
    if (!named || !consumerId) {
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
    // A seek that names nobody moves nobody: the route refuses it before it
    // gets here.
    const viewer = this.#host.viewers.of(named, consumerId);
    viewer.moveTo(positionSeconds);
    // WHICH VIEWING THEIR REQUESTS NOW BELONG TO, as the page states it.
    //
    // Not counted here: the page raises its own number before it sends this,
    // and stamps every request with it, so counting a second one on this side
    // would make two owners of one fact — and they would disagree exactly when
    // a request and a seek cross, which is the case the number exists for. A
    // page that states nothing leaves the generation where it is, which is the
    // behaviour every transport without a loader of ours has.
    //
    // The generation being left is not dropped: a request already in flight is
    // still answered by the output it was made against — see the two deadlines
    // in `Assignments.js`.
    viewer.assignments.statedGeneration(generation);
    this.#host.outputs.touch(named);
    // EVERY REQUEST THIS VIEWER HAS OUTSTANDING WAS MADE FOR WHERE THEY WERE,
    // and hls.js keeps one fragment load outstanding per track: a request held
    // for a segment behind them blocks the one they need now. Measured
    // 2026-08-04: 57 s of a 58 s backward seek was that wait, and the segment
    // they wanted was served in 15 ms once it was asked for.
    //
    // WAKING IS NOT CANCELLING. It moves the epoch, and each held request then
    // asks whether it is still wanted — for the viewer who made it, at that
    // viewer's own position. So a request of somebody else's on an output
    // shared with them is kept, and so is this viewer's own request for the
    // segment they have just landed on, which races this notification.
    //
    // EVERY OUTPUT THEY WATCH, not the one the browser addressed: their picture,
    // the quality step on their screen and their soundtrack are three outputs
    // with three sets of held requests, and a seek leaves all three behind.
    for (const outputId of viewer.outputs) {
      const watched = this.#host.outputs.get(outputId);
      if (watched) {
        this.#host.invalidateWaits(watched);
      }
    }
    this.#host.planEncodersSoon();
    return true;
  }

  /**
   * Whether this viewer still takes a request made in the generation it states.
   *
   * ASKED BEFORE ANYTHING THE REQUEST WOULD CAUSE. Resolving a step or a
   * soundtrack can create an output and registers the viewer on it; a request
   * made for a viewing the viewer has already left would do both and only then
   * be refused. So every route asks this first.
   *
   * @param {string} consumerId
   * @param {number} statedGeneration - What the request carried; NaN when
   *   nothing, which is always taken.
   * @returns {boolean}
   */
  acceptsRequest(consumerId, statedGeneration) {
    return this.#host.acceptsGeneration(consumerId, statedGeneration);
  }

  /**
   * Record that the output a request ADDRESSED answered it.
   *
   * The picture's own route names its output outright, so there is nothing to
   * choose; what is recorded is the answer, under the height that output is
   * named after (`variantHeightOf`). That is the same height under which the
   * step route answers with the picture itself, so the two addresses of one
   * height lead to one output and one record. An init is recorded as segment
   * −1. A soundtrack is not a height and records nothing: its repeat is not
   * kept, while the check of the generation and the hold of a response still
   * apply to it.
   *
   * @param {string} sessionId
   * @param {string} consumerId
   * @param {number} statedGeneration
   * @param {string} fileName
   * @returns {void}
   */
  noteAnsweredDirectly(sessionId, consumerId, statedGeneration, fileName) {
    const output = isOutputName(sessionId) ? this.#host.outputs.get(sessionId) : null;
    if (!output || !consumerId || !output.spec?.video) {
      return;
    }
    const segmentIndex = segmentAddressOf(output, fileName);
    if (segmentIndex === null) {
      return;
    }
    const height = this.#host.outputs.variantHeightOf(output);
    const generation = this.#host.generationOfRequest(consumerId, statedGeneration);
    this.#host.noteGivenOutput(consumerId, generation, height, segmentIndex, output.outputKey ?? "");
  }

  /**
   * A response from this output to this viewer has begun: the output is held
   * until the function returned is called, whatever happens to the generation
   * meanwhile. Safe to call more than once.
   *
   * @param {string} sessionId
   * @param {string} consumerId
   * @returns {() => void}
   */
  holdResponse(sessionId, consumerId) {
    const output = isOutputName(sessionId) ? this.#host.outputs.get(sessionId) : null;
    return this.#host.holdForResponse(consumerId, output?.outputKey ?? "");
  }

  /**
   * The same hold, named by an output's KEY: a piece served from what a gone
   * output left in the store has no live output to name it by.
   *
   * @param {string} outputKey
   * @param {string} consumerId
   * @returns {() => void}
   */
  holdResponseForKey(outputKey, consumerId) {
    return this.#host.holdForResponse(consumerId, outputKey ?? "");
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
    return this.#host.viewerSecondsOn(session, consumerId);
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
    const session = this.#host.activeOutputFor({ base: named, consumerId, outputs: this.#host.outputs });
    this.#host.outputs.touch(session);
    const audio = this.#host.renditions.servesAudioSeparately(session)
      ? this.#host.renditions.playbackAudioOutputFor(session, consumerId) : null;
    const failed = [session, audio].find(output => output && this.#host.encodeRuns.wireStateOf(output) === "failed");
    const warmupTotalSeconds = this.#host.startupWaitMs / 1000;
    const warmupElapsedSeconds = Math.max(
      0,
      (Date.now() - (this.#host.outputs.startedAt(session) ?? Date.now())) / 1000
    );
    // One question, one answer. Run state comes only from the encoding layer.
    const isWarmupPhase = this.#host.encodeRuns.wireStateOf(session) === "starting";
    const warmupPercent = isWarmupPhase
      ? Math.max(0, Math.min(100, (warmupElapsedSeconds / warmupTotalSeconds) * 100))
      : null;
    const warmupRemainingSeconds = isWarmupPhase
      ? Math.max(0, warmupTotalSeconds - warmupElapsedSeconds)
      : null;
    // Observed output bitrate (Mbit/s) from recently completed segments. The
    // proxy uses it for the viewer-link budget and the readiness forecast.
    const outputMbps = await this.#host.quality.observedStreamMbps(session);
    const progress = this.#host.encodeRuns.progressOf(session);
    const playbackReadiness = await this.#playbackReadinessFor(session, consumerId, progress, outputMbps);
    return {
      // The id the caller asked about, not the variant it was answered from —
      // the browser tracks its sessions by the id it was given.
      sessionId: named.id,
      state: failed ? "failed" : this.#host.encodeRuns.wireStateOf(session),
      // The smallest buffer at which no interruption reaches the viewer, from
      // THIS file's own recent interruptions: one whole segment — the one being
      // played — plus the worst wait that can arrive before the buffer refills.
      // On the field torrent that is 7-9 s where the browser waits for a
      // hand-chosen 25, which is sixteen seconds of staring at a spinner that
      // nothing had shown to be necessary. Null until the reader has seen two
      // interruptions; the browser keeps its own figure until then.
      minimumBufferSeconds: this.#host.minimumBufferSecondsFor(session),
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
      inputBytes: this.#host.encodeRuns.inputBytesOf(session),
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
      outputMbps,
      playbackReadiness,
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
      requestedHeight: this.#host.quality.standingAskFor(named, consumerId),
      // Whether that request is URGENT: this viewer's buffer would run dry
      // before anything else could arrive, so their page switches as soon as
      // the rung is ready instead of waiting for a cushion (roadmap item 98).
      requestedUrgent: this.#host.quality.standingAskIsUrgent(named, consumerId),
      // On what the output this viewer is given was judged against THEIR link:
      // `fits` (confirmed), `estimated to fit` (admitted by an average, not
      // confirmed), or `no measurement`. The page says which, so an estimate
      // is never presented as a guarantee.
      servingVerdict: this.#host.servingVerdictOf(consumerId),
      updatedAt: progress.updatedAt,
      error: this.#host.encodeRuns.failureOf(failed ?? session)
    };
  }

  async #playbackReadinessFor(session, consumerId, progress, outputMbps) {
    const now = Date.now();
    const viewer = consumerId ? this.#host.viewers.get(consumerId) : null;
    const viewerReading = viewer?.linkReading() ?? null;
    const measurement = this.#rateStateFor(session, consumerId);
    const linkAt = Number(viewerReading?.linkSampleMeasuredAt);
    if (Number.isFinite(viewerReading?.linkSampleMbps) && viewerReading.linkSampleMbps > 0 && Number.isFinite(linkAt)) {
      measurement.link.add(linkAt, viewerReading.linkSampleMbps * 1_000_000);
    }

    const outputs = [session];
    const requiresSeparateAudio = this.#host.renditions.servesAudioSeparately(session);
    const audioOutput = requiresSeparateAudio
      ? this.#host.renditions.playbackAudioOutputFor(session, consumerId)
      : null;
    if (audioOutput) {
      outputs.push(audioOutput);
    }

    const sourceMeasurements = new Map();
    const sourceForecasts = new Map();
    const tracks = [];
    for (const output of outputs) {
      const trackProgress = output === session ? progress : this.#host.encodeRuns.progressOf(output);
      const trackRates = this.#trackRateReadings(measurement, output, now);
      const timeline = output.timeline;
      const trackName = output === session ? "video" : "audio";
      const nativeRanges = Array.from({ length: timeline?.segmentCount ?? 0 }, (_, index) =>
        this.#host.encodeRuns.finishedMediaRangesOf(output, index));
      // The page states the offset its player applied to this track, and the
      // init it applied it to is the session's. Until both are known, the
      // pieces stay on their own presentation timeline: there is nothing yet
      // to place them by.
      const playerOffset = viewerReading?.timestampOffsets?.[trackName];
      const servedInit = Number.isFinite(playerOffset) ? this.#host.segmentStore.initOf(output.outputKey) : null;
      const placedByPlayer = Boolean(servedInit?.length);
      const sessionInit = placedByPlayer ? servedInit : null;
      const segments = Array.from({ length: timeline?.segmentCount ?? 0 }, (_, index) => {
        const ranges = nativeRanges[index];
        return {
          index,
          startSeconds: timeline.publishedStartOf(index),
          endSeconds: timeline.publishedStartOf(index + 1),
          sourceInputs: this.#host.sourceInputsFor?.(output, index) ?? undefined,
          mediaRanges: ranges && output.segmentFormat?.servedMediaRanges ?
            output.segmentFormat.servedMediaRanges(ranges, { initBytes: sessionInit }) : undefined
        };
      });
      const sourceIndexes = [output.spec.video?.fileIndex, output.spec.audio?.fileIndex]
        .filter((fileIndex) => Number.isInteger(fileIndex) && fileIndex >= 0);
      if (sourceIndexes.length === 0) {
        sourceIndexes.push(output.file.fileIndex);
      }
      const sourceIds = [];
      for (const fileIndex of new Set(sourceIndexes)) {
        const sourceId = `${output.file.sourceKey}:${fileIndex}`;
        sourceIds.push(sourceId);
        if (sourceMeasurements.has(sourceId)) {
          continue;
        }
        let stats = null;
        try {
          stats = await this.#host.getSourceStats?.(output.file.sourceKey, fileIndex,
            { forecast: !sourceForecasts.has(output.file.sourceKey) }) ?? null;
        } catch {
          stats = null;
        }
        if (!sourceForecasts.has(output.file.sourceKey)) sourceForecasts.set(output.file.sourceKey, stats?.downloadForecast ?? { ranges: [] });
        const sharedForecast = sourceForecasts.get(output.file.sourceKey);
        const downloadForecast = sharedForecast.global ? { measuredAt: sharedForecast.measuredAt,
          ranges: !stats ? [] : sharedForecast.ranges.map(range => ({ ...range,
            start: Math.max(0, range.start - stats.fileOffset),
            end: Math.min(stats.fileLength, range.end - stats.fileOffset)
          })).filter(range => range.end > range.start) } : sharedForecast;
        sourceMeasurements.set(sourceId, {
          id: sourceId,
          complete: stats?.fileAvailable === true,
          residence: stats?.residence,
          fileOffset: stats?.fileOffset,
          fileLength: stats?.fileLength,
          pieceLength: stats?.pieceLength,
          downloadRateReadings: this.#sourceRateReadings(measurement, sourceId, stats, now),
          downloadForecast,
        });
      }

      const inventory = this.#host.segmentStore.sizesOf(output.outputKey);
      const observedMbps = output === session
        ? outputMbps
        : await this.#host.quality.observedStreamMbps(output);
      const liveRuns = this.#host.encodeRuns.liveRunsOf?.(output) ?? [];
      const processingStarted = liveRuns.some(({ progress }) => progress.processedSeconds > progress.startPositionSeconds);
      const startedAt = liveRuns.find(({ startedAt }) => startedAt > 0)?.startedAt ?? now;
      tracks.push({
        id: output.outputKey,
        clockOffsetSeconds: placedByPlayer ? playerOffset : 0,
        clientRanges: viewerReading?.bufferedRanges?.[output === session ? "video" : "audio"] ??
          viewerReading?.bufferedRanges?.media,
        sourceIds,
        processedSeconds: trackProgress?.processedSeconds,
        startupRemainingSeconds: processingStarted ? 0 : Math.max(0,
          (this.#host.processingStartupSecondsOf?.(output) ?? 0) - Math.max(0, (now - startedAt) / 1000)),
        processingRanges: liveRuns.map(({ progress }) => ({
          start: progress.startPositionSeconds, end: progress.processedSeconds
        })),
        bitsPerMediaSecond: Number.isFinite(observedMbps) && observedMbps > 0 ? observedMbps * 1_000_000 :
          this.#host.initialOutputBitsPerMediaSecondOf?.(output) ?? 0,
        readings: trackRates,
        segments,
        readySegmentIndices: [...inventory.keys()],
        segmentSizesBytes: inventory
      });
    }

    const activeTrackIds = new Set(tracks.map(({ id }) => id));
    for (const id of measurement.tracks.keys()) {
      if (!activeTrackIds.has(id)) {
        measurement.tracks.delete(id);
      }
    }
    const bufferedAheadSeconds = Number(viewerReading?.bufferedAheadSec);
    const positionSeconds = Number.isFinite(viewerReading?.positionSeconds)
      ? viewerReading.positionSeconds
      : this.#host.viewerSecondsOn(session, consumerId, now);
    // Both separately delivered tracks can run short independently. Use the
    // largest measured supply interruption across the tracks the viewer needs;
    // when a track has no interruption history yet, its actual next segment
    // duration is the observed floor for that track.
    const reserveSeconds = Math.max(...outputs.map((output, index) => {
      const measured = Number(this.#host.minimumBufferSecondsFor(output));
      if (Number.isFinite(measured) && measured > 0) {
        return measured;
      }
      const trackSegments = tracks[index]?.segments ?? [];
      const nextSegment = trackSegments.find((segment) =>
        segment.startSeconds <= positionSeconds && segment.endSeconds > positionSeconds
      ) ?? trackSegments.find((segment) => segment.startSeconds >= positionSeconds);
      const segmentSeconds = nextSegment
        ? nextSegment.endSeconds - nextSegment.startSeconds
        : Number(this.#host.segmentDurationSec);
      return Number.isFinite(segmentSeconds) && segmentSeconds > 0 ? segmentSeconds : 0;
    }));

    const input = {
      now,
      positionSeconds,
      durationSeconds: session.file.durationSeconds,
      bufferedAheadSeconds,
      bufferLimitSeconds: viewerReading?.bufferLimitSeconds,
      reserveSeconds,
      lookaheadSeconds: this.#host.lookaheadSeconds,
      requiredAudio: requiresSeparateAudio,
      sources: [...sourceMeasurements.values()],
      tracks,
      linkReadings: measurement.link.snapshot()
    };
    // A subtitle track chosen inside THIS file is the last input the forecast
    // waits for. A subtitle FILE beside it is named by its own index and is
    // fetched whole by the page before it is chosen, so it never matches here.
    const subtitle = viewer?.subtitle?.sourceKey === session.file.sourceKey &&
      viewer.subtitle.fileIndex === session.file.fileIndex ? viewer.subtitle : null;
    const forecast = withSubtitleReadiness(this.#host.playbackReadiness.predict(input), subtitle,
      subtitle ? this.#host.subtitleReadyFor?.(viewer) !== false : true);
    forecast.operations = outputs.flatMap((output, index) => {
      const common = { speed: this.#host.playbackReadiness.forecastRate(tracks[index].readings), processedSeconds: tracks[index].processedSeconds };
      return [
        ...(output.spec.video ? [{ ...common, track: "video",
          operation: output.spec.transcodesVideo ? "encode" : "copy",
          inputCodec: output.file.media?.videoCodec ?? output.file.media?.codec,
          outputCodec: output.spec.transcodesVideo ? "h264" : null,
          height: output.spec.video.encode?.height ?? output.file.media?.height }] : []),
        ...(output.spec.audio ? [{ ...common, track: "audio",
          operation: output.spec.audio.transcode ? "encode" : "copy",
          inputCodec: this.#host.audioDescriptionOf?.(output)?.codec ?? output.file.media?.audioCodec,
          outputCodec: output.spec.audio.transcode ? "aac" : null }] : [])
      ];
    });
    if (measurement.forecastReason !== forecast.reason) {
      measurement.forecastReason = forecast.reason;
      logger.info(`playback readiness ${session.id} consumer=${consumerId} ${JSON.stringify({
        ...forecast,
        positionSeconds,
        durationSeconds: input.durationSeconds,
        bufferLimitSeconds: input.bufferLimitSeconds,
        lookaheadSeconds: input.lookaheadSeconds,
        link: input.linkReadings,
        sources: input.sources.map(({ id, complete, residence, downloadForecast, downloadRateReadings }) => ({
          id, complete, residenceRanges: residence?.length ?? 0,
          forecastAt: downloadForecast?.measuredAt ?? null, plannedPieces: downloadForecast?.ranges.length ?? 0,
          unknownPieces: downloadForecast?.ranges.filter(range => range.availableAt === null).length ?? 0,
          downloadRateBytesPerSecond: downloadRateReadings?.lastValue ?? null
        })),
        tracks: tracks.map(({ id, processedSeconds, readings, segments, readySegmentIndices }) => ({
          id, processedSeconds, readings, segments: segments.length, prepared: readySegmentIndices.length
        }))
      })}`);
    }
    return forecast;
  }

  #rateStateFor(session, consumerId) {
    let byViewer = this.#rateStateBySession.get(session);
    if (!byViewer) {
      byViewer = new Map();
      this.#rateStateBySession.set(session, byViewer);
    }
    const id = typeof consumerId === "string" ? consumerId : "";
    let state = byViewer.get(id);
    if (!state) {
      state = { link: new this.#host.playbackReadiness.RateTrend(this.#host.lookaheadSeconds), tracks: new Map(), sources: new Map() };
      byViewer.set(id, state);
    }
    return state;
  }

  #trackRateReadings(state, output, now) {
    const id = output.outputKey;
    let trend = state.tracks.get(id);
    if (!trend) {
      trend = new this.#host.playbackReadiness.RateTrend(this.#host.lookaheadSeconds);
      state.tracks.set(id, trend);
    }
    const reading = this.#host.encodeSpeedReadingOf?.(output, now) ?? null;
    if (Number.isFinite(reading?.speed) && reading.speed > 0 && Number.isFinite(reading.at)) {
      trend.add(reading.at, reading.speed);
    } else {
      const projected = Number(this.#host.projectedEncodeSpeedOf?.(output));
      if (Number.isFinite(projected) && projected > 0) {
        trend.add(now, projected);
      }
    }
    return trend.snapshot();
  }

  #sourceRateReadings(state, id, stats, now) {
    let trend = state.sources.get(id);
    if (!trend) {
      trend = new this.#host.playbackReadiness.RateTrend(this.#host.lookaheadSeconds);
      state.sources.set(id, trend);
    }
    if (Number.isFinite(stats?.downloadSpeed) && stats.downloadSpeed >= 0) {
      trend.add(now, stats.downloadSpeed);
    }
    return trend.snapshot();
  }
}
