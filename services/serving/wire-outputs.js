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
import { waits } from "../viewer/WaitLedger.js";
import { readMachineState, readProcessCpuSeconds, readProxyCpuSeconds, readSystemCpu, shareOfMachine } from "../encode/host-load.js";
import { minimumBufferFrom } from "../torrent/supply-margin.js";
import { PriorityOrchestrator } from "../viewer/PriorityOrchestrator.js";
import { softwareDescriptor } from "../encode/hwaccel.js";
import { resolveSegmentFormat } from "../encode/segment-formats/index.js";
import { Timelines } from "../encode/output/Timeline.js";
import { SourceFiles } from "../media/SourceFile.js";
import { SegmentStore } from "../storage/segment-store/SegmentStore.js";
import { EncodeCost } from "../encode/quality/EncodeCost.js";
import { QualityOffer } from "../encode/quality/QualityOffer.js";
import { viewersOf } from "../viewer/Viewer.js";
import { activeOutputFor } from "../viewer/active-output.js";
import { worstLinkReading } from "../viewer/link-readings.js";
import { viewerSecondsOn } from "../viewer/positions.js";
import { Viewers } from "../viewer/Viewers.js";
import { OutputCatalog } from "../encode/output/OutputCatalog.js";
import { ViewerRequests } from "./ViewerRequests.js";
import { OutputLifecycle } from "./OutputLifecycle.js";
import { SegmentServing } from "./SegmentServing.js";
import { audioStartSecondsFor } from "../viewer/audio-start.js";
import { audioRenditionName } from "../media/audio-inventory.js";
import { Renditions } from "../encode/Renditions.js";
import { CushionReport, LOOKAHEAD_PAUSE_SECONDS } from "../encode/CushionReport.js";
import { EncodeRuns } from "../encode/EncodeRuns.js";
import { OutputTimes } from "../encode/OutputTimes.js";
import { HostLoad } from "../encode/quality/HostLoad.js";
import { HostTimings } from "../encode/quality/HostTimings.js";
import { BUDGET_CHECK_INTERVAL_MS, QualityController } from "../encode/quality/QualityController.js";
import { EncodeOrchestrator } from "../encode/EncodeOrchestrator.js";
import { wireMachineBudget } from "../storage/wire.js";
import { Returns } from "../storage/returns.js";
import { freeBytesFor } from "../storage/free.js";

// Where a variant and an audio rendition live under a session — `v/<height>/…`
// and `a/<track>/…` — is stated in `encode/output/playlists.js`, beside the lines that
// write those addresses into a master playlist. The routes that parse them back
// are in `server.js`.

const CLEANUP_INTERVAL_MS = 30_000;
const DEFAULT_SEGMENT_DURATION_SEC = 4;
// Idle TTL: a session is disposed this long after the last segment/playlist
// access. Long enough that a viewer who pauses, backgrounds the tab, or briefly
// turns the phone off can resume WITHOUT a cold ffmpeg restart (the warm session
// also backs the seamless auto-reconnect). ffmpeg stops producing at the
// look-ahead cap when idle, so a lingering session costs retained segments on
// disk, not sustained CPU. Active playback refreshes the timer on every segment
// fetch, so it never expires mid-watch.
// How long a session outlives the BROWSER, not the viewing. Since server
// 0.8.103 a browser that holds a session re-asserts it every 30 s, so an open
// tab never consumes this at all — not while paused, not across a three-hour
// film. What is left is the case where the browser has genuinely gone: the tab
// was killed without releasing, the phone slept, the network dropped. Keeping
// the session means such a viewer comes back to a warm encoder instead of
// waiting out a cold start; the cost while nobody is there is disk for the
// produced segments, since the encoder is suspended and burns no CPU, and that
// disk is already bounded by the pool's 10 GB cap with eviction. Thirty minutes
// covers a meal, a phone call or a lift ride.
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
 * @property {import("./media/container/KeyframeTable.js").KeyframeTable} keyframes -
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
    decodeCostModel = null,
    getSourceStats = null,
    setPriorityMap = null,
    // What a second job costs on this host, measured at startup. Null when it
    // could not be measured, and then nothing is corrected — the alternative
    // is inventing a penalty, which is the same fault as inventing a fill rate.
    contentionPenalties = null,
    copySpeedX = null,
    tonemapSupported = false,
    getCachedMediaInfo = null,
    getCachedAudioTracks = null,
    getContainerMediaInfo = null,
    fetchWholeFile = null,
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
    budgetPolicy = null}) {
  const parts = {};
  // What the torrent and the proxy itself spend on this host, and how fast each watched torrent moves.
  parts.hostLoad = new HostLoad({
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
    softwareDescriptor,
    viewerSecondsOn,
    inputOf: (...args) => parts.renditions.inputOf(...args),
    producedNumbers: (...args) => parts.serving.producedNumbers(...args),
    servesAudioSeparately: (...args) => parts.renditions.servesAudioSeparately(...args),
    disposeSession: (...args) => parts.lifecycle.disposeSession(...args),
    get contentionPenalties() { return parts.contentionPenalties; },
    get encodeCost() { return parts.encodeCost; },
    get encodeOrchestrator() { return parts.encodeOrchestrator; },
    get ffmpegBin() { return parts.ffmpegBin; },
    get outputTimes() { return parts.outputTimes; },
    get outputs() { return parts.outputs; },
    get priority() { return parts.priority; },
    get segmentDurationSec() { return parts.segmentDurationSec; },
    get segmentStore() { return parts.segmentStore; },
    get videoEncoder() { return parts.videoEncoder; },
    set videoEncoder(value) { parts.videoEncoder = value; },
  });
  // How much film is ready in front of the viewers, said; and the spare soundtracks fetched once it is full.
  parts.cushion = new CushionReport({
    viewerSecondsOn,
    viewersOf,
    SourceFiles,
    logger,
    producedNumbers: (...args) => parts.serving.producedNumbers(...args),
    get encodeRuns() { return parts.encodeRuns; },
    get fetchWholeFile() { return parts.fetchWholeFile; },
    get getCachedAudioTracks() { return parts.getCachedAudioTracks; },
    get hostLoad() { return parts.hostLoad; },
    get lookaheadSeconds() { return parts.lookaheadSeconds; },
    get outputTimes() { return parts.outputTimes; },
    get outputs() { return parts.outputs; },
  });
  // The steps of a picture and its soundtracks: which output answers each, made when first asked for, and the master playlist listing them.
  parts.renditions = new Renditions({
    viewerSecondsOn,
    audioStartSecondsFor,
    activeOutputFor,
    viewersOf,
    audioRenditionName,
    logger,
    placeViewer: (...args) => parts.viewerRequests.placeViewer(...args),
    viewerLeaves: (...args) => parts.lifecycle.viewerLeaves(...args),
    createOrGetSession: (...args) => parts.viewerRequests.createOrGetSession(...args),
    planEncodersSoon: (...args) => parts.encodeRuns.planEncodersSoon(...args),
    releaseSessionConsumer: (...args) => parts.lifecycle.releaseSessionConsumer(...args),
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
    get viewers() { return parts.viewers; },
  });
  // Answering a request for a playlist, an init segment or a segment: from the store when the piece is made and whole, otherwise held until it is.
  parts.serving = new SegmentServing({
    buildMasterPlaylist: (...args) => parts.renditions.buildMasterPlaylist(...args),
    declaredTracks: (...args) => parts.renditions.declaredTracks(...args),
    publishedGridFor: (...args) => parts.outputTimes.publishedGridFor(...args),
    runStartTimeFor: (...args) => parts.outputTimes.runStartTimeFor(...args),
    get cushion() { return parts.cushion; },
    get encodeOrchestrator() { return parts.encodeOrchestrator; },
    get encodeRuns() { return parts.encodeRuns; },
    get hostTimings() { return parts.hostTimings; },
    get lookaheadSeconds() { return parts.lookaheadSeconds; },
    get outputTimes() { return parts.outputTimes; },
    get outputs() { return parts.outputs; },
    get segmentStore() { return parts.segmentStore; },
    get startupWaitMs() { return parts.startupWaitMs; },
    get viewers() { return parts.viewers; },
  });
  // How an output ends: disposed when nobody is left on it and it has been idle, or all at once on shutdown; and the segments an earlier process left behind adopted at startup.
  parts.lifecycle = new OutputLifecycle({
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
  // What a viewer asks for: an output of a file, a position, a report of progress.
  parts.viewerRequests = new ViewerRequests({
    disposeSession: (...args) => parts.lifecycle.disposeSession(...args),
    expectedFirstSegmentMs: (...args) => parts.hostTimings.expectedFirstSegmentMs(...args),
    expectedSessionCreateMs: (...args) => parts.hostTimings.expectedSessionCreateMs(...args),
    planEncodersSoon: (...args) => parts.encodeRuns.planEncodersSoon(...args),
    waitUntilReady: (...args) => parts.serving.waitUntilReady(...args),
    get decodeCostModel() { return parts.decodeCostModel; },
    get enabled() { return parts.enabled; },
    get encodeCost() { return parts.encodeCost; },
    get encodeRuns() { return parts.encodeRuns; },
    get ffmpegBin() { return parts.ffmpegBin; },
    get getCachedMediaInfo() { return parts.getCachedMediaInfo; },
    get hostLoad() { return parts.hostLoad; },
    get hostTimings() { return parts.hostTimings; },
    get keyframeTables() { return parts.keyframeTables; },
    get localBaseUrl() { return parts.localBaseUrl; },
    get outputTimes() { return parts.outputTimes; },
    get outputs() { return parts.outputs; },
    get quality() { return parts.quality; },
    get qualityOffer() { return parts.qualityOffer; },
    get renditions() { return parts.renditions; },
    get returns() { return parts.returns; },
    get segmentDurationSec() { return parts.segmentDurationSec; },
    get segmentFormat() { return parts.segmentFormat; },
    get segmentStore() { return parts.segmentStore; },
    get softwarePresetBenchmark() { return parts.softwarePresetBenchmark; },
    get sourceFiles() { return parts.sourceFiles; },
    get startupWaitMs() { return parts.startupWaitMs; },
    get timelines() { return parts.timelines; },
    get tonemapSupported() { return parts.tonemapSupported; },
    get videoEncoder() { return parts.videoEncoder; },
    get viewers() { return parts.viewers; },
  });
  // What this host takes to create an output and to produce its first segment, kept across restarts until the synthetic figure can replace it (CLAUDE.md, host timings).
  parts.hostTimings = new HostTimings({
    get segmentDurationSec() { return parts.segmentDurationSec; },
    get softwarePresetBenchmark() { return parts.softwarePresetBenchmark; },
    get stateDir() { return parts.stateDir; },
  });
  parts.enabled = Boolean(enabled);
  parts.ffmpegBin = ffmpegBin;
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
  // Fetch one whole file of a source, as a bounded read rather than a
  // selection. Used to pull a soundtrack that ships beside the picture onto
  // the disk while the swarm has capacity to spare — see
  // `#fetchSpareSoundtracks`. Optional: a proxy wired without it simply reads
  // such a soundtrack when it is played.
  parts.fetchWholeFile = typeof fetchWholeFile === "function" ? fetchWholeFile : null;
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
  parts.videoEncoder = videoEncoder ?? softwareDescriptor();
  // Per-preset software encode throughput (pixels/sec) measured at startup,
  // used to pick the best preset per stream. Null when unavailable (hardware
  // encoder, or benchmark skipped/failed).
  parts.softwarePresetBenchmark = Array.isArray(softwarePresetBenchmark) ? softwarePresetBenchmark : null;
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
  parts.viewers = new Viewers({ onChange: () => parts.encodeRuns.planEncodersSoon() });
  // The outputs that exist, and every question about them: the picture a step
  // belongs to, the steps, the soundtracks, the height a step is named by.
  parts.outputs = new OutputCatalog({
    fileLengthOf: (session) => parts.hostLoad.fileLengthByKey.get(session.file.key) ?? 0,
    largestPieceOf: (address) => parts.segmentStore.largestPiece(address)
  });
  // What this host learned last time it ran. Without it every restart shows
  // the first viewer a figure with no measurement behind it.
  parts.hostTimings.loadHostTimings();
  // Where produced segments live, addressed by WHAT they are rather than by
  // which session's encoder wrote them. Two sessions of one output — two
  // viewers who opened the same film at different places — write into one
  // directory and each serves what the other has already made. Injectable so
  // a test can give it a root of its own.
  parts.segmentStore = segmentStore instanceof SegmentStore
    ? segmentStore
    : new SegmentStore({ logger });
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
      availability: parts.hostLoad.hostAvailability,
      // WHICH encoder this host settled on. Only the software ladder is
      // benchmarked, so a reading taken off a hardware encoder cannot be
      // split into its decode and encode halves and is not filed as one.
      encoderKind: parts.videoEncoder?.kind ?? null
    }),
    // HOW MANY ENCODER PROCESSES ARE RUNNING, asked of the one thing that
    // makes and unmakes them. This used to be two counts of one fact, taken
    // by walking the session registry — one per session, one per run — and
    // they agreed only while a session held at most one run.
    runningEncoders: () => parts.encodeOrchestrator.runningCount(),
    encodersRunningNow: () => parts.encodeOrchestrator.runningCount(),
    torrentCostSecFor: (session) => parts.hostLoad.torrentCostSecFor(session),
    boundBy: (session) => parts.quality.classifyTranscodeBound(session),
    runsFor: (session) => parts.encodeRuns.runsOf(session),
    stateFor: (session) => parts.encodeRuns.runStateOf(session),
    progressFor: (session) => parts.encodeRuns.progressOf(session)
  });
  // WHICH HEIGHTS ARE ON THE MENU, which is the arithmetic above plus three
  // things that are nothing to do with it: whose answer it is, what may never
  // be withdrawn, and when the answer may be reused.
  parts.qualityOffer = new QualityOffer({
    encodeCost: parts.encodeCost,
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
    viewersOf: (session) => viewersOf(session),
    // WHERE THE TWO FACTS MEET, and this is the only place that holds both.
    // Which step is on somebody's screen belongs to the person; which output
    // a step supersedes belongs to the film's shape. Neither layer is handed
    // the other — one gets a plain id, the other is read for one field.
    watchedBy: (session, viewer) => !parts.outputs.supersededBy(session, viewer.activeVariantId ?? null),
    allowanceFor: (session) => minimumBufferFrom({
      segmentSeconds: parts.segmentDurationSec,
      worstSupplyWaitSec: session.supplyFigures?.worstWaitSec
    })?.seconds ?? parts.segmentDurationSec
  });
  parts.encodeOrchestrator = new EncodeOrchestrator({
    // What the viewers actually waited for, by band. The ledger is the
    // priority layer's; the encoding is handed a way to ask it.
    describeWaits: (address) => waits.describe(address),
    maxRunsFor: (address) => parts.encodeRuns.maxRunsForOutput(address),
    makeRun: ({ address, from, to, because }) => parts.encodeRuns.makeRunAt(address, from, to, because),
    segmentSeconds: parts.segmentDurationSec,
    contentionPenalties: parts.contentionPenalties,
    startingSpeedFor: (address) => parts.encodeCost.speedForOutput(address),
    segmentStore: parts.segmentStore,
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
  // One owner of the disk, and the list of what takes it lives with the owner.
  parts.machineBudget = wireMachineBudget({
    segmentStore: parts.segmentStore,
    spill: parts.spillDisk,
    wholeFiles: parts.wholeFiles,
    diagnostics: parts.diagnostics,
    diagnosticsRoot: parts.diagnosticsRoot,
    memory: parts.memoryClaimant,
    policy: parts.budgetPolicy ?? undefined,
    readFree: freeBytesFor,
    logger
  });
  // Realtime-budget monitor: only meaningful for the software encoder with a
  // benchmark (the only path that can pick/step resolution). Cheap no-op scan
  // otherwise.
  // The quality budget: what each output is asked to step to, and the bitrate ceiling a viewer's link sets. Everything it reads of the rest of the proxy is listed here.
  parts.quality = new QualityController({
    viewersOf: (output) => viewersOf(output),
    worstLinkReading: (output) => worstLinkReading(output),
    isLive: (...args) => parts.encodeRuns.isLive(...args),
    liveConsumers: (...args) => parts.renditions.liveConsumers(...args),
    liveRunsOf: (...args) => parts.encodeRuns.liveRunsOf(...args),
    producedNumbers: (...args) => parts.serving.producedNumbers(...args),
    reportHostLoad: (...args) => parts.hostLoad.reportHostLoad(...args),
    runStateOf: (...args) => parts.encodeRuns.runStateOf(...args),
    sampleDownloadRates: (...args) => parts.hostLoad.sampleDownloadRates(...args),
    stopEncodeRun: (...args) => parts.encodeRuns.stopEncodeRun(...args),
    planEncodersSoon: (...args) => parts.encodeRuns.planEncodersSoon(...args),
    get encodeCost() { return parts.encodeCost; },
    get getSourceStats() { return parts.getSourceStats; },
    get outputs() { return parts.outputs; },
    get qualityOffer() { return parts.qualityOffer; },
    get segmentDurationSec() { return parts.segmentDurationSec; },
    get segmentStore() { return parts.segmentStore; },
    get videoEncoder() { return parts.videoEncoder; },
  });
  parts.budgetTimer = setInterval(() => {
    parts.cushion.reportCushions();
    void parts.quality.runQualityBudgetOnce();
  }, BUDGET_CHECK_INTERVAL_MS);
  parts.budgetTimer.unref();
  return parts;
}
