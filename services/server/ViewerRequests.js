/**
 * What a viewer asks of this proxy, one request at a time.
 *
 * Open an output of a file — the one that already exists when its parameters
 * agree — and be placed on it; state a new position; ask how far the material
 * in front of them has got. Each request states a fact about the viewer and
 * returns; where encoders go follows from those facts and is the plan's.
 */

import { megabytesPerSecond } from "../../utils/units.js";
import { logger } from "../../utils/logger.js";
import { isOutputName, OutputSpec } from "../encode/output/index.js";
import { withSubtitleReadiness } from "./subtitle-readiness.js";

/** @param {{ spec: { sourceFileIndexes: number[] }, file: { fileIndex: number } }} output */
export function sourceFileIndexesForOutput(output) {
  return output.spec.sourceFileIndexes.length > 0
    ? [...output.spec.sourceFileIndexes]
    : [output.file.fileIndex];
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
function browserServiceSummary(value) {
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(["init", "media"].filter(kind => value[kind]).map(kind => [kind, value[kind]]).map(([kind, service]) => [kind, {
    bytes: service.bytes,
    elapsedMs: service.elapsedMs,
    operations: service.operations,
    sampleCount: service.samples.length,
    newestSampleAgeMs: service.samples.reduce((age, sample) => age === null ? sample.ageMs : Math.min(age, sample.ageMs), null),
    samples: service.samples.map(({ bytes, elapsedMs, ageMs, fragmentId, fragmentSequence, partIndex, fragmentStartSeconds,
      parseElapsedMs, bufferingElapsedMs, bufferingAgeMs, eventAgesMs }) => ({ bytes, elapsedMs, ageMs, fragmentId,
      fragmentSequence, partIndex, fragmentStartSeconds,
      ...(parseElapsedMs === null || parseElapsedMs === undefined ? {} : { parseElapsedMs }),
      ...(bufferingElapsedMs === null || bufferingElapsedMs === undefined ? {} : { bufferingElapsedMs }),
      ...(bufferingAgeMs === null || bufferingAgeMs === undefined ? {} : { bufferingAgeMs }),
      ...(eventAgesMs ? { eventAgesMs } : {}) }))
  }]));
}

function browserServiceFingerprint(tracks) {
  const serviceFingerprint = service => service ? ["init", "media"].map(kind => {
    const value = service[kind];
    return value ? [kind, value.bytes, value.elapsedMs, value.operations, value.samples.map(sample => [
      sample.bytes, sample.elapsedMs, sample.fragmentId, sample.fragmentSequence, sample.partIndex,
      sample.fragmentStartSeconds, sample.parseElapsedMs, sample.bufferingElapsedMs
    ])] : [kind, null];
  }) : null;
  return JSON.stringify(tracks.map(track => [track.id,
    serviceFingerprint(track.appendService), serviceFingerprint(track.fragmentService)]));
}

export function forecastInputState(tracks, identity) {
  if (!identity) return null;
  const track = tracks.find(candidate => candidate.id === identity.trackId);
  const segment = track?.segments.find(candidate => candidate.index === identity.segmentIndex);
  const sourceInput = segment?.sourceInputs?.find(candidate => candidate.sourceId === identity.sourceId);
  return {
    sourceId: identity.sourceId,
    trackId: identity.trackId,
    segmentIndex: identity.segmentIndex,
    phase: identity.phase,
    trackFound: Boolean(track),
    segmentFound: Boolean(segment),
    sourceInputFound: Boolean(sourceInput),
    rangesKnown: Array.isArray(sourceInput?.ranges),
    rangeCount: Array.isArray(sourceInput?.ranges) ? sourceInput.ranges.length : null
  };
}

function forecastInputIdentity(state) {
  return state && JSON.stringify([state.sourceId, state.trackId, state.segmentIndex, state.phase]);
}

function unknownCapture(owner, actionId, generation, reason) {
  return { owner, clock: "performance", clockEpoch: null, startedAt: null, completedAt: null,
    actionId: actionId ?? null, generation: Number.isSafeInteger(generation) ? generation : null,
    revision: null, validity: "unknown", unknownReason: reason };
}

function sourceCaptureOf(stats, actionId, generation) {
  const source = stats?.sourceCapture;
  if (!source || source.owner !== "torrent-worker" || source.clock !== "performance" ||
      source.validity !== "valid" || !Number.isFinite(source.clockEpoch) ||
      source.clockEpoch !== performance.timeOrigin ||
      !Number.isFinite(source.startedAt) || !Number.isFinite(source.completedAt) ||
      source.completedAt < source.startedAt || !Number.isSafeInteger(source.revision)) {
    return { ...unknownCapture("torrent-worker", actionId, generation,
      source?.unknownReason ?? "source-capture-unavailable"),
      ...(Number.isFinite(source?.clockEpoch) ? { clockEpoch: source.clockEpoch } : {}),
      ...(Number.isSafeInteger(source?.revision) ? { revision: source.revision } : {}) };
  }
  return { ...source, actionId: actionId ?? null, generation: Number.isSafeInteger(generation) ? generation : null };
}

export function encoderCaptureOf(sampleCaptures, liveRuns, actionId, generation) {
  const runCaptures = (liveRuns ?? []).map(run => ({ owner: "proxy-encoder", clock: "performance",
    clockEpoch: run.progress?.clockEpoch, startedAt: run.progress?.updatedAtMonotonic,
    completedAt: run.progress?.updatedAtMonotonic, revision: run.progress?.updatedAtMonotonic,
    validity: Number.isFinite(run.progress?.clockEpoch) && Number.isFinite(run.progress?.updatedAtMonotonic)
      ? "valid" : "unknown", unknownReason: Number.isFinite(run.progress?.clockEpoch) &&
        Number.isFinite(run.progress?.updatedAtMonotonic) ? null : "encoder-progress-capture-unavailable" }));
  const captures = [...(Array.isArray(sampleCaptures) ? sampleCaptures : []), ...runCaptures];
  const epoch = captures[0]?.clockEpoch;
  const samplesOrdered = (Array.isArray(sampleCaptures) ? sampleCaptures : []).every((capture, index, samples) =>
    index === 0 || capture.revision >= samples[index - 1].revision);
  const valid = captures.length > 0 && samplesOrdered && epoch === performance.timeOrigin && captures.every(capture =>
    capture.owner === "proxy-encoder" && capture.clock === "performance" && capture.validity === "valid" &&
    Number.isFinite(capture.clockEpoch) && capture.clockEpoch === epoch && Number.isFinite(capture.startedAt) &&
    Number.isFinite(capture.completedAt) && capture.completedAt >= capture.startedAt &&
    Number.isFinite(capture.revision));
  if (!valid) {
    const projected = captures.find(capture => capture.provenance === "projected");
    return { ...unknownCapture("proxy-encoder", actionId, generation,
      projected?.unknownReason ?? "encoder-capture-unavailable"),
    samples: captures, ...(projected ? { provenance: projected.provenance, projectionSource: projected.source } : {}) };
  }
  return { owner: "proxy-encoder", clock: "performance", clockEpoch: epoch,
    startedAt: Math.min(...captures.map(capture => capture.startedAt)),
    completedAt: Math.max(...captures.map(capture => capture.completedAt)), actionId: actionId ?? null,
    generation: Number.isSafeInteger(generation) ? generation : null, provenance: "measured",
    revision: captures.at(-1).revision ?? null, samples: captures, validity: "valid", unknownReason: null };
}

export function trackRateReadings(readings, { predicted, projected }, now, playbackReadiness) {
  const measured = (readings ?? []).filter(reading => reading.at <= now);
  const summary = measured.length > 0 ? playbackReadiness.rateSummaryOf(measured) : null;
  if (summary) return { summary, captures: measured.map(reading => ({ owner: reading.captureOwner,
    clock: reading.captureClock, clockEpoch: reading.captureClockEpoch,
    startedAt: reading.captureStartedAtMonotonic, completedAt: reading.captureCompletedAtMonotonic,
    revision: reading.at,
    validity: reading.captureOwner === "proxy-encoder" && reading.captureClock === "performance" &&
      Number.isFinite(reading.captureClockEpoch) && Number.isFinite(reading.captureStartedAtMonotonic) &&
      Number.isFinite(reading.captureCompletedAtMonotonic) && Number.isFinite(reading.at) &&
      reading.captureCompletedAtMonotonic >= reading.captureStartedAtMonotonic
      ? "valid" : "unknown",
    unknownReason: reading.captureOwner === "proxy-encoder" && reading.captureClock === "performance" &&
      Number.isFinite(reading.captureClockEpoch) && Number.isFinite(reading.captureStartedAtMonotonic) &&
      Number.isFinite(reading.captureCompletedAtMonotonic) && Number.isFinite(reading.at) &&
      reading.captureCompletedAtMonotonic >= reading.captureStartedAtMonotonic
      ? null : "encoder-sample-capture-unavailable" })) };
  const rate = Number(predicted ?? projected);
  if (Number.isFinite(rate) && rate > 0) {
    const seed = new playbackReadiness.RateTrend();
    seed.add(now, rate);
    const source = predicted === null || predicted === undefined
      ? "current-cost-projection" : "stored-encode-prediction";
    return { summary: seed.snapshot(), captures: [{ owner: "proxy-encoder", clock: "performance",
      clockEpoch: null, startedAt: null, completedAt: null, revision: null, provenance: "projected", source,
      validity: "unknown", unknownReason: "projected-encoder-speed-has-no-capture" }] };
  }
  return null;
}

function observeForecastInput(observeWait, sourceKey, state, event) {
  if (!state) return;
  observeWait?.(sourceKey, "process", {
    process: "P4.2", phase: event, at: performance.now(),
    sourceId: state.sourceId, outputKey: state.trackId, segment: state.segmentIndex,
    forecastPhase: state.phase, rangesKnown: state.rangesKnown, rangeCount: state.rangeCount
  });
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
  /**
   * @param {object} host - `opening`, `activeOutputFor`, `viewerSecondsOn`, `minimumBufferSecondsFor`, `getSourceStats`, `planEncodersSoon`, `encodeRuns`, `encodeSpeedReadingsOf`, `outputs`, `lookaheadSeconds`, `quality`, `qualityOffer`, `renditions`, `segmentDurationSec`, `segmentStore`, `sourceFiles`, `startupWaitMs`, `viewers`, `placeViewerOn`, `chooseAudioTrack`, `acceptsGeneration`, `generationOfRequest`, `noteGivenOutput`, `holdForResponse`, `noteServingVerdict`, `servingVerdictOf`
   */
  constructor(host) {
    this.#host = host;
  }

  viewerDeparted(viewer) {
    if (viewer) this.#host.viewerPlaybackState.forgetViewer(viewer);
  }

  viewerTokenOf(consumerId) {
    return consumerId ? this.#host.viewers.get(consumerId) : null;
  }

  outputViewerDeparted(viewer, output) {
    if (!viewer || !output) return;
    if (this.#host.viewers.get(viewer.id) === viewer) {
      this.#host.viewerPlaybackState.forgetViewerOutput(viewer, output);
    } else {
      this.#host.viewerPlaybackState.forgetViewer(viewer);
    }
  }

  outputDisposed(output) {
    this.#host.viewerPlaybackState.forgetOutput(output);
    this.#host.outputForecastGeometry.forget(output);
  }

  /** Record the facts known while listing a source, without producing an ETA. */
  noteWaitFileSnapshot({ consumerId, generation, sourceKey, fileIndex, fileName, fileLength, linkMbps, linkSampleAgeMs,
    viewerToken }) {
    if (!consumerId || !Number.isSafeInteger(generation) || typeof sourceKey !== "string" ||
        !Number.isSafeInteger(fileIndex) || fileIndex < 0) return;
    const waitId = `${sourceKey}:${fileIndex}:${generation}`;
    const viewer = this.#currentViewerToken(consumerId, viewerToken);
    if (!viewer) return;
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
    this.#host.viewerPlaybackState.recordWaitSnapshot({ viewer, consumerId, generation, sourceKey, fileIndex, waitId, features });
    this.#host.viewerPlaybackState.pruneWaits();
  }

  /**
   * Record current source and link facts for later forecast evaluation. These
   * partial inputs do not determine the first presented frame, so this method
   * does not produce a wait estimate.
   *
   * @param {{ consumerId: string, generation: number, sourceKey: string, fileIndex: number | null, fileName?: string, fileLength?: number | null, stats?: object }} params
   * @returns {object | null}
   */
  noteWaitSourceSnapshot({ consumerId, generation, sourceKey, fileIndex, fileName = "", fileLength = null,
    stats = {}, linkMbps, linkSampleAgeMs, processing = {}, viewerToken }) {
    if (!consumerId || !Number.isSafeInteger(generation) || typeof sourceKey !== "string") return;
    const waitId = `${sourceKey}:${fileIndex ?? "all"}:${generation}`;
    const viewer = this.#currentViewerToken(consumerId, viewerToken);
    if (!viewer) return;
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
    this.#host.viewerPlaybackState.recordWaitSnapshot({ viewer, consumerId, generation, sourceKey, fileIndex, waitId, features });
    this.#host.viewerPlaybackState.pruneWaits();
  }

  /**
   * Learn from the browser's presented-frame measurement for the current
   * viewing. The saved source and link readings are the ones available at
   * selection time, before the full track plan existed.
   *
   * @param {{ consumerId: string, generation: number, waitId: string, wait: number, elapsedMs: number,
   *   stages?: { totalMs: number, transportMs: number, planMs: number, prepareMs: number,
   *     prebufferMs: number, presentationMs: number } | null }} params
   * @returns {void}
   */
  noteFirstFrameObservation({ consumerId, generation, waitId, wait, elapsedMs, stages = null }) {
    const viewer = this.#host.viewers.get(consumerId);
    if (!viewer) return;
    this.#host.viewerPlaybackState.noteFirstFrame({ viewer, generation, waitId, wait, elapsedMs, stages,
      record: observation => this.#host.noteFirstFrame?.({ ...observation, stages }) });
  }

  #currentViewerToken(consumerId, viewerToken) {
    return viewerToken && this.#host.viewers.get(consumerId) === viewerToken ? viewerToken : null;
  }

  #preparedOutputBytes(sourceKey, fileIndex) {
    const outputs = this.#host.outputs;
    const segmentStore = this.#host.segmentStore;
    if (!outputs?.values || !segmentStore?.sizesOf) return null;
    let bytes = 0;
    const seen = new Set();
    const liveOutputs = [...outputs.values()];
    const keys = new Set([
      ...liveOutputs.map(output => output.outputKey),
      ...(segmentStore.addresses?.() ?? [])
    ].filter(key => typeof key === "string" && key.length > 0));
    for (const outputKey of keys) {
      const output = liveOutputs.find(candidate => candidate.outputKey === outputKey);
      const spec = output ? null : OutputSpec.fromKey(outputKey);
      const matchesFile = output
        ? output.file?.sourceKey === sourceKey && output.file?.fileIndex === fileIndex
        : spec?.sourceKey === sourceKey &&
          (spec.video?.fileIndex === fileIndex || spec.audio?.fileIndex === fileIndex);
      if (!matchesFile || seen.has(outputKey)) continue;
      seen.add(outputKey);
      for (const size of segmentStore.sizesOf(outputKey).values()) {
        if (Number.isFinite(size) && size > 0) bytes += size;
      }
    }
    return bytes;
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
    let placedHere = false;
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
            placedHere = this.placeViewerOn(candidate, consumerId, startPositionSeconds) === true;
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
      this.#host.chooseAudioTrack(output, consumerId, audio);
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
          ...(placedHere ? { positionSeconds: startPositionSeconds } : {}),
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
    // Return the allocated session before a keyframe-based output writes its
    // first playlist. The browser can then poll this session's live playback
    // forecast while the source, proxy and client-link work is still underway;
    // otherwise this request hides all revised estimates until the first
    // segment is already ready. The playlist route and the viewer's existing
    // wait loop handle output that is still being prepared, and the progress
    // route reports a terminal encoder failure.
    return output;
  }

  /**
   * Ask the viewer layer to place this viewer at their initial position.
   *
   * Encoding asks for this when a request for any file of an output is the
   * first sign of the person behind it. The operation takes the viewer's name
   * and position; the viewer layer owns the record and its idempotency rule.
   *
   * @param {object} output
   * @param {string} consumerId
   * @param {number} positionSeconds
   * @returns {boolean} Whether the viewer layer placed the viewer.
   */
  placeViewerOn(output, consumerId, positionSeconds) {
    if (!output || !consumerId) {
      return false;
    }
    const placed = this.#host.placeViewerOn(output, consumerId, positionSeconds) === true;
    if (placed) this.#host.planEncodersSoon();
    return placed;
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
    this.#beginSeekWait(named, consumerId, generation);
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

  #beginSeekWait(output, consumerId, generation) {
    const file = output?.file;
    if (!Number.isSafeInteger(generation) || !file || typeof file.sourceKey !== "string" ||
        !Number.isSafeInteger(file.fileIndex) || file.fileIndex < 0) return;
    const waitId = `${file.sourceKey}:${file.fileIndex}:${generation}`;
    const fileName = file.relativePath ?? file.name ?? "";
    const extension = typeof fileName === "string" ? fileName.split(".").at(-1)?.toLowerCase() ?? "" : "";
    const viewer = this.#host.viewers.get(consumerId);
    if (!viewer) return;
    const link = linkMeasurementOf(viewer);
    const features = {
      extension,
      fileLength: Number.isFinite(file.length) && file.length > 0 ? file.length : null,
      downloadSpeed: null,
      linkMbps: link.mbps,
      linkSampleAgeMs: link.ageMs,
      preparedOutputBytes: this.#preparedOutputBytes(file.sourceKey, file.fileIndex),
      fileAvailable: null,
      headerRemaining: null,
      peers: null,
      videoOperation: null,
      audioOperation: null,
      videoSpeedX: null,
      audioSpeedX: null
    };
    // A seek is a new observation group even when a caller repeats the same
    // generation; its source facts must not join observations from the prior wait.
    this.#host.viewerPlaybackState.deleteWait(viewer, waitId);
    this.#host.viewerPlaybackState.recordWaitSnapshot({ viewer, consumerId, generation, sourceKey: file.sourceKey,
      fileIndex: file.fileIndex, waitId, features });
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

  async getSessionProgress(sessionId, consumerId = "", statedGeneration = Number.NaN) {
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
    const viewer = consumerId ? this.#host.viewers.get(consumerId) : null;
    const requestGeneration = consumerId && viewer?.assignments
      ? this.#host.generationOfRequest(consumerId) : null;
    const requestGenerationIsStated = Number.isSafeInteger(statedGeneration);
    if (requestGenerationIsStated && requestGeneration !== statedGeneration) return { superseded: true };
    const requestGenerationIsCurrent = () => !Number.isSafeInteger(requestGeneration) ||
      this.#host.generationOfRequest(consumerId) === requestGeneration;
    const stillOwnsProgress = () => this.#stillOwnsProgress(named, session, consumerId, viewer);
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
    if (!requestGenerationIsCurrent()) return requestGenerationIsStated ? { superseded: true } : null;
    if (!stillOwnsProgress()) return null;
    const progress = this.#host.encodeRuns.progressOf(session);
    const playbackReadiness = await this.#playbackReadinessFor(session, consumerId, progress, outputMbps,
      viewer, stillOwnsProgress);
    if (!requestGenerationIsCurrent()) return requestGenerationIsStated ? { superseded: true } : null;
    if (!stillOwnsProgress()) return null;
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

  #stillOwnsProgress(named, session, consumerId, viewer) {
    if (this.#host.outputs.get(named.id) !== named || this.#host.outputs.get(session.id) !== session) return false;
    if (!viewer) return !consumerId || !this.#host.viewers.get(consumerId);
    return this.#host.viewers.get(consumerId) === viewer &&
      (!(viewer.outputs instanceof Set) || viewer.outputs.has(named.id)) &&
      this.#host.activeOutputFor({ base: named, consumerId, outputs: this.#host.outputs }) === session;
  }

  async #playbackReadinessFor(session, consumerId, progress, outputMbps, viewer, stillOwnsProgress) {
    if (!stillOwnsProgress()) return null;
    const waitStartedAt = performance.now();
    const waitFields = { process: "P14", sessionId: session.id, consumerId };
    this.#host.observeWait?.(session.file.sourceKey, "process", { ...waitFields, phase: "begin", at: waitStartedAt });
    let waitOutcome = "error";
    try {
    const now = Date.now();
    // WHERE AN ANSWER'S TIME GOES, said with each answer. On Home Assistant a
    // held viewer's answer took 11.2 s while its forecast took 0.1-0.4 s and
    // the answer crossed the connection in 21 ms (r50, torrent-tv/meta#178).
    const parts = { enteredAt: performance.now(), statsMs: 0, workerForecastMs: 0, qualityMs: 0 };
    const viewerReading = viewer?.linkReading() ?? null;
    const generation = consumerId && viewer?.assignments
      ? this.#host.generationOfRequest(consumerId) : null;
    const actionIsCurrent = () => !Number.isSafeInteger(generation) ||
      this.#host.generationOfRequest(consumerId) === generation;
    const actionId = Number.isSafeInteger(generation)
      ? `${session.file.sourceKey}:${session.file.fileIndex}:${generation}` : null;
    const measurement = viewer
      ? this.#host.viewerPlaybackState.rateState(viewer, session, this.#host.playbackReadiness, this.#host.lookaheadSeconds)
      : { link: new this.#host.playbackReadiness.RateTrend(this.#host.lookaheadSeconds), sources: new Map() };
    const existingLinkCaptures = measurement.link.captureSnapshot();
    if (viewer && (viewerReading?.linkCapture?.validity !== "valid" || existingLinkCaptures.some(capture =>
      !capture || capture.clockEpoch !== viewerReading.linkCapture.clockEpoch))) {
      this.#host.viewerPlaybackState.forgetLinkReadings(measurement, this.#host.playbackReadiness,
        this.#host.lookaheadSeconds);
    }
    const linkAt = Number(viewerReading?.linkSampleMeasuredAt);
    if (viewerReading?.linkCapture?.validity === "valid" && Number.isFinite(viewerReading?.linkSampleMbps) &&
        viewerReading.linkSampleMbps > 0 && Number.isFinite(linkAt)) {
      this.#host.viewerPlaybackState.addLinkReading(measurement, linkAt, viewerReading.linkSampleMbps,
        viewerReading.linkCapture);
    }
    const rawBufferCapture = viewerReading?.bufferCapture ?? unknownCapture("browser", actionId, generation,
      "browser-buffer-capture-unavailable");
    const bufferCaptureValid = rawBufferCapture.validity === "valid" && rawBufferCapture.actionId === session.id &&
      rawBufferCapture.generation === generation;

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
      if (!stillOwnsProgress() || !actionIsCurrent() || this.#host.outputs.get(output.id) !== output) return null;
      const trackProgress = output === session ? progress : this.#host.encodeRuns.progressOf(output);
      const trackRate = this.#trackRateReadings(output, now);
      const trackRates = trackRate?.summary ?? null;
      const trackName = output === session ? "video" : "audio";
      // The page states the offset its player applied to this track, and the
      // init it applied it to is the session's. Until both are known, the
      // pieces stay on their own presentation timeline: there is nothing yet
      // to place them by.
      const playerOffset = bufferCaptureValid ? viewerReading?.timestampOffsets?.[trackName] : null;
      const reportedPosition = bufferCaptureValid && Number.isFinite(viewerReading?.positionSeconds)
        ? viewerReading.positionSeconds : null;
      const servedInit = Number.isFinite(playerOffset) ? this.#host.segmentStore.initOf(output.outputKey) : null;
      const placedByPlayer = Boolean(servedInit?.length);
      const sessionInit = placedByPlayer ? servedInit : null;
      const inventory = this.#host.segmentStore.sizesOf(output.outputKey);
      const segments = this.#host.outputForecastGeometry.segmentsOf(output, sessionInit, inventory,
        Number.isFinite(reportedPosition) ? reportedPosition : this.#host.viewerSecondsOn(session, consumerId, now));
      const forecastGeometry = this.#host.outputForecastGeometry.get(output);
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
        if (!stillOwnsProgress() || !actionIsCurrent() || this.#host.outputs.get(output.id) !== output) return null;
        if (output === session && fileIndex === session.file.fileIndex) primarySourceStats = stats;
        parts.statsMs += performance.now() - statsAt;
        parts.workerForecastMs += Number(stats?.forecastMs) || 0;
        const sourceCapture = sourceCaptureOf(stats, actionId, generation);
        if (!sourceForecasts.has(output.file.sourceKey)) sourceForecasts.set(output.file.sourceKey, stats?.downloadForecast ?? { ranges: [] });
        const sharedForecast = sourceForecasts.get(output.file.sourceKey);
        const capturedForecast = sourceCaptureOf({ sourceCapture: sharedForecast?.capture }, actionId, generation);
        const forecastCapture = sharedForecast?.global === true && !Array.isArray(sharedForecast.ranges)
          ? { ...capturedForecast, validity: "unknown", unknownReason: "source-arrival-ranges-unavailable" }
          : capturedForecast;
        const downloadForecast = sourceCapture.validity !== "valid" || forecastCapture.validity !== "valid"
          ? { ranges: [] } : sharedForecast.global ? { measuredAt: sharedForecast.measuredAt,
          ranges: !stats ? [] : sharedForecast.ranges.map(range => ({ ...range,
            start: Math.max(0, range.start - stats.fileOffset),
            end: Math.min(stats.fileLength, range.end - stats.fileOffset)
          })).filter(range => range.end > range.start) } : sharedForecast;
        const sourceFactsValid = sourceCapture.validity === "valid";
        const ownsSourceState = viewer && this.#host.viewerPlaybackState.owns(viewer, session, measurement);
        const sourceReadingsValid = sourceFactsValid && Number.isFinite(stats?.downloadSpeed) && stats.downloadSpeed >= 0;
        const existingSourceCaptures = ownsSourceState
          ? this.#host.viewerPlaybackState.sourceCaptureSnapshot(measurement, output.file.sourceKey) : null;
        const sourceEpochChanged = sourceReadingsValid && existingSourceCaptures &&
          [existingSourceCaptures.recent?.delivered, existingSourceCaptures.recent?.free,
            existingSourceCaptures.tail?.delivered, existingSourceCaptures.tail?.free].some(capture =>
            capture?.validity === "valid" && capture.clockEpoch !== sourceCapture.clockEpoch);
        if (ownsSourceState && (!sourceReadingsValid || sourceEpochChanged)) {
          this.#host.viewerPlaybackState.forgetSourceReadings(measurement, output.file.sourceKey);
        }
        const downloadRateReadings = ownsSourceState && sourceReadingsValid
          ? this.#host.viewerPlaybackState.sourceRateReadings(measurement, output.file.sourceKey, stats, now,
            this.#host.playbackReadiness, this.#host.lookaheadSeconds, sourceCapture) : null;
        const tailRateReadings = ownsSourceState && sourceReadingsValid
          ? this.#host.viewerPlaybackState.sourceTailRateReadings(measurement, output.file.sourceKey, now,
            this.#host.playbackReadiness) : null;
        const downloadRateSummaries = ownsSourceState && sourceReadingsValid
          ? this.#host.viewerPlaybackState.sourceRateSummaries(measurement, output.file.sourceKey) : null;
        const rateCapture = ownsSourceState && sourceReadingsValid
          ? this.#host.viewerPlaybackState.sourceCaptureSnapshot(measurement, output.file.sourceKey) : null;
        sourceMeasurements.set(sourceId, {
          id: sourceId,
          serviceKey: output.file.sourceKey,
          complete: sourceFactsValid ? stats?.fileAvailable === true : null,
          residence: sourceFactsValid ? stats?.residence : null,
          fileOffset: sourceFactsValid ? stats?.fileOffset : null,
          fileLength: sourceFactsValid ? stats?.fileLength : null,
          bytesPerMediaSecond: sourceFactsValid && Number.isFinite(stats?.fileLength) && stats.fileLength > 0 &&
            Number.isFinite(session.file.durationSeconds) && session.file.durationSeconds > 0
            ? stats.fileLength / session.file.durationSeconds : null,
          pieceLength: sourceFactsValid ? stats?.pieceLength : null,
          downloadRateReadings,
          tailRateReadings,
          downloadRateSummaries,
          capture: { ...sourceCapture, rateReadings: rateCapture ?? {
            validity: "unknown", unknownReason: "source-rate-capture-unavailable" },
          downloadForecast: forecastCapture },
          downloadForecast,
        });
      }

      const qualityAt = performance.now();
      const observedMbps = output === session
        ? outputMbps
        : await this.#host.quality.observedStreamMbps(output);
      if (!stillOwnsProgress() || !actionIsCurrent() || this.#host.outputs.get(output.id) !== output) return null;
      parts.qualityMs += performance.now() - qualityAt;
      const liveRuns = this.#host.encodeRuns.liveRunsOf?.(output) ?? [];
      const encoderCapture = encoderCaptureOf(trackRate?.captures, liveRuns, actionId, generation);
      const encoderCaptureValid = encoderCapture.validity === "valid";
      const projectedRateCanSeedForecast = trackRate?.captures?.length > 0 &&
        trackRate.captures.every(capture => capture.provenance === "projected");
      const processingStarted = liveRuns.some(({ progress }) => progress.processedSeconds > progress.startPositionSeconds);
      const startedAt = liveRuns.find(({ startedAt }) => startedAt > 0)?.startedAt ?? now;
      tracks.push({
        id: output.outputKey,
        clockOffsetSeconds: placedByPlayer ? playerOffset : 0,
        clientRanges: bufferCaptureValid ? viewerReading?.bufferedRanges?.[output === session ? "video" : "audio"] ??
          viewerReading?.bufferedRanges?.media : null,
        // Browser-observed append and fragment-parse samples are retained for
        // the full model's service schedule; they are not yet used as numeric
        // predecessors in the partial continuity calculation.
        appendService: bufferCaptureValid && viewerReading?.appendSessionId === session.id && viewerReading?.appendService?.[trackName]
          ? { ...viewerReading.appendService[trackName], epoch: viewerReading.appendEpoch,
            epochStartedAt: viewerReading.appendEpochStartedAt, snapshotAt: viewerReading.appendSnapshotAt,
            receivedAt: viewerReading.appendServiceReceivedAt }
          : null,
        fragmentService: bufferCaptureValid && viewerReading?.appendSessionId === session.id && viewerReading?.fragmentService?.[trackName]
          ? { ...viewerReading.fragmentService[trackName], epoch: viewerReading.appendEpoch,
            epochStartedAt: viewerReading.appendEpochStartedAt, snapshotAt: viewerReading.appendSnapshotAt,
            receivedAt: viewerReading.appendServiceReceivedAt }
          : null,
        sourceIds,
        processedSeconds: encoderCaptureValid ? trackProgress?.processedSeconds : null,
        startupRemainingSeconds: !encoderCaptureValid ? null : processingStarted ? 0 : Math.max(0,
          (this.#host.processingStartupSecondsOf?.(output) ?? 0) - Math.max(0, (now - startedAt) / 1000)),
        processingRanges: encoderCaptureValid ? liveRuns.map(({ progress }) => ({
          start: progress.startPositionSeconds, end: progress.processedSeconds
        })) : [],
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
        durationSeconds: output.timeline?.publishedStartOf(output.timeline.segmentCount) ?? session.file.durationSeconds,
        segmentCount: output.timeline?.segmentCount ?? segments.length,
        // A projection is explicitly not a measured capture, but remains the
        // numeric seed it was before capture provenance was carried here.
        // Other invalid measured captures stay out of the forecast.
        readings: encoderCaptureValid || projectedRateCanSeedForecast ? trackRates : [],
        capture: encoderCapture,
        segments,
        tailSegments: forecastGeometry?.tailSegments ?? [],
        geometry: forecastGeometry?.geometry,
        readySegmentIndices: [...inventory.keys()],
        segmentSizesBytes: inventory
      });
    }

    if (!stillOwnsProgress() || !actionIsCurrent()) return null;

    const bufferedAheadSeconds = bufferCaptureValid ? Number(viewerReading?.bufferedAheadSec) : null;
    const positionSeconds = bufferCaptureValid && Number.isFinite(viewerReading?.positionSeconds)
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
      bufferLimitSeconds: bufferCaptureValid ? viewerReading?.bufferLimitSeconds : null,
      reserveSeconds,
      lookaheadSeconds: this.#host.lookaheadSeconds,
      // Disk room remaining after stock reserved for other active outputs.
      sourceStorageBytes: this.#host.sourceStorageBytes?.(session.outputKey ?? session.id) ?? null,
      requiredAudio: requiresSeparateAudio,
      sources: [...sourceMeasurements.values()],
      tracks,
      linkReadings: viewerReading?.linkCapture?.validity === "valid" ? measurement.link.snapshot() : null
    };
    // A subtitle track chosen inside THIS file is the last input the forecast
    // waits for. A subtitle FILE beside it is named by its own index and is
    // fetched whole by the page before it is chosen, so it never matches here.
    const subtitle = viewer?.subtitle?.sourceKey === session.file.sourceKey &&
      viewer.subtitle.fileIndex === session.file.fileIndex ? viewer.subtitle : null;
    const startedAt = performance.now();
    const predicted = this.#host.playbackReadiness.predict(input);
    if (consumerId && viewer && this.#host.viewers.get(consumerId) === viewer && Number.isFinite(predicted.cushionBytes)) {
      this.#host.notePlaybackStorageDemand?.(session.outputKey ?? session.id, consumerId, predicted.cushionBytes);
    }
    const predictMs = performance.now() - startedAt;
    this.#host.noteForecast(predictMs, tracks.map(track => track.geometry?.reason ?? "none"));
    logger.info(`readiness parts ${session.id} consumer=${consumerId}: source stats ${Math.round(parts.statsMs)}ms ` +
      `(the torrent thread's arrival forecast ${Math.round(parts.workerForecastMs)}ms), stream rate ${Math.round(parts.qualityMs)}ms, ` +
      `start forecast ${Math.round(predictMs)}ms, in all ${Math.round(performance.now() - parts.enteredAt)}ms`);
    const forecast = withSubtitleReadiness(predicted, subtitle,
      subtitle ? this.#host.subtitleReadyFor?.(viewer) !== false : true);
    forecast.snapshotAtProxyMs = startedAt;
    forecast.snapshotClockEpoch = performance.timeOrigin;
    forecast.inputCaptures = {
      source: [...sourceMeasurements].map(([id, source]) => ({ id, capture: source.capture })),
      link: { ...(viewerReading?.linkCapture ?? unknownCapture("browser", actionId, generation,
        "link-capture-unavailable")), rateReadings: measurement.link.captureSnapshot() },
      encoder: tracks.map(track => ({ id: track.id, capture: track.capture })),
      buffer: bufferCaptureValid || rawBufferCapture.validity === "unknown" ? rawBufferCapture : {
        ...rawBufferCapture, validity: "invalid",
        unknownReason: rawBufferCapture.generation !== generation ? "seek-generation-replaced" :
          rawBufferCapture.actionId !== session.id ? "viewer-session-replaced" : "viewer-output-cancelled"
      }
    };
    forecast.operations = outputs.flatMap((output, index) => {
      const common = { speed: this.#host.playbackReadiness.forecastRate(tracks[index].readings, now, 0, "piece"),
        processedSeconds: tracks[index].processedSeconds,
        sourceFileIndexes: sourceFileIndexesForOutput(output) };
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
    const earlyWaitId = Number.isSafeInteger(generation)
      ? `${session.file.sourceKey}:${session.file.fileIndex}:${generation}` : null;
    if (earlyWaitId && this.#host.viewerPlaybackState.hasWait(viewer, earlyWaitId) && primarySourceStats) {
      const linkMeasuredAt = Number(viewerReading?.linkMeasuredAt);
      const videoOperation = forecast.operations.find(operation => operation.track === "video");
      const audioOperation = forecast.operations.find(operation => operation.track === "audio");
      this.noteWaitSourceSnapshot({ consumerId, generation,
        sourceKey: session.file.sourceKey, fileIndex: session.file.fileIndex,
        fileName: session.file.relativePath ?? session.file.name ?? "",
        fileLength: primarySourceStats.fileLength, stats: primarySourceStats,
        viewerToken: viewer,
        linkMbps: viewerReading?.linkMbps,
        linkSampleAgeMs: Number.isFinite(linkMeasuredAt) ? Math.max(0, Date.now() - linkMeasuredAt) : undefined,
        processing: {
          videoOperation: videoOperation?.operation,
          audioOperation: audioOperation?.operation,
          videoSpeedX: videoOperation?.speed,
          audioSpeedX: audioOperation?.speed,
          firstRequiredSegmentsSeconds: forecast.firstRequiredSegmentsSeconds,
          ...(forecast.ready !== true && Number.isFinite(forecast.delaySeconds)
            ? { startGateSeconds: forecast.delaySeconds } : {}),
          firstRequiredStages: forecast.firstRequiredStages
        } });
    }
    const unavailableInput = forecast.unavailableSource;
    const previousInputState = measurement.forecastInputState ?? null;
    const currentInputState = forecastInputState(tracks, unavailableInput);
    if (previousInputState && forecastInputIdentity(previousInputState) !== forecastInputIdentity(currentInputState)) {
      const resolvedInputState = forecastInputState(tracks, previousInputState) ?? previousInputState;
      observeForecastInput(this.#host.observeWait, session.file.sourceKey, resolvedInputState,
        currentInputState ? "forecast-blocker-replaced" : "forecast-blocker-cleared");
    }
    if (currentInputState && JSON.stringify(previousInputState) !== JSON.stringify(currentInputState)) {
      observeForecastInput(this.#host.observeWait, session.file.sourceKey, currentInputState, "forecast-blocked");
    }
    measurement.forecastInputState = currentInputState;
    const forecastInputKey = unavailableInput ? JSON.stringify([
      unavailableInput.sourceId, unavailableInput.trackId, unavailableInput.segmentIndex, unavailableInput.phase
    ]) : null;
    const browserEvidenceKey = browserServiceFingerprint(tracks);
    const browserEvidenceChanged = measurement.browserEvidenceKey !== browserEvidenceKey;
    if (measurement.forecastReason !== forecast.reason || measurement.forecastInputKey !== forecastInputKey ||
        browserEvidenceChanged) {
      measurement.forecastReason = forecast.reason;
      measurement.forecastInputKey = forecastInputKey;
      measurement.browserEvidenceKey = browserEvidenceKey;
      if (forecast.subtitles) this.#host.observeWait?.(session.file.sourceKey, "process", {
        process: "C3", phase: "event", fileIndex: session.file.fileIndex,
        trackIndex: forecast.subtitles.trackIndex, ready: forecast.subtitles.ready,
        reason: forecast.reason, consumerId
      });
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
        tracks: tracks.map(({ id, processedSeconds, readings, segments, readySegmentIndices, appendService, fragmentService }) => ({
          id, processedSeconds, readings, appendService: browserServiceSummary(appendService),
          fragmentService: browserServiceSummary(fragmentService), segments: segments.length,
          prepared: readySegmentIndices.length
        }))
      })}`);
    }
    this.#sayHolding(session, consumerId, measurement, forecast, input, now);
    // The encoder this viewer waits for, told to whoever shares the processor
    // (torrent-tv/meta#180): the forecast knows it before the map's deadlines do.
    const holding = forecast.holdingBy;
    this.#host.noteViewerWaiting?.(consumerId || session.id,
      holding?.kind === "production" ? { address: holding.track, index: holding.segment } : null);
    delete forecast.firstRequiredStages;
    waitOutcome = "forecast-ready";
    return forecast;
    } finally {
      const waitEndedAt = performance.now();
      this.#host.observeWait?.(session.file.sourceKey, "process", { ...waitFields, phase: "end", at: waitEndedAt,
        startedAt: waitStartedAt, endedAt: waitEndedAt, durationMs: waitEndedAt - waitStartedAt,
        outcome: waitOutcome });
    }
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
      return megabytesPerSecond(rate);
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
  /**
   * The encoder's rate for the forecast: the output's whole window of readings,
   * summarized again on each poll. A run that ended between two polls took its
   * readings with it when the forecast asked for the newest one alone; and two
   * runs of one output can report out of order, so a summary kept and added to
   * would drop the later-told, earlier-taken one (torrent-tv/meta#178).
   */
  #trackRateReadings(output, now) {
    const readings = this.#host.encodeSpeedReadingsOf?.(output) ?? [];
    // ONLY UNTIL A PIECE IS MEASURED does the prediction stand for the
    // encoder, and it is not kept among the readings. Added on every poll
    // between runs, it put the machine's share of that moment — 1 % at a
    // cold start — on the whole film, and the forecast read 0.03x
    // (torrent-tv/meta#178).
    return trackRateReadings(readings, {
      predicted: this.#host.predictedEncodeSpeedOf?.(output),
      projected: this.#host.projectedEncodeSpeedOf?.(output)
    }, now, this.#host.playbackReadiness);
  }

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
