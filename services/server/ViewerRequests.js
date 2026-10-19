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
/**
 * Whether two lists of a piece's torrent inputs state the same bytes: the
 * download map hands out new lists around the ranges it keeps, so the ranges
 * themselves are compared.
 *
 * @param {Array<{ sourceId: string, ranges: object[] }> | undefined} left
 * @param {Array<{ sourceId: string, ranges: object[] }> | undefined} right
 * @returns {boolean}
 */
function sameInputs(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((input, index) => input.sourceId === right[index].sourceId && input.ranges === right[index].ranges);
}

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
  /** @type {Map<string, { consumerId: string, generation: number, fileIndex: number | null, waitId: string, features: object, updatedAt: number, revision: number, observedWaits: Set<number> }>} */
  #earlyWaits = new Map();
  /**
   * What the start forecasts cost, said once a minute: how many there were,
   * their time on the main thread, and for each track whether the times of its
   * pieces were kept from the last poll or why they were worked out again. In
   * r37 the forecast took 19.2 s of Home Assistant's main thread in 15 minutes
   * and the times were mostly worked out again (torrent-tv/meta#178).
   */
  #forecastCosts = { since: Date.now(), polls: 0, ms: 0, maxMs: 0, times: new Map() };

  #noteForecast(ms, reasons) {
    const costs = this.#forecastCosts;
    costs.polls += 1; costs.ms += ms; costs.maxMs = Math.max(costs.maxMs, ms);
    for (const reason of reasons) costs.times.set(reason, (costs.times.get(reason) ?? 0) + 1);
    const now = Date.now();
    if (now - costs.since < 60_000) return;
    logger.info(`start forecasts in ${((now - costs.since) / 1000).toFixed(1)}s: ${costs.polls}, ` +
      `${Math.round(costs.ms)}ms in all, ${(costs.ms / costs.polls).toFixed(1)}ms each, longest ${Math.round(costs.maxMs)}ms; ` +
      `times of a track's pieces: ${[...costs.times].map(([reason, count]) => `${reason} ${count}`).join(", ")}`);
    Object.assign(costs, { since: now, polls: 0, ms: 0, maxMs: 0, times: new Map() });
  }

  /**
   * The pieces of each output as the start forecast read them last (see
   * `#segmentsOf`), and what the forecast keeps of their time geometry while
   * they stand (`playback-readiness.js` `timescaleOfPieces`).
   *
   * @type {WeakMap<object, { pieces: object[], geometry: object }>}
   */
  #forecastPieces = new WeakMap();

  /**
   * @param {object} host - `opening`, `activeOutputFor`, `viewerSecondsOn`, `minimumBufferSecondsFor`, `getSourceStats`, `disposeSession`, `planEncodersSoon`, `waitUntilReady`, `encodeRuns`, `encodeSpeedReadingsOf`, `outputTimes`, `outputs`, `lookaheadSeconds`, `quality`, `qualityOffer`, `renditions`, `segmentDurationSec`, `segmentStore`, `sourceFiles`, `startupWaitMs`, `viewers`, `acceptsGeneration`, `generationOfRequest`, `noteGivenOutput`, `holdForResponse`, `noteServingVerdict`, `servingVerdictOf`
   */
  constructor(host) {
    this.#host = host;
  }

  /**
   * Attach a host-matched estimate to the file list before the viewer chooses
   * a file, so the original action need not wait for a torrent-worker round trip.
   *
   * @param {{ consumerId: string, generation: number, sourceKey: string, fileIndex: number, fileName: string, fileLength: number }} params
   * @returns {object | null}
   */
  waitEstimateForFile({ consumerId, generation, sourceKey, fileIndex, fileName, fileLength, linkMbps, linkSampleAgeMs,
    waitElapsedMs }) {
    if (!consumerId || !Number.isSafeInteger(generation) || typeof sourceKey !== "string" ||
        !Number.isSafeInteger(fileIndex) || fileIndex < 0) return null;
    const waitId = `${sourceKey}:${fileIndex}:${generation}`;
    const key = `${consumerId}:${waitId}`;
    const extension = typeof fileName === "string" ? fileName.split(".").at(-1)?.toLowerCase() ?? "" : "";
    const link = linkMeasurementOf(this.#host.viewers.get(consumerId), linkMbps, linkSampleAgeMs);
    const features = {
      extension,
      fileLength,
      downloadSpeed: null,
      linkMbps: link.mbps,
      linkSampleAgeMs: link.ageMs,
      preparedOutputBytes: this.#preparedOutputBytes(sourceKey, fileIndex),
      fileAvailable: null,
      headerRemaining: null,
      peers: null
    };
    const current = this.#earlyWaits.get(key);
    if (current?.waitId === waitId && current.hasSourceObservation) {
      const context = this.#setEarlyWait({ consumerId, generation, fileIndex, waitId, features,
        revision: current.revision, current, waitElapsedMs });
      const changed = this.#recordEarlyWaitSnapshot(context, context.features);
      if (changed) context.revision += 1;
      this.#pruneEarlyWaits();
      const totalSeconds = this.#host.firstFrameSecondsOf?.(context.features) ?? null;
      const seconds = earlyWaitRemainingSeconds(totalSeconds, waitElapsedSince(context, waitElapsedMs));
      if (!Number.isFinite(seconds) || seconds < 0) return null;
      return { version: 1, waitId, revision: context.revision, remainingSeconds: seconds, ageMs: 0 };
    }
    const sameWait = current?.waitId === waitId;
    const revision = sameWait ? current.revision : 0;
    const context = this.#setEarlyWait({ consumerId, generation, fileIndex, waitId, features, revision, current,
      waitElapsedMs });
    const changed = this.#recordEarlyWaitSnapshot(context, context.features);
    if (sameWait && changed) context.revision += 1;
    this.#pruneEarlyWaits();
    const totalSeconds = this.#host.firstFrameSecondsOf?.(context.features) ?? null;
    const seconds = earlyWaitRemainingSeconds(totalSeconds, waitElapsedSince(context, waitElapsedMs));
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return { version: 1, waitId, revision: context.revision, remainingSeconds: seconds, ageMs: 0 };
  }

  /**
   * Keep the measurements available before the container is inspected and
   * predict the complete first-frame wait from this host's earlier outcomes.
   *
   * @param {{ consumerId: string, generation: number, sourceKey: string, fileIndex: number | null, fileName?: string, fileLength?: number | null, stats?: object }} params
   * @returns {object | null}
   */
  waitEstimateForSource({ consumerId, generation, sourceKey, fileIndex, fileName = "", fileLength = null,
    stats = {}, linkMbps, linkSampleAgeMs, waitElapsedMs, processing = {} }) {
    if (!consumerId || !Number.isSafeInteger(generation) || typeof sourceKey !== "string") return null;
    const waitId = `${sourceKey}:${fileIndex ?? "all"}:${generation}`;
    const key = `${consumerId}:${waitId}`;
    const extension = typeof fileName === "string" ? fileName.split(".").at(-1)?.toLowerCase() ?? "" : "";
    const link = linkMeasurementOf(this.#host.viewers.get(consumerId), linkMbps, linkSampleAgeMs);
    const features = {
      extension,
      fileLength: Number.isFinite(stats?.fileLength) && stats.fileLength > 0
        ? stats.fileLength : fileLength,
      downloadSpeed: stats?.downloadSpeed,
      linkMbps: link.mbps,
      linkSampleAgeMs: link.ageMs,
      preparedOutputBytes: Number.isSafeInteger(fileIndex) && fileIndex >= 0
        ? this.#preparedOutputBytes(sourceKey, fileIndex) : null,
      fileAvailable: typeof stats?.fileAvailable === "boolean" ? stats.fileAvailable : null,
      headerRemaining: Number.isFinite(stats?.headerBytes) && Number.isFinite(stats?.headerDownloadedBytes)
        ? Math.max(0, stats.headerBytes - stats.headerDownloadedBytes) : null,
      peers: stats?.connectedPeers ?? stats?.numPeers,
      videoOperation: processing.videoOperation ?? null,
      audioOperation: processing.audioOperation ?? null,
      videoSpeedX: processing.videoSpeedX ?? null,
      audioSpeedX: processing.audioSpeedX ?? null
    };
    const current = this.#earlyWaits.get(key);
    const sameWait = current?.waitId === waitId;
    const revision = sameWait ? current.revision : 0;
    const context = this.#setEarlyWait({ consumerId, generation, fileIndex, waitId, features, revision, current,
      sourceObserved: true, waitElapsedMs });
    const changed = this.#recordEarlyWaitSnapshot(context, context.features);
    if (sameWait && changed) context.revision += 1;
    this.#pruneEarlyWaits();
    const totalSeconds = this.#host.firstFrameSecondsOf?.(context.features) ?? null;
    const seconds = earlyWaitRemainingSeconds(totalSeconds, waitElapsedSince(context, waitElapsedMs));
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return { version: 1, waitId, revision: context.revision, remainingSeconds: seconds, ageMs: 0 };
  }

  /**
   * Learn from the browser's presented-frame measurement for the current
   * viewing. The saved source and link readings are the ones available at
   * selection time, before the full track plan existed.
   *
   * @param {{ consumerId: string, generation: number, waitId: string, wait: number, elapsedMs: number }} params
   * @returns {void}
   */
  noteFirstFrameObservation({ consumerId, generation, waitId, wait, elapsedMs }) {
    const key = `${consumerId}:${waitId}`;
    const early = this.#earlyWaits.get(key);
    if (!early || early.generation !== generation || !Number.isSafeInteger(wait) || wait < 0 || early.observedWaits.has(wait) ||
        !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    for (const snapshot of early.snapshots) {
      this.#host.noteFirstFrame?.({ seconds: elapsedMs / 1000, features: snapshot });
    }
    early.observedWaits.add(wait);
    early.updatedAt = Date.now();
  }

  #setEarlyWait({ consumerId, generation, fileIndex, waitId, features, revision, current,
    sourceObserved = false, waitElapsedMs }) {
    const sameWait = current?.waitId === waitId;
    const context = sameWait ? current : {
      consumerId,
      generation,
      fileIndex,
      waitId,
      snapshots: [],
      hasSourceObservation: false,
      observedWaits: new Set()
    };
    const measuredAt = performance.now();
    const actionElapsedMs = Number.isFinite(waitElapsedMs) && waitElapsedMs >= 0 ? waitElapsedMs : null;
    const startedAt = actionElapsedMs === null
      ? Number.isFinite(context.startedAt) ? context.startedAt : measuredAt
      : measuredAt - actionElapsedMs;
    const ageElapsedMs = Number.isFinite(context.featuresMeasuredAt)
      ? Math.max(0, measuredAt - context.featuresMeasuredAt)
      : 0;
    const mergedFeatures = mergeWaitFeatures(context.features, features, ageElapsedMs);
    Object.assign(context, { consumerId, generation, fileIndex, waitId, features: mergedFeatures,
      featuresMeasuredAt: measuredAt, startedAt, updatedAt: Date.now(), revision,
      hasSourceObservation: context.hasSourceObservation || sourceObserved });
    this.#earlyWaits.set(`${consumerId}:${waitId}`, context);
    return context;
  }

  #recordEarlyWaitSnapshot(context, features) {
    const previous = context.snapshots.at(-1);
    if (previous && JSON.stringify(previous) === JSON.stringify(features)) return false;
    const snapshot = { ...features };
    if (context.snapshots.length < 2) context.snapshots.push(snapshot);
    else context.snapshots[1] = snapshot;
    return true;
  }

  #preparedOutputBytes(sourceKey, fileIndex) {
    const outputs = this.#host.outputs;
    const segmentStore = this.#host.segmentStore;
    if (!outputs?.values || !segmentStore?.sizesOf) return null;
    let bytes = 0;
    const seen = new Set();
    for (const output of outputs.values()) {
      if (output.file?.sourceKey !== sourceKey || output.file?.fileIndex !== fileIndex || !output.outputKey) continue;
      if (seen.has(output.outputKey)) continue;
      seen.add(output.outputKey);
      for (const size of segmentStore.sizesOf(output.outputKey).values()) {
        if (Number.isFinite(size) && size > 0) bytes += size;
      }
    }
    return bytes;
  }

  #pruneEarlyWaits() {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [key, value] of this.#earlyWaits) {
      if (value.updatedAt < cutoff) this.#earlyWaits.delete(key);
    }
    while (this.#earlyWaits.size > 1000) this.#earlyWaits.delete(this.#earlyWaits.keys().next().value);
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
    let known = consumerId ? this.#host.viewers.get(consumerId) : null;
    const requireViewing = () => {
      request.signal?.throwIfAborted();
      if (known && this.#host.viewers.get(consumerId) !== known) {
        throw new DOMException("The viewer left while the output was opening.", "AbortError");
      }
    };
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
          requireViewing();
          alreadyOn = this.#host.viewers.forOutput(candidate).has(consumerId);
          const answer = alreadyOn
            ? { admitted: true, reason: "already watching it", speedX: null }
            : this.#host.admitsWatching(candidate);
          if (answer.admitted) {
            known = this.#host.viewers.of(candidate, consumerId);
            this.placeViewer(candidate, known, startPositionSeconds);
          }
          return answer;
        }
      : null;
    const { output, existed, audio, verdict } = await this.#host.opening.open({
      ...request,
      viewerLinkMbps,
      claim
    });
    requireViewing();
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
    const viewer = this.#host.viewers.join(output, consumerId);
    if (viewer) this.placeViewer(output, viewer, positionSeconds);
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
    const viewer = this.#host.viewers.join(named, consumerId);
    if (!viewer) return false;
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
    // WHERE AN ANSWER'S TIME GOES, said with each answer. On Home Assistant a
    // held viewer's answer took 11.2 s while its forecast took 0.1-0.4 s and
    // the answer crossed the connection in 21 ms (r50, torrent-tv/meta#178).
    const parts = { enteredAt: performance.now(), statsMs: 0, workerForecastMs: 0, qualityMs: 0 };
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
    let primarySourceStats = null;
    const tracks = [];
    for (const output of outputs) {
      const trackProgress = output === session ? progress : this.#host.encodeRuns.progressOf(output);
      const trackRates = this.#trackRateReadings(output, now);
      const trackName = output === session ? "video" : "audio";
      // The page states the offset its player applied to this track, and the
      // init it applied it to is the session's. Until both are known, the
      // pieces stay on their own presentation timeline: there is nothing yet
      // to place them by.
      const playerOffset = viewerReading?.timestampOffsets?.[trackName];
      const servedInit = Number.isFinite(playerOffset) ? this.#host.segmentStore.initOf(output.outputKey) : null;
      const placedByPlayer = Boolean(servedInit?.length);
      const sessionInit = placedByPlayer ? servedInit : null;
      const inventory = this.#host.segmentStore.sizesOf(output.outputKey);
      const segments = this.#segmentsOf(output, sessionInit, inventory, Number.isFinite(viewerReading?.positionSeconds)
        ? viewerReading.positionSeconds : this.#host.viewerSecondsOn(session, consumerId, now));
      const sourceIndexes = [...output.spec.sourceFileIndexes];
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
        const statsAt = performance.now();
        try {
          stats = await this.#host.getSourceStats?.(output.file.sourceKey, fileIndex,
            { forecast: !sourceForecasts.has(output.file.sourceKey) }) ?? null;
        } catch {
          stats = null;
        }
        if (output === session && fileIndex === session.file.fileIndex) primarySourceStats = stats;
        parts.statsMs += performance.now() - statsAt;
        parts.workerForecastMs += Number(stats?.forecastMs) || 0;
        if (!sourceForecasts.has(output.file.sourceKey)) sourceForecasts.set(output.file.sourceKey, stats?.downloadForecast ?? { ranges: [] });
        const sharedForecast = sourceForecasts.get(output.file.sourceKey);
        const downloadForecast = sharedForecast.global ? { measuredAt: sharedForecast.measuredAt,
          ranges: !stats ? [] : sharedForecast.ranges.map(range => ({ ...range,
            start: Math.max(0, range.start - stats.fileOffset),
            end: Math.min(stats.fileLength, range.end - stats.fileOffset)
          })).filter(range => range.end > range.start) } : sharedForecast;
        sourceMeasurements.set(sourceId, {
          id: sourceId,
          serviceKey: output.file.sourceKey,
          complete: stats?.fileAvailable === true,
          residence: stats?.residence,
          fileOffset: stats?.fileOffset,
          fileLength: stats?.fileLength,
          pieceLength: stats?.pieceLength,
          downloadRateReadings: this.#sourceRateReadings(measurement, output.file.sourceKey, stats, now),
          downloadRateSummaries: this.#sourceRateSummaries(measurement, output.file.sourceKey),
          downloadForecast,
        });
      }

      const qualityAt = performance.now();
      const observedMbps = output === session
        ? outputMbps
        : await this.#host.quality.observedStreamMbps(output);
      parts.qualityMs += performance.now() - qualityAt;
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
        // What a run's start costs this output, and the stretches its live
        // runs were given: the forecast starts a run wherever production meets
        // bytes that were not held when the run before was admitted.
        openSeconds: this.#host.openSecondsOf?.(output) ?? null,
        runSpans: liveRuns.map(run => ({
          start: output.timeline?.publishedStartOf?.(run.from),
          end: Number.isInteger(run.to) && run.to >= run.from ? output.timeline?.publishedStartOf?.(run.to + 1) : Number.POSITIVE_INFINITY
        })),
        bitsPerMediaSecond: Number.isFinite(observedMbps) && observedMbps > 0 ? observedMbps * 1_000_000 :
          this.#host.initialOutputBitsPerMediaSecondOf?.(output) ?? 0,
        readings: trackRates,
        segments,
        geometry: this.#forecastPieces.get(output)?.geometry,
        readySegmentIndices: [...inventory.keys()],
        segmentSizesBytes: inventory
      });
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
    const startedAt = performance.now();
    const predicted = this.#host.playbackReadiness.predict(input);
    const predictMs = performance.now() - startedAt;
    this.#noteForecast(predictMs, tracks.map(track => track.geometry?.reason ?? "none"));
    logger.info(`readiness parts ${session.id} consumer=${consumerId}: source stats ${Math.round(parts.statsMs)}ms ` +
      `(the torrent thread's arrival forecast ${Math.round(parts.workerForecastMs)}ms), stream rate ${Math.round(parts.qualityMs)}ms, ` +
      `start forecast ${Math.round(predictMs)}ms, in all ${Math.round(performance.now() - parts.enteredAt)}ms`);
    const forecast = withSubtitleReadiness(predicted, subtitle,
      subtitle ? this.#host.subtitleReadyFor?.(viewer) !== false : true);
    forecast.operations = outputs.flatMap((output, index) => {
      const common = { speed: this.#host.playbackReadiness.forecastRate(tracks[index].readings, now, 0, "piece"),
        processedSeconds: tracks[index].processedSeconds };
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
    const generation = consumerId && viewer?.assignments
      ? this.#host.generationOfRequest(consumerId) : null;
    const earlyWaitId = Number.isSafeInteger(generation)
      ? `${session.file.sourceKey}:${session.file.fileIndex}:${generation}` : null;
    if (earlyWaitId && this.#earlyWaits.has(`${consumerId}:${earlyWaitId}`) && primarySourceStats) {
      const linkMeasuredAt = Number(viewerReading?.linkMeasuredAt);
      const videoOperation = forecast.operations.find(operation => operation.track === "video");
      const audioOperation = forecast.operations.find(operation => operation.track === "audio");
      const waitEstimate = this.waitEstimateForSource({ consumerId, generation,
        sourceKey: session.file.sourceKey, fileIndex: session.file.fileIndex,
        fileName: session.file.relativePath ?? session.file.name ?? "",
        fileLength: primarySourceStats.fileLength, stats: primarySourceStats,
        linkMbps: viewerReading?.linkMbps,
        linkSampleAgeMs: Number.isFinite(linkMeasuredAt) ? Math.max(0, Date.now() - linkMeasuredAt) : undefined,
        processing: {
          videoOperation: videoOperation?.operation,
          audioOperation: audioOperation?.operation,
          videoSpeedX: videoOperation?.speed,
          audioSpeedX: audioOperation?.speed
        } });
      if (waitEstimate) forecast.waitEstimate = waitEstimate;
    }
    if (measurement.forecastReason !== forecast.reason) {
      measurement.forecastReason = forecast.reason;
      logger.info(`playback readiness ${session.id} consumer=${consumerId} ${JSON.stringify({
        ...forecast,
        positionSeconds,
        durationSeconds: input.durationSeconds,
        bufferLimitSeconds: input.bufferLimitSeconds,
        lookaheadSeconds: input.lookaheadSeconds,
        link: input.linkReadings,
        sources: input.sources.map(({ id, complete, residence, downloadForecast, downloadRateReadings,
          downloadRateSummaries }) => ({
          id, complete, residenceRanges: residence?.length ?? 0,
          forecastAt: downloadForecast?.measuredAt ?? null, plannedPieces: downloadForecast?.ranges.length ?? 0,
          unknownPieces: downloadForecast?.ranges.filter(range => range.availableAt === null).length ?? 0,
          // The rate the forecast reads, and both summaries it was chosen from.
          downloadRateBytesPerSecond: this.#host.playbackReadiness.forecastRate(downloadRateReadings, now, 0, "time"),
          downloadRateSummaries
        })),
        tracks: tracks.map(({ id, processedSeconds, readings, segments, readySegmentIndices }) => ({
          id, processedSeconds, readings, segments: segments.length, prepared: readySegmentIndices.length
        }))
      })}`);
    }
    this.#sayHolding(session, consumerId, measurement, forecast, input, now);
    // The encoder this viewer waits for, told to whoever shares the processor
    // (torrent-tv/meta#180): the forecast knows it before the map's deadlines do.
    const holding = forecast.holdingBy;
    this.#host.noteViewerWaiting?.(consumerId || session.id,
      holding?.kind === "production" ? { address: holding.track, index: holding.segment } : null);
    return forecast;
  }

  /**
   * What holds a waiting viewer's start, said when it changes: which piece,
   * its production or its delivery, when it comes against the media before it,
   * and the rates the forecast used. Said again when the delay has moved by a
   * second, at most once a second; a hold that changes nothing says nothing.
   *
   * @param {object} session
   * @param {string} consumerId
   * @param {object} measurement - This viewer's forecast state.
   * @param {object} forecast
   * @param {object} input
   * @param {number} now
   */
  #sayHolding(session, consumerId, measurement, forecast, input, now) {
    const holding = forecast.holdingBy;
    if (!holding) {
      measurement.held = null;
      return;
    }
    const key = `${holding.kind}:${holding.track}:${holding.segment}`;
    const delay = Number.isFinite(forecast.delaySeconds) ? forecast.delaySeconds : null;
    const said = measurement.held;
    if (said && said.key === key && (delay === null || said.delay === null || Math.abs(delay - said.delay) < 1 ||
      now - said.at < 1000)) return;
    measurement.held = { key, delay, at: now };
    const seconds = value => Number.isFinite(value) ? value.toFixed(2) : "?";
    const rates = (forecast.operations ?? []).map(operation =>
      `${operation.track} ${operation.operation} ${Number.isFinite(operation.speed) ? operation.speed.toFixed(2) : "?"}x`);
    const downloads = (input.sources ?? []).map(source => {
      const rate = this.#host.playbackReadiness.forecastRate(source.downloadRateReadings, now, 0, "time");
      return `${Number.isFinite(rate) ? (rate / 1_048_576).toFixed(2) : "?"} MB/s`;
    });
    logger.info(`playback held ${session.id} consumer=${consumerId}: delay ${seconds(delay)}s by ` +
      (holding.kind === "position-not-held" ? "the position, which nothing buffered covers" :
        `the ${holding.kind} of ${holding.track} #${holding.segment} in ${seconds(holding.atSeconds)}s against ` +
        `${seconds(holding.aheadSeconds)}s of media before it${holding.requiresSource ? ", its input still downloading" : ""}` +
        (Number.isFinite(holding.sourceArrivalSeconds) ? ` until ${seconds(holding.sourceArrivalSeconds)}s by ` +
          (holding.sourcePlanned ? "the torrent's queues" : "the measured download rate") : "")) +
      `; buffered ${seconds(forecast.bufferedSeconds)}s; rates ${rates.join(", ") || "none"}; download ${downloads.join(", ") || "none"}`);
  }

  /**
   * The pieces of one output as the start forecast reads them, kept between
   * polls: a piece whose playlist edges, read ranges and torrent inputs have
   * not changed is the same object it was, so what the forecast derived from it
   * once — its exact edges, its joined ranges — is not derived again. An unread
   * piece that is not made and ends before the viewer is not listed: the
   * forecast reads nothing from it. Building the whole film anew on every poll
   * was part of what held the main thread for seconds (torrent-tv/meta#178).
   *
   * @param {object} output
   * @param {Buffer | null} sessionInit
   * @param {Map<number, number>} inventory - Made pieces and their sizes.
   * @param {number} positionSeconds
   * @returns {object[]}
   */
  #segmentsOf(output, sessionInit, inventory, positionSeconds) {
    const timeline = output.timeline;
    const count = timeline?.segmentCount ?? 0;
    let forecast = this.#forecastPieces.get(output);
    if (!forecast) {
      forecast = { pieces: [], geometry: {} };
      this.#forecastPieces.set(output, forecast);
    }
    const kept = forecast.pieces;
    const segments = [];
    for (let index = 0; index < count; index++) {
      const endSeconds = timeline.publishedStartOf(index + 1);
      // Only a made piece has media intervals to read. Asked of every piece,
      // each one not made cost a `stat` of its file in the store's safety net
      // for a missed directory event: 1327 per poll per output, 12.6 s of 300 s
      // of the main thread at a cold start on Home Assistant (r61,
      // torrent-tv/meta#178), while requests waited behind it.
      const ranges = inventory.has(index) ? this.#host.encodeRuns.finishedMediaRangesOf(output, index) : undefined;
      const mediaRanges = ranges && output.segmentFormat?.servedMediaRanges ?
        output.segmentFormat.servedMediaRanges(ranges, { initBytes: sessionInit }) : undefined;
      if (index !== 0 && mediaRanges === undefined && !inventory.has(index) &&
        Number.isFinite(endSeconds) && Number.isFinite(positionSeconds) && endSeconds <= positionSeconds) {
        continue;
      }
      const startSeconds = timeline.publishedStartOf(index);
      const sourceInputs = this.#host.sourceInputsFor?.(output, index) ?? undefined;
      const previous = kept[index];
      if (previous && previous.startSeconds === startSeconds && previous.endSeconds === endSeconds &&
        previous.mediaRanges === mediaRanges && sameInputs(previous.sourceInputs, sourceInputs)) {
        segments.push(previous);
        continue;
      }
      const segment = { index, startSeconds, endSeconds, sourceInputs, mediaRanges };
      kept[index] = segment;
      segments.push(segment);
    }
    if (kept.length > count) kept.length = count;
    return segments;
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
      state = { link: new this.#host.playbackReadiness.RateTrend(this.#host.lookaheadSeconds), sources: new Map() };
      byViewer.set(id, state);
    }
    return state;
  }

  /**
   * The encoder's rate for the forecast: the output's whole window of readings,
   * summarized again on each poll. A run that ended between two polls took its
   * readings with it when the forecast asked for the newest one alone; and two
   * runs of one output can report out of order, so a summary kept and added to
   * would drop the later-told, earlier-taken one (torrent-tv/meta#178).
   */
  #trackRateReadings(output, now) {
    const readings = (this.#host.encodeSpeedReadingsOf?.(output) ?? []).filter(reading => reading.at <= now);
    const summary = readings.length > 0 ? this.#host.playbackReadiness.rateSummaryOf(readings) : null;
    if (!summary) {
      // ONLY UNTIL A PIECE IS MEASURED does the prediction stand for the
      // encoder, and it is not kept among the readings. Added on every poll
      // between runs, it put the machine's share of that moment — 1 % at a
      // cold start — on the whole film, and the forecast read 0.03x
      // (torrent-tv/meta#178).
      const projected = Number(this.#host.predictedEncodeSpeedOf?.(output) ?? this.#host.projectedEncodeSpeedOf?.(output));
      if (Number.isFinite(projected) && projected > 0) {
        const seed = new this.#host.playbackReadiness.RateTrend();
        seed.add(now, projected);
        return seed.snapshot();
      }
    }
    return summary;
  }

  /**
   * What the swarm can give this source. A rate measured while our own
   * selection held a connection back measures our asking: on a cold Matroska
   * it read 0.4-1.3 MB/s while the same swarm later gave 12-14 MB/s, and the
   * forecast swung from 0.9 s to 19 075 s (torrent-tv/meta#178). So it is read
   * from the time no connection was held back (`SelectionLimit`), and a later
   * such reading lowers it as readily as it raises it. Until there is one, the
   * rate delivered stands, which is the least the swarm can give.
   */
  #sourceRateReadings(state, id, stats, now) {
    let source = state.sources.get(id);
    if (!source) {
      const { RateTrend } = this.#host.playbackReadiness;
      source = { delivered: new RateTrend(this.#host.lookaheadSeconds), free: new RateTrend(this.#host.lookaheadSeconds), limit: null };
      state.sources.set(id, source);
    }
    if (Number.isFinite(stats?.downloadSpeed) && stats.downloadSpeed >= 0) {
      source.delivered.add(now, stats.downloadSpeed);
    }
    const limit = stats?.selectionLimit;
    if (limit && source.limit && limit.freeMs > source.limit.freeMs) {
      source.free.add(now, Math.max(0, limit.freeBytes - source.limit.freeBytes) * 1000 / (limit.freeMs - source.limit.freeMs));
    }
    // Totals that went back belong to a torrent added again: read on from them.
    if (limit) source.limit = limit;
    return sourceService(source.free.snapshot(), source.delivered.snapshot(),
      (summary) => this.#host.playbackReadiness.forecastRate(summary, now, 0, "time"));
  }

  /** Both summaries a source's service was chosen from, for the forecast's log line. */
  #sourceRateSummaries(state, id) {
    const source = state.sources.get(id);
    return source ? { free: source.free.snapshot(), delivered: source.delivered.snapshot() } : null;
  }
}

/**
 * Keep a wait's measurements when a later response omits a field. Zero is a
 * measurement for rates, peers and byte counts; only null or an invalid value
 * means that this response did not measure the field.
 *
 * @param {object | null | undefined} previous
 * @param {object} incoming
 * @param {number} ageElapsedMs
 * @returns {object}
 */
function mergeWaitFeatures(previous, incoming, ageElapsedMs) {
  const merged = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value === null || value === undefined) {
      if (!Object.hasOwn(merged, key)) merged[key] = null;
      continue;
    }
    if (key === "extension") {
      if (typeof value === "string" && value.length > 0) merged[key] = value;
      continue;
    }
    if (key === "fileAvailable") {
      if (typeof value === "boolean") merged[key] = value;
      continue;
    }
    if (key === "videoOperation" || key === "audioOperation") {
      if (value === "copy" || value === "encode") merged[key] = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
        ((key === "fileLength" || key === "linkMbps") && value === 0)) continue;
    merged[key] = value;
  }
  const hasIncomingAge = Number.isFinite(incoming?.linkSampleAgeMs) && incoming.linkSampleAgeMs >= 0;
  if (Number.isFinite(merged.linkSampleAgeMs) && !hasIncomingAge) {
    merged.linkSampleAgeMs += Number.isFinite(ageElapsedMs) ? Math.max(0, ageElapsedMs) : 0;
  }
  return merged;
}

/**
 * Read the separately measured viewer-to-proxy link and retain the age of the
 * sample when an older page does not send it with its source request.
 *
 * @param {object | null | undefined} viewer
 * @param {number | null | undefined} reportedMbps
 * @param {number | null | undefined} reportedAgeMs
 * @returns {{ mbps: number | null, ageMs: number | null }}
 */
function linkMeasurementOf(viewer, reportedMbps, reportedAgeMs) {
  const reading = viewer?.linkReading?.() ?? null;
  const mbps = Number.isFinite(reportedMbps) && reportedMbps > 0
    ? reportedMbps
    : Number.isFinite(reading?.linkMbps) && reading.linkMbps > 0 ? reading.linkMbps : null;
  const ageMs = Number.isFinite(reportedAgeMs) && reportedAgeMs >= 0
    ? reportedAgeMs
    : Number.isFinite(reading?.linkMeasuredAt) ? Math.max(0, Date.now() - reading.linkMeasuredAt) : null;
  return { mbps, ageMs };
}

/**
 * Convert a learned full wait into the time still expected after this action.
 *
 * @param {number | null} totalSeconds
 * @param {number} elapsedMs
 * @returns {number | null}
 */
function earlyWaitRemainingSeconds(totalSeconds, elapsedMs) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0 || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  return Math.max(0, totalSeconds - elapsedMs / 1000);
}

/**
 * Prefer the browser's monotonic age of the original action; retain a proxy
 * monotonic clock fallback for older pages that do not send it.
 *
 * @param {object} context
 * @param {number | undefined} reportedElapsedMs
 * @returns {number}
 */
function waitElapsedSince(context, reportedElapsedMs) {
  if (Number.isFinite(reportedElapsedMs) && reportedElapsedMs >= 0) return reportedElapsedMs;
  return Number.isFinite(context.startedAt) ? Math.max(0, performance.now() - context.startedAt) : 0;
}

/**
 * The download service a source's forecast runs on: what the swarm carried
 * while our selection held none of its connections back, but never less than
 * what it carried in all. A stretch our selection held nothing back can be a
 * moment with nothing to ask, and its rate then measures our asking: after a
 * seek to 1000 s the forecast read 0 B/s from such a stretch while the torrent
 * downloaded 5-18 MB/s, answered "service not advancing", and held the viewer
 * (r54, torrent-tv/meta#178). What the swarm did carry, it can carry.
 *
 * The two are compared by the rate the forecast reads from them, bytes over
 * the span measured. Compared by their last readings, a summary whose last
 * reading was 10.7 MB/s and whose span read 0 B/s won over 3.4-16.7 MB/s
 * carried, and the forecast held the viewer with no delay to state (r74,
 * torrent-tv/meta#185).
 *
 * @param {object | null} free - A rate summary (`RateTrend.snapshot`).
 * @param {object | null} delivered
 * @param {(summary: object) => number | null} rateOf - The rate the forecast reads from a summary.
 * @returns {object | null}
 */
export function sourceService(free, delivered, rateOf) {
  if (!free) return delivered;
  if (!delivered) return free;
  return (rateOf(delivered) ?? 0) > (rateOf(free) ?? 0) ? delivered : free;
}
