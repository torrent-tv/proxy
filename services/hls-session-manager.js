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
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { logger } from "../utils/logger.js";
import { KeyframeTables } from "./media/KeyframeTables.js";
import { waits } from "./priority/WaitLedger.js";
import { probeVideoKeyframeTimes } from "./media/keyframe-probe.js";
import { readMachineState, readProcessCpuSeconds, readProxyCpuSeconds, readSystemCpu, shareOfMachine } from "./host-load.js";
import { minimumBufferFrom } from "./supply-margin.js";
import { PriorityOrchestrator } from "./priority/PriorityOrchestrator.js";
import {
  ENCODE_RUN_EVENT,
  ENCODE_RUN_STATE,
  wireState
} from "./encode/encode-run-state.js";

/** Own package version, stamped onto session-start log lines. */
const PROXY_VERSION = createRequire(import.meta.url)("../package.json").version;
import {
  softwareDescriptor,
  chooseOutputFps
} from "./hwaccel.js";
import {
  parseFfmpegBitrateKbps,
  parseFfmpegDurationSeconds,
  parseFfmpegStartTimeSeconds,
  parseFfmpegStreamCounts,
  parseFfmpegVideoDimensions,
  parseFfmpegVideoFps,
  parseFfmpegHdr
} from "./media/ffmpeg-banner.js";
import { resolveSegmentFormat, SEGMENT_FORMAT_IDS } from "./segment-formats/index.js";
import { AudioOutput, CutGrid, isOutputName, OutputSpec, VideoOutput } from "./output/index.js";
import { Timeline, Timelines } from "./output/Timeline.js";
import { computeCutGrid } from "./output/cut-grid.js";
import { Output } from "./output/Output.js";
import { mediaPlaylistText, } from "./output/playlists.js";
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
import { OutputLifecycle } from "./serving/OutputLifecycle.js";
import { SegmentServing } from "./serving/SegmentServing.js";
import { audioStartSecondsFor } from "./viewer/audio-start.js";
import { audioRenditionName } from "./media/audio-inventory.js";
import { isFamilyConsumerId } from "./encode/Renditions.js";
import { Renditions } from "./encode/Renditions.js";
import { LOOKAHEAD_PAUSE_SECONDS } from "./encode/CushionReport.js";
import { CushionReport } from "./encode/CushionReport.js";
import { formatSeconds, } from "./encode/EncodeRuns.js";
import { EncodeRuns } from "./encode/EncodeRuns.js";
import { OutputTimes } from "./encode/OutputTimes.js";
import { HostLoad } from "./quality/HostLoad.js";
import { HostTimings } from "./quality/HostTimings.js";
import { BUDGET_CHECK_INTERVAL_MS, QualityController } from "./quality/QualityController.js";
import { EncodedOutput } from "./output/EncodedOutput.js";
import { EncodeOrchestrator } from "./encode/EncodeOrchestrator.js";
import { decideOutputFormat } from "./quality/output-format.js";
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
      placeViewer: (...args) => self.#placeViewer(...args),
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
    if (!this.enabled) {
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
      : this.segmentFormat;

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
    const audioSource = this.renditions.resolveAudioSource(sourceKey, fileIndex, normalizedAudioTrack);
    // The file itself, held once for every session of it. Its name, its key and
    // the facts a probe of it returned used to be copied onto each session, so
    // two viewers of one film held two copies of numbers that cannot differ —
    // and twenty places assembled its key by hand to reach the caches that are
    // keyed by a file.
    const file = this.sourceFiles.get(sourceKey, fileIndex, fileName);
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
      ? this.renditions.audioTravelsSeparately({
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
    const audioFile = this.sourceFiles.get(sourceKey, audioSource.fileIndex, audioSource.name);
    const inputFile = audioOnly === true && audioSource.isSidecar ? audioFile : file;
    // Media info (duration/resolution/fps/startTime/HDR) up front, so we can
    // serve a complete VOD playlist (#EXT-X-ENDLIST) with the correct total
    // duration and a fully seekable timeline before a single segment exists.
    // Reuse the planner's probe when it is available and complete — the plan
    // request just ran the same ffmpeg scan over the same input. Fall back to
    // a fresh probe otherwise (proxy restarted between plan and session, or a
    // critical field is missing).
    const mediaInfoStartMs = Date.now();
    const cachedMediaInfo = this.getCachedMediaInfo?.({ sourceKey, fileIndex }) ?? null;
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
    const pictureUrl = file.streamUrl(this.localBaseUrl);
    const mediaInfo = cachedUsable
      ? cachedMediaInfo
      : await probeInputMediaInfo(this.ffmpegBin, pictureUrl.toString());
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
      this.renditions.warmFileStartTime(audioFile);
    }
    // Tone-map an HDR source to SDR only when re-encoding video on the software
    // path and this ffmpeg has the filters. Hardware encoders keep their own
    // (untone-mapped) path for now; when unavailable, HDR falls back to a plain
    // 8-bit convert (washed-out but playable).
    const applyTonemap =
      transcodeVideo === true &&
      mediaInfo.isHdr === true &&
      this.tonemapSupported &&
      this.videoEncoder?.kind === "software";
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
    const readWindowBytes = await this.hostLoad.readWindowBytesFor(
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
    const keyframes = this.keyframeTables.of({ sourceKey, fileIndex });
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
      const { arrived } = await this.keyframeTables.within({ sourceKey, fileIndex, logName });
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
            `${Math.round(this.keyframeTables.budgetMs / 1000)}s, so this session re-encodes the picture ` +
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
      void probeVideoKeyframeTimes(this.ffmpegBin, inputFile.streamUrl(this.localBaseUrl).toString(), 25_000).then((times) => {
        // Into the FILE's table, which the picture, its quality steps and a
        // second viewer's session all hold — so nothing has to be alive for the
        // answer to be kept, and the session this probe was started for may
        // long since have gone. It used to be written onto whichever session
        // was still there, and dropped outright when none was.
        this.keyframeTables.learn({ sourceKey, fileIndex }, { times, format: "packet probe" });
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
    const timeline = this.timelines.get(
      Timelines.keyFor(sourceKey, fileIndex, useKeyframeGrid ? "keyframe" : "uniform"),
      () => {
        const cut = hasDuration
          ? computeCutGrid({
              useKeyframeGrid,
              durationSeconds,
              segDur: this.segmentDurationSec,
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
      encoder: this.videoEncoder,
      benchmark: this.softwarePresetBenchmark,
      cost: {
        decodeModel: this.decodeCostModel,
        observedDecodeCostSec: this.encodeCost.decodeCostFor(SourceFiles.keyFor(sourceKey, fileIndex))?.costSec ?? null,
        requiredSpeed: this.hostLoad.requiredSpeedFor(sourceKey, fileIndex)
      },
      chooseBudget: (params) => this.encodeCost.chooseEncodeBudget(params),
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
        keys: [...this.outputs.values()].map((other) => other.outputKey).concat(this.segmentStore.addresses()),
        readyAt: (key) => this.segmentStore.isClosed(key, timeline.indexForTime(Math.max(0, startPositionSeconds)))
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
      const existing = this.outputs.get(existingId);
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
          const joining = this.viewers.of(existing, consumerId);
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
          this.#placeViewer(existing, joining, startPositionSeconds);
        } else {
          const joining = this.viewers.of(existing, "");
          joining.audio = {
            trackIndex: normalizedAudioTrack,
            transcode: transcodeAudio === true
          };
          this.#placeViewer(existing, joining, startPositionSeconds);
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
        this.outputs.touch(existing);
        try {
          await this.waitUntilReady(existing);
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
    this.hostTimings.rememberSessionCreateLatency(Date.now() - createEntryMs);
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
    this.returns.note({ lastReadAt: this.segmentStore.lastReadAt(spec.toKey()), now: Date.now() });
    this.segmentStore.directoryFor(spec.toKey());
    this.segmentStore.useFormat(spec.toKey(), segmentFormat);

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
    session.predictedSpeedWhenOffered = this.encodeCost.lastPredictedByHeight?.get(output.encodeHeight) ?? null;
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
      const first = this.viewers.of(session, consumerId);
      first.audio = {
        trackIndex: normalizedAudioTrack,
        transcode: transcodeAudio === true
      };
      this.#placeViewer(session, first, startPositionSeconds);
    } else if (!consumerId) {
      const first = this.viewers.of(session, "");
      first.audio = {
        trackIndex: normalizedAudioTrack,
        transcode: transcodeAudio === true
      };
      this.#placeViewer(session, first, startPositionSeconds);
    }
    this.outputs.set(sessionId, session);
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
        `video=${transcodeVideo ? `${this.videoEncoder.name}${output.softwarePreset ? `/${output.softwarePreset}` : ""}` : "copy"} ` +
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
    this.planEncodersSoon();

    try {
      await this.waitUntilReady(session);
      return session;
    } catch (error) {
      if (this.encodeRuns.runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED) {
        await this.disposeSession(session.id);
        throw error;
      }
      // Do not fail session creation on warmup timeout; the synthetic playlist
      // is already available and segments appear as ffmpeg produces them.
      return session;
    }
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
  #placeViewer(session, viewer, positionSeconds) {
    if (viewer.position !== null) {
      return;
    }
    const seconds = Number.isFinite(positionSeconds) && positionSeconds > 0 ? positionSeconds : 0;
    let segment = 0;
    try {
      const index = this.outputTimes.segmentIndexForTime(session, seconds);
      if (Number.isInteger(index) && index >= 0) {
        segment = index;
      }
    } catch {
      // A session whose cut table is not built yet places its viewer at the
      // beginning, which is where the run starts anyway.
    }
    viewer.position = { segment, seconds, at: Date.now(), seeked: null };
    this.planEncodersSoon();
  }

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
    const named = this.outputs.get(sessionId);
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
    this.viewers.of(named, consumerId).moveTo(positionSeconds);
    this.outputs.touch(named);
    this.planEncodersSoon();
    return true;
  }

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
    const session = isOutputName(sessionId) ? this.outputs.get(sessionId) : null;
    if (!session) {
      return 0;
    }
    return viewerSecondsOn(session, consumerId);
  }

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
    const session = this.outputs.get(sessionId);
    if (!session) {
      return;
    }
    session.inputBytes = (session.inputBytes ?? 0) + bytes;
  }

  async getSessionProgress(sessionId, consumerId = "") {
    if (!isOutputName(sessionId)) {
      return null;
    }
    const named = this.outputs.get(sessionId);
    if (!named) {
      return null;
    }
    this.outputs.touch(named);
    // Progress is asked about the stream on screen, which after a quality
    // change is another session. Touching the named one as well is what keeps
    // the family alive: only the ACTIVE variant gets segment requests, so
    // without this the base session would idle out from under its own variants.
    const session = activeOutputFor({ base: named, consumerId, outputs: this.outputs });
    this.outputs.touch(session);
    const warmupTotalSeconds = this.startupWaitMs / 1000;
    const warmupElapsedSeconds = Math.max(
      0,
      (Date.now() - (this.outputs.startedAt(session) ?? Date.now())) / 1000
    );
    // One question, one answer. Run state comes only from the encoding layer.
    const isWarmupPhase = wireState(this.encodeRuns.runStateOf(session)) === "starting";
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
    const outputMbps = await this.quality.observedStreamMbps(session);
    const progress = this.encodeRuns.progressOf(session);
    return {
      // The id the caller asked about, not the variant it was answered from —
      // the browser tracks its sessions by the id it was given.
      sessionId: named.id,
      state: wireState(this.encodeRuns.runStateOf(session)),
      // The smallest buffer at which no interruption reaches the viewer, from
      // THIS file's own recent interruptions: one whole segment — the one being
      // played — plus the worst wait that can arrive before the buffer refills.
      // On the field torrent that is 7-9 s where the browser waits for a
      // hand-chosen 25, which is sixteen seconds of staring at a spinner that
      // nothing had shown to be necessary. Null until the reader has seen two
      // interruptions; the browser keeps its own figure until then.
      minimumBufferSeconds: minimumBufferFrom({
        segmentSeconds: this.segmentDurationSec,
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
      segmentDurationSec: this.segmentDurationSec,
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
      offeredHeights: this.qualityOffer.offeredHeights(session),
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
      requestedHeight: this.quality.standingAskFor(named),
      // What this host takes to create a session and to make a first segment.
      // Also on the playback plan, but the browser reads that once per file:
      // measured 2026-08-06 across four seeks, a proxy that had just restarted
      // answered null for both, and every later seek then computed its estimate
      // with one term of four — the figure hit zero after 3.5 s of an 11.8 s
      // wait and read "starting now" for the remaining 8.4 s. This response is
      // polled about every 1.5 s, so carrying them here keeps them current.
      expectedSessionCreateMs: this.expectedSessionCreateMs(),
      expectedFirstSegmentMs: this.expectedFirstSegmentMs(),
      updatedAt: progress.updatedAt,
      error: this.encodeRuns.runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED ? this.encodeRuns.lastErrorOf(session) : ""
    };
  }

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
}
