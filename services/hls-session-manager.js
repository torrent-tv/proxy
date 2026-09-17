/**
 * @file HLS transcode session manager.
 *
 * Spawns one ffmpeg process per unique source+settings combination and
 * streams the resulting HLS playlist and segments from a temporary directory.
 * Sessions are expired automatically via a periodic cleanup interval, or
 * immediately when all registered consumers release them.
 */

import { readdirSync, statSync, } from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger.js";
import { KeyframeTables } from "./media/KeyframeTables.js";
import { waits } from "./priority/WaitLedger.js";
import { readMachineState, readProcessCpuSeconds, readProxyCpuSeconds, readSystemCpu, shareOfMachine } from "./host-load.js";
import { minimumBufferFrom } from "./supply-margin.js";
import { PriorityOrchestrator } from "./priority/PriorityOrchestrator.js";
import {
  ENCODE_RUN_EVENT,
} from "./encode/encode-run-state.js";

import {
  softwareDescriptor,
} from "./hwaccel.js";
import { resolveSegmentFormat, } from "./segment-formats/index.js";
import { Timelines } from "./output/Timeline.js";
import { SourceFiles } from "./source/SourceFile.js";
import { SegmentStore } from "./segment-store/SegmentStore.js";
import { EncodeCost } from "./quality/EncodeCost.js";
import { QualityOffer } from "./quality/QualityOffer.js";
import {
  ffmpegSeconds,
  onKeyframeGridFor,
  seekLandingOffsetFor,
  segmentCutTimesFrom,
} from "./encode/run-command.js";
// Re-exported because four of them are read by tests that name this module, and
// what they pin — where a run begins, where it cuts, which timeline it works on
// — did not move when the code did.
export { ffmpegSeconds, onKeyframeGridFor, seekLandingOffsetFor, segmentCutTimesFrom };
import { viewersOf } from "./viewer/Viewer.js";
import { activeOutputFor } from "./viewer/active-output.js";
import { worstLinkReading } from "./viewer/link-readings.js";
import { viewerSecondsOn, } from "./viewer/positions.js";
import { Viewers } from "./viewer/Viewers.js";
import { OutputCatalog } from "./output/OutputCatalog.js";
import { ViewerRequests } from "./serving/ViewerRequests.js";
import { OutputLifecycle } from "./serving/OutputLifecycle.js";
import { SegmentServing } from "./serving/SegmentServing.js";
import { audioStartSecondsFor } from "./viewer/audio-start.js";
import { audioRenditionName } from "./media/audio-inventory.js";
import { Renditions } from "./encode/Renditions.js";
import { LOOKAHEAD_PAUSE_SECONDS } from "./encode/CushionReport.js";
import { CushionReport } from "./encode/CushionReport.js";
import { EncodeRuns } from "./encode/EncodeRuns.js";
import { OutputTimes } from "./encode/OutputTimes.js";
import { HostLoad } from "./quality/HostLoad.js";
import { HostTimings } from "./quality/HostTimings.js";
import { BUDGET_CHECK_INTERVAL_MS, QualityController } from "./quality/QualityController.js";
import { EncodeOrchestrator } from "./encode/EncodeOrchestrator.js";
import { wireMachineBudget } from "./storage/wire.js";
import { Returns } from "./storage/returns.js";
import { freeBytesFor } from "./storage/free.js";

// Where a variant and an audio rendition live under a session — `v/<height>/…`
// and `a/<track>/…` — is stated in `output/playlists.js`, beside the lines that
// write those addresses into a master playlist. The routes that parse them back
// are in `server.js`.

/**
 * Which segment numbers a session actually holds, across every run it has had.
 *
 * A name is not a segment. The `segment` muxer creates its output file when it
 * OPENS it, so a run that is stopped or killed with a piece open leaves a file
 * of zero bytes behind — and that file's name is indistinguishable from a
 * finished piece's. Field 2026-09-03: a run was suspended 548 ms after it
 * started with `segment-00025.mp4` newly opened; the empty file then closed the
 * only hole in the numbering, the look-ahead read `420s ahead of the viewer`
 * and kept the encoder stopped, while the serving path refused the same file as
 * short of a track. The encoder was stopped because the segment was on disk and
 * the segment was refused because it was empty, and neither side could see the
 * other's reason. Both sides ask this function now.
 *
 * A number counts when SOME run holds a non-empty copy of it — which is exactly
 * the condition under which the serving path can answer, since it falls back
 * through the runs to the newest copy that carries every track.
 *
 * Sizes are asked of the filesystem once per file: a piece that has bytes in it
 * never loses them, and a run rewriting the same number writes into a directory
 * of its own. Without that memory this walks every segment of every run on
 * every request — 1350 of them for a 90-minute film — on the thread that also
 * carries the data channel.
 *
 * @param {string[]} dirs - Run directories, newest first.
 * @param {{ isSegmentFileName: (name: string) => boolean, segmentIndexFromName: (name: string) => number }} segmentFormat
 * @param {Set<string>} knownNonEmpty - Paths already seen carrying bytes; added to.
 * @returns {Set<number>}
 */
export function usableSegmentIndices(dirs, segmentFormat, knownNonEmpty) {
  const present = new Set();
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: false });
    } catch {
      continue; // The run's directory is gone; the others still answer.
    }
    for (const name of names) {
      if (!segmentFormat.isSegmentFileName(name)) {
        continue;
      }
      const index = segmentFormat.segmentIndexFromName(name);
      if (index < 0) {
        continue;
      }
      const full = path.join(dir, name);
      if (!knownNonEmpty.has(full)) {
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          continue; // Vanished between the listing and the question.
        }
        if (size === 0) {
          continue; // Opened, nothing written into it yet — or ever.
        }
        knownNonEmpty.add(full);
      }
      present.add(index);
    }
  }
  return present;
}

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
 * Parse an ffmpeg `HH:MM:SS.mmm` timestamp string into total seconds.
 * Returns `null` if the value is absent or malformed.
 *
 * @param {string | undefined} value
 * @returns {number | null}
 */

/**
 * Compute derived progress metrics from raw ffmpeg output values.
 *
 * When `startPositionSeconds` is provided (seek-restart case), progress is
 * computed relative to the remaining duration after the seek point so the
 * percent value reflects transcoding of the requested segment, not the whole
 * file.
 *
 * @param {number} processedSeconds   - Output timestamp of last encoded frame.
 * @param {number | null} totalSeconds - Total duration, or `null` if unknown.
 * @param {number} [startPositionSeconds=0] - Seek offset used for this session.
 * @returns {{ totalSeconds: number | null, percent: number | null, remainingSeconds: number | null, processedSeconds: number }}
 */


/**
 * @typedef {Object} HlsSessionManagerOptions
 * @property {boolean} enabled              - Whether HLS transcoding is enabled.
 * @property {string}  ffmpegBin            - Path to the ffmpeg executable.
 * @property {string}  localBindHost        - Host the proxy HTTP server is bound to.
 * @property {number}  localPort            - Port the proxy HTTP server is listening on.
 * @property {number}  [segmentDurationSec] - HLS segment length in seconds.
 * @property {number}  [sessionTtlMs]       - Session idle TTL in milliseconds.
 * @property {number}  [startupWaitMs]      - Max time to wait for the first playlist file.
 * @property {string}  [segmentFormatId]    - Output container: "fmp4" (default)
 *   or "mpegts". See `./segment-formats/index.js`.
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
 * Manages HLS transcode sessions backed by ffmpeg child processes.
 *
 * One session is created per unique (source, fileIndex, transcode settings)
 * combination. Sessions are reused across consumers and are automatically
 * expired after {@link HlsSessionManagerOptions.sessionTtlMs} of idle time.
 */
export class HlsSessionManager {
  /**
   * Recent times from session-create to a servable first segment, in ms.
   * See #rememberFirstSegmentLatency.
   *
   * @type {number[]}
   */

  // What an encoder taught this host — the cost of decoding a file, of
  // copying its picture, of each of its soundtracks — is held by the object
  // that reads it (`quality/EncodeCost.js`), together with the last refusal
  // it printed. The three methods that LEARN those costs are still here and
  // write into it; moving them is the next step, and until then there must
  // not be two copies of one reading.

  /**
   * @param {HlsSessionManagerOptions} options
   */
  constructor({
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
    const self = this;
    // What the torrent and the proxy itself spend on this host, and how fast each watched torrent moves.
    this.hostLoad = new HostLoad({
      readMachineState,
      readProcessCpuSeconds,
      readProxyCpuSeconds,
      readSystemCpu,
      shareOfMachine,
      liveRunsOf: (...args) => self.encodeRuns.liveRunsOf(...args),
      runStateOf: (...args) => self.encodeRuns.runStateOf(...args),
      get getSourceStats() { return self.getSourceStats; },
      get getTorrentTotals() { return self.getTorrentTotals; },
      get outputs() { return self.outputs; },
    });
    // Where each segment of an output begins, and how that table is corrected from what the encoder produced.
    this.outputTimes = new OutputTimes({
      logger,
      runsOf: (...args) => self.encodeRuns.runsOf(...args),
      stopEncodeRun: (...args) => self.encodeRuns.stopEncodeRun(...args),
      planEncodersSoon: (...args) => self.planEncodersSoon(...args),
      get outputs() { return self.outputs; },
      get segmentDurationSec() { return self.segmentDurationSec; },
    });
    // The encoders of this proxy: built where the plan places them, followed while they run, accounted when they end.
    this.encodeRuns = new EncodeRuns({
      logger,
      softwareDescriptor,
      viewerSecondsOn,
      inputOf: (...args) => self.renditions.inputOf(...args),
      producedNumbers: (...args) => self.serving.producedNumbers(...args),
      servesAudioSeparately: (...args) => self.renditions.servesAudioSeparately(...args),
      disposeSession: (...args) => self.disposeSession(...args),
      get contentionPenalties() { return self.contentionPenalties; },
      get encodeCost() { return self.encodeCost; },
      get encodeOrchestrator() { return self.encodeOrchestrator; },
      get ffmpegBin() { return self.ffmpegBin; },
      get outputTimes() { return self.outputTimes; },
      get outputs() { return self.outputs; },
      get priority() { return self.priority; },
      get segmentDurationSec() { return self.segmentDurationSec; },
      get segmentStore() { return self.segmentStore; },
      get videoEncoder() { return self.videoEncoder; },
      set videoEncoder(value) { self.videoEncoder = value; },
    });
    // How much film is ready in front of the viewers, said; and the spare soundtracks fetched once it is full.
    this.cushion = new CushionReport({
      viewerSecondsOn,
      viewersOf,
      SourceFiles,
      logger,
      producedNumbers: (...args) => self.serving.producedNumbers(...args),
      get encodeRuns() { return self.encodeRuns; },
      get fetchWholeFile() { return self.fetchWholeFile; },
      get getCachedAudioTracks() { return self.getCachedAudioTracks; },
      get hostLoad() { return self.hostLoad; },
      get lookaheadSeconds() { return self.lookaheadSeconds; },
      get outputTimes() { return self.outputTimes; },
      get outputs() { return self.outputs; },
    });
    // The steps of a picture and its soundtracks: which output answers each, made when first asked for, and the master playlist listing them.
    this.renditions = new Renditions({
      viewerSecondsOn,
      audioStartSecondsFor,
      activeOutputFor,
      viewersOf,
      audioRenditionName,
      logger,
      placeViewer: (...args) => self.viewerRequests.placeViewer(...args),
      viewerLeaves: (...args) => self.lifecycle.viewerLeaves(...args),
      createOrGetSession: (...args) => self.createOrGetSession(...args),
      planEncodersSoon: (...args) => self.planEncodersSoon(...args),
      releaseSessionConsumer: (...args) => self.releaseSessionConsumer(...args),
      viewerPositionOf: (...args) => self.viewerPositionOf(...args),
      get encodeRuns() { return self.encodeRuns; },
      get fileStartTimeReads() { return self.fileStartTimeReads; },
      set fileStartTimeReads(value) { self.fileStartTimeReads = value; },
      get getCachedAudioTracks() { return self.getCachedAudioTracks; },
      get getCachedMediaInfo() { return self.getCachedMediaInfo; },
      get getContainerMediaInfo() { return self.getContainerMediaInfo; },
      get localBaseUrl() { return self.localBaseUrl; },
      get outputTimes() { return self.outputTimes; },
      get outputs() { return self.outputs; },
      get quality() { return self.quality; },
      get qualityOffer() { return self.qualityOffer; },
      get segmentDurationSec() { return self.segmentDurationSec; },
      get sourceFiles() { return self.sourceFiles; },
      get viewers() { return self.viewers; },
    });
    // Answering a request for a playlist, an init segment or a segment: from the store when the piece is made and whole, otherwise held until it is.
    this.serving = new SegmentServing({
      buildMasterPlaylist: (...args) => self.buildMasterPlaylist(...args),
      declaredTracks: (...args) => self.declaredTracks(...args),
      publishedGridFor: (...args) => self.publishedGridFor(...args),
      runStartTimeFor: (...args) => self.runStartTimeFor(...args),
      get cushion() { return self.cushion; },
      get encodeOrchestrator() { return self.encodeOrchestrator; },
      get encodeRuns() { return self.encodeRuns; },
      get hostTimings() { return self.hostTimings; },
      get lookaheadSeconds() { return self.lookaheadSeconds; },
      get outputTimes() { return self.outputTimes; },
      get outputs() { return self.outputs; },
      get segmentStore() { return self.segmentStore; },
      get startupWaitMs() { return self.startupWaitMs; },
      get viewers() { return self.viewers; },
    });
    // How an output ends: disposed when nobody is left on it and it has been idle, or all at once on shutdown; and the segments an earlier process left behind adopted at startup.
    this.lifecycle = new OutputLifecycle({
      get budgetTimer() { return self.budgetTimer; },
      get cleanupTimer() { return self.cleanupTimer; },
      get encodeRuns() { return self.encodeRuns; },
      get keyframeTables() { return self.keyframeTables; },
      get machineBudget() { return self.machineBudget; },
      get outputTimes() { return self.outputTimes; },
      get outputs() { return self.outputs; },
      get returns() { return self.returns; },
      get segmentStore() { return self.segmentStore; },
      get sessionTtlMs() { return self.sessionTtlMs; },
      get sourceFiles() { return self.sourceFiles; },
      get timelines() { return self.timelines; },
      get viewers() { return self.viewers; },
    });
    // What a viewer asks for: an output of a file, a position, a report of progress.
    this.viewerRequests = new ViewerRequests({
      disposeSession: (...args) => self.disposeSession(...args),
      expectedFirstSegmentMs: (...args) => self.expectedFirstSegmentMs(...args),
      expectedSessionCreateMs: (...args) => self.expectedSessionCreateMs(...args),
      planEncodersSoon: (...args) => self.planEncodersSoon(...args),
      waitUntilReady: (...args) => self.waitUntilReady(...args),
      get decodeCostModel() { return self.decodeCostModel; },
      get enabled() { return self.enabled; },
      get encodeCost() { return self.encodeCost; },
      get encodeRuns() { return self.encodeRuns; },
      get ffmpegBin() { return self.ffmpegBin; },
      get getCachedMediaInfo() { return self.getCachedMediaInfo; },
      get hostLoad() { return self.hostLoad; },
      get hostTimings() { return self.hostTimings; },
      get keyframeTables() { return self.keyframeTables; },
      get localBaseUrl() { return self.localBaseUrl; },
      get outputTimes() { return self.outputTimes; },
      get outputs() { return self.outputs; },
      get quality() { return self.quality; },
      get qualityOffer() { return self.qualityOffer; },
      get renditions() { return self.renditions; },
      get returns() { return self.returns; },
      get segmentDurationSec() { return self.segmentDurationSec; },
      get segmentFormat() { return self.segmentFormat; },
      get segmentStore() { return self.segmentStore; },
      get softwarePresetBenchmark() { return self.softwarePresetBenchmark; },
      get sourceFiles() { return self.sourceFiles; },
      get startupWaitMs() { return self.startupWaitMs; },
      get timelines() { return self.timelines; },
      get tonemapSupported() { return self.tonemapSupported; },
      get videoEncoder() { return self.videoEncoder; },
      get viewers() { return self.viewers; },
    });
    // What this host takes to create an output and to produce its first segment, kept across restarts until the synthetic figure can replace it (CLAUDE.md, host timings).
    this.hostTimings = new HostTimings({
      get segmentDurationSec() { return self.segmentDurationSec; },
      get softwarePresetBenchmark() { return self.softwarePresetBenchmark; },
      get stateDir() { return self.stateDir; },
    });
    this.enabled = Boolean(enabled);
    this.ffmpegBin = ffmpegBin;
    this.keyframeTables = keyframeTables;
    // Where measurements about this host are kept between runs. Empty means
    // beside the installed proxy; a deployment with somewhere persistent to
    // write names it (--state-dir).
    this.stateDir = typeof stateDir === "string" ? stateDir : "";
    // Output container (fMP4/CMAF or MPEG-TS). Everything container-specific —
    // muxer args, file naming, playlist header, per-segment correction — lives
    // in this module; nothing here branches on the format.
    this.segmentFormat = resolveSegmentFormat(segmentFormatId);
    // Optional accessor for media info the playback planner already probed for
    // (sourceKey, fileIndex), so session create can skip its own ffmpeg scan.
    this.getCachedMediaInfo = typeof getCachedMediaInfo === "function" ? getCachedMediaInfo : null;
    // The file's audio tracks, for the master playlist's rendition group. Same
    // inventory the browser's audio menu is built from.
    this.getCachedAudioTracks = typeof getCachedAudioTracks === "function" ? getCachedAudioTracks : null;
    // What a file declares about itself, read by the container layer from the
    // same header its track table comes from: format, duration, and where its
    // own timeline begins. The last of those is why this exists — a soundtrack
    // shipped as its own file has a timeline of its own, and asking ffmpeg for
    // it meant reading a header this proxy had already read.
    this.getContainerMediaInfo =
      typeof getContainerMediaInfo === "function" ? getContainerMediaInfo : null;
    // Fetch one whole file of a source, as a bounded read rather than a
    // selection. Used to pull a soundtrack that ships beside the picture onto
    // the disk while the swarm has capacity to spare — see
    // `#fetchSpareSoundtracks`. Optional: a proxy wired without it simply reads
    // such a soundtrack when it is played.
    this.fetchWholeFile = typeof fetchWholeFile === "function" ? fetchWholeFile : null;
    // Optional async accessor for a source's live download stats, used by the
    // realtime budget to tell a CPU limit from a download-starved input:
    // (sourceKey, fileIndex) => Promise<{ downloadSpeed, fileLength, fileProgress } | null>.
    this.getSourceStats = typeof getSourceStats === "function" ? getSourceStats : null;
    this.setPriorityMap = typeof setPriorityMap === "function" ? setPriorityMap : null;
    this.contentionPenalties = contentionPenalties instanceof Map ? contentionPenalties : null;
    // Seconds of film per second when the picture is COPIED, measured at
    // startup. Nothing else prices that branch: the other benchmarks measure
    // encoding and decoding, and a copy does neither.
    this.copySpeedX = Number.isFinite(copySpeedX) && copySpeedX > 0 ? copySpeedX : null;
    // Totals across every torrent this proxy holds, used to price what the
    // torrent itself costs the machine (item 7). Optional: a proxy wired
    // without it simply never learns that figure.
    this.getTorrentTotals = typeof getTorrentTotals === "function" ? getTorrentTotals : null;
    // The spilled pieces, as a pair of closures over the torrent thread: what
    // they weigh and how to tell them their share. Not the pool — the pool is
    // on the other side of the thread boundary and this side holds none of it.
    this.spillDisk = spillDisk;
    this.wholeFiles = wholeFiles;
    this.diagnostics = diagnostics;
    this.diagnosticsRoot = diagnosticsRoot;
    this.memoryClaimant = memoryClaimant;
    this.budgetPolicy = budgetPolicy;
    // Detected H.264 encoder descriptor (hardware or software). Defaults to
    // software libx264 when no detection result is supplied. May be downgraded
    // to software at runtime if a hardware encode fails.
    this.videoEncoder = videoEncoder ?? softwareDescriptor();
    // Per-preset software encode throughput (pixels/sec) measured at startup,
    // used to pick the best preset per stream. Null when unavailable (hardware
    // encoder, or benchmark skipped/failed).
    this.softwarePresetBenchmark = Array.isArray(softwarePresetBenchmark) ? softwarePresetBenchmark : null;
    // Host decode cost solved at startup from the calibration clips:
    // `a × Mpixel/s + b × Mbit/s + c` seconds of decoding per second of video.
    // A re-encode pays for this as well as for the encoder, and leaving it out
    // is what made the budget offer rungs this host ran at a third of realtime.
    // Null when the clips are missing or the fit was rejected — the budget then
    // prices the encoder alone, as it did before.
    this.decodeCostModel = decodeCostModel ?? null;
    // Whether this ffmpeg build can tone-map HDR→SDR (zscale + tonemap filters).
    // Gates the tonemap chain for HDR sources on the software path.
    this.tonemapSupported = Boolean(tonemapSupported);
    this.segmentDurationSec = segmentDurationSec;
    // How far ahead of the viewer this proxy lets an encoder run, in seconds of
    // playback. Stated rather than kept private, because the browser's forward
    // buffer is bounded by the same quantity and used to carry a copy of its
    // own: a hand-written 30 s, justified in a comment by a DIFFERENT constant
    // (the eight segments that bound a request ahead of the ENCODE HEAD), so
    // three quarters of what the encoder had already produced was thrown away.
    // One figure, said by the side that owns it (roadmap item 4).
    this.lookaheadSeconds = LOOKAHEAD_PAUSE_SECONDS;
    this.sessionTtlMs = sessionTtlMs;
    this.startupWaitMs = startupWaitMs;
    this.localBaseUrl = buildHttpBaseUrl(localBindHost, localPort);
    // Everyone watching anything, one object per person rather than one per
    // person per output. What a viewer chose, where they are and which outputs
    // they are watching are facts about the person; kept per output they were
    // three copies of which two were always stale.
    // Every change to who is watching what re-decides which encoders should
    // exist, because that decision reads nothing else about viewers. It used to
    // be re-taken on a five-second timer instead, which made a just-created
    // output wait up to five seconds before anything noticed it had a viewer.
    this.viewers = new Viewers({ onChange: () => this.planEncodersSoon() });
    // The outputs that exist, and every question about them: the picture a step
    // belongs to, the steps, the soundtracks, the height a step is named by.
    this.outputs = new OutputCatalog({
      fileLengthOf: (session) => this.hostLoad.fileLengthByKey.get(session.file.key) ?? 0,
      largestPieceOf: (address) => this.segmentStore.largestPiece(address)
    });
    // What this host learned last time it ran. Without it every restart shows
    // the first viewer a figure with no measurement behind it.
    this.hostTimings.loadHostTimings();
    // Where produced segments live, addressed by WHAT they are rather than by
    // which session's encoder wrote them. Two sessions of one output — two
    // viewers who opened the same film at different places — write into one
    // directory and each serves what the other has already made. Injectable so
    // a test can give it a root of its own.
    this.segmentStore = segmentStore instanceof SegmentStore
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
    this.encodeCost = new EncodeCost({
      outputs: this.outputs,
      host: () => ({
        benchmark: this.softwarePresetBenchmark,
        decodeModel: this.decodeCostModel,
        contentionPenalties: this.contentionPenalties,
        copySpeedX: this.copySpeedX,
        availability: this.hostLoad.hostAvailability,
        // WHICH encoder this host settled on. Only the software ladder is
        // benchmarked, so a reading taken off a hardware encoder cannot be
        // split into its decode and encode halves and is not filed as one.
        encoderKind: this.videoEncoder?.kind ?? null
      }),
      // HOW MANY ENCODER PROCESSES ARE RUNNING, asked of the one thing that
      // makes and unmakes them. This used to be two counts of one fact, taken
      // by walking the session registry — one per session, one per run — and
      // they agreed only while a session held at most one run.
      runningEncoders: () => this.encodeOrchestrator.runningCount(),
      encodersRunningNow: () => this.encodeOrchestrator.runningCount(),
      torrentCostSecFor: (session) => this.hostLoad.torrentCostSecFor(session),
      boundBy: (session) => this.quality.classifyTranscodeBound(session),
      runsFor: (session) => this.encodeRuns.runsOf(session),
      stateFor: (session) => this.encodeRuns.runStateOf(session),
      progressFor: (session) => this.encodeRuns.progressOf(session)
    });
    // WHICH HEIGHTS ARE ON THE MENU, which is the arithmetic above plus three
    // things that are nothing to do with it: whose answer it is, what may never
    // be withdrawn, and when the answer may be reused.
    this.qualityOffer = new QualityOffer({
      encodeCost: this.encodeCost,
      outputs: this.outputs,
      stateFor: (session) => this.encodeRuns.runStateOf(session),
      // WHICH HEIGHTS A LIVE VIEWER HAS ON SCREEN, as numbers. Who is watching
      // what is the viewer layer's, and which session is which height is the
      // film's shape; neither travels — what crosses is the list of heights.
      heightsOnScreen: (owner) => this.quality.heightsOnScreen(owner),
      // WHAT THE SWARM IS DOING WITH THIS FILE. Three readings, taken by
      // whoever reads it and handed over as three numbers: the speed this
      // file's own interruptions demand, the megabytes a second a viewer draws
      // through it, and what a megabyte costs this process.
      supplyFor: (file) => ({
        requiredSpeed: this.hostLoad.requiredSpeedFor(file.sourceKey, file.fileIndex),
        megabytesPerSecond: this.hostLoad.torrentMegabytesPerSecond(
          file.sourceKey,
          file.fileIndex,
          file.lengthBytes ?? this.hostLoad.fileLengthByKey.get(file.key) ?? null,
          file.durationSeconds
        ),
        costPerMegabyte: this.hostLoad.observedTorrentCostPerMegabyte
      })
    });
    // The priority map, built from where the viewers are and handed to both
    // sides that act on it. The downloading lives in another thread, so its
    // copy travels over the worker channel.
    this.priority = new PriorityOrchestrator({
      publish: ({ sourceKey, fileIndex, durationSeconds, zones }) => {
        void Promise.resolve(
          this.setPriorityMap?.({ sourceKey, fileIndex, durationSeconds, zones })
        ).catch(() => {});
      },
      viewersOf: (session) => viewersOf(session),
      // WHERE THE TWO FACTS MEET, and this is the only place that holds both.
      // Which step is on somebody's screen belongs to the person; which output
      // a step supersedes belongs to the film's shape. Neither layer is handed
      // the other — one gets a plain id, the other is read for one field.
      watchedBy: (session, viewer) => !this.outputs.supersededBy(session, viewer.activeVariantId ?? null),
      allowanceFor: (session) => minimumBufferFrom({
        segmentSeconds: this.segmentDurationSec,
        worstSupplyWaitSec: session.supplyFigures?.worstWaitSec
      })?.seconds ?? this.segmentDurationSec
    });
    this.encodeOrchestrator = new EncodeOrchestrator({
      // What the viewers actually waited for, by band. The ledger is the
      // priority layer's; the encoding is handed a way to ask it.
      describeWaits: (address) => waits.describe(address),
      maxRunsFor: (address) => this.maxRunsForOutput(address),
      makeRun: ({ address, from, to, because }) => this.encodeRuns.makeRunAt(address, from, to, because),
      segmentSeconds: this.segmentDurationSec,
      contentionPenalties: this.contentionPenalties,
      startingSpeedFor: (address) => this.encodeCost.speedForOutput(address),
      segmentStore: this.segmentStore,
      // HOW IT ASKS TO DECIDE AGAIN. A plan that refuses to place anything
      // because an output's input is away needs something to bring it back:
      // nothing about the state changes while the data is missing, so no event
      // arrives on its own.
      planSoon: () => this.planEncodersSoon(),
      logger
    });
    // What a start and a stop were measured to cost here, before any viewer
    // existed. Without it both read zero at a cold open, and zero is not
    // "unmeasured" — it is "free", which is what moved an encoder between two
    // adjacent numbers every half second in the field.
    this.encodeOrchestrator.noteStartupCosts(startStopCost);
    // Where each file is cut, held once per file and grid rather than once per
    // session. Two sessions of one film MUST agree about this to the
    // millisecond — a segment made by either has to be appendable where the
    // other's would have gone — and until now they agreed by copying, which is
    // a thing somebody has to remember to do and which drifted twice in the
    // field. They share the table now.
    this.timelines = new Timelines();
    // The files this proxy is serving, one object per file however many
    // sessions are of it. It holds the file's key — which every cache about a
    // file is keyed by — its name, and the facts a probe returned.
    this.sourceFiles = new SourceFiles();
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired();
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
    // How long after material stops being read somebody asks for it again — the
    // one term of the keeping period that is guessed rather than measured, and
    // the only place it can be measured from.
    this.returns = new Returns();
    // One owner of the disk, and the list of what takes it lives with the owner.
    this.machineBudget = wireMachineBudget({
      segmentStore: this.segmentStore,
      spill: this.spillDisk,
      wholeFiles: this.wholeFiles,
      diagnostics: this.diagnostics,
      diagnosticsRoot: this.diagnosticsRoot,
      memory: this.memoryClaimant,
      policy: this.budgetPolicy ?? undefined,
      readFree: freeBytesFor,
      logger
    });
    // Realtime-budget monitor: only meaningful for the software encoder with a
    // benchmark (the only path that can pick/step resolution). Cheap no-op scan
    // otherwise.
    // The quality budget: what each output is asked to step to, and the bitrate ceiling a viewer's link sets. Everything it reads of the rest of the proxy is listed here.
    this.quality = new QualityController({
      viewersOf: (output) => viewersOf(output),
      worstLinkReading: (output) => worstLinkReading(output),
      isLive: (...args) => self.encodeRuns.isLive(...args),
      liveConsumers: (...args) => self.renditions.liveConsumers(...args),
      liveRunsOf: (...args) => self.encodeRuns.liveRunsOf(...args),
      producedNumbers: (...args) => self.serving.producedNumbers(...args),
      reportHostLoad: (...args) => self.hostLoad.reportHostLoad(...args),
      runStateOf: (...args) => self.encodeRuns.runStateOf(...args),
      sampleDownloadRates: (...args) => self.hostLoad.sampleDownloadRates(...args),
      stopEncodeRun: (...args) => self.encodeRuns.stopEncodeRun(...args),
      planEncodersSoon: (...args) => self.planEncodersSoon(...args),
      get encodeCost() { return self.encodeCost; },
      get getSourceStats() { return self.getSourceStats; },
      get outputs() { return self.outputs; },
      get qualityOffer() { return self.qualityOffer; },
      get segmentDurationSec() { return self.segmentDurationSec; },
      get segmentStore() { return self.segmentStore; },
      get videoEncoder() { return self.videoEncoder; },
    });
    this.budgetTimer = setInterval(() => {
      this.cushion.reportCushions();
      void this.runQualityBudgetOnce();
    }, BUDGET_CHECK_INTERVAL_MS);
    this.budgetTimer.unref();
  }

  /**
   * Build a complete VOD HLS playlist for the full media duration.
   *
   * The playlist lists every segment up-front and is terminated with
   * `#EXT-X-ENDLIST`, so the player knows the total duration and can seek to
   * any position immediately — even before the corresponding segment has been
   * transcoded.  Segments are produced on demand (see {@link getFileStream}).
   *
   * @param {number[]} boundaries - Segment start times (0-based); segment i
   *   spans `[boundaries[i], boundaries[i+1])`.
   * @returns {string}
   */
  /**
   * Keyframe times for a source file, from the container's own index.
   *
   * Cached per (source, file) because the answer never changes for a given
   * file: a second session, a re-open or a seek all reuse the first read
   * instead of repeating it.
   *
   * Reads byte ranges through the proxy's own /stream route, so it goes through
   * the same torrent piece prioritisation as everything else and needs no
   * separate access path.
   *
   * @param {{ sourceKey: string, fileIndex: number, inputUrl: URL, logName: string }} params
   * @returns {Promise<number[] | null>} Ascending seconds, or null when this
   *   file carries no readable index.
   */

  /**
   * Start time of segment `index` AS THE PLAYER WAS TOLD IT — from the boundary
   * table as it stood when this session's playlist text was built.
   *
   * Two tables, deliberately: the live one is corrected as produced segments
   * reveal where the file's cuts truly are, and those corrections are what let a
   * re-encoded rung be forced onto a copied stream's real grid. But the playlist
   * a player is holding was written once and never changes, so a stamp taken
   * from the corrected table describes a timeline nobody sent the player. That
   * is not a subtlety: it cost ten minutes of a dead film on 2026-08-17, the
   * browser asking for two segments 1908 times each.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @returns {number}
   */

  /**
   * Realtime budget monitor (software encoder only). For each active
   * software-transcode session, watch the encoder's cumulative `speed`: when it
   * stays below realtime for a sustained window AND the input is not
   * download-starved (so the limit is the encoder, not the torrent), step the
   * resolution one rung down the ladder and restart the encode at the current
   * segment. Conservative: sustained window, post-action cooldown, a step cap,
   * and a resolution floor (the last ladder rung). No upswitch in v1.
   *
   * @returns {Promise<void>}
   */

  /**
   * Stop encoders that have run too far ahead of their viewer, and release
   * those the viewer has caught up with.
   *
   * The encoder is SUSPENDED, not killed. Killing would be simpler, but
   * restarting it costs about nine seconds on this hardware — the torrent has
   * to serve a fresh position and ffmpeg has to reach its first keyframe — so a
   * viewer reaching the end of the produced range would stall every time.
   * Suspending keeps the process, its open input and its position, and costs
   * nothing to undo.
   *
   * POSIX only. `SIGSTOP` does not exist on Windows, where `process.kill`
   * throws; the attempt is made once per session and, if it fails, that session
   * simply keeps its old unbounded behaviour rather than breaking.
   *
   * @returns {void}
   */

  /**
   * Ask the plan what encoders there should be, and let it act.
   *
   * This is where three separate rules written into this class become one:
   * where a run belongs, when a run has been overtaken, and how many the
   * machine can afford. Each of them was a condition among eleven thousand
   * lines; the plan is a hundred lines of arithmetic over coverage, demand and
   * a budget, with sixteen checks over it and no ffmpeg, session or route
   * behind it.
   *
   * What it is given is deliberately anonymous. Which viewer wants a segment
   * never reaches it — only that somebody does, stated as a span, exactly as
   * the download layer states what it wants of the swarm.
   *
   * @returns {void}
   */

  /**
   * Move this session's encoder run to the state the table says an event leads
   * to, and say so in the log.
   *
   * The log line is the point of it. Every transition a real run makes is
   * printed as state, event and target, so a session can be checked against the
   * specification after the fact — and a pair the table does not declare prints
   * as a refusal, which is a cell nobody considered rather than a line nobody
   * wrote. Five field failures in a row were exactly that.
   *
   * Refusing changes nothing and never throws: an event that means nothing here
   * is ignored, and the caller's own work goes on. The machine this pattern
   * replaces threw from inside a handler, so a refused transition abandoned the
   * rest of it and left the app describing a state it was no longer in.
   *
   * @param {HlsSession} session
   * @param {string} event - One of {@link ENCODE_RUN_EVENT}.
   * @returns {string} The state now in force.
   */

  /**
   * One line per interval about the MACHINE, while an encoder is running on it.
   *
   * The budget predicts a rung from benchmarks taken at startup on an idle box,
   * and on 2026-08-15 it predicted 1.83x for a rung that ran at 0.90-0.999x
   * with nothing else encoding. Every candidate explanation is measurable — the
   * encoder not getting the cores, the machine having dropped its clock or
   * grown hot, the work around the encode costing more than anyone counted —
   * and none of them was being measured, so the gap could only be argued about.
   *
   * Written only while something is encoding, and only when a reading is
   * available: on a host without `/proc` this says nothing at all.
   */

  /** One pass over the sessions. See {@link runQualityBudgetOnce}. */

  /**
   * (Re)start the ffmpeg encode run beginning at segment `startIndex`.
   *
   * Any ffmpeg process currently running for this session is terminated FIRST
   * AND ITS EXIT IS AWAITED before the replacement is spawned into the same
   * directory. This closes a real incident: a fire-and-forget SIGTERM does not
   * mean the process is dead — `ChildProcess.killed` reflects only that a
   * signal was sent, not that the process exited (ffmpeg's own blocking read of
   * our torrent-backed `/stream` input can defer signal handling for a long
   * time while starved). On a rapid sequence of seeks this left multiple
   * ffmpeg processes alive concurrently, all writing into the SAME session
   * directory — observed as `failed to rename file segment-NNNNN.m4s.tmp`
   * (a dying process racing a fresh one) and a zombie process still writing a
   * `.tmp` file ~30s after being "killed" by two LATER restarts, even after the
   * session had already been released. Multiple ffmpeg processes fighting over
   * CPU and the same files on a weak host is what a seek could get "stuck" on.
   *
   * Because this now awaits, a NEWER restart request can arrive while an OLDER
   * one is still waiting for the previous process to die. The attempt object
   * resolves that: each call puts its own on the session, and after the await a
   * call whose attempt has been replaced returns without spawning — only the
   * LATEST requested target ever actually starts a process.
   *
   * Segment files are named with a global index (`-start_number`) so they
   * always line up with the synthetic VOD playlist regardless of where
   * encoding started — this is what makes server-side seeking work.
   *
   * @param {HlsSession} session
   * @param {number} startIndex
   * @param {number} [positionSecondsOverride] - Begin the run at this instant
   *   instead of at the time the playlist gives `startIndex`, keeping the
   *   numbering and the cut list on the published grid. The one caller is the
   *   realignment below: a COPIED picture cannot cut anywhere but at the
   *   source's own keyframes, so its segment #N begins where the file says and
   *   not where the grid does — and the sound that plays with it has to begin
   *   at that same instant, or the two are apart by the difference. The output
   *   is still labelled from the source clock (`-copyts`) and stamped on serve,
   *   so the player sees both at the time the playlist names.
   * @returns {Promise<void>}
   */

  /**
   * Remember how long this host took to make a session's first segment.
   *
   * The browser has to answer "how long until playback" during the gap between
   * the file being downloaded and the first segment existing, and until now it
   * assumed the pipeline merely keeps up with realtime — which on the measured
   * session meant showing 15 s where 3.8 s were left, and showing it as a jump
   * UP from 5.5 s. This host knows the real figure because it has just done it
   * several times: 782 ms, 1052 ms, 1387 ms, 1518 ms on the sessions measured
   * 2026-08-04/05. A median of recent runs is a measurement, not an assumption,
   * and it is per-host, so a weak box and a fast one each get their own.
   *
   * @param {number} latencyMs
   * @returns {void}
   */
  /**
   * What this host should take to produce a first segment, derived from the
   * startup benchmark rather than from any past session.
   *
   * The encoder detection already encodes `testsrc2` through the real HLS
   * pipeline and records each preset's throughput in pixels per second. One
   * segment is `segmentDurationSec x width x height x fps` pixels, so the time
   * to make it follows by division. No coefficient is involved: it is a
   * measurement of this machine taken minutes earlier, applied to a known
   * quantity of work.
   *
   * This is the answer we would LIKE to rely on exclusively — it needs no
   * history, so it is right on a machine's very first run, when nothing has
   * been recorded yet. Whether it is good enough to replace the recorded median
   * is what {@link #compareSyntheticWithMeasured} is for.
   *
   * @param {{ width?: number, height?: number, fps?: number }} [output]
   * @returns {number | null} Milliseconds, or null without a benchmark.
   */

  /** Load them, if any were ever written. Never throws. */

  /** Write them. Best effort: losing them costs a first estimate, nothing more. */

  /**
   * Record how far a produced segment's real start fell from what the playlist
   * declared for it.
   *
   * The playlist's figure comes from the container's keyframe index; the
   * segment's own figure comes from the piece ffmpeg wrote. The difference IS
   * the index's error at that boundary, measured without scanning anything —
   * the piece is already read whole in order to be stamped, and only boundaries
   * that were actually produced are counted, which is to say the parts somebody
   * watched.
   *
   * Counted once per boundary: a segment can be requested again, and a repeat
   * is not new evidence.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @param {number} trueStart - Seconds, read from the piece itself.
   * @param {number} declaredStart - Seconds, from the playlist.
   * @returns {void}
   */

  /**
   * Where the viewer is on this session's timeline, in seconds.
   *
   * The reported seek position when there has been one, otherwise the segment
   * the player last asked for — which is its read head, a little ahead of the
   * picture but never behind it. Used to place a variant's first encode run, so
   * a switch mid-film starts where the viewer is standing.
   *
   * @param {HlsSession} session
   * @returns {number}
   */

  /**
   * Where to start a separately published audio track, in seconds.
   *
   * The player, on changing track, discards the audio it holds and refills from
   * the PICTURE onwards — so that is where the encoder has to begin, and with
   * more than one viewer that means the EARLIEST picture: a run starting at the
   * leader's position has nothing to give the one behind them.
   *
   * The viewer states where they are, in their own link report. It used to be
   * worked out instead, as the read head less the buffer they reported, and
   * that subtraction is only sound with one viewer: the read head is the
   * furthest request of ANY of them while the buffer belongs to whoever
   * reported last, so with two viewers the two halves belong to different
   * people and the error is as large as the buffer is deep.
   *
   * One segment of margin, because the report is up to ten seconds old and the
   * picture has moved on since — a run that begins a little early costs a
   * segment of audio nobody plays, while one that begins a little late is
   * behind the viewer and can only be fixed by restarting it.
   *
   * A browser that reports no position falls back to the old subtraction, with
   * the DEEPEST buffer reported, which errs early — the cheap direction. With
   * no fresh report at all the whole look-ahead is subtracted: it is the
   * furthest the two can be apart, so it cannot leave the run ahead of them.
   *
   * @param {HlsSession} base
   * @returns {number}
   */

  /**
   * Prepare a rung the viewer is about to switch to, without switching to it.
   *
   * The rung does not exist until it is asked for, so the moment the player is
   * told to switch it has nothing to fetch and the viewer watches a spinner
   * while an encoder starts from nothing — measured 2026-08-11 at 15 988 ms for
   * the first segment of a rung producing at 1.2x. Nothing can make that
   * production instant; what CAN be done is to have it happen while the rung
   * the viewer is on is still playing.
   *
   * So this creates and positions the variant and says which segment to wait
   * for, and deliberately does NOT mark it active: the rung on screen keeps its
   * encoder until the player actually moves. Both encoders run for the length
   * of the warm-up, which is the price of the switch not being visible.
   *
   * @param {string} baseSessionId
   * @param {number} height
   * @param {number} positionSeconds - Where the switch will happen.
   * @returns {Promise<{ sessionId: string, fileName: string } | null>}
   */

  /**
   * Answer a request for a file that is not on disk: make sure the encoder is
   * heading for it, and hold the request.
   *
   * @param {HlsSession} session
   * @param {string} fileName
   * @param {boolean} isPlaylist
   * @param {{ requestSeq?: number }} options
   * @returns {{ kind: "warming-up" }}
   */

  /**
   * Return a progress snapshot for the given session, or `null` if not found.
   * Also refreshes the registry access time to prevent the output from expiring.
   *
   * @param {string} sessionId
   * @returns {Promise<object | null>}
   */

  runQualityBudgetOnce(...args) {
    return this.quality.runQualityBudgetOnce(...args);
  }

  offeredHeights(...args) {
    return this.quality.offeredHeights(...args);
  }

  predictOfferedHeights(...args) {
    return this.quality.predictOfferedHeights(...args);
  }

  syntheticFirstSegmentMs(...args) {
    return this.hostTimings.syntheticFirstSegmentMs(...args);
  }

  expectedSessionCreateMs(...args) {
    return this.hostTimings.expectedSessionCreateMs(...args);
  }

  expectedFirstSegmentMs(...args) {
    return this.hostTimings.expectedFirstSegmentMs(...args);
  }

  publishedGridFor(...args) {
    return this.outputTimes.publishedGridFor(...args);
  }

  runStartTimeFor(...args) {
    return this.outputTimes.runStartTimeFor(...args);
  }

  correctBoundaryFromSegment(...args) {
    return this.outputTimes.correctBoundaryFromSegment(...args);
  }

  planEncodersNow(...args) {
    return this.encodeRuns.planEncodersNow(...args);
  }

  planEncodersSoon(...args) {
    return this.encodeRuns.planEncodersSoon(...args);
  }

  maxRunsForOutput(...args) {
    return this.encodeRuns.maxRunsForOutput(...args);
  }

  noteRunEnded(...args) {
    return this.encodeRuns.noteRunEnded(...args);
  }

  resolveVariantSession(...args) {
    return this.renditions.resolveVariantSession(...args);
  }

  resolveVariantFile(...args) {
    return this.renditions.resolveVariantFile(...args);
  }

  prepareAudioTrack(...args) {
    return this.renditions.prepareAudioTrack(...args);
  }

  prepareVariant(...args) {
    return this.renditions.prepareVariant(...args);
  }

  buildMasterPlaylist(...args) {
    return this.renditions.buildMasterPlaylist(...args);
  }

  resolveAudioRenditionFile(...args) {
    return this.renditions.resolveAudioRenditionFile(...args);
  }

  declaredTracks(...args) {
    return this.renditions.declaredTracks(...args);
  }

  getFileStream(...args) {
    return this.serving.getFileStream(...args);
  }

  nextRequestSeq(...args) {
    return this.serving.nextRequestSeq(...args);
  }

  requestStillWanted(...args) {
    return this.serving.requestStillWanted(...args);
  }

  seekEpoch(...args) {
    return this.serving.seekEpoch(...args);
  }

  waitUntilReady(...args) {
    return this.serving.waitUntilReady(...args);
  }

  recordFragmentFar(...args) {
    return this.serving.recordFragmentFar(...args);
  }

  producedSegmentNumbers(...args) {
    return this.serving.producedSegmentNumbers(...args);
  }

  disposeSession(...args) {
    return this.lifecycle.disposeSession(...args);
  }

  cleanupExpired(...args) {
    return this.lifecycle.cleanupExpired(...args);
  }

  disposeAll(...args) {
    return this.lifecycle.disposeAll(...args);
  }

  adoptSegmentsLeftBehind(...args) {
    return this.lifecycle.adoptSegmentsLeftBehind(...args);
  }

  releaseSessionConsumer(...args) {
    return this.lifecycle.releaseSessionConsumer(...args);
  }

  viewerHasGone(...args) {
    return this.lifecycle.viewerHasGone(...args);
  }

  createOrGetSession(...args) {
    return this.viewerRequests.createOrGetSession(...args);
  }

  requestSeek(...args) {
    return this.viewerRequests.requestSeek(...args);
  }

  viewerPositionOf(...args) {
    return this.viewerRequests.viewerPositionOf(...args);
  }

  noteInputBytes(...args) {
    return this.viewerRequests.noteInputBytes(...args);
  }

  getSessionProgress(...args) {
    return this.viewerRequests.getSessionProgress(...args);
  }
}
