/**
 * @file Wiring of the outputs, the viewers and the encoding.
 *
 * Builds each component and hands it the narrow host it reads, and nothing
 * else. It holds no behaviour: every member that used to be a method of the
 * session manager is a method of the component that owns it now. What it
 * returns is the set of components and the settings they share, for
 * `server.js` to give each route the ones that route asks.
 */

import { logger } from "../../utils/logger.js";
import { KeyframeTables } from "../media/KeyframeTables.js";
import { waits } from "./WaitLedger.js";
import { readMachineState, readProcessCpuSeconds, readProxyCpuSeconds, readSystemCpu, shareOfMachine } from "../encode/host-load.js";
import { minimumBufferFrom } from "../torrent/supply-margin.js";
import { PriorityOrchestrator } from "../viewer/PriorityOrchestrator.js";
import { urgentOutputsReady } from "../viewer/urgent-output-ready.js";
import { softwareDescriptor } from "../encode/hwaccel.js";
import { resolveSegmentFormat } from "../encode/segment-formats/index.js";
import { Timelines } from "../encode/output/Timeline.js";
import { SourceFiles } from "../media/SourceFile.js";
import { SegmentStore } from "../storage/segment-store/SegmentStore.js";
import { EncodeCost } from "../encode/quality/EncodeCost.js";
import { QualityOffer } from "../encode/quality/QualityOffer.js";
import { activeOutputFor } from "../viewer/active-output.js";
import {
  acceptsGeneration,
  askQualityOf,
  audioBeingWarmedOf,
  audioChoiceOf,
  chooseAudioTrack,
  chooseOutput,
  chosenOutputOf,
  consumersOn,
  dropAskOf,
  generationOfRequest,
  givenOutputOf,
  heightsChosenAs,
  highestGivenSegmentOf,
  holdForResponse,
  linkMbpsOf,
  linkReportOf,
  bufferOf,
  bufferedSecondsOf,
  visiblePictureOf,
  linkReportsOn,
  noteAudioBeingWarmed,
  noteGivenOutput,
  noteSameHeightSwitch,
  noteServingVerdict,
  noteStepBeingWarmed,
  noteStepOnScreen,
  outputsBeingPrepared,
  placeOn,
  presentOn,
  qualityModeOf,
  sameHeightSwitchOf,
  servingVerdictOf,
  standingAskOf,
  stepBeingWarmedOf,
  stepBeingWarmedSinceOf,
  stepOnScreenOf,
  switchingOnto,
  watches
} from "../viewer/choices.js";
import { viewerSecondsOn, viewerSegmentsOn } from "../viewer/positions.js";
import { Viewers } from "../viewer/Viewers.js";
import { OutputRetention } from "../encode/output/index.js";
import { OutputCatalog } from "../encode/output/OutputCatalog.js";
import { ViewerRequests } from "./ViewerRequests.js";
import { OutputLifecycle } from "./OutputLifecycle.js";
import { SegmentServing } from "./SegmentServing.js";
import { audioStartSecondsFor } from "../viewer/audio-start.js";
import { forecastRate, predictPlaybackReadiness, RateTrend } from "../viewer/playback-readiness.js";
import { audioRenditionName } from "../media/audio-inventory.js";
import { Renditions } from "../encode/Renditions.js";
import { CushionReport, LOOKAHEAD_PAUSE_SECONDS } from "../encode/CushionReport.js";
import { EncodeRuns } from "../encode/EncodeRuns.js";
import { EncodeInputs } from "../encode/EncodeInputs.js";
import { OutputTimes } from "../encode/OutputTimes.js";
import { HostLoad } from "../encode/quality/HostLoad.js";
import { ColdStarts, secondsToFirstPiece } from "../encode/quality/ColdStarts.js";
import { BUDGET_CHECK_INTERVAL_MS, QualityController } from "../encode/quality/QualityController.js";
import { EncodeOrchestrator } from "../encode/EncodeOrchestrator.js";
import { EncodeAdmission } from "../encode/EncodeAdmission.js";
import { EncoderSelection } from "../encode/EncoderSelection.js";
import { OutputOpening } from "../encode/OutputOpening.js";
import { segmentFormatOfKey } from "../encode/output-key-format.js";
import { OutputSpec } from "../encode/output/OutputSpec.js";
import { compareInits } from "../encode/segment-formats/init-compat.js";
import { nominalKbpsFor, AUDIO_TRANSCODE_KBPS } from "../encode/args.js";
import { audioReadingFor } from "../encode/audio-work-rate.js";
import { wireMachineBudget } from "../storage/wire.js";
import { Returns } from "../storage/returns.js";
import { freeBytesFor } from "../storage/free.js";
import path from "node:path";
import { contentOf, LocalObservations, PROXY_ROOT } from "../encode/LocalObservations.js";
import { configurationKeyOf } from "../encode/fingerprint.js";
import { qualityStateOf } from "../encode/quality/OutputQualityState.js";

// Where a variant and an audio rendition live under a session — `v/<height>/…`
// and `a/<track>/…` — is stated in `encode/output/playlists.js`, beside the lines that
// write those addresses into a master playlist. The routes that parse them back
// are in `server.js`.

const CLEANUP_INTERVAL_MS = 30_000;
const DEFAULT_SEGMENT_DURATION_SEC = 4;
// Sessions expire after confirmed absence of viewer demand. Material has the
// longer keeping period in storage/keep.js; both use OutputRetention's single
// unused timestamp. A pause or progress polling is not a departure.
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_STARTUP_WAIT_MS = 5_000;

/**
 * Convert a bind-all host address to the loopback address so that
 * the HLS input URL is always reachable from the same machine.
 *
 * @param {string} host
 * @returns {string}
 */
function toLoopbackHost(host) {
  if (host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }
  return host;
}

/**
 * Build the HTTP base URL (scheme + host + port) for the local proxy server.
 *
 * @param {string} host - Bind host (may be "0.0.0.0" or "::").
 * @param {number} port
 * @returns {string} e.g. "http://127.0.0.1:9090"
 */
function buildHttpBaseUrl(host, port) {
  const url = new URL("http://localhost");
  url.hostname = toLoopbackHost(host);
  url.port = String(port);
  return url.origin;
}

/**
 * @typedef {Object} WireOutputsOptions
 * @property {boolean} enabled              - Whether HLS transcoding is enabled.
 * @property {string}  ffmpegBin            - Path to the ffmpeg executable.
 * @property {string}  localBindHost        - Host the proxy HTTP server is bound to.
 * @property {number}  localPort            - Port the proxy HTTP server is listening on.
 * @property {number}  [segmentDurationSec] - HLS segment length in seconds.
 * @property {number}  [sessionTtlMs]       - Session idle TTL in milliseconds.
 * @property {number}  [startupWaitMs]      - Max time to wait for the first playlist file.
 * @property {string}  [segmentFormatId]    - Output container: "fmp4" (default)
 *   or "mpegts". See `../segment-formats/index.js`.
 */

/**
 * @typedef {Object} HlsSession
 * @property {string}  id            - The name of the output it produces.
 * @property {string}  fileName      - Display name of the file being transcoded.
 * @property {import("../media/container/KeyframeTable.js").KeyframeTable} keyframes -
 *   Where this file's keyframes are. One object per file, held by every session
 *   of it, so a table read late still reaches them. Used to snap a source seek
 *   onto a known-valid position (see #startEncodeRun).
 */

/**
 * Build the components and connect them.
 *
 * @param {WireOutputsOptions} options
 * @returns {object} The components, and the settings they read.
 */
export function wireOutputs({
    enabled,
    ffmpegBin,
    localBindHost,
    localPort,
    segmentDurationSec = DEFAULT_SEGMENT_DURATION_SEC,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    startupWaitMs = DEFAULT_STARTUP_WAIT_MS,
    // Where every file's keyframe table lives, and the only thing that reads
    // one. A session asks for its file's table and is handed the object every
    // other reader of that file holds, so a table that arrives late reaches the
    // sessions created before it. Built here when nothing supplied one, which
    // is a registry with no reader: it answers "not read" about every file, and
    // every picture is then re-encoded — the correct behaviour for a proxy
    // wired without a container reader, and what every unit test gets.
    keyframeTables = new KeyframeTables(),
    videoEncoder = null,
    softwarePresetBenchmark = null,
    // What every encoder this host may use was qualified and measured to do at
    // startup, by kind (`encode/calibration.js`). Takes the place of the one
    // array above, which a test may still hand in on its own.
    calibration = null,
    decodeCostModel = null,
    getSourceStats = null,
    setPriorityMap = null,
    // What a second job costs on this host, measured at startup. Null when it
    // could not be measured, and then nothing is corrected — the alternative
    // is inventing a penalty, which is the same fault as inventing a fill rate.
    contentionPenalties = null,
    copySpeedX = null,
    audioCalibration = [],
    tonemapSupported = false,
    getCachedMediaInfo = null,
    getCachedAudioTracks = null,
    getContainerMediaInfo = null,
    segmentFormatId = undefined,
    stateDir = "",
    segmentStore = null,
    getTorrentTotals,
    startStopCost = null,
    spillDisk = null,
    wholeFiles = null,
    diagnostics = null,
    diagnosticsRoot = "",
    memoryClaimant = null,
    resolveEncodeInput = null,
    readSourceMedia = null,
    readMetadataActivity = null,
    sourceInputsFor = null,
    readEncodeRanges = null,
    readEncodeHeldRanges = null,
    encodeInputs = null,
    indexMemory = null,
    budgetPolicy = null,
    // What viewers' connections carry beyond the film, per byte of film, as
    // the transport measured it (`transport/delivery-shares.js`); null while
    // nothing has been delivered.
    serviceShare = () => null,
    onViewerChanged = null,
    // Told when an encoder starts or ends: the room this host has for one more
    // encode changes with it, and the server chooses proxies by that room.
    onEncodersChanged = null}) {
  const parts = {};
  const audioDescriptionOf = (output) => (getCachedAudioTracks?.({
    sourceKey: output.file.sourceKey, fileIndex: output.spec.grid?.fileIndex ?? output.file.fileIndex
  }) ?? []).find((track) => track.fileIndex === output.spec.audio?.fileIndex &&
    track.sourceTrackIndex === output.spec.audio?.trackIndex) ?? null;
  // Encode components receive only the storage operations they use. The
  // concrete SegmentStore remains owned by this assembly and is never handed
  // to the encode layer.
  const segmentCoverage = {
    provenNumbers: (address) => parts.segmentStore.provenNumbers(address),
    announce: (address, index) => parts.segmentStore.announce(address, index),
    filesHeld: (address) => parts.segmentStore.filesHeld(address),
    clearUpAfter: (address, startedAt) => parts.segmentStore.clearUpAfter(address, startedAt)
  };
  const segmentFiles = {
    pathFor: (address) => parts.segmentStore.pathFor(address),
    initOf: (address) => parts.segmentStore.initOf(address),
    directoryFor: (address, format) => parts.segmentStore.directoryFor(address, format),
    publish: (address, makingName, format, read) => parts.segmentStore.publish(address, makingName, format, read),
    closedBytesOf: (address, makingName) => parts.segmentStore.closedBytesOf(address, makingName),
    mediaRangesOf: (address, index, where) => parts.segmentStore.mediaRangesOf(address, index, where),
    remove: (address, index, because) => parts.segmentStore.remove(address, index, because)
  };
  const segmentOutputFiles = {
    addresses: () => parts.segmentStore.addresses(),
    isClosed: (address, index) => parts.segmentStore.isClosed(address, index),
    lastReadAt: (address) => parts.segmentStore.lastReadAt(address),
    directoryFor: (address, format) => parts.segmentStore.directoryFor(address, format)
  };
  const segmentPaths = {
    pathOf: (address, index) => parts.segmentStore.pathOf(address, index),
    sizesOf: (address) => parts.segmentStore.sizesOf(address)
  };
  /**
   * Whether everything this output will ever serve is made: every segment of
   * its timeline closed in the store. Such an output needs no encoder and
   * holds no place, however many watch it.
   *
   * @param {object} session
   * @returns {boolean}
   */
  const finishedOutput = (session) => {
    const count = Number(session?.timeline?.segmentCount) || 0;
    return count > 0 && parts.segmentStore.provenNumbers(session.outputKey).length >= count;
  };
  // The limit follows this file's measured picture rate and the output frame;
  // no rate means no ceiling. The same answer is used when opening and moving
  // between limits, so one size of one file keeps one declared H.264 level.
  parts.limitsFor = (frame, file) => [nominalKbpsFor(frame, file)];
  // What the torrent and the proxy itself spend on this host, and how fast each watched torrent moves.
  parts.hostLoad = new HostLoad({
    readMetadataActivity,
    readMachineState,
    readProcessCpuSeconds,
    readProxyCpuSeconds,
    readSystemCpu,
    shareOfMachine,
    liveRunsOf: (...args) => parts.encodeRuns.liveRunsOf(...args),
    runStateOf: (...args) => parts.encodeRuns.runStateOf(...args),
    get getSourceStats() { return parts.getSourceStats; },
    get getTorrentTotals() { return parts.getTorrentTotals; },
    get outputs() { return parts.outputs; },
  });
  // Where each segment of an output begins, and how that table is corrected from what the encoder produced.
  parts.outputTimes = new OutputTimes({
    logger,
    runsOf: (...args) => parts.encodeRuns.runsOf(...args),
    stopEncodeRun: (...args) => parts.encodeRuns.stopEncodeRun(...args),
    planEncodersSoon: (...args) => parts.encodeRuns.planEncodersSoon(...args),
    get outputs() { return parts.outputs; },
    get segmentDurationSec() { return parts.segmentDurationSec; },
  });
  // The encoders of this proxy: built where the plan places them, followed while they run, accounted when they end.
  parts.encodeRuns = new EncodeRuns({
    logger,
    // What this host is doing with an encode is learned each time a run has
    // measured its processing speed, on every host.
    noteRunSpeedMeasured: (session, run) => {
      void parts.encodeCost.learnFrom(session, run);
    },
    // What an admitted encode was seen to do, filed under its configuration.
    observeEncodeEnded: (session) => {
      if (!parts.localObservations || !session?.spec?.video?.encode) {
        return;
      }
      const alone = Number(qualityStateOf(session).lastAloneSpeed);
      parts.localObservations.noteEncode({
        spec: session.spec,
        content: contentOf(session.file),
        aloneSpeedX: Number.isFinite(alone) && alone > 0 ? alone : null,
        segmentKbps: segmentRatesOf(session)
      });
    },
    viewerSecondsOn: (output, consumerId, now) => viewerSecondsOn(parts.viewers, output, consumerId, now),
    get encodeInputs() { return parts.encodeInputs; },
    producedNumbers: (...args) => parts.serving.producedNumbers(...args),
    servesAudioSeparately: (...args) => parts.renditions.servesAudioSeparately(...args),
    disposeSession: (...args) => parts.lifecycle.disposeSession(...args),
    get contentionPenalties() { return parts.contentionPenalties; },
    get encodeCost() { return parts.encodeCost; },
    get encodeOrchestrator() { return parts.encodeOrchestrator; },
    get ffmpegBin() { return parts.ffmpegBin; },
    get localBaseUrl() { return parts.localBaseUrl; },
    get outputTimes() { return parts.outputTimes; },
    get outputs() { return parts.outputs; },
    get priority() { return parts.priority; },
    get segmentDurationSec() { return parts.segmentDurationSec; },
    segmentFiles,
    get videoEncoder() { return parts.encoders.current; },
    get encoders() { return parts.encoders; },
    invalidateWaits: (output) => parts.serving.invalidateWaits(output),
    productionFailed: (output) => parts.renditions.noteProductionFailed(output),
    encodersChanged: () => onEncodersChanged?.(),
  });
  // How much film is ready in front of the viewers, said; and the spare soundtracks fetched once it is full.
  parts.cushion = new CushionReport({
    viewerSecondsOn: (output, consumerId, now) => viewerSecondsOn(parts.viewers, output, consumerId, now),
    linkReportsOn: (output) => linkReportsOn(parts.viewers, output),
    SourceFiles,
    logger,
    producedNumbers: (...args) => parts.serving.producedNumbers(...args),
    get encodeRuns() { return parts.encodeRuns; },
    get getCachedAudioTracks() { return parts.getCachedAudioTracks; },
    get hostLoad() { return parts.hostLoad; },
    get lookaheadSeconds() { return parts.lookaheadSeconds; },
    get outputTimes() { return parts.outputTimes; },
    get outputs() { return parts.outputs; },
  });
  // The steps of a picture and its soundtracks: which output answers each, made when first asked for, and the master playlist listing them.
  // The cushion this file needs, from its segment length and the worst
  // interruption its supply has shown — one statement read by every operation
  // that asks it.
  const minimumBufferSecondsOf = (output) => minimumBufferFrom({
    segmentSeconds: parts.segmentDurationSec,
    worstSupplyWaitSec: parts.hostLoad.supplyFor(output.file)?.worstWaitSec
  })?.seconds ?? null;
  parts.renditions = new Renditions({
    // Whether this proxy re-encodes at all: a soundtrack with no stated rate is
    // re-encoded where it may be, and copied where it may not.
    get transcodeEnabled() { return parts.enabled; },
    observedPeakMbps: (spec) => parts.localObservations?.peakMbps(spec) ?? null,
    serviceShare,
    // A viewer has been moved onto an output prepared for them: how long it
    // took, and what they held.
    notePreparation: (output, seconds, bufferedSec) =>
      parts.localObservations?.notePreparation({ spec: output?.spec, seconds, bufferedSec }),
    viewerSecondsOn: (output, consumerId, now) => viewerSecondsOn(parts.viewers, output, consumerId, now),
    audioStartSecondsFor: (args) => audioStartSecondsFor({ ...args, viewers: parts.viewers }),
    activeOutputFor: (args) => activeOutputFor({ ...args, viewers: parts.viewers }),
    // WHAT ENCODING IS TOLD ABOUT A PERSON, and what it may tell the viewer
    // layer about them: values and names, never the viewer itself. Steps and
    // soundtracks are chosen, warmed and left per person, so this is the widest
    // of the three sets — and every one of them is a call on the owner, which
    // is what keeps one writer per fact.
    viewerCountOn: (output) => parts.viewers.forOutput(output).size,
    // Whether anything still stands on it — somebody watching, or an
    // assignment not yet released. See `Viewers.stillNeeded`.
    outputStillNeeded: (output) => parts.viewers.stillNeeded(output),
    consumersOn: (output) => consumersOn(parts.viewers, output),
    presentOn: (output) => presentOn(parts.viewers, output),
    qualityModeOf: (output, consumerId) => qualityModeOf(parts.viewers, output, consumerId),
    linkMbpsOf: (output, consumerId) => linkMbpsOf(parts.viewers, output, consumerId),
    audioChoiceOf: (output, consumerId) => audioChoiceOf(parts.viewers, output, consumerId),
    chooseAudioTrack: (output, consumerId, choice) =>
      chooseAudioTrack(parts.viewers, output, consumerId, choice),
    stepOnScreenOf: (output, consumerId) => stepOnScreenOf(parts.viewers, output, consumerId),
    noteStepOnScreen: (output, consumerId, stepId) =>
      noteStepOnScreen(parts.viewers, output, consumerId, stepId),
    stepBeingWarmedOf: (output, consumerId) => stepBeingWarmedOf(parts.viewers, output, consumerId),
    stepBeingWarmedSinceOf: (output, consumerId) => stepBeingWarmedSinceOf(parts.viewers, output, consumerId),
    noteStepBeingWarmed: (output, consumerId, stepId) =>
      noteStepBeingWarmed(parts.viewers, output, consumerId, stepId),
    audioBeingWarmedOf: (output, consumerId) => audioBeingWarmedOf(parts.viewers, output, consumerId),
    noteAudioBeingWarmed: (output, consumerId, renditionId) =>
      noteAudioBeingWarmed(parts.viewers, output, consumerId, renditionId),
    watches: (output, consumerId) => watches(parts.viewers, output, consumerId),
    placeOn: (output, consumerId, seconds) => placeOn(parts.viewers, output, consumerId, seconds),
    // A viewer's own assignments: which output answered a height and segment in
    // one generation of their viewing, so a repeat is answered the same way.
    // Values in and out, like everything above.
    generationOfRequest: (consumerId, stated) => generationOfRequest(parts.viewers, consumerId, stated),
    givenOutputOf: (consumerId, generation, askedHeight, segmentIndex) =>
      givenOutputOf(parts.viewers, consumerId, generation, askedHeight, segmentIndex),
    noteGivenOutput: (consumerId, generation, askedHeight, segmentIndex, outputKey) =>
      noteGivenOutput(parts.viewers, consumerId, generation, askedHeight, segmentIndex, outputKey),
    // The output this viewer was chosen at a height, and the rule's choice of
    // it — the viewer's own record, never one per file.
    chosenOutputOf: (consumerId, askedHeight) => chosenOutputOf(parts.viewers, consumerId, askedHeight),
    chooseOutput: (consumerId, askedHeight, outputKey) => chooseOutput(parts.viewers, consumerId, askedHeight, outputKey),
    noteServingVerdict: (consumerId, verdict) => noteServingVerdict(parts.viewers, consumerId, verdict),
    // A move between two limits of the height on a viewer's screen (roadmap
    // item 97, step 12): which heights their choice is the output on screen
    // under, the segment they were last given, the move being prepared, and
    // whether a segment is closed on the output being prepared.
    limitsFor: (frame, file) => parts.limitsFor(frame, file),
    heightsChosenAs: (consumerId, outputKey) => heightsChosenAs(parts.viewers, consumerId, outputKey),
    highestGivenSegmentOf: (consumerId, askedHeight) => highestGivenSegmentOf(parts.viewers, consumerId, askedHeight),
    sameHeightSwitchOf: (consumerId) => sameHeightSwitchOf(parts.viewers, consumerId),
    noteSameHeightSwitch: (consumerId, value) => noteSameHeightSwitch(parts.viewers, consumerId, value),
    switchingOnto: (output) => switchingOnto(parts.viewers, output),
    // What a viewer holds, and the cushion this file needs before a move that
    // is not urgent is made (roadmap item 98).
    bufferedSecondsOf: (consumerId) => bufferedSecondsOf(parts.viewers, consumerId),
    minimumBufferSecondsFor: (output) => minimumBufferSecondsOf(output),
    // Whether the whole machine has a place for one more encoder on this output,
    // asked before a preparation is recorded.
    admitsPreparation: (output) => parts.admission.admitsPreparation(output?.outputKey ?? ""),
    segmentClosed: (key, index) => parts.segmentStore.isClosed(key, index),
    // What a gone output left in the store, and whether another output's header
    // may stand in for its own.
    storedPieceReady: (key, fileName) => parts.serving.hasStoredPiece(key, fileName),
    headersCompatible: (goneKey, liveKey) => parts.serving.headersCompatible(goneKey, liveKey),
    placeViewerOn: (...args) => parts.viewerRequests.placeViewerOn(...args),
    audioRenditionName,
    logger,
    viewerLeaves: (...args) => parts.lifecycle.viewerLeaves(...args),
    createOrGetSession: (...args) => parts.viewerRequests.createOrGetSession(...args),
    planEncodersSoon: (...args) => parts.encodeRuns.planEncodersSoon(...args),
    disposeSession: (...args) => parts.lifecycle.disposeSession(...args),
    viewerPositionOf: (...args) => parts.viewerRequests.viewerPositionOf(...args),
    get encodeRuns() { return parts.encodeRuns; },
    get fileStartTimeReads() { return parts.fileStartTimeReads; },
    set fileStartTimeReads(value) { parts.fileStartTimeReads = value; },
    get getCachedAudioTracks() { return parts.getCachedAudioTracks; },
    get getCachedMediaInfo() { return parts.getCachedMediaInfo; },
    get getContainerMediaInfo() { return parts.getContainerMediaInfo; },
    get localBaseUrl() { return parts.localBaseUrl; },
    get outputTimes() { return parts.outputTimes; },
    get outputs() { return parts.outputs; },
    get quality() { return parts.quality; },
    get qualityOffer() { return parts.qualityOffer; },
    get segmentDurationSec() { return parts.segmentDurationSec; },
    get sourceFiles() { return parts.sourceFiles; },
    invalidateWaits: (output) => parts.serving.invalidateWaits(output),
  });
  // Answering a request for a playlist, an init segment or a segment: from the store when the piece is made and whole, otherwise held until it is.
  parts.serving = new SegmentServing({
    // What a key names, read back from the key: how to find a gone output's
    // stored pieces and whether they are cut at given times.
    segmentFormatOfKey,
    specOfKey: (key) => OutputSpec.fromKey(key),
    compareInits,
    activeOutputFor: (args) => activeOutputFor({ ...args, viewers: parts.viewers }),
    viewerSecondsOn: (output, consumerId, now) => viewerSecondsOn(parts.viewers, output, consumerId, now),
    buildMasterPlaylist: (...args) => parts.renditions.buildMasterPlaylist(...args),
    declaredTracks: (...args) => parts.renditions.declaredTracks(...args),
    publishedGridFor: (...args) => parts.outputTimes.publishedGridFor(...args),
    runStartTimeFor: (...args) => parts.outputTimes.runStartTimeFor(...args),
    get cushion() { return parts.cushion; },
    get encodeOrchestrator() { return parts.encodeOrchestrator; },
    get encodeRuns() { return parts.encodeRuns; },
    get coldStarts() { return parts.coldStarts; },
    get lookaheadSeconds() { return parts.lookaheadSeconds; },
    get outputTimes() { return parts.outputTimes; },
    get outputs() { return parts.outputs; },
    get segmentStore() { return parts.segmentStore; },
    get startupWaitMs() { return parts.startupWaitMs; },
    get viewers() { return parts.viewers; },
  });
  // How an output ends: disposed when nobody is left on it and it has been idle, or all at once on shutdown; and the segments an earlier process left behind adopted at startup.
  parts.lifecycle = new OutputLifecycle({
    get retention() { return parts.retention; },
    outputNeeded: (key, now) => parts.segmentStore.isReading(key) || parts.viewers.assignmentsHold({ outputKey: key }, now) ||
      parts.outputs.outputsOn(key).some(output => parts.viewers.stillNeeded(output, now)),
    outputWriting: key => parts.encodeOrchestrator.runsOn(key).some(run => run.isAlive || run.isStopping),
    outputReading: key => parts.segmentStore.isReading(key) || parts.viewers.responsesHold(key),
    planEncodersSoon: () => parts.encodeRuns.planEncodersSoon(),
    invalidateWaits: (output) => parts.serving.invalidateWaits(output),
    segmentFormatOfKey,
    // Where the viewers of one output stand, in its segments: what the store
    // the output retention policy reads to give disk back in the right order.
    viewerSegmentsOn: (key) => viewerSegmentsOn({
      outputs: parts.outputs.values(),
      outputKey: key,
      segmentAt: (output, seconds) => parts.outputTimes.segmentIndexForTime(output, seconds),
      now: Date.now(),
      viewers: parts.viewers
    }),
    get budgetTimer() { return parts.budgetTimer; },
    get cleanupTimer() { return parts.cleanupTimer; },
    get encodeRuns() { return parts.encodeRuns; },
    get keyframeTables() { return parts.keyframeTables; },
    get machineBudget() { return parts.machineBudget; },
    get outputTimes() { return parts.outputTimes; },
    get outputs() { return parts.outputs; },
    get returns() { return parts.returns; },
    get segmentStore() { return parts.segmentStore; },
    get sessionTtlMs() { return parts.sessionTtlMs; },
    get sourceFiles() { return parts.sourceFiles; },
    get timelines() { return parts.timelines; },
    get viewers() { return parts.viewers; },
  });
  // Which output answers a request for a file, made if it is not here yet: the encoding component's decision, made without knowing who asked.
  parts.opening = new OutputOpening({
    logger,
    // The largest peak an output of this mode and rate control has been seen
    // carrying here: the only figure an encoder with no bound of its own has.
    observedPeakMbps: (spec) => parts.localObservations?.peakMbps(spec) ?? null,
    serviceShare,
    limitsFor: (frame, file) => parts.limitsFor(frame, file),
    readSourceMedia,
    get encodeInputs() { return parts.encodeInputs; },
    get decodeCostModel() { return parts.decodeCostModel; },
    get enabled() { return parts.enabled; },
    get encodeCost() { return parts.encodeCost; },
    get encodeRuns() { return parts.encodeRuns; },
    get admission() { return parts.admission; },
    get getCachedMediaInfo() { return parts.getCachedMediaInfo; },
    get hostLoad() { return parts.hostLoad; },
    get coldStarts() { return parts.coldStarts; },
    get keyframeTables() { return parts.keyframeTables; },
    get localBaseUrl() { return parts.localBaseUrl; },
    get outputs() { return parts.outputs; },
    get renditions() { return parts.renditions; },
    get returns() { return parts.returns; },
    get segmentDurationSec() { return parts.segmentDurationSec; },
    get segmentFormat() { return parts.segmentFormat; },
    segmentOutputFiles,
    get softwarePresetBenchmark() { return parts.softwarePresetBenchmark; },
    get sourceFiles() { return parts.sourceFiles; },
    get timelines() { return parts.timelines; },
    get tonemapSupported() { return parts.tonemapSupported; },
    get videoEncoder() { return parts.encoders.current; },
  });
  // What a viewer asks for: an output of a file, a position, a report of progress.
  parts.viewerRequests = new ViewerRequests({
    // Whether this machine has a place for one more viewer on this output —
    // asked in the same synchronous stretch as they are put on it.
    admitsWatching: (output) => parts.admission.admitsWatching(output?.outputKey ?? ""),
    activeOutputFor: (args) => activeOutputFor({ ...args, viewers: parts.viewers }),
    viewerSecondsOn: (output, consumerId, now) => viewerSecondsOn(parts.viewers, output, consumerId, now),
    minimumBufferSecondsFor: (output) => minimumBufferSecondsOf(output),
    getSourceStats: (...args) => parts.getSourceStats?.(...args) ?? null,
    disposeSession: (...args) => parts.lifecycle.disposeSession(...args),
    planEncodersSoon: (...args) => parts.encodeRuns.planEncodersSoon(...args),
    waitUntilReady: (...args) => parts.serving.waitUntilReady(...args),
    get encodeRuns() { return parts.encodeRuns; },
    // When this viewer's playback can start and run to the end: the viewer
    // component's forecast, which models the viewer's browser.
    playbackReadiness: { predict: predictPlaybackReadiness, forecastRate, RateTrend },
    // Whether the subtitle a viewer chose has been read where they stand — the
    // source preparation's answer, set on these parts by the assembly.
    subtitleReadyFor: (viewer) => parts.subtitleReadyFor?.(viewer) ?? true,
    sourceInputsFor: (output, index) => parts.sourceInputsFor?.(output, index),
    encodeSpeedReadingOf: (output) => parts.encodeCost.latestSpeedReadingOf(output),
    projectedEncodeSpeedOf: (output) => parts.encodeCost.projectedSpeedOf(output),
    audioDescriptionOf,
    processingStartupSecondsOf: (output) => output.spec.carries === "audio-only" ?
      audioReadingFor(audioCalibration, { ...audioDescriptionOf(output),
        codec: audioDescriptionOf(output)?.codec ?? output.file.media?.audioCodec,
        transcode: output.spec.audio?.transcode })?.startupSeconds ?? 0 :
      Math.max(0, (startStopCost?.firstByteWaitSec ?? 0) - parts.segmentDurationSec /
        parts.encodeCost.projectedSpeedOf(output)),
    initialOutputBitsPerMediaSecondOf: (output) => {
      const description = audioDescriptionOf(output);
      const reference = audioReadingFor(audioCalibration, { codec: description?.codec, transcode: false });
      const audio = output.spec.audio ? output.spec.audio.transcode ? AUDIO_TRANSCODE_KBPS * 1000 :
        description?.bitrateKbps > 0 ? description.bitrateKbps * 1000 :
          reference ? reference.bytes * 8 / reference.durationSeconds : 0 : 0;
      const video = output.spec.video ? (output.spec.video.encode?.rateControl?.maxrateKbps ??
        output.file.media?.bitrateKbps ?? 0) * 1000 : 0;
      return video + audio;
    },
    get opening() { return parts.opening; },
    get outputTimes() { return parts.outputTimes; },
    get outputs() { return parts.outputs; },
    get lookaheadSeconds() { return parts.lookaheadSeconds; },
    get quality() { return parts.quality; },
    get qualityOffer() { return parts.qualityOffer; },
    get renditions() { return parts.renditions; },
    get segmentDurationSec() { return parts.segmentDurationSec; },
    get segmentStore() { return parts.segmentStore; },
    get sourceFiles() { return parts.sourceFiles; },
    get startupWaitMs() { return parts.startupWaitMs; },
    get viewers() { return parts.viewers; },
    invalidateWaits: (output) => parts.serving.invalidateWaits(output),
    // Whether a request of this generation is still taken, what it belongs to,
    // what answered it, and the hold a response keeps while it is being sent.
    acceptsGeneration: (consumerId, stated) => acceptsGeneration(parts.viewers, consumerId, stated),
    generationOfRequest: (consumerId, stated) => generationOfRequest(parts.viewers, consumerId, stated),
    noteGivenOutput: (consumerId, generation, askedHeight, segmentIndex, outputKey) =>
      noteGivenOutput(parts.viewers, consumerId, generation, askedHeight, segmentIndex, outputKey),
    holdForResponse: (consumerId, outputKey) => holdForResponse(parts.viewers, consumerId, outputKey),
    noteServingVerdict: (consumerId, verdict) => noteServingVerdict(parts.viewers, consumerId, verdict),
    servingVerdictOf: (consumerId) => servingVerdictOf(parts.viewers, consumerId),
  });
  // How long each output took to its first served segment, said once in the log.
  parts.coldStarts = new ColdStarts();
  parts.enabled = Boolean(enabled);
  parts.ffmpegBin = ffmpegBin;
  parts.sourceInputsFor = typeof sourceInputsFor === "function" ? sourceInputsFor : null;
  parts.keyframeTables = keyframeTables;
  // Where measurements about this host are kept between runs. Empty means
  // beside the installed proxy; a deployment with somewhere persistent to
  // write names it (--state-dir).
  parts.stateDir = typeof stateDir === "string" ? stateDir : "";
  // Output container (fMP4/CMAF or MPEG-TS). Everything container-specific —
  // muxer args, file naming, playlist header, per-segment correction — lives
  // in this module; nothing here branches on the format.
  parts.segmentFormat = resolveSegmentFormat(segmentFormatId);
  // Optional accessor for media info the playback planner already probed for
  // (sourceKey, fileIndex), so session create can skip its own ffmpeg scan.
  parts.getCachedMediaInfo = typeof getCachedMediaInfo === "function" ? getCachedMediaInfo : null;
  // The file's audio tracks, for the master playlist's rendition group. Same
  // inventory the browser's audio menu is built from.
  parts.getCachedAudioTracks = typeof getCachedAudioTracks === "function" ? getCachedAudioTracks : null;
  // What a file declares about itself, read by the container layer from the
  // same header its track table comes from: format, duration, and where its
  // own timeline begins. The last of those is why this exists — a soundtrack
  // shipped as its own file has a timeline of its own, and asking ffmpeg for
  // it meant reading a header this proxy had already read.
  parts.getContainerMediaInfo =
    typeof getContainerMediaInfo === "function" ? getContainerMediaInfo : null;
  // Optional async accessor for a source's live download stats, used by the
  // realtime budget to tell a CPU limit from a download-starved input:
  // (sourceKey, fileIndex) => Promise<{ downloadSpeed, fileLength, fileProgress } | null>.
  parts.getSourceStats = typeof getSourceStats === "function" ? getSourceStats : null;
  parts.setPriorityMap = typeof setPriorityMap === "function" ? setPriorityMap : null;
  parts.contentionPenalties = contentionPenalties instanceof Map ? contentionPenalties : null;
  // Seconds of film per second when the picture is COPIED, measured at
  // startup. Nothing else prices that branch: the other benchmarks measure
  // encoding and decoding, and a copy does neither.
  parts.copySpeedX = Number.isFinite(copySpeedX) && copySpeedX > 0 ? copySpeedX : null;
  // Totals across every torrent this proxy holds, used to price what the
  // torrent itself costs the machine (item 7). Optional: a proxy wired
  // without it simply never learns that figure.
  parts.getTorrentTotals = typeof getTorrentTotals === "function" ? getTorrentTotals : null;
  // The spilled pieces, as a pair of closures over the torrent thread: what
  // they weigh and how to tell them their share. Not the pool — the pool is
  // on the other side of the thread boundary and this side holds none of it.
  parts.spillDisk = spillDisk;
  parts.wholeFiles = wholeFiles;
  parts.diagnostics = diagnostics;
  parts.diagnosticsRoot = diagnosticsRoot;
  parts.memoryClaimant = memoryClaimant;
  parts.budgetPolicy = budgetPolicy;
  // Detected H.264 encoder descriptor (hardware or software). Defaults to
  // software libx264 when no detection result is supplied. May be downgraded
  // to software at runtime if a hardware encode fails.
  parts.encoders = new EncoderSelection({ detected: videoEncoder, softwareDescriptor });
  // WHAT THIS HOST HAS SEEN ITS OWN ADMITTED ENCODES DO, kept between runs and
  // used only on the configuration it was seen on (roadmap item 97, step 14).
  // A refinement of figures that exist without it: nothing is selected,
  // admitted or served differently when it is empty. Absent where the startup
  // calibration was not run, which is only a wiring made without it.
  parts.localObservations = null;
  if (calibration?.fingerprint) {
    parts.localObservations = new LocalObservations({
      fingerprint: calibration.fingerprint,
      filePath: path.join(typeof stateDir === "string" && stateDir.length > 0 ? stateDir : PROXY_ROOT, "local-observations.json"),
      logger
    });
    parts.localObservations.load(calibration.kinds().map((kind) => configurationKeyOf(calibration.fingerprint, {
      kind,
      name: kind === "software" ? softwareDescriptor().name : (videoEncoder?.kind === kind ? videoEncoder.name : kind)
    })));
  }
  /**
   * What the segments an output has closed carried, from their sizes and the
   * spans its timeline gives them: the average over all of them and the
   * largest one.
   *
   * @param {object} session
   * @returns {{ averageKbps: number, peakKbps: number } | null}
   */
  const segmentRatesOf = (session) => {
    const sizes = parts.segmentStore.sizesOf(session.outputKey);
    const timeline = session.timeline;
    if (!timeline || sizes.size === 0) {
      return null;
    }
    let bits = 0;
    let seconds = 0;
    let peakKbps = 0;
    for (const [index, size] of sizes) {
      const start = timeline.publishedStartOf(index);
      const end = index < timeline.segmentCount ? timeline.publishedStartOf(index + 1) : null;
      if (!(Number.isFinite(start) && Number.isFinite(end) && end > start) || !(size > 0)) {
        continue;
      }
      bits += size * 8;
      seconds += end - start;
      peakKbps = Math.max(peakKbps, (size * 8) / (end - start) / 1000);
    }
    return seconds > 0 ? { averageKbps: bits / seconds / 1000, peakKbps } : null;
  };
  // The modes of the encoder IN USE NOW, as measured at startup: slowest
  // first, each with its throughput by size. Read through the selection rather
  // than copied, because the encoder in use can change — a failing device
  // moves this host to software for the rest of the process, and from then on
  // it is software's own modes that price and choose, not the device's.
  // Null where nothing was measured, and then nothing is re-encoded here.
  parts.calibration = calibration ?? null;
  const givenModes = Array.isArray(softwarePresetBenchmark) ? softwarePresetBenchmark : null;
  Object.defineProperty(parts, "softwarePresetBenchmark", {
    get: () => (parts.calibration
      ? parts.calibration.modesFor(parts.encoders.current?.kind)
      : givenModes),
    enumerable: true
  });
  // Host decode cost solved at startup from the calibration clips:
  // `a × Mpixel/s + b × Mbit/s + c` seconds of decoding per second of video.
  // A re-encode pays for this as well as for the encoder, and leaving it out
  // is what made the budget offer rungs this host ran at a third of realtime.
  // Null when the clips are missing or the fit was rejected — the budget then
  // prices the encoder alone, as it did before.
  parts.decodeCostModel = decodeCostModel ?? null;
  // Whether this ffmpeg build can tone-map HDR→SDR (zscale + tonemap filters).
  // Gates the tonemap chain for HDR sources on the software path.
  parts.tonemapSupported = Boolean(tonemapSupported);
  parts.segmentDurationSec = segmentDurationSec;
  // How far ahead of the viewer this proxy lets an encoder run, in seconds of
  // playback. Stated rather than kept private, because the browser's forward
  // buffer is bounded by the same quantity and used to carry a copy of its
  // own: a hand-written 30 s, justified in a comment by a DIFFERENT constant
  // (the eight segments that bound a request ahead of the ENCODE HEAD), so
  // three quarters of what the encoder had already produced was thrown away.
  // One figure, said by the side that owns it (roadmap item 4).
  parts.lookaheadSeconds = LOOKAHEAD_PAUSE_SECONDS;
  parts.sessionTtlMs = sessionTtlMs;
  parts.startupWaitMs = startupWaitMs;
  parts.localBaseUrl = buildHttpBaseUrl(localBindHost, localPort);
  // Everyone watching anything, one object per person rather than one per
  // person per output. What a viewer chose, where they are and which outputs
  // they are watching are facts about the person; kept per output they were
  // three copies of which two were always stale.
  // Every change to who is watching what re-decides which encoders should
  // exist, because that decision reads nothing else about viewers. It used to
  // be re-taken on a five-second timer instead, which made a just-created
  // output wait up to five seconds before anything noticed it had a viewer.
  parts.retention = new OutputRetention();
  parts.viewers = new Viewers({ onChange: () => {
    parts.lifecycle.observeUse();
    parts.encodeRuns.planEncodersSoon();
    onViewerChanged?.();
  } });
  // The outputs that exist, and every question about them: the picture a step
  // belongs to, the steps, the soundtracks, the height a step is named by.
  parts.outputs = new OutputCatalog({
    fileLengthOf: (session) => parts.hostLoad.fileLengthByKey.get(session.file.key) ?? 0,
    largestPieceOf: (address) => parts.segmentStore.largestPiece(address)
  });
  // Where produced segments live, addressed by WHAT they are rather than by
  // which session's encoder wrote them. Two sessions of one output — two
  // viewers who opened the same film at different places — write into one
  // directory and each serves what the other has already made. Injectable so
  // a test can give it a root of its own.
  parts.segmentStore = segmentStore instanceof SegmentStore
    ? segmentStore
    : new SegmentStore({ logger });
  // The store has grown: whether it still fits its share is asked now rather
  // than on the next cleanup pass.
  parts.segmentStore.onPublished(() => parts.lifecycle.keepWithinRoomSoon());
  // A segment closed may be the one a viewer's move between two limits of a
  // height is waiting for.
  parts.segmentStore.onPublished((key, index) => parts.renditions.noteSegmentPublished(key, index));
  // What encoders there should be on each output, and where. Given the two
  // things only this class can answer: how many this machine can afford, and
  // how to make one.
  // What encoding costs this machine, and which heights follow from it. Given
  // what it cannot work out for itself: which sessions belong to one file, the
  // host's own readings AT THE MOMENT OF THE QUESTION rather than copied, how
  // a soundtrack is keyed, how many encoders are running, and what a file
  // costs merely by being fetched.
  parts.encodeCost = new EncodeCost({
    outputs: parts.outputs,
    host: () => ({
      benchmark: parts.softwarePresetBenchmark,
      decodeModel: parts.decodeCostModel,
      contentionPenalties: parts.contentionPenalties,
      copySpeedX: parts.copySpeedX,
      audioCalibration,
      audioDescriptionOf,
      availability: parts.hostLoad.hostAvailability,
      // WHICH encoder this host settled on. Only the software ladder is
      // benchmarked, so a reading taken off a hardware encoder cannot be
      // split into its decode and encode halves and is not filed as one.
      encoderKind: parts.encoders.current?.kind ?? null,
      // The slowest this output's mode has been seen running alone on
      // comparable material on this configuration, or null.
      observedAloneSpeed: (session) => parts.localObservations?.slowestAloneSpeed(session.spec, contentOf(session.file)) ?? null
    }),
    // HOW MANY ENCODER PROCESSES ARE RUNNING, asked of the one thing that
    // makes and unmakes them. This used to be two counts of one fact, taken
    // by walking the session registry — one per session, one per run — and
    // they agreed only while a session held at most one run.
    runningEncoders: () => parts.encodeOrchestrator.runningCount(),
    encodersRunningNow: () => parts.encodeOrchestrator.runningCount(),
    torrentCostSecFor: (session) => parts.hostLoad.torrentCostSecFor(session),
    runsFor: (session) => parts.encodeRuns.runsOf(session),
    stateFor: (session) => parts.encodeRuns.runStateOf(session)
  });
  // WHICH HEIGHTS ARE ON THE MENU, which is the arithmetic above plus three
  // things that are nothing to do with it: whose answer it is, what may never
  // be withdrawn, and when the answer may be reused.
  parts.qualityOffer = new QualityOffer({
    encodeCost: parts.encodeCost,
    occupiedCostSec: (fileKey) => parts.admission?.occupiedCost({ exceptFileKey: fileKey }).costSec ?? 0,
    occupancyKnownFor: (fileKey) => (parts.admission?.occupiedCost({ exceptFileKey: fileKey }).unpriced ?? 0) === 0,
    outputs: parts.outputs,
    stateFor: (session) => parts.encodeRuns.runStateOf(session),
    // WHICH HEIGHTS A LIVE VIEWER HAS ON SCREEN, as numbers. Who is watching
    // what is the viewer layer's, and which session is which height is the
    // film's shape; neither travels — what crosses is the list of heights.
    heightsOnScreen: (owner) => parts.quality.heightsOnScreen(owner),
    // WHAT THE SWARM IS DOING WITH THIS FILE. Three readings, taken by
    // whoever reads it and handed over as three numbers: the speed this
    // file's own interruptions demand, the megabytes a second a viewer draws
    // through it, and what a megabyte costs this process.
    supplyFor: (file) => ({
      requiredSpeed: parts.hostLoad.requiredSpeedFor(file.sourceKey, file.fileIndex),
      megabytesPerSecond: parts.hostLoad.torrentMegabytesPerSecond(
        file.sourceKey,
        file.fileIndex,
        file.lengthBytes ?? parts.hostLoad.fileLengthByKey.get(file.key) ?? null,
        file.durationSeconds
      ),
      costPerMegabyte: parts.hostLoad.observedTorrentCostPerMegabyte
    })
  });
  // The priority map, built from where the viewers are and handed to both
  // sides that act on it. The downloading lives in another thread, so its
  // copy travels over the worker channel.
  parts.priority = new PriorityOrchestrator({
    publish: ({ sourceKey, fileIndex, durationSeconds, zones }) => {
      void Promise.resolve(
        parts.setPriorityMap?.({ sourceKey, fileIndex, durationSeconds, zones })
      ).catch(() => {});
    },
    get viewers() { return parts.viewers; },
    // WHERE THE TWO FACTS MEET, and this is the only place that holds both.
    // Which step is on somebody's screen belongs to the person; which output
    // a step supersedes belongs to the film's shape. Neither layer is handed
    // the other — one gets a plain id, the other is read for one field.
    watchedBy: (session, viewer) => !parts.outputs.supersededBy(session, viewer.activeVariantId ?? null),
    urgentReadyFor: (session, viewer, seconds, now) => {
      if (parts.subtitleReadyFor?.(viewer) === false) return false;
      return urgentOutputsReady({
        sourceKey: session.file.sourceKey, fileIndex: session.file.fileIndex,
        durationSeconds: session.file.durationSeconds, atSeconds: viewer.positionSeconds(now) ?? 0, seconds,
        outputs: parts.outputs.values(),
        consumed: (output) => parts.viewers.forOutput(output).has(viewer.id) &&
          !parts.outputs.supersededBy(output, viewer.activeVariantId ?? null),
        segmentIndex: (output, at) => parts.outputTimes.segmentIndexForTime(output, at),
        segmentStart: (output, index) => parts.outputTimes.segmentStartTime(output, index),
        closed: (key, index) => parts.segmentStore.isClosed(key, index)
      });
    },
    allowanceFor: (session) => minimumBufferFrom({
      segmentSeconds: parts.segmentDurationSec,
      worstSupplyWaitSec: parts.hostLoad.supplyFor(session.file)?.worstWaitSec
    })?.seconds ?? parts.segmentDurationSec
  });
  // WHETHER THE WHOLE MACHINE HAS A PLACE for one more encoder, across outputs.
  // Given what it cannot hold itself: what runs (the orchestrator's), what is
  // being prepared (the viewers' records), what an output costs (the encoding
  // cost) and how much of the machine nobody has priced (the host's reading).
  parts.admission = new EncodeAdmission({
    liveRunsByAddress: () => parts.encodeOrchestrator.liveRunsByAddress(),
    preparedAddresses: () => {
      const addresses = new Set();
      for (const id of outputsBeingPrepared(parts.viewers)) {
        const key = parts.outputs.get(id)?.outputKey;
        if (key) {
          addresses.add(key);
        }
      }
      return addresses;
    },
    // Every output a present viewer RECEIVES — by the same rule the per-output
    // priority map is built by — that still has something left to make. The
    // place an output is opened on is held from the moment its viewer is put
    // on it, not from when the plan gets round to its first encoder.
    watchedAddresses: () => {
      const addresses = new Set();
      for (const session of parts.outputs.values()) {
        const address = session.outputKey;
        if (!address || addresses.has(address) || finishedOutput(session)) {
          continue;
        }
        for (const viewer of parts.viewers.forOutput(session).values()) {
          if (viewer.isPresent() && !parts.outputs.supersededBy(session, viewer.activeVariantId ?? null)) {
            addresses.add(address);
            break;
          }
        }
      }
      return addresses;
    },
    finished: (address) => parts.outputs.outputsOn(address).some((session) => finishedOutput(session)),
    loadOf: (address) => parts.encodeCost.loadOfOutput(address),
    loadForCandidate: (spec, file) => parts.encodeCost.loadForCandidate(spec, file),
    availability: () => parts.hostLoad.hostAvailability ?? null
  });
  parts.encodeOrchestrator = new EncodeOrchestrator({
    inputDemandChanged: (address, windows) => {
      for (const output of parts.outputs.outputsOn(address)) parts.encodeInputs?.retain(output, windows);
    },
    admission: parts.admission,
    // What the viewers actually waited for, by band. The ledger is the
    // priority layer's; the encoding is handed a way to ask it.
    describeWaits: (address) => waits.describe(address),
    maxRunsFor: (address) => parts.encodeRuns.maxRunsForOutput(address),
    makeRun: ({ address, from, to, because }) => parts.encodeRuns.makeRunAt(address, from, to, because),
    segmentSeconds: parts.segmentDurationSec,
    contentionPenalties: parts.contentionPenalties,
    startingSpeedFor: (address) => parts.encodeCost.speedForOutput(address),
    segmentCoverage,
    // HOW IT ASKS TO DECIDE AGAIN. A plan that refuses to place anything
    // because an output's input is away needs something to bring it back:
    // nothing about the state changes while the data is missing, so no event
    // arrives on its own.
    planSoon: () => parts.encodeRuns.planEncodersSoon(),
    logger
  });
  // What a start and a stop were measured to cost here, before any viewer
  // existed. Without it both read zero at a cold open, and zero is not
  // "unmeasured" — it is "free", which is what moved an encoder between two
  // adjacent numbers every half second in the field.
  parts.encodeOrchestrator.noteStartupCosts(startStopCost);
  // Where each file is cut, held once per file and grid rather than once per
  // session. Two sessions of one film MUST agree about this to the
  // millisecond — a segment made by either has to be appendable where the
  // other's would have gone — and until now they agreed by copying, which is
  // a thing somebody has to remember to do and which drifted twice in the
  // field. They share the table now.
  parts.timelines = new Timelines();
  // The files this proxy is serving, one object per file however many
  // sessions are of it. It holds the file's key — which every cache about a
  // file is keyed by — its name, and the facts a probe returned.
  parts.sourceFiles = new SourceFiles();
  parts.cleanupTimer = setInterval(() => {
    void parts.lifecycle.cleanupExpired();
  }, CLEANUP_INTERVAL_MS);
  parts.cleanupTimer.unref();
  // How long after material stops being read somebody asks for it again — the
  // one term of the keeping period that is guessed rather than measured, and
  // the only place it can be measured from.
  parts.returns = new Returns();
  parts.encodeInputs = encodeInputs ?? (typeof resolveEncodeInput === "function" ? new EncodeInputs({
    resolve: resolveEncodeInput,
    readRanges: readEncodeRanges,
    heldRanges: readEncodeHeldRanges,
    reviseBudget: () => parts.machineBudget.revise(),
    capacity: () => parts.machineBudget.capacityOf("memory"),
    urgent: (output, index) => parts.encodeOrchestrator.wantedSegmentsOn(output.outputKey).some(window =>
      index >= window.from && index <= window.to && window.urgent === true),
    log: line => logger.info(line),
    changed: (output, result) => {
      if (result.kind === "terminal") {
        logger.warn(`encode input output=${output.outputKey} terminal=${result.reason}: ${result.message ?? ""}` +
          (Number.isFinite(result.bytes) ? ` bytes=${result.bytes} capacity=${result.capacity}` : ""));
        parts.serving.invalidateWaits(output);
      }
      parts.encodeRuns.planEncodersSoon();
    },
    failed: (output, error) => {
      logger.warn(`encode input output=${output.outputKey} failed: ${error.message}`);
      parts.serving.invalidateWaits(output);
    }
  }) : null);
  // One owner of the disk, and the list of what takes it lives with the owner.
  parts.machineBudget = wireMachineBudget({
    segmentStore: parts.segmentStore,
    spill: parts.spillDisk,
    wholeFiles: parts.wholeFiles,
    diagnostics: parts.diagnostics,
    diagnosticsRoot: parts.diagnosticsRoot,
    memory: parts.memoryClaimant,
    encodeInputs: parts.encodeInputs,
    indexMemory,
    policy: parts.budgetPolicy ?? undefined,
    readFree: freeBytesFor,
    logger
  });
  // Realtime-budget monitor: only meaningful for the software encoder with a
  // benchmark (the only path that can pick/step resolution). Cheap no-op scan
  // otherwise.
  // The quality budget: what each output is asked to step to, and the bitrate ceiling a viewer's link sets. Everything it reads of the rest of the proxy is listed here.
  parts.quality = new QualityController({
    serviceShare,
    // The longest an output of this mode has been seen taking to be ready for
    // a viewer moving onto it, in milliseconds, or null.
    observedPreparationMs: (output) => {
      const seconds = parts.localObservations?.longestPreparationSec(output?.spec) ?? null;
      return seconds === null ? null : seconds * 1000;
    },
    // WHAT ENCODING IS TOLD ABOUT A PERSON: values, by name. Not the viewer,
    // whose record belongs to the viewer layer and is written only there.
    consumersOn: (output) => consumersOn(parts.viewers, output),
    qualityModeOf: (output, consumerId) => qualityModeOf(parts.viewers, output, consumerId),
    stepOnScreenOf: (output, consumerId) => stepOnScreenOf(parts.viewers, output, consumerId),
    standingAskOf: (output, consumerId) => standingAskOf(parts.viewers, output, consumerId),
    askQualityOf: (output, consumerId, height, reason, now, urgent) =>
      askQualityOf(parts.viewers, output, consumerId, height, reason, now, urgent),
    // What a viewer's page said about their buffer and the picture they see
    // (roadmap item 98), as values.
    bufferOf: (output, consumerId, spanSec) => bufferOf(parts.viewers, output, consumerId, spanSec),
    visiblePictureOf: (output, consumerId) => visiblePictureOf(parts.viewers, output, consumerId),
    // How soon another output of this mode could have the piece a viewer needs,
    // computed from this host's measured wait for a first output and the
    // output's own measured speed.
    computedPreparationSec: (output) => secondsToFirstPiece({
      firstByteWaitSec: parts.encodeOrchestrator?.runCostSeconds().firstByteWaitSec ?? 0,
      segmentDurationSec: parts.segmentDurationSec,
      speed: parts.encodeCost.speedForOutput(output?.outputKey ?? "")
    }),
    dropAskOf: (output, consumerId) => dropAskOf(parts.viewers, output, consumerId),
    // EACH viewer's own link and who is present: a thin link decides for the
    // person on it and for nobody else (roadmap item 97, step 11), so the
    // budget asks per viewer instead of taking the worst over all of them.
    presentOn: (output) => presentOn(parts.viewers, output),
    linkReportOf: (output, consumerId) => linkReportOf(parts.viewers, output, consumerId),
    // The soundtrack a viewer receives, as part of the load their link carries.
    viewerAudioLoadOf: (base, consumerId) => parts.renditions.viewerAudioLoadOf(base, consumerId),
    // The first lever on a viewer's link: another limit of the height on their
    // screen, prepared and moved to without their player being told.
    prepareSameHeightSwitch: (output, consumerId, direction, reason) =>
      parts.renditions.prepareSameHeightSwitch(output, consumerId, direction, reason),
    sameHeightSwitchPending: (consumerId) => parts.renditions.sameHeightSwitchPending(consumerId),
    sameHeightSwitchDirection: (consumerId) => parts.renditions.sameHeightSwitchDirection(consumerId),
    cancelSameHeightSwitch: (consumerId, reason) => parts.renditions.cancelSameHeightSwitch(consumerId, reason),
    heightReadyFor: (base, consumerId, height) => parts.renditions.heightReadyFor(base, consumerId, height),
    isLive: (...args) => parts.encodeRuns.isLive(...args),
    liveConsumers: (...args) => parts.renditions.liveConsumers(...args),
    liveRunsOf: (...args) => parts.encodeRuns.liveRunsOf(...args),
    producedNumbers: (...args) => parts.serving.producedNumbers(...args),
    reportHostLoad: (...args) => parts.hostLoad.reportHostLoad(...args),
    runStateOf: (...args) => parts.encodeRuns.runStateOf(...args),
    sampleDownloadRates: (...args) => parts.hostLoad.sampleDownloadRates(...args),
    get encodeCost() { return parts.encodeCost; },
    get getSourceStats() { return parts.getSourceStats; },
    get outputs() { return parts.outputs; },
    get qualityOffer() { return parts.qualityOffer; },
    get segmentDurationSec() { return parts.segmentDurationSec; },
    segmentPaths,
    get videoEncoder() { return parts.encoders.current; },
  });
  parts.budgetTimer = setInterval(() => {
    parts.cushion.reportCushions();
    void parts.quality.runQualityBudgetOnce();
  }, BUDGET_CHECK_INTERVAL_MS);
  parts.budgetTimer.unref();
  return parts;
}
