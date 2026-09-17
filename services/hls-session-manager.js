/**
 * @file HLS transcode session manager.
 *
 * Spawns one ffmpeg process per unique source+settings combination and
 * streams the resulting HLS playlist and segments from a temporary directory.
 * Sessions are expired automatically via a periodic cleanup interval, or
 * immediately when all registered consumers release them.
 */

import { createReadStream, readdirSync, statSync, } from "node:fs";
import { access, readFile, stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
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
import { audioRenditionName } from "./media/audio-inventory.js";
import { AudioOutput, CutGrid, isOutputName, OutputSpec, VideoOutput } from "./output/index.js";
import { Timeline, Timelines } from "./output/Timeline.js";
import { computeCutGrid } from "./output/cut-grid.js";
import { Output } from "./output/Output.js";
import { masterPlaylistText, mediaPlaylistText, } from "./output/playlists.js";
import { SourceFiles } from "./source/SourceFile.js";
import { SegmentStore } from "./segment-store/SegmentStore.js";
import { EncodeCost } from "./quality/EncodeCost.js";
import { QualityOffer } from "./quality/QualityOffer.js";
import {
  ffmpegSeconds,
  onKeyframeGridFor,
  PLAYLIST_FILE_NAME,
  seekLandingOffsetFor,
  segmentCutTimesFrom,
} from "./encode/run-command.js";
// Re-exported because four of them are read by tests that name this module, and
// what they pin — where a run begins, where it cuts, which timeline it works on
// — did not move when the code did.
export { ffmpegSeconds, onKeyframeGridFor, seekLandingOffsetFor, segmentCutTimesFrom };
import { viewersOf } from "./viewer/Viewer.js";
import { activeOutputFor } from "./viewer/active-output.js";
import { audioStartSecondsFor } from "./viewer/audio-start.js";
import { worstLinkReading } from "./viewer/link-readings.js";
import { viewerSecondsOn, viewerSegmentsOn } from "./viewer/positions.js";
import { Viewers } from "./viewer/Viewers.js";
import { OutputCatalog } from "./output/OutputCatalog.js";
import { formatSeconds, earliestRunStart } from "./encode/EncodeRuns.js";
import { EncodeRuns } from "./encode/EncodeRuns.js";
import { PLAYER_BUFFER_HOLE_SEC } from "./encode/OutputTimes.js";
import { OutputTimes } from "./encode/OutputTimes.js";
import { HostLoad } from "./quality/HostLoad.js";
import { HostTimings } from "./quality/HostTimings.js";
import { BUDGET_CHECK_INTERVAL_MS, QualityController } from "./quality/QualityController.js";
import { EncodedOutput } from "./output/EncodedOutput.js";
import { variantHeightsFor } from "./output/ladder.js";
import { EncodeOrchestrator } from "./encode/EncodeOrchestrator.js";
import { encoderInputs } from "./encode/run-inputs.js";
import { decideOutputFormat } from "./quality/output-format.js";
import { wireMachineBudget } from "./storage/wire.js";
import { IDLE_KEEP_MS } from "./storage/keep.js";
import { Returns } from "./storage/returns.js";
import { freeBytesFor } from "./storage/free.js";


// The index of variants. Served from the same route as the media playlist, so
// it needs no path of its own.
const MASTER_PLAYLIST_FILE_NAME = "master.m3u8";
// Where a variant and an audio rendition live under a session — `v/<height>/…`
// and `a/<track>/…` — is stated in `output/playlists.js`, beside the lines that
// write those addresses into a master playlist. The routes that parse them back
// are in `server.js`.

/**
 * The last index of the unbroken run of segments starting at `from`.
 *
 * Null when `from` itself is absent. A hole matters: segments beyond one are
 * not look-ahead, because the viewer cannot reach them until it is filled.
 *
 * @param {Set<number>} present
 * @param {number} from
 * @returns {number | null}
 */
export function contiguousEnd(present, from) {
  if (!present.has(from)) {
    return null;
  }
  let last = from;
  while (present.has(last + 1)) {
    last += 1;
  }
  return last;
}

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

/**
 * How a base files the audio renditions it has made.
 *
 * By the track AND by how it is produced, because those are two different
 * encodes of it: a browser that can decode the track as it stands is served a
 * copy, and one that cannot is served AAC. Two viewers of one picture can
 * legitimately need both.
 *
 * @param {number} trackIndex
 * @param {boolean} transcode
 * @returns {string}
 */
export function audioRenditionKey(trackIndex, transcode) {
  return `${Number(trackIndex) || 0}:${transcode === true ? "aac" : "copy"}`;
}

/**
 * The consumer a base session registers on its variants.
 *
 * Derived from the base's id so it is stable across requests and unique per
 * family: releasing it is how a base lets go of a variant that another family
 * may still be watching.
 *
 * @param {string} baseSessionId
 * @returns {string}
 */
export function variantConsumerId(baseSessionId) {
  return `variant-of:${baseSessionId}`;
}

/**
 * Whether this name belongs to a person or to the family bookkeeping.
 *
 * An output made on behalf of a picture — a quality step, a soundtrack — is
 * created under a made-up name so that the picture ending can let it go. That
 * name is not somebody watching, and it must not enter the viewer registry: a
 * viewer is placed the moment they arrive and counts as present until something
 * says otherwise, so a made-up one would keep its output producing for ever.
 *
 * @param {string} consumerId
 * @returns {boolean}
 */
export function isFamilyConsumerId(consumerId) {
  return typeof consumerId === "string" && consumerId.startsWith("variant-of:");
}

const CLEANUP_INTERVAL_MS = 30_000;
const DEFAULT_SEGMENT_DURATION_SEC = 4;
// How many segments ahead of the current encode head a missing-segment request
// is allowed to be before we restart ffmpeg at that position (server-side seek).
// Requests within the window are served by waiting for the running encode.
const MAX_LOOKAHEAD_SEGMENTS = 8;
const LOOKAHEAD_PAUSE_SECONDS = 120;
// How often each session says what its cushion is. Half a minute: the link
// reports that feed it arrive every ten seconds, and a line per session per
// ten seconds would drown the log on a host serving several.
const CUSHION_REPORT_MS = 30_000;
// How old a viewer's link report may be and still describe where they are. It
// is sent every 10 s, and a seek in between moves them somewhere this cannot
// predict — so anything older is treated as no report at all.
const NET_REPORT_FRESH_MS = 15_000;
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
/**
 * How long produced segments are kept after the last request for them.
 *
 * Long on purpose, and deliberately not the session TTL: an output outlives
 * every session on it, and the reason to keep it is that somebody may ask
 * again — the viewer who closed the tab, or one who has not arrived yet and
 * will find the film already encoded. Reclaiming space is the allowance below,
 * not this; this only stops something nobody has touched all day from sitting
 * there for the life of the process.
 */
const SEGMENT_STORE_IDLE_MS = IDLE_KEEP_MS;
const DEFAULT_STARTUP_WAIT_MS = 5_000;
// Read segment files in large blocks so the body is delivered to the data
// channel in few, big chunks. On a busy ARM host the in-process WebTorrent
// hashing starves the event loop in bursts, so fewer read iterations means
// far less time lost between chunks while serving the first segments.
const SEGMENT_READ_HIGH_WATER_MARK = 4 * 1024 * 1024;

/**
 * Resolve after a given number of milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wait for a child process to exit, with a hard timeout fallback.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<void>}
 */
function waitForChildExit(child, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    setTimeout(finish, timeoutMs);
  });
}

/**
 * Whether a child process has genuinely exited. `ChildProcess.killed` only
 * means `.kill()` was called — the process can stay alive well after that
 * (blocked in I/O, ignoring/delaying the signal). `exitCode`/`signalCode` are
 * only set once the `exit` event has actually fired, so this is the reliable
 * check before treating a directory/file as free for a new process to use.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @returns {boolean}
 */
function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

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
 * Guard against path traversal by restricting file names to the known
 * playlist and segment patterns produced by ffmpeg. Which segment names are
 * legal depends on the active container, so the format decides.
 *
 * @param {string} fileName
 * @param {import("./segment-formats/index.js").SegmentFormat} segmentFormat
 * @returns {boolean}
 */
function isSafeFileName(fileName, segmentFormat) {
  return (
    fileName === PLAYLIST_FILE_NAME ||
    fileName === MASTER_PLAYLIST_FILE_NAME ||
    (segmentFormat.initFileName !== null && fileName === segmentFormat.initFileName) ||
    segmentFormat.isSegmentFileName(fileName)
  );
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


/**
 * Whether this output is cut at times we hand the muxer, rather than at a
 * duration it chooses for itself.
 *
 * A property of the output and not of a run: the cut grid and the branch decide
 * it, so every run of one output answers alike. It decides how a segment is
 * judged finished — see getFileStream.
 *
 * @param {object} session
 * @returns {boolean}
 */
function cutsAtGivenTimes(session) {
  const explicit = session?.segmentFormat?.explicitTimesMuxerArgs?.() ?? null;
  if (!explicit) {
    return false;
  }
  return !session.spec.transcodesVideo || session.timeline?.cutGrid === "keyframe";
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
      inputOf: (...args) => self.#inputOf(...args),
      producedNumbers: (...args) => self.#producedNumbers(...args),
      servesAudioSeparately: (...args) => self.#servesAudioSeparately(...args),
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
      liveConsumers: (...args) => self.#liveConsumers(...args),
      liveRunsOf: (...args) => self.encodeRuns.liveRunsOf(...args),
      producedNumbers: (...args) => self.#producedNumbers(...args),
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
      this.#reportCushions();
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
    const audioSource = this.#resolveAudioSource(sourceKey, fileIndex, normalizedAudioTrack);
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
      ? this.#audioTravelsSeparately({
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
      this.#warmFileStartTime(audioFile);
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
   * The init header, lifted out of the first segment that exists.
   *
   * Needed only on the explicit-cut path, where the muxer produces no init file
   * of its own. Scans rather than assuming segment 0: a run started by a seek
   * begins at whatever index the viewer asked for.
   *
   * @param {HlsSession} session
   * @returns {Promise<Buffer | null>}
   */
  /**
   * The track set this session's output will carry — what the proxy DECLARES,
   * and the one answer both sides must agree on.
   *
   * The source may hold any number of tracks: several dubs, subtitles, even a
   * cover-art video stream. The output does not inherit that list — the command
   * maps at most one video and at most one audio, each optional, and subtitles
   * never enter the HLS output at all (they are served separately as WebVTT).
   * So this is not an inference about the file; it is the proxy stating what it
   * chose to produce.
   *
   * Used in two places, and that is the point: the init segment is checked
   * against it here, and it is sent to the browser so the browser can check
   * what it actually received against the same statement. Without the second
   * check a missing track is only noticed by its absence, minutes later, as a
   * black picture with working sound.
   *
   * @param {HlsSession} session
   * @returns {{ video: boolean, audio: boolean }}
   */
  declaredTracks(session) {
    const probed = this.getCachedMediaInfo?.({
      sourceKey: session.file.sourceKey,
      fileIndex: session.file.fileIndex
    }) ?? null;
    // What the SOURCE has, narrowed to what this session's output carries. A
    // rendition maps only audio and a stream whose audio travels separately
    // maps only video, so answering from the source alone would tell the
    // browser about a track that is not in the stream, and would leave
    // `#initFromFirstSegment` waiting for a second track that no init will ever
    // declare — its warning about a short header would then fire on every one.
    const carriesVideo = session.spec.carries !== "audio-only";
    const carriesAudio = !this.#servesAudioSeparately(session);
    // The soundtrack of this session may not be in the file that was probed. A
    // release that ships its dub as a separate file often ships the picture with
    // no sound of its own at all, and then the picture's probe says there is no
    // audio while the output plainly carries some — which would leave the header
    // check expecting one track where two arrive, and tell the browser its sound
    // was lost.
    const audioFromAnotherFile = session.spec.audioFileIndex !== session.file.fileIndex;
    return {
      video: carriesVideo && Boolean(probed?.videoCodec),
      audio: carriesAudio && (audioFromAnotherFile || Boolean(probed?.audioCodec))
    };
  }

  async #initFromFirstSegment(session) {
    if (typeof session.segmentFormat.extractInit !== "function") {
      return null;
    }
    // How many tracks a complete header must declare is ANSWERED, not assumed.
    //
    // The probe already knows the source's stream list, and the output maps at
    // most one of each (`-map 0:v:0? -map 0:a:0?`), so the count follows from
    // what the source actually has. A film with no soundtrack expects one; an
    // ordinary file expects two; neither is a convention.
    //
    // Deriving it from the produced pieces instead — the first version of this
    // — reads correctly only once a piece carrying every track exists, and the
    // whole point is the moment BEFORE that: early pieces written before the
    // video was muxed would set the requirement to one and wave through exactly
    // the header this exists to reject. The pieces are still consulted, but
    // only as a floor: a piece carrying more than the probe led us to expect is
    // evidence, and evidence outranks the probe.
    const declared = this.declaredTracks(session);
    let expectedTracks = (declared.video ? 1 : 0) + (declared.audio ? 1 : 0);
    if (expectedTracks === 0) {
      // Nothing to consult. Fall back to the evidence, with its known lag.
      expectedTracks = 1;
    }
    let best = null;
    let bestTracks = 0;
    /** @type {Map<string, Buffer>} Pieces read once and used for both passes. */
    const pieces = new Map();
    let names;
    try {
      names = this.#producedNumbers(session).map((index) => session.segmentFormat.segmentFileName(index));
    } catch {
      return null;
    }
    // First pass: what do the produced pieces actually carry? The answer is the
    // requirement — no assumption about the source is involved.
    if (typeof session.segmentFormat.countSegmentTracks === "function") {
      for (const name of names) {
        try {
          // The first copy WITH BYTES IN IT, not the first name: a run stopped
          // with a piece open leaves an empty file under the same name, and
          // taking that one skips a number whose header is sitting in the run
          // before it.
          const found = await this.#firstCopyWithBytes(session, name);
          if (!found) {
            continue;
          }
          const bytes = await readFile(found);
          pieces.set(name, bytes);
          expectedTracks = Math.max(expectedTracks, session.segmentFormat.countSegmentTracks(bytes));
        } catch {
          // Being written right now — it says nothing about the others.
        }
      }
    }

    for (const name of names) {
      try {
        const cached = pieces.get(name);
        const found = cached ? name : await this.#firstCopyWithBytes(session, name);
        if (!found) {
          continue;
        }
        const init = session.segmentFormat.extractInit(cached ?? await readFile(found));
        if (!init || init.length === 0) {
          continue;
        }
        // The requirement computed above is APPLIED here. It was computed and
        // then ignored: this loop returned the first header it found, so a
        // piece written before the video was muxed supplied an audio-only
        // header — and that header is cached for the session's whole life,
        // because the player fetches `#EXT-X-MAP` once. Measured 2026-08-11:
        // `videoWidth=0`, `totalVideoFrames=0`, `readyState=4` — sound playing
        // and no picture, for as long as the session lasted.
        const tracks = typeof session.segmentFormat.countInitTracks === "function"
          ? session.segmentFormat.countInitTracks(init)
          : expectedTracks;
        if (tracks >= expectedTracks) {
          return init;
        }
        if (tracks > bestTracks) {
          best = init;
          bestTracks = tracks;
        }
      } catch {
        // Being written right now — try the next one.
      }
    }
    if (best !== null) {
      // Nothing carried the full set. The source is probably missing a stream;
      // serving the richest header found is right, and saying so makes the
      // other possibility — every piece so far written before the video was
      // muxed — visible rather than silent.
      logger.warn(
        `transcode ${session.id} no piece declared ${expectedTracks} tracks; ` +
        `serving an init with ${bestTracks}`
      );
      return best;
    }
    return best;
  }

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
   * Record where one viewer of this session is, and answer with the furthest
   * any of them has reached.
   *
   * The furthest is what the single encoder is steered by: it has to serve
   * everyone, and what lies behind the leader has already been produced and is
   * served from disk without a wait. The individual positions exist for the
   * opposite question — whether a particular held request is still wanted —
   * which cannot be answered from a shared field.
   *
   * A REQUEST IS NOT A POSITION. It says the viewer is still here and nothing
   * more: where they are is what they themselves state, on the viewer, and a
   * request cannot reach it. Asking for a segment used to write the position,
   * so two writers filled one field in turn and the priority map jumped
   * backwards several times a second — measured 2026-09-13, 77 encoder starts
   * and 141 stops in six minutes while both viewers sat frozen.
   *
   * A viewer is forgotten once nothing has been heard from them for longer than
   * any silence a watching viewer can produce. The figure is the proxy's own
   * look-ahead, not a chosen interval.
   *
   * @param {HlsSession} session
   * @param {string} consumerId
   * @returns {void}
   */
  #noteViewerSeen(session, consumerId) {
    this.viewers.of(session, consumerId).seen();
  }

  /**
   * Answer the player's report that a delivered fragment sits far from the edge
   * of its buffer, with the one fact only this side holds: which boundary the
   * segment of that number really begins at.
   *
   * The player can say the gap; it cannot say whether the cause is its own
   * loading or a run whose output no longer matches its numbering. Here both
   * are in hand — the time the playlist gave that segment, and, when the
   * segment has been served, the time it truly began at — so the line either
   * names a shifted run or clears this side of it.
   *
   * Diagnostic only: nothing is repositioned on the strength of a browser's
   * reading, deliberately, because a wrong answer here would restart an encoder
   * the viewer is waiting on.
   *
   * @param {string} sessionId
   * @param {{ sn: number, track?: string, fragStartSec: number, bufferEndSec: number, currentTimeSec: number }} report
   * @returns {boolean} False when no such session exists.
   */
  recordFragmentFar(sessionId, { sn, track, fragStartSec, bufferEndSec, currentTimeSec }) {
    const named = this.outputs.get(sessionId);
    if (!named) {
      return false;
    }
    // Which of the two streams the report is about. The browser addresses
    // everything to the video session's id — the soundtrack is served under
    // `/a/<n>/` on that same id — but it is a session of its own, with its own
    // run and its own position, and that is exactly the pair this report exists
    // to tell apart. Answering an audio report from the picture's records would
    // state, confidently, something about the wrong stream.
    const onScreen = activeOutputFor({ base: named, outputs: this.outputs });
    const session = track === "audio"
      ? ([...this.outputs.familyOf(onScreen)].find((member) => member.spec.carries === "audio-only") ?? onScreen)
      : onScreen;
    const gap = fragStartSec - bufferEndSec;
    const declared = this.outputTimes.publishedStartTime(session, sn);
    const trueStart = session.trueStartByIndex instanceof Map ? session.trueStartByIndex.get(sn) : undefined;
    const verdict = trueStart === undefined
      // Where a segment truly began is only ever read off one that was cut on
      // an explicit list — a uniform grid has nothing to read back — so this is
      // "not recorded", which is not the same as "not produced", and the line
      // must not claim the second.
      ? "where that segment began is not recorded on this side, so the gap cannot be attributed here"
      : (() => {
        const at = this.outputTimes.boundaryIndexAt(session, trueStart, this.publishedGridFor(session));
        if (at === null) {
          return `it really began at ${trueStart.toFixed(3)}s, which is no boundary of this grid`;
        }
        if (at === sn) {
          return `it really began at boundary #${sn}, where it should — the gap is not this run's`;
        }
        return `it really began at boundary #${at}, ${sn - at} place(s) before its own number — ` +
          "this run's output does not match its numbering";
      })();
    logger.warn(
      `transcode ${session.id} the player is stuck: ${session.spec.carries === "audio-only" ? "sound" : "picture"} ` +
      `fragment #${sn} starts ${gap.toFixed(1)}s past ` +
      `the end of its buffer (${bufferEndSec.toFixed(1)}s, viewer at ${currentTimeSec.toFixed(1)}s, ` +
      `the playlist puts it at ${declared.toFixed(3)}s) — ${verdict}`
    );
    return true;
  }

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
   * Say what the cushion is, for every session.
   *
   * This is all that is left of `#enforceLookAhead`, which also SUSPENDED a run
   * once it was `LOOKAHEAD_PAUSE_SECONDS` in front of the viewer and woke it at
   * `LOOKAHEAD_RESUME_SECONDS` — two chosen numbers, and a second authority
   * over the encoders beside the plan. The two contradicted each other
   * directly: this one deliberately pushed a run past the window the plan was
   * asking about, and the plan then killed it for standing there. Measured in
   * the field 2026-09-05, 350-700ms per cycle, the viewer's picture stopped for
   * 125 seconds.
   *
   * How far ahead a run may get is now a question for the plan alone, which
   * answers it from the demand map. What remains here is a READING — how much
   * film is ready in front of the earliest viewer — and a reading commands
   * nothing.
   */
  #reportCushions() {
    for (const session of this.outputs.values()) {
      this.#reportCushionFor(session);
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
   * Decide whether one session's encoder should be running right now.
   *
   * Called both on the monitor's interval and the moment a segment is
   * requested. It must be the SAME decision in both places: an earlier version
   * simply resumed on any request, which meant a request for a segment produced
   * ten minutes ago released an encoder that had nothing left to do — measured
   * 2026-08-04, the encoder sawtoothed between suspended and running and drifted
   * from 135 s to 702 s ahead of the viewer while doing it.
   *
   * @param {HlsSession} session
   * @returns {void}
   */
  #reportCushionFor(session) {
    if (!this.encodeRuns.isLive(session) || this.encodeRuns.liveRunsOf(session).length === 0) {
      return;
    }
    // How far the encoder has got, measured by what EXISTS. ffmpeg's own
    // report of its timeline position is not evidence: field 2026-08-06, it
    // claimed 6012 s at `speed=1.18e+03x` on a file that was one percent
    // downloaded and had produced exactly one segment. The limiter believed it,
    // suspended the encoder twelve seconds into the session, and segment #1 —
    // which nobody was now making — was held for 45.7 s until the viewer gave
    // up and seeked. A segment on disk is something the viewer can be served;
    // a number from ffmpeg is not.
    // Where the viewer is, from the one reading there is.
    const viewerSegment = this.outputTimes.segmentIndexForTime(session, viewerSecondsOn(session));

    // How much is ready CONTIGUOUSLY FROM WHERE THE VIEWER IS — not the highest
    // segment number lying in the directory. The two are the same only while a
    // viewer moves forward through one run, and the difference destroyed a
    // session on 2026-08-06: a seek forward left segments 662-665 on disk, the
    // viewer then seeked BACK to 646, and the limiter measured 6950 s of output
    // against a viewer at 6700 s, called it "250s ahead" and suspended a run
    // 136 ms after it started, before it had produced anything at all. Nothing
    // was then encoding, so nothing read the input, so no pieces were asked for
    // — `0 selection(s)` with 33 peers connected — and segment 646 was never
    // made. Segments beyond a hole are not look-ahead: the viewer cannot reach
    // them without the hole being filled first.
    const reading = this.#contiguousAheadSeconds(session, viewerSegment);
    const aheadSeconds = reading === null ? null : reading.seconds;
    if (aheadSeconds === null) {
      // The segment the viewer needs does not exist, so there is no cushion to
      // report. Nothing is commanded here any more: whether an encoder should
      // be working on it is the plan's question, and it is asked the moment
      // anything the plan depends on changes.
      return;
    }

    // Worth knowing when ffmpeg's own report and what exists disagree wildly —
    // it is the only trace of whatever made it claim a position it had not
    // reached. Reported on its EDGES, because it is a state and not a stream.
    const claimed = Number(this.encodeRuns.progressOf(session, viewerSegment)?.processedSeconds);
    const encodedTo = this.outputTimes.segmentStartTime(session, viewerSegment) + aheadSeconds;
    this.#sayCushion(session, encodedTo);
    const disagrees =
      Number.isFinite(claimed) && Math.abs(claimed - encodedTo) > LOOKAHEAD_PAUSE_SECONDS;
    if (disagrees && !session.lookAheadDisagreementSince) {
      session.lookAheadDisagreementSince = Date.now();
      logger.info(
        `transcode ${session.id} ffmpeg claims ${Math.round(claimed)}s processed ` +
          `but the viewer's own run of segments ends at ${Math.round(encodedTo)}s`
      );
    } else if (!disagrees && session.lookAheadDisagreementSince) {
      const lastedMs = Date.now() - session.lookAheadDisagreementSince;
      session.lookAheadDisagreementSince = 0;
      logger.info(
        `transcode ${session.id} ffmpeg's position and the segments on disk agree again ` +
          `after ${(lastedMs / 1000).toFixed(1)}s (ready through ${Math.round(encodedTo)}s)`
      );
    }

  }

  /**
   * What the cushion actually is, said once every half minute per session.
   *
   * Three quantities that were never printed together, and could not be
   * reconstructed afterwards from anything that was:
   *
   *   - how far the produced range runs ahead of the EARLIEST viewer's picture,
   *     which is the protection an interruption would have to exhaust before
   *     anybody saw it;
   *   - what that costs the person hosting this proxy, in megabytes of film
   *     pulled off the swarm ahead of the picture — the read window sits on top
   *     of it, so this is a floor;
   *   - what the browsers say they are holding, so the depth asked for on that
   *     side can be checked against the depth that arrived.
   *
   * Every term is measured: the produced range comes from the segments on disk,
   * the picture from the viewers' own reports, and the byte rate from the
   * file's length over its duration. Roadmap item 4.
   *
   * @param {HlsSession} session
   * @param {number} encodedTo - Seconds of film produced, contiguously, from
   *   where the leading viewer is.
   * @returns {void}
   */
  #sayCushion(session, encodedTo) {
    const now = Date.now();
    if (now - (session.cushionSaidAt ?? 0) < CUSHION_REPORT_MS) {
      return;
    }
    const { earliestPosition, deepestBuffer, viewers } = this.#reportedPictureOf(session, now);
    // Nobody has said where they are, so there is no picture to measure
    // against and the line would be about nothing.
    if (earliestPosition === null) {
      return;
    }
    session.cushionSaidAt = now;
    const aheadOfPicture = Math.max(0, encodedTo - earliestPosition);
    const fileLength = this.hostLoad.fileLengthByKey.get(session.file.key);
    const duration = Number(session.file.durationSeconds) || Number(session.file.durationSeconds) || 0;
    const megabytes =
      Number.isFinite(fileLength) && fileLength > 0 && duration > 0
        ? ((aheadOfPicture * fileLength) / duration / 1e6).toFixed(0)
        : "?";
    logger.info(
      `transcode ${session.id.slice(0, 8)} cushion: ${Math.round(aheadOfPicture)}s of film ready ` +
        `ahead of the picture at ${Math.round(earliestPosition)}s (~${megabytes}MB pulled ahead), ` +
        `${viewers} viewer(s) holding up to ` +
        `${deepestBuffer === null ? "?" : deepestBuffer.toFixed(1)}s`
    );
    this.#fetchSpareSoundtracks(session, aheadOfPicture);
  }

  /**
   * Fetch the soundtracks that ship beside this picture, whole, while the swarm
   * has capacity to spare.
   *
   * WHY IT WAITS FOR THE CUSHION. A soundtrack nobody has chosen is worth having
   * on disk — it is a twentieth of the picture (30 MB against 566 MB on the
   * field torrent) and having it makes every later switch instant instead of
   * paying for its first pieces. But fetching it takes swarm capacity from the
   * picture, and there is exactly one moment when that capacity is demonstrably
   * spare: when the encoder is already as far ahead of the viewer as it is
   * allowed to get. That is not a guess about the swarm — it is the measurement
   * the line above just printed.
   *
   * WHY IT IS A READ AND NOT A SELECTION. `file.select()` claims every piece of
   * a file at once, and `#syncSelections` in `torrent-pool.js` records what that
   * cost when it was done alongside the readers' own windows: a claim covering
   * everything always outranked the window, and a seek to 89.1% of a 4.7 GB film
   * waited 93 s while the swarm fetched 2.47 GB in file order. So this goes
   * through the same bounded read the edge warm-up uses, which claims a moving
   * window like any other reader and gives it back when it ends.
   *
   * Once per file, and only for a soundtrack in a file of its own — the
   * picture's own tracks are already in the bytes being played.
   *
   * @param {HlsSession} session
   * @param {number} aheadOfPicture - Seconds of film ready ahead of the viewer.
   * @returns {void}
   */
  #fetchSpareSoundtracks(session, aheadOfPicture) {
    if (typeof this.fetchWholeFile !== "function") {
      return;
    }
    // The encoder is held at this distance and no further, so reaching it is the
    // signal that nothing more is being asked of the swarm on the picture's
    // behalf.
    if (!(aheadOfPicture >= this.lookaheadSeconds)) {
      return;
    }
    const inventory = this.getCachedAudioTracks?.({
      sourceKey: session.file.sourceKey,
      fileIndex: session.file.fileIndex
    }) ?? [];
    if (!(this.spareSoundtracksFetched instanceof Set)) {
      this.spareSoundtracksFetched = new Set();
    }
    const wanted = new Set(
      inventory
        .filter((entry) => entry?.kind === "sidecar" && Number.isInteger(entry.fileIndex))
        .map((entry) => entry.fileIndex)
    );
    for (const fileIndex of wanted) {
      const key = SourceFiles.keyFor(session.file.sourceKey, fileIndex);
      if (this.spareSoundtracksFetched.has(key)) {
        continue;
      }
      this.spareSoundtracksFetched.add(key);
      logger.info(
        `transcode ${session.id.slice(0, 8)} the picture is ${Math.round(aheadOfPicture)}s ahead of ` +
          `the viewer, so file ${fileIndex} — a soundtrack beside it — is fetched whole now; ` +
          "a switch to it will not wait for the swarm"
      );
      // Not awaited: nothing depends on it finishing, and a failure costs only
      // that the switch pays for its own pieces, as it did before this existed.
      Promise.resolve(this.fetchWholeFile({ sourceKey: session.file.sourceKey, fileIndex })).catch(
        (error) => {
          logger.info(
            `transcode: fetching soundtrack file ${fileIndex} whole failed ` +
              `(${error instanceof Error ? error.message : String(error)}) — ` +
              "it will be read when it is played"
          );
        }
      );
    }
  }

  /**
   * Seconds of playback ready without a gap, starting at the segment the viewer
   * is on.
   *
   * Null when that very segment is missing — which is not "zero ahead" but
   * "the viewer is waiting", and the two call for opposite decisions.
   *
   * @param {HlsSession} session
   * @param {number} viewerSegment
   * @returns {{ seconds: number, lastCovered: number, total: number } | null}
   */
  #contiguousAheadSeconds(session, viewerSegment) {
    let present;
    try {
      present = new Set(this.#producedNumbers(session));
    } catch {
      return null;
    }
    const lastCovered = contiguousEnd(present, viewerSegment);
    if (lastCovered === null) {
      return null;
    }
    const from = this.outputTimes.segmentStartTime(session, viewerSegment);
    const to = this.outputTimes.segmentStartTime(session, lastCovered + 1);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return null;
    }
    return { seconds: Math.max(0, to - from), lastCovered, total: present.size };
  }

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
   * Ensure the encoder is producing (or will soon produce) the requested
   * segment.  If the segment is far ahead of the current encode head, or
   * behind it, restart ffmpeg at that segment (server-side seek).  Requests
   * within the look-ahead window are served by waiting for the running encode.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @returns {void}
   */
  #ensureEncodingFor(session, index, requestSeq = Number.MAX_SAFE_INTEGER) {
    // When this segment was FIRST asked for and nobody was producing it. The
    // restart itself costs 0.7-1.3 s (measured 2.9.132), while a seek costs
    // 5-8 s end to end — so most of the wait happens before a restart is even
    // decided on, and that is what this records.
    session.firstWantedAt ??= new Map();
    if (!session.firstWantedAt.has(index)) {
      session.firstWantedAt.set(index, Date.now());
    }
    if (!this.encodeRuns.isLive(session) || index < 0) {
      return;
    }
    // NOTE (2026-08-01): a "only the newest request may steer the encoder"
    // guard was tried here and REVERTED — it made seeking worse, not better.
    // The premise (the newest request is the one the viewer wants) does not
    // hold: when the player cannot get its target segment it starts SCANNING
    // the playlist, firing dozens of requests across the whole file within
    // half a second (field log: #178, #681, #725, #807, #74, #245, #387 …).
    // Under that traffic the newest request is an arbitrary scan probe, so
    // the guard steered the encoder away from the actual seek target, the
    // target segment was never produced, and the player gave up and reset to
    // the start of the file. The ping-pong this tried to fix is real, but the
    // fix has to distinguish a VIEWER seek from the player's own scan — the
    // request's arrival order does not carry that information.
    const head = earliestRunStart(this.encodeRuns.runsOf(session)) ?? 0;
    // Anchor the look-ahead window on the CURRENT encode position (start index +
    // seconds already processed), not the run's start index. Otherwise a long
    // run that has encoded well past `head` would needlessly restart for a
    // request just ahead of the live edge.
    const progress = this.encodeRuns.progressOf(session, index);
    const processed = Number.isFinite(progress?.processedSeconds)
      ? progress.processedSeconds
      : this.runStartTimeFor(session, head);
    const currentSeg = Math.max(head, this.outputTimes.segmentIndexForTime(session, processed));
    const withinWindow = index >= head && index <= currentSeg + MAX_LOOKAHEAD_SEGMENTS;
    if (withinWindow) {
      return;
    }
    // A request BELOW where the run begins is not noise and never will be
    // satisfied: this encoder only ever moves forward from `head`, so nothing
    // it does can produce this segment. Every other far request is a claim that
    // the running encode may yet reach — this one is a hole, and holding it is
    // holding it for ever.
    //
    // Measured 2026-08-11: a run repositioned to #770 while the player needed
    // #757 held that request for two minutes forty-one, producing 409 s of
    // video nobody had asked for at 2.48x, until the viewer gave up. That was a
    // quality switch placing the run wrongly; the placement is fixed, but the
    // shape must not be able to hang a session again whatever puts it there.
    //
    // Waited on rather than acted on at once: a burst that arrives around a
    // reported seek settles by itself within a moment, and the seek is what
    // should move the encoder. Only a request still unanswerable after that is
    // repaired here.
    if (index < head) {
      // SAID, NOT ACTED ON. What is missing in front of a viewer is stated by
      // the priority map, and putting encoders on it is the plan's work. This
      // used to move the encoder itself, from a segment REQUEST — a second
      // authority over where encoders go, with six chosen constants of its own,
      // and it survived the pass that removed the other two because it lives in
      // the path that answers a file rather than in the plan.
      this.#explainHold(
        session,
        session.segmentFormat.segmentFileName(index),
        `it is behind the run (#${head}); where the viewers are is what places encoders`
      );
      return;
    }
    // Circuit breaker: this exact target has exhausted the encoding layer's
    // consecutive fast-start budget (see noteRunEnded).
    // Stop auto-retrying it so getFileStream reports a clean, retryable error
    // instead of looping forever. A DIFFERENT
    // target (the viewer seeking elsewhere) is unaffected — it gets its own
    // fresh attempt budget.
    if (!this.encodeOrchestrator.mayStartAt(session.outputKey, index)) {
      return;
    }
    // A far request is NOT treated as a seek. Measured 2026-08-02: on a single
    // viewer seek the player opens ~25 CONCURRENT requests spanning #904..#1101
    // and holds them all for the full 60 s without aborting any — normal
    // read-ahead, not probing. There is therefore no such thing as "the segment
    // the player ended on": at any instant a couple of dozen different indices
    // are outstanding, so any rule picking one of them picks noise. Doing so
    // produced NINE encoder restarts in one minute (#576→#885→#609→#591→#673→
    // #833→#624→#1071→#1101), each killed 5-8 s in, turning a seek into a
    // ~70 s ordeal.
    //
    // The seek target now arrives explicitly from the browser (requestSeek,
    // POST /api/transcode-sessions/:id/seek) — the only place the viewer's
    // intent actually exists. Same split as Jellyfin (startTimeTicks) and
    // webtor (?t=): requests fetch data, they do not steer the encoder.
    //
    // Requests are still valuable, just not as commands: they are a queue of
    // claims. Held open until produced (the player waits), served from disk
    // when behind the encoder, and the LOWEST outstanding index marks where the
    // viewer is actually stalled — the honest input for what to produce first.
    // See research/hls-seek-prior-art-2026-08-02.md.
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
   * Poll until the HLS playlist file exists and contains a valid `#EXTM3U`
   * header, or until the session fails, or until the startup timeout elapses.
   * Throws with message `"HLS playlist is still warming up."` on timeout.
   *
   * @param {HlsSession} session
   * @returns {Promise<void>}
   */
  async waitUntilReady(session) {
    // With a synthetic VOD playlist there is nothing to wait for: the playlist
    // is generated from the probed duration and is available immediately.
    // Individual segments are long-polled by the segment route as ffmpeg
    // produces them.
    if (session.useSyntheticPlaylist) {
      if (this.encodeRuns.runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED) {
        throw new Error(this.encodeRuns.lastErrorOf(session) || "ffmpeg failed to start HLS session.");
      }
      return;
    }

    const playlistPath = path.join(this.segmentStore.pathFor(session.outputKey ?? ""), PLAYLIST_FILE_NAME);
    const deadline = Date.now() + this.startupWaitMs;

    while (Date.now() < deadline) {
      if (this.encodeRuns.runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED) {
        throw new Error(this.encodeRuns.lastErrorOf(session) || "ffmpeg failed to start HLS session.");
      }
      try {
        await access(playlistPath);
        const text = await readFile(playlistPath, "utf8");
        if (text.includes("#EXTM3U")) {
            return;
        }
      } catch (_error) {
        // Playlist is not ready yet.
      }
      await delay(250);
    }

    throw new Error("HLS playlist is still warming up.");
  }

  /**
   * Issue the sequence number an incoming segment request keeps for all of its
   * long-poll iterations. The caller (the route) takes ONE number when the
   * request arrives and passes it back on every poll, which is what lets
   * #ensureEncodingFor tell "a newer request arrived" apart from "the same
   * request polled again" — see the ping-pong it prevents there.
   *
   * @param {string} sessionId
   * @returns {number} 0 when the session is unknown (treated as newest).
   */
  nextRequestSeq(sessionId) {
    const session = isOutputName(sessionId) ? this.outputs.get(sessionId) : null;
    if (!session) {
      return 0;
    }
    session.requestSeqCounter += 1;
    return session.requestSeqCounter;
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
   * This viewer is no longer watching this output.
   *
   * Both directions of the relation go together — the output forgets the
   * viewer, the viewer forgets the output — and so does the claim their
   * watching had placed on production. That last part is why this is a method
   * and not a line: the ONLY place a claim is released is the plan's pass over
   * `viewersOf(session)` (`#planEncoding`), so a viewer deleted from that map
   * by any other route leaves a claim nothing can ever release, and the plan
   * goes on making segments for somebody who has gone.
   *
   * @param {HlsSession} output
   * @param {string} consumerId
   * @returns {boolean} Whether they had been watching it.
   */
  #viewerLeaves(output, consumerId) {
    if (!output) {
      return false;
    }
    // Nothing to release in the encoding: it holds one map per output, built
    // from where the viewers are, and the map that arrives next simply does not
    // have this one in it. A name to release was the last place a viewer
    // appeared inside the encoding at all.
    return this.viewers.leaves(output, consumerId);
  }

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
   * Where a variant's first encode run should begin, in seconds.
   *
   * The segment the player asked for, when there is one: after a level switch
   * hls.js discards what it had buffered ahead and fetches from the picture's
   * own position, so its first request IS that position. Falling back to the
   * rung being left means falling back to that rung's READ head, which sits a
   * whole buffer further on.
   *
   * @param {HlsSession} base
   * @param {number} wantedIndex - Segment index asked for, or -1.
   * @returns {number}
   */
  #variantStartSeconds(base, wantedIndex, consumerId = "") {
    if (Number.isInteger(wantedIndex) && wantedIndex >= 0) {
      return this.outputTimes.segmentStartTime(base, wantedIndex);
    }
    return viewerSecondsOn(activeOutputFor({ base, consumerId, outputs: this.outputs }));
  }

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
   * Where the earliest viewer's picture is, and the deepest cushion any of them
   * reports holding — both read from the link reports, both null when nobody
   * has said recently.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @returns {{ earliestPosition: number | null, deepestBuffer: number | null, viewers: number }}
   */
  #reportedPictureOf(session, now) {
    let earliestPosition = null;
    let deepestBuffer = null;
    let viewers = 0;
    // A session that has never had a link report is the ordinary state at a
    // cold open, and the answer for it is the same as for one whose reports
    // have all gone stale: nobody has said where they are.
    for (const viewer of viewersOf(session).values()) {
      const report = viewer.netReport;
      if (report === null) {
        continue;
      }
      if (now - report.at > NET_REPORT_FRESH_MS) {
        continue;
      }
      viewers += 1;
      if (Number.isFinite(report.positionSeconds)) {
        earliestPosition =
          earliestPosition === null
            ? report.positionSeconds
            : Math.min(earliestPosition, report.positionSeconds);
      }
      if (Number.isFinite(report.bufferedAheadSec)) {
        deepestBuffer =
          deepestBuffer === null
            ? report.bufferedAheadSec
            : Math.max(deepestBuffer, report.bufferedAheadSec);
      }
    }
    return { earliestPosition, deepestBuffer, viewers };
  }

  /**
   * The session that produces a given height for the same file, created on
   * first request.
   *
   * A variant IS a session — same source, same file, a different encode — so
   * this makes one rather than inventing a parallel object. It is created only
   * when its playlist is actually asked for, which is what keeps a weak host
   * running one encoder: with the player's own bitrate adaptation off, no
   * variant is ever requested unless the viewer picked it.
   *
   * @param {string} baseSessionId
   * @param {number} height - Encode height; must be one of the offered rungs.
   * @returns {Promise<HlsSession | null>} Null when the base session is unknown,
   *   or the height is not offered for it.
   */
  async resolveVariantSession(baseSessionId, height, wantedIndex = -1, consumerId = "") {
    if (!isOutputName(baseSessionId)) {
      return null;
    }
    const base = this.outputs.get(baseSessionId);
    if (!base) {
      return null;
    }
    if (!Number.isInteger(height) || height <= 0) {
      return null;
    }
    // Only the heights the master offers. Anything else is a made-up request,
    // and honouring it would let a client start encoder runs at will. The
    // MASTER's list, not the live one: a rung is published for the session's
    // whole life, and refusing what we published is how a quality switch became
    // a 404 storm across every level.
    if (!this.outputs.splicableHeights(base).includes(height)) {
      return null;
    }
    if (height === this.outputs.variantHeightOf(base)) {
      return base;
    }
    // What this height was answered with before, if it has been asked. Kept as
    // a height and not as a session id: the answer must not move — a player
    // holding an init for one size cannot be sent another — and a number cannot
    // go stale, so nothing has to be cleaned from the other side when a session
    // ends.
    const answeredWith = base.file.stepHeights.get(height);
    if (answeredWith) {
      const serving = this.outputs.stepsOf(base).find((other) => this.outputs.producedHeightOf(other) === answeredWith);
      const existing = this.outputs.producedHeightOf(base) === answeredWith ? base : serving;
      if (existing) {
        this.outputs.touch(existing);
        return existing;
      }
    }
    // hls.js asks for a new level's playlist, its init and its first segments
    // within the same moment. Without this every one of them would build its
    // own session, and the ones that lost would encode for nobody.
    base.variantPending ??= new Map();
    const pending = base.variantPending.get(height);
    if (pending) {
      return pending;
    }
    const creation = this.createOrGetSession({
      sourceKey: base.file.sourceKey,
      fileIndex: base.file.fileIndex,
      transcodeVideo: true,
      transcodeAudio: base.spec.transcodesAudio,
      fileName: base.file.name,
      // The family's own claim on it. Sessions are already shared between
      // consumers and disposed when the last one leaves, and a variant is
      // shareable in exactly the same way — two viewers on the same rung of the
      // same file are one encode. This is how the base lets go of it.
      consumerId: variantConsumerId(base.id),
      targetWidth: 0,
      targetHeight: height,
      // Where this variant must begin. The segment the player asked it for when
      // it can be known — that is the player stating outright where it will
      // start fetching, and it is the only figure that cannot be stale.
      //
      // The other rung's read head is NOT that figure, and using it cost a
      // stuck session on 2026-08-11: a 240p rung encoding at 5-6x had read 56 s
      // further than the picture had played, so switching back to 400p placed
      // that run at 3084 s while the player needed 3028 s, and no segment it
      // wanted was ever produced.
      //
      // Floored onto the ten-second grid that session keys are bucketed to:
      // rounding is what that bucket does, and a position rounded UP starts the
      // run past the viewer, so the run just spawned is killed and restarted
      // before it has produced anything.
      startPositionSeconds: Math.floor(this.#variantStartSeconds(base, wantedIndex, consumerId) / 10) * 10,
      audioTrackIndex: this.#flatAudioTrackOf(base),
      // A rung is produced at exactly the size it names and the realtime budget
      // does not move it — otherwise two rungs could drift onto the same height
      // and the choice between them would mean nothing. True of EVERY rung,
      // including one the player moved itself onto.
      exactSize: true,
      // Whose request this is decides whether an output already here may serve
      // it: a size picked by hand is served exactly, the automatic choice by the
      // quality rules. A viewer whose page does not say is taken as picking.
      servingMode: viewersOf(base).get(consumerId)?.qualityMode ?? "manual",
      viewerLinkMbps: viewersOf(base).get(consumerId)?.netReport?.linkMbps ?? null,
      // A rung of a session whose audio is published separately carries no
      // audio either — every rung of one master must agree about that, or
      // switching rung would start or stop a second copy of the same track.
      audioRenditions: this.#servesAudioSeparately(base),
      // Not re-decided here: asked on its own, a variant would answer about the
      // rungs IT would be offered at — a 540p rung of a copied 1080p source is
      // offered nothing but itself, so it would conclude "audio muxed" and
      // start carrying a second copy of a track the player is already fetching
      // from the rendition.
      inheritedAudioSeparate: this.#servesAudioSeparately(base),
      segmentFormatId: base.segmentFormat?.id ?? "",
      // Cut where the base is cut. Only for a base on the source's own keyframe
      // grid — a copy — where the variant has to land on those exact times to
      // be interchangeable with it. A base on the uniform grid needs nothing
      // passed: the variant computes the same even grid from the same duration.
      inheritedGrid: base.timeline.cutGrid === "keyframe"
        ? {
            // The table as it stands NOW, corrections included — not the index
            // it was first built from. This is what the new session CUTS at.
            boundaries: base.timeline.boundaries,
            // And this is what it must SAY, which is not the same thing: every
            // member of a family has to publish one timeline, or two sessions
            // stamp the same moment differently and the picture and the sound
            // drift apart by exactly the corrections made between their two
            // creations (field 2026-08-17, corrections of 0.6-2.9 s).
            published: base.timeline.published
          }
        : null
    })
      .then(async (variant) => {
        // Making a session takes seconds — a probe and a keyframe index — and
        // the viewer can leave inside that window. A variant registered onto a
        // disposed base is reachable by nobody: the browser never learns its
        // id, so nothing would release it and it would hold an encoder, a temp
        // directory and a claim on the torrent until its own idle timer noticed
        // half an hour later.
        if (!this.encodeRuns.isLive(base)) {
          await this.releaseSessionConsumer(
            variant.id,
            variantConsumerId(base.id),
            "the session it was made for ended while it was being made"
          );
          return null;
        }
        // Served by the picture itself, which does not become a step.
        if (variant === base) {
          return base;
        }
        const incumbent = await this.#adoptIfAlreadyProduced(base, height, variant);
        if (incumbent) {
          base.file.stepHeights.set(height, this.outputs.producedHeightOf(incumbent));
          return incumbent;
        }
        // A step at its own height. A stand-in of another height chosen for this
        // viewer is not remembered as the answer for the height asked for.
        const produced = this.outputs.producedHeightOf(variant);
        variant.variantHeight ??= produced > 0 ? produced : height;
        // How it came to be: a step of a picture, not a picture a browser
        // opened. Read where a step needs the facts of the file rather than of
        // its own encode.
        variant.isStep = true;
        if (produced === height) {
          base.file.stepHeights.set(height, produced);
        }
        return variant;
      })
      .finally(() => {
        base.variantPending.delete(height);
      });
    base.variantPending.set(height, creation);
    return creation;
  }

  /**
   * A session of this family already making exactly this picture, if there is
   * one — so that a second request for it does not start a second encoder.
   *
   * WHY IT COMPARES THE HEIGHT PRODUCED. An output is named by its whole
   * format, and a rung produced exactly at a height can still differ from one
   * already running at that height by its speed setting or its encoder. For
   * the viewer those two are the same picture, so the one already producing it
   * is used rather than a second encoder beside it. It was written when a
   * manual pick was clamped below the height named, which put three encoders on
   * one identical picture on 2026-08-28
   * (`research/session-pileup-variant-key-2026-08-28.md`); the clamp is gone,
   * and choosing an existing output by quality replaces this comparison.
   *
   * @param {HlsSession} base
   * @param {number} askedHeight
   * @param {HlsSession} candidate - The session just created for `askedHeight`.
   * @returns {Promise<HlsSession | null>} The incumbent to use instead, or null
   *   to keep the one just made.
   */
  async #adoptIfAlreadyProduced(base, askedHeight, candidate) {
    const produced = this.outputs.producedHeightOf(candidate);
    if (produced <= 0) {
      return null;
    }
    const seen = new Set([candidate.id]);
    // The base belongs in this scan: it is a rung like any other, and when it
    // is itself a re-encode the clamp can land a variant right on top of it.
    for (const other of [base, ...this.outputs.stepsOf(base)]) {
      if (!other || seen.has(other.id)) {
        continue;
      }
      seen.add(other.id);
      if (this.outputs.producedHeightOf(other) !== produced) {
        continue;
      }
      // Same picture, already being made. Let go of the one just created; the
      // incumbent already carries this family's claim, because both were made
      // with the same consumer id.
      await this.releaseSessionConsumer(
        candidate.id,
        variantConsumerId(base.id),
        `${produced}p is already being produced by ${other.id.slice(0, 8)}`
      );
      logger.info(
        `transcode ${base.id.slice(0, 8)} the ${askedHeight}p rung encodes at ${produced}p on this ` +
          `machine, which ${other.id.slice(0, 8)} is already producing — serving it from there ` +
          `instead of starting a second encoder "${base.file.name}"`
      );
      return other;
    }
    return null;
  }

  /**
   * Resolve one file request addressed to a variant: `v/<height>/<fileName>`
   * under a session.
   *
   * The single entry point for the variant route, so the policy — which variant
   * exists, which one the viewer is watching, which encoder runs — stays here
   * rather than being spread into a route handler.
   *
   * @param {string} baseSessionId
   * @param {number} height
   * @param {string} fileName
   * @param {string} [consumerId] - Which viewer is asking. One picture is shared
   *   by everyone watching it, and the quality each of them chose is their own.
   * @returns {Promise<{ sessionId: string | null, error?: string }>} The session
   *   to serve the file from; a null id means there is no such variant.
   */
  async resolveVariantFile(baseSessionId, height, fileName, consumerId = "") {
    if (!isOutputName(baseSessionId)) {
      return { sessionId: null };
    }
    const base = this.outputs.get(baseSessionId);
    if (!base) {
      return { sessionId: null };
    }
    // A variant carries a media playlist, an init segment and segments. Nothing
    // else lives under that path — a master there would describe variants of a
    // variant.
    const isPlaylist = fileName === PLAYLIST_FILE_NAME;
    const isInit = base.segmentFormat.initFileName !== null &&
      fileName === base.segmentFormat.initFileName;
    const isSegment = base.segmentFormat.isSegmentFileName(fileName);
    if (!isPlaylist && !isInit && !isSegment) {
      return { sessionId: null };
    }
    if (!this.outputs.splicableHeights(base).includes(height)) {
      return { sessionId: null };
    }
    // Answered from the base, and no encoder is started for it. Every variant of
    // a file has the SAME media playlist — same duration, same boundaries, same
    // init name — because that is exactly what makes them interchangeable. The
    // player fetches a level's playlist to decide with, and creating a session
    // for one it may never switch to would leave a second encoder running on a
    // host that has capacity for one.
    if (isPlaylist) {
      return { sessionId: base.id };
    }
    let variant;
    try {
      variant = await this.resolveVariantSession(
        baseSessionId,
        height,
        isSegment ? base.segmentFormat.segmentIndexFromName(fileName) : -1
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `transcode ${baseSessionId} could not prepare the ${height}p variant: ${message}` +
        (error instanceof Error && error.stack ? `\n${error.stack}` : "")
      );
      return { sessionId: null, error: message };
    }
    if (!variant) {
      return { sessionId: null };
    }
    if (consumerId && !isFamilyConsumerId(consumerId)) {
      // The same circle as a soundtrack's: the init has to be made before a
      // segment can be asked for, and nothing is made for an output nobody is
      // watching. Asking for any of its files is watching it.
      const watcher = this.viewers.of(variant, consumerId);
      this.#placeViewer(variant, watcher, this.viewerPositionOf(baseSessionId, consumerId));
    }
    // Only a SEGMENT says the viewer is watching this rung — and it says more
    // than that: it names the exact segment the player wants from it.
    if (isSegment) {
      this.#noteVariantActive(
        base,
        variant,
        variant.segmentFormat.segmentIndexFromName(fileName),
        consumerId
      );
    }
    return { sessionId: variant.id };
  }

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
   * Prepare an audio track at a position, so a change of track is instant.
   *
   * The player, told to change track, discards the audio it holds and cannot
   * show a frame until the new track covers the playhead — so switching first
   * and producing second puts the whole of the track's cold start on screen as
   * a spinner. Measured 2026-08-15: the picture stopped for as long as the
   * first piece took. Prepared first, the player finds the bytes already there.
   *
   * The same shape as {@link prepareVariant}, and for the same reason.
   *
   * @param {string} baseSessionId
   * @param {number} trackIndex
   * @param {number} positionSeconds
   * @returns {Promise<{ sessionId: string, fileName: string } | null>}
   */
  async prepareAudioTrack(baseSessionId, trackIndex, positionSeconds, consumerId = "") {
    const base = this.outputs.get(baseSessionId);
    if (!base || !this.#servesAudioSeparately(base)) {
      return null;
    }
    if (!this.#audioRenditionsOf(base).some((track) => track.trackIndex === trackIndex)) {
      return null;
    }
    const rendition = await this.#resolveAudioRenditionSession(base, trackIndex, consumerId);
    if (!rendition) {
      return null;
    }
    // A track prepared for a change the viewer did not make would otherwise
    // encode for nobody until its own idle timer noticed — the same trap
    // warming a quality rung has, and the same answer. Kept per viewer, because
    // one viewer's abandoned preparation must not stop a track another viewer
    // is listening to.
    const stillWarming = this.viewers.of(base, consumerId).warmingAudioId;
    if (stillWarming && stillWarming !== rendition.id) {
      const abandoned = this.outputs.get(stillWarming);
      const wanted = this.#liveAudioRenditionKeys(base);
      const wantedIds = new Set(
        this.outputs.renditionsOf(base)
          .filter((other) => wanted.has(audioRenditionKey(
            this.#flatAudioTrackOf(other),
            other.spec.transcodesAudio
          )))
          .map((other) => other.id)
      );
      if (abandoned && !wantedIds.has(abandoned.id)) {
        // They are not listening to it, so they stop watching it. Its encoder
        // follows from that and is not commanded here: nobody left on an output
        // is a map with nothing in it, and the plan stops what is on it.
        this.#viewerLeaves(abandoned, consumerId);
      }
    }
    this.viewers.of(base, consumerId).warmingAudioId = rendition.id;
    // Being prepared for them is watching it: it is made for this viewer, and
    // when they leave it must be let go with everything else of theirs.
    // Where the switch will land. An existing track was left wherever the
    // viewer last was on it; saying where they are now is the whole of pointing
    // it there, because the encoder follows the person and not the request.
    this.viewers.of(rendition, consumerId).moveTo(positionSeconds);
    this.planEncodersSoon();
    const index = this.outputTimes.segmentIndexForTime(rendition, positionSeconds);
    return { sessionId: rendition.id, fileName: rendition.segmentFormat.segmentFileName(index) };
  }

  async prepareVariant(baseSessionId, height, positionSeconds, consumerId = "") {
    if (!isOutputName(baseSessionId)) {
      return null;
    }
    const base = this.outputs.get(baseSessionId);
    if (!base) {
      return null;
    }
    if (!this.qualityOffer.offeredHeightsFor(base).includes(height)) {
      return null;
    }
    const index = this.outputTimes.segmentIndexForTime(base, positionSeconds);
    const variant = await this.resolveVariantSession(baseSessionId, height, index, consumerId);
    if (!variant) {
      return null;
    }
    // A rung warmed for a switch that was never made. Nothing else would ever
    // stop it: only becoming active stops the rung being left, so a viewer
    // trying two rungs in a row would leave the first encoding for nobody until
    // the look-ahead cap suspended it — three encoders at once on a host sized
    // for one, which is the opposite of what warming is for.
    // Kept per viewer, and stopped only if nobody has it on screen: with two
    // viewers, what one of them abandons may be what the other is watching.
    const stillWarming = this.viewers.of(base, consumerId).warmingVariantId;
    if (stillWarming && stillWarming !== variant.id) {
      const abandoned = this.outputs.get(stillWarming);
      if (abandoned && !this.quality.variantsOnScreen(base).has(abandoned.id)) {
        this.#viewerLeaves(abandoned, consumerId);
      }
    }
    // The base is not a rung being prepared for anybody — it is what the family
    // is named by — so warming its own height leaves nothing outstanding.
    if (variant.id === base.id) {
      this.viewers.of(base, consumerId).warmingVariantId = null;
    } else {
      this.viewers.of(base, consumerId).warmingVariantId = variant.id;
    }
    // An existing rung may be parked wherever it was left, so it is pointed at
    // the switch position exactly as an activation would — the difference is
    // only that the rung on screen keeps its own encoder meanwhile.
    this.outputs.touch(variant);
    // Anything that is not the rung on screen has to be pointed at the switch
    // position — INCLUDING the base. Skipping it because it is the base was a
    // defect: the base is parked wherever it was when the viewer left it, and
    // its encoder was stopped then. Measured 2026-08-12, warming 400p at
    // 6506.5s found the base still at `run from #0`, so the segment the switch
    // needed was never produced and the viewer got nothing at all.
    // A rung that is not on their screen is parked where they last left it, so
    // being warmed begins with saying where they are. Their being ON it is what
    // buys it an encoder, and both halves are said here: a warmed rung is one
    // this person is watching for as long as the warm-up lasts, which is why
    // two encoders run through it.
    if (variant.id !== activeOutputFor({ base, consumerId, outputs: this.outputs }).id) {
      this.viewers.of(variant, consumerId).moveTo(this.outputTimes.segmentStartTime(base, index));
      this.planEncodersSoon();
    }
    logger.info(
      `transcode ${base.id} warming ${height}p at ${positionSeconds.toFixed(1)}s (segment #${index})`
    );
    return { sessionId: variant.id, fileName: variant.segmentFormat.segmentFileName(index) };
  }

  /**
   * Record which variant the viewer is watching, and give it the encoder.
   *
   * The previous variant's encoder is stopped and the new one is pointed at
   * where the viewer stands, because a segment request does not steer the
   * encoder anywhere (see #ensureEncodingFor) and a variant that was watched a
   * minute ago is parked wherever it was left.
   *
   * @param {HlsSession} base
   * @param {HlsSession} variant
   * @param {number} wantedIndex - The segment this rung was just asked for.
   * @param {string} [consumerId] - Which viewer moved.
   * @returns {void}
   */
  #noteVariantActive(base, variant, wantedIndex = -1, consumerId = "") {
    const previous = activeOutputFor({ base, consumerId, outputs: this.outputs });
    if (previous.id === variant.id) {
      // The rung on screen asking for more of itself, which it does every few
      // seconds. Nothing is being decided here — and deciding anything was the
      // defect: the warm-up was cancelled by the next segment the CURRENT rung
      // fetched, measured 2026-08-12 at 117 ms and 1.5 s after two warm-ups
      // began, so the rung being prepared was stopped before it had encoded
      // anything and the viewer waited out the full thirty-second warm-up for a
      // segment nobody was making, then waited again for the switch itself.
      return;
    }
    // A rung is being left, so whatever was warmed is decided: either it is the
    // rung now being switched to, or the viewer went somewhere else and it must
    // stop like any other rung nobody is watching. Nothing else would ever stop
    // it — only the rung being LEFT is stopped below.
    const baseViewer = viewersOf(base).get(consumerId) ?? null;
    const warmed = baseViewer?.warmingVariantId ?? null;
    if (baseViewer) {
      baseViewer.warmingVariantId = null;
    }
    if (warmed && warmed !== variant.id && warmed !== previous.id) {
      const abandoned = this.outputs.get(warmed);
      if (abandoned && !this.quality.variantsOnScreen(base).has(abandoned.id)) {
        this.#viewerLeaves(abandoned, consumerId);
      }
    }
    const position = this.#variantStartSeconds(base, wantedIndex, consumerId);
    this.viewers.of(base, consumerId).activeVariantId = variant.id;
    // The step is an output of this viewer's now.
    this.viewers.of(variant, consumerId);
    // And the one they came off is not — unless it is the picture itself, which
    // they never stop watching: the browser addresses the picture, their chosen
    // soundtrack is recorded on it, and the plan reads their position from it.
    // Leaving it deleted their whole record, so a viewer who went down a step,
    // back to the picture's own height and down again lost the soundtrack they
    // had chosen, and the encoder making it was stopped as unwanted.
    if (previous !== base && previous !== variant) {
      this.#viewerLeaves(previous, consumerId);
    }
    logger.info(
      `transcode ${base.id} variant now ${this.outputs.variantHeightOf(variant)}p ` +
      `(was ${this.outputs.variantHeightOf(previous)}p) at ${position.toFixed(1)}s` +
      (consumerId ? ` for ${consumerId}` : "")
    );
    // Requests still held on the rung they came off are for segments nobody
    // will produce now, and the player stopped waiting for them the moment it
    // switched. Answering "retry" at once frees them instead of holding each for
    // the full minute.
    //
    // WHETHER ITS ENCODER GOES ON IS NOT DECIDED HERE. It used to be stopped
    // from this line whenever no viewer had it on screen — the plan, handed the
    // whole film's priority map, wanted an encoder on every output of it and
    // started one again on the very next pass, which this viewer's own move had
    // just triggered. Each output is handed its own map now, so a rung nobody is
    // on has nothing in it and the plan stops what is on it, once.
    if (!this.quality.variantsOnScreen(base).has(previous.id)) {
      previous.waitEpoch = (previous.waitEpoch ?? 0) + 1;
    }
    if (position > 0) {
      // The rung being switched TO, named literally: a warm-up may have left
      // the family pointing elsewhere, and forwarding would move that one
      // instead. Saying where this person is on it is the whole of pointing its
      // encoder there.
      this.viewers.of(variant, consumerId).moveTo(position);
    }
    this.planEncodersSoon();
  }

  /**
   * The master playlist: every resolution this file can be served at, as HLS
   * variants.
   *
   * This is what makes a change of quality seamless. Our media playlist is VOD
   * and terminated with `#EXT-X-ENDLIST`, and hls.js only re-reads a playlist
   * that is live — so rewriting it underneath the player achieves nothing, and
   * a switch had to tear the player down and build a new session. Offered as
   * variants instead, the switch is the player's own: it fetches the other
   * variant, appends it after what is already buffered, and changes the
   * decoder's type if the codec parameters differ.
   *
   * Offered only where the variants can actually be joined, which is a question
   * about the CUT GRID and not about who produces the frames:
   *
   * - a re-encoded session on the uniform grid — its variants are re-encoded on
   *   the same one, keyframes forced onto it;
   * - a session cut at the source's own keyframes — a copy, which has no other
   *   choice — where the variants are re-encoded and forced onto those very
   *   times, so a rung's segment covers the same span as the copy's.
   *
   * What is refused is a session whose own grid is a fiction: a copy with no
   * readable keyframe index falls back to an even grid that ffmpeg then does
   * not cut on, and nothing can be aligned to that.
   *
   * @param {string} sessionId
   * @returns {string | null} The playlist text, or null when there is nothing
   *   to choose between, or nothing to align to.
   */
  buildMasterPlaylist(sessionId, consumerId = "") {
    if (!isOutputName(sessionId)) {
      return null;
    }
    const session = this.outputs.get(sessionId);
    if (!session) {
      return null;
    }
    if (!this.outputs.publishesVariants(session)) {
      return null;
    }
    // The audio tracks, published once for the whole file rather than muxed
    // into every rung. Two things follow from that: the same track is not
    // encoded once per rung on a host that struggles to encode it once, and
    // changing track becomes the player switching rendition instead of this
    // proxy rebuilding the session with another `audioTrackIndex`.
    //
    // Only for a session that asked for them. A browser that does not know
    // about renditions is served audio in its stream, as before, and gets no
    // `#EXT-X-MEDIA` lines to be confused by.
    const renditions = this.#servesAudioSeparately(session)
      // Which track is marked DEFAULT is the ASKING viewer's business: one
      // picture is shared by everyone watching it, and each of them may have
      // chosen a different language. A default written from the session's own
      // field would start the second viewer in the first viewer's language.
      ? this.#audioRenditionsOf(session, this.#audioChoiceOf(session, consumerId).trackIndex)
      : [];
    return masterPlaylistText({
      // The shape of the film and the rates it carries, asked of the layer that
      // holds both. What CAN be spliced, not what is worth offering this second:
      // the live judgement travels in `offeredHeights` and in every progress
      // report, and letting it decide the master's existence made a live session
      // answer 404 to its own published address.
      ...this.outputs.masterFactsOf(session),
      renditions,
      playlistFileName: PLAYLIST_FILE_NAME
    });
  }

  /**
   * Whether this session's audio is published separately rather than muxed into
   * its picture.
   *
   * Two things have to hold, and the second is why this is asked here rather
   * than settled when the session was made. The browser must understand
   * renditions — it says so when it creates the session, and one that does not
   * has to be sent audio in the stream. AND there must be a master playlist to
   * publish them in: a stream served as a single media playlist has nowhere to
   * carry an `#EXT-X-MEDIA` line, so taking the audio out of it would leave the
   * viewer with a picture and silence.
   *
   * @param {HlsSession} session
   * @returns {boolean}
   */
  #servesAudioSeparately(session) {
    return session.spec.carries !== "audio-only" && session.spec.carriesAudioSeparately;
  }

  #inputOf(session) {
    return encoderInputs({
      picture: session.file,
      soundtrack: session.spec.audio
        ? this.sourceFiles.get(session.file.sourceKey, session.spec.audioFileIndex)
        : session.file,
      carries: session.spec.carries,
      audioSeparate: this.#servesAudioSeparately(session),
      sessionId: session.id,
      readWindowBytes: session.readWindowBytes,
      baseUrl: this.localBaseUrl
    });
  }

  /**
   * One file of an audio rendition: its playlist, its init segment or one of
   * its segments.
   *
   * A rendition is an ordinary session underneath — same source, same file,
   * same cut grid, one audio track and no picture — created on the first
   * request for it, exactly as a quality variant is. What differs is that the
   * player fetches it ALONGSIDE a variant rather than instead of one, so both
   * encoders run: a rung and the audio it is played with.
   *
   * @param {string} baseSessionId
   * @param {number} trackIndex
   * @param {string} fileName
   * @param {string} [consumerId] - Who is asking. One picture serves everyone
   *   watching it, and which soundtrack they are listening to is theirs alone.
   * @returns {Promise<{ sessionId: string | null, error?: string }>}
   */
  async resolveAudioRenditionFile(baseSessionId, trackIndex, fileName, consumerId = "") {
    if (!isOutputName(baseSessionId) || !Number.isInteger(trackIndex) || trackIndex < 0) {
      return { sessionId: null };
    }
    const base = this.outputs.get(baseSessionId);
    if (!base || !this.#servesAudioSeparately(base)) {
      return { sessionId: null };
    }
    const isPlaylist = fileName === PLAYLIST_FILE_NAME;
    const isInit = base.segmentFormat.initFileName !== null && fileName === base.segmentFormat.initFileName;
    const isSegment = base.segmentFormat.isSegmentFileName(fileName);
    if (!isPlaylist && !isInit && !isSegment) {
      return { sessionId: null };
    }
    if (!this.#audioRenditionsOf(base).some((rendition) => rendition.trackIndex === trackIndex)) {
      return { sessionId: null };
    }
    // The playlist is answered from the base, for the same reason a variant's
    // is: every rendition of a file has the same boundaries and the same
    // duration — they are cut on one grid — and the player fetches the playlist
    // of tracks it may never select. Starting an encoder for each would put as
    // many encoders on the host as the file has languages.
    if (isPlaylist) {
      return { sessionId: base.id };
    }
    let rendition;
    try {
      rendition = await this.#resolveAudioRenditionSession(base, trackIndex, consumerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `transcode ${baseSessionId} could not prepare audio track ${trackIndex}: ${message}` +
        (error instanceof Error && error.stack ? `\n${error.stack}` : "")
      );
      return { sessionId: null, error: message };
    }
    if (rendition && consumerId && !isFamilyConsumerId(consumerId)) {
      // Asking for ANY file of this soundtrack is this viewer watching it, and
      // the init is the file they ask for first. Registered here rather than on
      // the segment alone, because the segment cannot be asked for until the
      // init has been served, and the init cannot be made unless somebody is
      // watching: that circle is what left a soundtrack with no encoder, no
      // init and a viewer waiting sixty seconds on 2026-09-05.
      //
      // WHERE they are on it is where they are on the picture: the two are
      // played together.
      const listener = this.viewers.of(rendition, consumerId);
      this.#placeViewer(rendition, listener, this.viewerPositionOf(base.id, consumerId));
    }
    if (isSegment && rendition) {
      this.#noteAudioTrackActive(base, trackIndex, consumerId);
    }
    return { sessionId: rendition?.id ?? null };
  }

  /**
   * A SEGMENT of this track is what says the viewer is listening to it — the
   * player fetches the playlist and the init of tracks it may never choose.
   *
   * Every other track is then stopped. Each one is an ffmpeg process AND a
   * reader holding pieces of the torrent in memory, and the store can only
   * spill a piece nobody is reading: on 2026-08-15 a viewer who had changed
   * track once had three readers on one file — picture, the track they chose
   * and the track they left — and at a seek all three revived their windows at
   * once, every resident piece was pinned, a read ended with zero bytes, and
   * every encoder took that for the end of the file and died. Playback was over
   * for good; the sessions answered 500 to everything after that.
   *
   * Stopped, not disposed: the track keeps its place, its grid and its
   * position, so switching back does not build it again — the same treatment a
   * quality rung gets when the viewer moves off it.
   *
   * "Every other track" is every track NO LIVE VIEWER is listening to, which
   * with one viewer is what it always was. It has to be asked that way now that
   * two viewers share one picture: each of them fetches the sound they chose,
   * and stopping "the others" per request would have them switch each other's
   * soundtrack off in turn, once per segment, for the whole film.
   *
   * @param {HlsSession} base
   * @param {number} trackIndex
   * @param {string} consumerId - Who is listening. Empty on a transport that
   *   cannot say, which is one viewer by construction.
   */
  #noteAudioTrackActive(base, trackIndex, consumerId) {
    const previous = this.#audioChoiceOf(base, consumerId);
    if (previous.trackIndex === trackIndex) {
      return;
    }
    this.viewers.of(base, consumerId).audio = { ...previous, trackIndex };
    // Kept for the viewer who cannot name themselves, and for the master's
    // default rendition when nobody has said anything else.
    const wanted = this.#liveAudioRenditionKeys(base);
    for (const other of this.outputs.renditionsOf(base)) {
      if (wanted.has(audioRenditionKey(this.#flatAudioTrackOf(other), other.spec.transcodesAudio))) {
        continue;
      }
      // Requests held on it are for segments nobody will produce now, and the
      // player stopped waiting for them the moment it changed track.
      if (this.encodeRuns.liveRunsOf(other).length > 0) {
        other.waitEpoch = (other.waitEpoch ?? 0) + 1;
      }
      // Nobody is listening to it any more: this viewer stops watching that
      // output, on both sides of the relation, and the claim their listening
      // placed on it is released with them. Its encoder follows from that —
      // an output with nobody on it has a map with nothing in it — and was
      // additionally stopped from here, which is the same decision taken twice
      // by two parties with two rules.
      this.#viewerLeaves(other, consumerId);
    }
  }

  /**
   * The viewers this family has heard from recently enough to still be watching.
   *
   * Asked of the whole family, not of one session: a viewer on a quality step
   * asks that step for its segments, so the picture they started on has not
   * heard from them since they switched. Their head expires by the same rule the
   * encoder's own steering uses.
   *
   * It is what decides whether an encoder is still wanted, and it is needed
   * because nothing releases a session when a channel closes (roadmap item 54)
   * — without it a viewer whose tab is gone would hold a soundtrack or a rung
   * for the session's whole life.
   *
   * @param {HlsSession} base
   * @returns {Set<string>}
   */
  #liveConsumers(base) {
    const live = new Set();
    for (const member of this.outputs.familyOf(base)) {
      for (const [consumerId, viewer] of viewersOf(member)) {
        if (viewer.isPresent()) {
          live.add(consumerId);
        }
      }
    }
    return live;
  }

  /**
   * What one viewer wants of the sound: which soundtrack, and whether their
   * browser needs it re-encoded.
   *
   * @param {HlsSession} base
   * @param {string} consumerId
   * @returns {{ trackIndex: number, transcode: boolean }}
   */
  #audioChoiceOf(base, consumerId) {
    const stated = viewersOf(base).get(consumerId)?.audio ?? null;
    if (stated) {
      return stated;
    }
    // A viewer this session has not heard from by name. The session's own
    // parameters are the honest fallback: they are what the request that
    // created it asked for.
    return {
      trackIndex: this.#flatAudioTrackOf(base),
      transcode: base.spec.transcodesAudio
    };
  }

  /**
   * The renditions live viewers are listening to, as the keys they are filed
   * under.
   *
   * A viewer counts while their head is fresh on the picture — the same
   * expiry the encoder's own steering uses. Without that test a viewer whose
   * tab was closed without releasing the session (roadmap item 54) would hold
   * an encoder for the session's whole life.
   *
   * @param {HlsSession} base
   * @returns {Set<string>}
   */
  #liveAudioRenditionKeys(base) {
    const wanted = new Set();
    const live = this.#liveConsumers(base);
    for (const [consumerId, viewer] of viewersOf(base)) {
      const choice = viewer.audio;
      // The unnamed viewer has no head to expire and is always counted; a named
      // one counts while some session of the family has heard from them.
      if (consumerId && live.size > 0 && !live.has(consumerId)) {
        continue;
      }
      wanted.add(audioRenditionKey(choice.trackIndex, choice.transcode));
    }
    return wanted;
  }

  /**
   * The session producing one audio track of this file, made on first request.
   *
   * Filed under the track AND how it has to be produced, because those are two
   * different encodes: a browser that can decode this track as it stands is
   * served a copy, and one that cannot is served AAC. The base cannot answer
   * for either of them now that it is shared — its own `transcodeAudio` is
   * whatever the first viewer's browser needed.
   *
   * @param {HlsSession} base
   * @param {number} trackIndex
   * @param {string} consumerId - Who is asking.
   * @returns {Promise<HlsSession | null>}
   */
  async #resolveAudioRenditionSession(base, trackIndex, consumerId = "") {
    const transcodeAudio = this.#audioChoiceOf(base, consumerId).transcode;
    // Found by what it IS: a soundtrack of this file, this track, produced this
    // way. That is what a map from a rendition key to a session id said, at the
    // price of a link between two sessions' lifetimes — one that had to be
    // cleaned from the other side when either ended.
    const already = this.outputs.renditionsOf(base).find(
      (other) =>
        this.#flatAudioTrackOf(other) === trackIndex &&
        other.spec.transcodesAudio === transcodeAudio
    );
    if (already) {
      this.outputs.touch(already);
      return already;
    }
    const rendition = await this.createOrGetSession({
      sourceKey: base.file.sourceKey,
      fileIndex: base.file.fileIndex,
      // No picture at all: the video flag says what to do with a video stream
      // this output does not carry.
      transcodeVideo: false,
      transcodeAudio,
      fileName: base.file.name,
      consumerId: variantConsumerId(base.id),
      audioTrackIndex: trackIndex,
      audioOnly: true,
      // Where the viewer is, so the rendition starts with the picture rather
      // than at the beginning of the file. Read the same way a quality variant
      // reads it: the base's own field is only written by a seek or by a
      // segment IT served, so on a resume-from-position open it is still unset
      // while the player is asking for segment #537 — and the audio would begin
      // at zero and never catch up, since nothing treats a far request as a
      // seek. The accessor falls back to the last segment actually requested.
      // Where the PICTURE is, not where it has been read to.
      //
      // The position this class keeps is written by the segments a session
      // serves, so it is the READ head, and the viewer's picture sits behind it
      // by everything the player has buffered. Started at the read head, the
      // audio run begins AHEAD of the viewer, and every request they then make
      // is behind a run that only moves forward — field 2026-08-15, placed at
      // #16 while the player asked for #10, and the audio arrived only after
      // the encoder was dragged back.
      //
      // The distance is measured, not assumed: the browser reports how many
      // seconds it holds ahead of the picture with every link report, so the
      // playhead is one subtraction away. A stale report is no use — a viewer
      // who seeked since then is somewhere else entirely — so an old one is
      // ignored and the whole look-ahead is subtracted instead, which cannot
      // leave the run ahead of them.
      startPositionSeconds: audioStartSecondsFor({
        family: this.outputs.familyOf(base),
        openedAtSeconds: this.encodeRuns.progressOf(base)?.startPositionSeconds,
        segmentSeconds: this.segmentDurationSec
      }),
      segmentFormatId: base.segmentFormat.id,
      // Cut where the picture is cut. Two streams meant to be played together
      // have to be divided at the same times, and the grid is the base's — the
      // table as it stands now, corrections included. A base on the uniform
      // grid passes nothing: the rendition computes the same even grid from the
      // same duration.
      inheritedGrid: base.timeline.cutGrid === "keyframe"
        ? {
            boundaries: base.timeline.boundaries,
            published: base.timeline.published
          }
        : null
    });
    return rendition ?? null;
  }

  /**
   * Whether a session created with these parameters publishes its sound as its
   * own stream rather than muxing it into the picture.
   *
   * Asked before the session exists, because the session's KEY depends on the
   * answer: an output that carries no sound must not be told apart by which
   * soundtrack was asked for, and an output that carries it must be.
   *
   * Three conditions, all of them facts about the request and the file rather
   * than about the machine's load, so the answer cannot move afterwards:
   *
   * 1. the browser said it understands rendition groups. One that did not must
   *    be sent its sound inside the picture, or it gets silence;
   * 2. the file has soundtracks to publish;
   * 3. there is more than one height to move between, because renditions are
   *    published in a master playlist and a stream served as a single media
   *    playlist has nowhere to carry an `#EXT-X-MEDIA` line.
   *
   * Condition 3 is the reason a source too small for a ladder mixes its sound
   * in as it always did. It is asked of the same ladder the master's rung list
   * comes from; the realtime budget may still encode below the height named
   * here, and cannot change the count, because what it picks is a rung of that
   * same ladder.
   *
   * @param {{ sourceKey: string, fileIndex: number, audioRenditions: boolean, ownHeight: number }} params
   * @returns {boolean}
   */
  #audioTravelsSeparately({ sourceKey, fileIndex, audioRenditions, ownHeight }) {
    if (audioRenditions !== true) {
      return false;
    }
    const tracks = this.getCachedAudioTracks?.({ sourceKey, fileIndex }) ?? [];
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return false;
    }
    // The source's own height, from the probe the playback plan already ran.
    // Absent, this answers "mix it in" — which is what the later computation
    // answered too, since a session with no source height has an empty ladder.
    const sourceHeight = Math.round(Number(this.getCachedMediaInfo?.({ sourceKey, fileIndex })?.height) || 0);
    const heights = new Set(variantHeightsFor(sourceHeight));
    if (Number.isInteger(ownHeight) && ownHeight > 0) {
      heights.add(ownHeight);
    }
    return heights.size >= 2;
  }

  /**
   * Where one numbered soundtrack actually is: which file of the torrent, and
   * which `0:a:N` inside it.
   *
   * The number is flat across the picture's own tracks and every soundtrack
   * shipped as a file beside it, so that the browser's menu, the
   * `audioTrackIndex` on a session request and the `a/<n>/` path a rendition is
   * published at all mean the same thing. This resolves it, once, from the
   * inventory the playback plan built — the very list the menu was drawn from,
   * so the two cannot disagree about what a number means.
   *
   * A number the inventory does not describe resolves to the picture's own file
   * at that index, which is exactly what every session did before soundtracks in
   * their own files existed: a plan cached by an older build carries no
   * inventory, and a session created against it must keep working.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex - The PICTURE's file.
   * @param {number} flatIndex
   * @returns {{ fileIndex: number, sourceTrackIndex: number, isSidecar: boolean, name: string }}
   */
  #resolveAudioSource(sourceKey, fileIndex, flatIndex) {
    const inventory = this.getCachedAudioTracks?.({ sourceKey, fileIndex }) ?? [];
    const entry = Array.isArray(inventory)
      ? inventory.find((candidate) => candidate?.index === flatIndex)
      : null;
    if (!entry || !Number.isInteger(entry.fileIndex) || !Number.isInteger(entry.sourceTrackIndex)) {
      return { fileIndex, sourceTrackIndex: flatIndex, isSidecar: false, name: "" };
    }
    return {
      fileIndex: entry.fileIndex,
      sourceTrackIndex: entry.sourceTrackIndex,
      isSidecar: entry.fileIndex !== fileIndex,
      name: typeof entry.fileName === "string" ? entry.fileName : ""
    };
  }

  /**
   * The browser's flat soundtrack number for the audio carried by this output.
   *
   * `OutputSpec` keeps the stable source address: file plus `0:a:N`. The flat
   * number belongs to the browser menu and is reconstructed from that menu's
   * inventory when a route needs it. It is therefore not kept as a duplicate
   * field on the output.
   *
   * @param {HlsSession} session
   * @returns {number}
   */
  #flatAudioTrackOf(session) {
    const audio = session.spec.audio;
    if (!audio) {
      return 0;
    }
    const tracks = this.getCachedAudioTracks?.({
      sourceKey: session.file.sourceKey,
      fileIndex: session.file.fileIndex
    }) ?? [];
    const matching = Array.isArray(tracks)
      ? tracks.find((entry) => entry?.fileIndex === audio.fileIndex && entry?.sourceTrackIndex === audio.trackIndex)
      : null;
    return Number.isInteger(matching?.index) ? matching.index : audio.trackIndex;
  }

  /**
   * Start reading where a soundtrack file's own timeline begins, if nobody has.
   *
   * Read by the container layer from the file's own header — the same 64 KB,
   * the same reader and the same per-file cache the audio menu's track list
   * comes from. A container states this, so it is read from the container and
   * not measured from the media.
   *
   * The answer goes onto the FILE, which is where it belongs and which is what
   * removed the pair of maps this used to keep beside it: a start time held per
   * `sourceKey:fileIndex` is a fact of that file, and a second store of facts
   * about files is a second thing that can disagree. Every session of the
   * soundtrack shares the one object, so a reading that lands after a session
   * has started is seen by that session too — which is what the spawn path
   * needed and used to re-read a map for.
   *
   * Until 2.73.0 the session spawned an ffmpeg against the proxy's own
   * `/stream` for it and waited up to eight seconds for the banner. Field
   * 2026-09-03: that read cost 8121 ms of a cold start, three times out of
   * three, while the container layer had read the same header of the same file
   * in 8 ms in the same second. The eight seconds were not even spent on the
   * answer — the early exit was gated on a DURATION, and a partly downloaded
   * file prints `Duration: N/A` with the start time on that very line.
   *
   * Runs behind whoever asked, so no viewer waits for it. Once per file per
   * process: a container's start time is a property of the file and cannot
   * change. A reading that comes back without an answer is NOT remembered — the
   * file may simply not have been downloaded far enough yet, and the next
   * session asks again.
   *
   * @param {SourceFile} file - The soundtrack's own file.
   * @returns {void}
   */
  #warmFileStartTime(file) {
    if (typeof this.getContainerMediaInfo !== "function") {
      return;
    }
    if (!(this.fileStartTimeReads instanceof Set)) {
      this.fileStartTimeReads = new Set();
    }
    if (file.media?.startTime !== undefined || this.fileStartTimeReads.has(file.key)) {
      return;
    }
    this.fileStartTimeReads.add(file.key);
    void Promise.resolve(
      this.getContainerMediaInfo({ sourceKey: file.sourceKey, fileIndex: file.fileIndex })
    )
      .then((info) => {
        if (info && Number.isFinite(info.startTimeSeconds)) {
          file.learn({ startTime: info.startTimeSeconds });
          logger.info(
            `transcode: soundtrack file ${file.fileIndex}'s own timeline starts at ` +
            `${info.startTimeSeconds.toFixed(6)}s, read from its header`
          );
        }
      })
      .catch((error) => {
        logger.info(
          `transcode: the start of soundtrack file ${file.fileIndex}'s timeline could not be read ` +
          `(${error instanceof Error ? error.message : String(error)}) — the two timelines are ` +
          "taken to agree until it can be"
        );
      })
      .finally(() => {
        this.fileStartTimeReads.delete(file.key);
      });
  }

  /**
   * The audio tracks of this session's file, as renditions for the master.
   *
   * Taken from the inventory the playback plan already probed — the same list
   * the browser's audio menu is built from — so nothing is probed again here.
   * The track the session was created with is the default one: it is what the
   * viewer chose (or the file's first track), and a master that defaulted to
   * something else would change the language on its own.
   *
   * @param {HlsSession} session
   * @param {number} [chosenTrack] - The track to mark as the default one.
   *   Defaults to the session's own, which is what a caller that is only
   *   counting the renditions wants.
   * @returns {Array<{ trackIndex: number, name: string, language: string, isDefault: boolean }>}
   */
  #audioRenditionsOf(session, chosenTrack) {
    const tracks = this.getCachedAudioTracks?.({
      sourceKey: session.file.sourceKey,
      // The PICTURE's file, which is what `file` is on every session of a
      // family — a rendition is created with its base's, and only its
      // `audioFile` points at the file its sound comes from. The inventory is
      // keyed on the picture and spans the soundtracks beside it.
      fileIndex: session.file.fileIndex
    }) ?? [];
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return [];
    }
    const chosen = Number.isInteger(chosenTrack) ? chosenTrack : this.#flatAudioTrackOf(session);
    // One line per entry of the inventory, in its order and without omissions —
    // including a track the container marks unusable. The player addresses a
    // rendition by its POSITION in this list, and the browser addresses it by
    // the number the inventory gave it; leaving anything out would make those two
    // disagree from that point on. A track the file says not to offer is kept out
    // of the VIEWER's menu, which is the browser's own business and does not
    // touch the numbering.
    return tracks.map((entry, order) => {
      const index = Number.isInteger(entry?.index) ? entry.index : order;
      const language = typeof entry?.languageBcp47 === "string" && entry.languageBcp47.length > 0
        ? entry.languageBcp47
        : (typeof entry?.language === "string" ? entry.language : "");
      return {
        trackIndex: index,
        name: audioRenditionName(
          { ...entry, index, folders: Array.isArray(entry?.folders) ? entry.folders : [] },
          tracks
        ),
        // Only what the container itself states. What a folder name suggests
        // about a language is derived in the browser, where the language table
        // and the viewer's own locale already are; writing a guess into
        // `LANGUAGE` would put it in a playlist as though the file had said it.
        language,
        isDefault: index === chosen
      };
    });
  }

  /**
   * How many times the viewer has moved since this session started.
   *
   * A request being held for a segment answers "retry" as soon as this changes,
   * because it was made for a position the viewer has left — see `requestSeek`.
   *
   * @param {string} sessionId
   * @returns {number}
   */
  seekEpoch(sessionId) {
    const session = isOutputName(sessionId) ? this.outputs.get(sessionId) : null;
    return session?.waitEpoch ?? 0;
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
    const session = isOutputName(sessionId) ? this.outputs.get(sessionId) : null;
    if (!session) {
      return 0;
    }
    return viewerSecondsOn(session, consumerId);
  }

  /**
   * Whether a held request is for a segment the viewer STILL needs.
   *
   * The epoch alone says a seek happened; it cannot say whether this particular
   * request was made for the position left behind or for the one just arrived
   * at. That distinction is the whole of the failure measured 2026-08-18: the
   * viewer seeked to 1061.0 s, the request for `segment-00101` — the segment AT
   * that position — raced the seek notification, the epoch moved underneath it,
   * and it was answered 503 twice within 80 ms. The player then hunted at
   * sn=105-107, never came back to 101, and looped two audio segments 1473
   * times over 149 s while the picture stood still.
   *
   * A request is stale when its segment lies behind where the viewer now is, or
   * so far ahead that the running encode will not reach it. Anything between is
   * exactly what the viewer is waiting for, and holding it is the point.
   *
   * "So far ahead" is the encoder's own look-ahead, measured on this session's
   * own cut grid — the same figure the browser sizes its forward buffer from.
   * It used to be `MAX_LOOKAHEAD_SEGMENTS`, which is eight segments ahead of
   * the ENCODE HEAD
   * and has nothing to do with how far ahead of the VIEWER a request may
   * legitimately sit; it happened to match a browser holding 30 s, and would
   * have refused three quarters of the requests of one holding the whole
   * cushion (roadmap item 4).
   *
   * Judged against the position of the viewer who MADE the request, when the
   * transport carries who that is. A session is shared by everyone watching a
   * copied picture and the epoch is per session, so a seek by the viewer in
   * front used to release every request being held for the viewer behind them.
   *
   * @param {string} sessionId
   * @param {string} fileName
   * @param {string} [consumerId] - Who is asking. Without it the one shared
   *   position decides, which is what a single viewer means anyway.
   * @returns {boolean} True when the request should keep waiting.
   */
  requestStillWanted(sessionId, fileName, consumerId = "") {
    const session = isOutputName(sessionId) ? this.outputs.get(sessionId) : null;
    if (!session) {
      return false;
    }
    const index = session.segmentFormat?.segmentIndexFromName?.(fileName) ?? -1;
    if (!(index >= 0)) {
      return true; // a playlist or an init segment belongs to no position
    }
    const position = viewerSecondsOn(session, consumerId);
    const at = this.outputTimes.segmentIndexForTime(session, position);
    // The far edge on THIS session's own grid rather than a count of nominal
    // segments: a copied picture is cut at the source's keyframes, so its
    // segments are not four seconds long and dividing by that figure would put
    // the edge somewhere else entirely. The segment CONTAINING the edge is
    // wanted — it is the one the deepest allowed request lands in, and it
    // already reaches past the cushion by whatever is left of its own duration.
    const edge = this.outputTimes.segmentIndexForTime(session, position + this.lookaheadSeconds);
    return index >= at && index <= edge;
  }

  /**
   * Open a read stream for an HLS segment or playlist file from a session.
   *
   * @param {string} sessionId
   * @param {string} fileName - Must match the playlist or segment name pattern.
   * @param {{ requestSeq?: number, consumerId?: string }} [options] -
   *   `requestSeq` from {@link nextRequestSeq}, constant across one request's
   *   long-poll loop. `consumerId` says WHICH viewer is asking, so a session
   *   shared by several of them can tell their positions apart; absent from a
   *   browser or a transport that does not carry it, and then everything falls
   *   back to the one shared position.
   * @returns {Promise<
   *   | { kind: "not-found" }
   *   | { kind: "warming-up" }
   *   | { kind: "failed"; message: string }
   *   | { kind: "file"; stream: import("node:fs").ReadStream; contentType: string; isPlaylist: boolean }
   * >}
   */
  async getFileStream(sessionId, fileName, options = {}) {
    const consumerId = typeof options.consumerId === "string" ? options.consumerId : "";
    if (!isOutputName(sessionId)) {
      return { kind: "not-found" };
    }
    const session = this.outputs.get(sessionId);
    // The session is looked up BEFORE the name is validated, because what
    // counts as a valid segment name depends on the container this session
    // chose — `.mp4` for fMP4, `.ts` for MPEG-TS.
    if (!session || !isSafeFileName(fileName, session.segmentFormat)) {
      return { kind: "not-found" };
    }
    if (this.encodeRuns.runStateOf(session) === ENCODE_RUN_STATE.RETRY_WAIT) {
      // The data went away and is being fetched again. Holding the request is
      // the truthful answer: nothing is broken and there is nothing for the
      // viewer to retry.
      return { kind: "warming-up" };
    }
    if (this.encodeRuns.runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED) {
      return {
        kind: "failed",
        message: this.encodeRuns.lastErrorOf(session) || "ffmpeg failed for this transcode session."
      };
    }
    this.outputs.touch(session);

    // The index of variants. Served from here rather than a route of its own,
    // because to a player it is simply another playlist under the session.
    if (fileName === MASTER_PLAYLIST_FILE_NAME) {
      const masterText = this.buildMasterPlaylist(sessionId, consumerId);
      if (!masterText) {
        return { kind: "not-found" };
      }
      return {
        kind: "file",
        stream: Readable.from([masterText]),
        contentType: "application/vnd.apple.mpegurl",
        isPlaylist: true
      };
    }

    // Serve the synthetic VOD playlist (full duration, terminated with
    // #EXT-X-ENDLIST) so the player gets the correct total length and a fully
    // seekable timeline up-front, independent of how far ffmpeg has encoded.
    if (fileName === PLAYLIST_FILE_NAME && session.useSyntheticPlaylist) {
      return {
        kind: "file",
        stream: Readable.from([session.playlistText]),
        contentType: "application/vnd.apple.mpegurl",
        isPlaylist: true
      };
    }

    // The init segment (fMP4 only; referenced by #EXT-X-MAP). Each seek-restart
    // run REWRITES it, so cache the FIRST one and always serve that — the
    // player fetches it once and never re-fetches, so it must stay stable for
    // the session's lifetime. (What that costs, and why segments must therefore
    // carry their own position, is documented in `segment-formats/mp4-boxes.js`
    // `stampSegmentStartTime`.)
    //
    // ffmpeg creates init.mp4 before it has finished writing the fMP4 header
    // boxes into it (unlike segments, its write is not gated behind an atomic
    // rename), so a read can race a moment where the file EXISTS but is still
    // EMPTY. Root cause of a real incident: that empty read used to be cached
    // as `session.initBytes` — a zero-length Buffer is still a truthy object,
    // so `if (session.initBytes)` treated it as "already resolved" and served
    // the empty file for the rest of the session's life, permanently breaking
    // playback (hls.js can never initialize its SourceBuffer from an empty
    // init segment) while the transcode itself kept encoding normally. Guard
    // on non-empty content on both the cache check and the fresh read, so an
    // empty read is treated as not-yet-ready and the caller's long-poll keeps
    // retrying until ffmpeg has actually written the header.
    const { initFileName } = session.segmentFormat;
    if (initFileName !== null && fileName === initFileName) {
      if (session.initBytes && session.initBytes.length > 0) {
        return {
          kind: "file",
          stream: Readable.from([session.initBytes]),
          contentType: session.segmentFormat.initContentType,
          isPlaylist: false
        };
      }
      try {
        // With explicit cut times there is no init file: that muxer writes each
        // piece self-contained, header and all. The header is identical in every
        // piece, so the first one to exist supplies it.
        const bytes = cutsAtGivenTimes(session)
          ? await this.#initFromFirstSegment(session)
          : await readFile(path.join(this.segmentStore.pathFor(session.outputKey ?? ""), initFileName));
        if (!bytes || bytes.length === 0) {
          return { kind: "warming-up" };
        }
        session.initBytes = bytes;
        return {
          kind: "file",
          stream: Readable.from([bytes]),
          contentType: session.segmentFormat.initContentType,
          isPlaylist: false
        };
      } catch (error) {
        if (error?.code === "ENOENT") {
          // Not produced yet — the encode run started at session creation
          // writes it early; the caller long-polls until it appears.
          return { kind: "warming-up" };
        }
        logger.error(
          `transcode ${session.id} could not serve ${initFileName}: ${error?.message ?? error}` +
          (error?.stack ? `\n${error.stack}` : "")
        );
        return {
          kind: "failed",
          message: `Could not serve ${initFileName}: ${error?.message ?? String(error)}`
        };
      }
    }

    // Which run's copy answers, when several have written this name. Chosen by
    // what the copies CARRY, not by which run is newest — see #chooseProducedCopy.
    const filePath = this.segmentStore.pathOfName(session.outputKey ?? "", fileName) ??
      path.join(this.segmentStore.pathFor(session.outputKey ?? ""), fileName);
    const isPlaylist = fileName === PLAYLIST_FILE_NAME;
    if (!isPlaylist) {
      // A REQUEST SAYS THE VIEWER IS HERE, AND NOTHING ELSE. It does not say
      // where they are — that is what they state themselves — and it steers no
      // encoder: the segment either exists and is served, or does not and is
      // waited for.
      const requested = session.segmentFormat.segmentIndexFromName(fileName);
      if (requested >= 0) {
        this.#noteViewerSeen(session, consumerId);
        // A viewer who has caught up must not wait out the monitor's interval —
        // but only if they HAVE caught up, which is why this re-evaluates the
        // same condition instead of resuming outright.
        this.#reportCushionFor(session);
      }
    }
    // Whether the file is there is asked on its own, and nothing else shares
    // this catch. Everything below is PREPARATION of a file that exists, and a
    // failure there means something entirely different from "not produced yet"
    // — but for one release the two were caught together, so an undeclared name
    // in the fMP4 path read as "the segment is not ready". Every poll threw the
    // same ReferenceError, every poll answered "wait", and playback never began
    // on any file cut at keyframes (2.9.124; measured 2026-08-08: segment #0
    // held for 45 281 ms with twelve finished segments on disk).
    try {
      await access(filePath);
    } catch {
      // Not produced yet.
      return this.#holdForProduction(session, fileName, isPlaylist, options);
    }
    try {
      // Existing is not the same as finished. The `hls` muxer wrote each
      // segment to a temporary name and renamed it once complete, so a file
      // appearing WAS a finished segment. The `segment` muxer has no such
      // option: the file appears when writing begins. Serving it then hands the
      // player a truncated segment, which it rejects and then simply stops —
      // observed as playback dying a few seconds in with the encoder still
      // running happily ahead. A segment is finished once the NEXT one has been
      // started, or once the run producing it has ended.
      if (!isPlaylist && cutsAtGivenTimes(session)) {
        // WHAT PROVES A PIECE IS WHOLE is the encoder's own word for it: it
        // names each file on a channel of its own the moment it closes it, and
        // the store keeps those names.
        //
        // What stood here instead was the existence of the NEXT file, with two
        // exceptions bolted on because it is not true. It is never true of the
        // last piece of a run — nothing is producing a next one — so the first
        // segment of every run was held: measured 2026-08-09, #807 held while
        // it lay on disk, and in August the same shape held #317 for 46 seconds
        // and then answered 404 to a browser that had given up.
        const index = session.segmentFormat.segmentIndexFromName(fileName);
        if (!this.segmentStore.isClosed(session.outputKey ?? "", index)) {
          this.#explainHold(session, fileName, "the encoder has not closed it yet");
          return { kind: "warming-up" };
        }
      }

      // Cold-start: log the first servable SEGMENT of this session exactly once
      // — the time from session-create entry to a playable first segment.
      if (!isPlaylist && !session.firstSegmentLogged) {
        session.firstSegmentLogged = true;
        // Data is flowing again, so the next loss starts its backoff afresh
        // rather than inheriting the delay of the last one.
        session.inputRetryCount = 0;
        this.hostTimings.rememberFirstSegmentLatency(Date.now() - session.createEntryMs);
        logger.info(
          `cold-start ${sessionId.slice(0, 8)}: first-segment ready +${Date.now() - session.createEntryMs}ms`
        );
      }
      // Formats whose segments need correcting before they are valid against
      // the session's cached init are read whole and passed through the format
      // module; the rest stream straight off disk.
      if (!isPlaylist && session.segmentFormat.needsSegmentRewrite) {
        const index = session.segmentFormat.segmentIndexFromName(fileName);
        const raw = await readFile(filePath);
        // Self-contained pieces carry the init header; a media segment must not.
        const bytes = cutsAtGivenTimes(session) && session.segmentFormat.stripInit
          ? session.segmentFormat.stripInit(raw)
          : raw;
        // WHOLE OR SHORT IS A JUDGEMENT ABOUT BYTES, and the format that
        // knows how to read them makes it (`judgeTracks`). What is done about
        // the answer is this path's business and stays here: a whole piece is
        // served, a short one is removed so it can be made again.
        const verdict = session.segmentFormat.judgeTracks?.(raw, bytes, session.initBytes ?? null) ?? null;
        if (verdict && !verdict.whole) {
          logger.warn(
            `transcode ${session.id} segment #${index} is short of a track — ` +
            `${filePath}, ${raw.length} bytes on disk, ${bytes.length} of body, ` +
            `${verdict.fragmentTracks} track(s) in its fragments against ` +
            `${verdict.sessionTracks} the session's header declares and ` +
            `${verdict.ownTracks} its own declares — ${verdict.because}`
          );
          if (!verdict.serve) {
            try {
              await unlink(filePath);
            } catch {
              // Already gone: either way nothing to do.
            }
            // What the store remembers of this directory is stale the moment a
            // file is taken out of it.
            this.segmentStore.forget(session.outputKey ?? "");
            return { kind: "warming-up" };
          }
        }
        // Where this segment REALLY begins, taken from the piece itself, and
        // only from the playlist when the piece does not say.
        //
        // The playlist's own answer is built from the container's keyframe
        // index, and an index can be wrong: measured 2026-08-06 on a Matroska
        // file whose index claimed a keyframe at 157.99 s where the real ones
        // were 153.82 and 164.247. ffmpeg cut at 153.82, and stamping that
        // picture with 157.99 told the player it belonged four seconds later
        // than it did — while subtitles, extracted straight from the source,
        // kept the true times. Speech and text drifted apart by 4.17 s.
        //
        // Read from `raw`, before the header is stripped: the position lives
        // in an empty edit in the piece's own `moov`, which `stripInit`
        // removes. Identical to the playlist's figure whenever the index is
        // honest, so nothing changes for a well-formed file.
        const trueStart = cutsAtGivenTimes(session)
          ? session.segmentFormat.readSegmentStartSeconds?.(raw) ?? null
          : null;
        const declaredStart = this.outputTimes.segmentStartTime(session, index);
        if (trueStart !== null) {
          this.outputTimes.noteRunLanding(session, index, trueStart);
          this.outputTimes.noteIndexAccuracy(session, index, trueStart, declaredStart);
        }
        // WHERE THE PLAYER WAS TOLD THIS SEGMENT BEGINS, which is the playlist
        // it holds and nothing else. The published text is fixed when the
        // session is created; `#segmentStartTime` reads a table that a
        // correction may since have moved, and a stamp taken from the moved
        // table describes a timeline the player has never seen.
        const publishedStart = this.outputTimes.publishedStartTime(session, index);
        // A player places a fragment by the playlist. If the bytes claim a
        // different position, the fragment does not land where the fragment was
        // expected, hls.js finds the range still unbuffered and asks for the
        // same fragment again — for ever. Measured 2026-08-17: a seek to
        // 1590.4 s produced audio segments #292/#293 whose own timeline said
        // 1587.892 and 1592.692 against a playlist saying 1585.376 and
        // 1590.585, and the browser fetched those two segments 1908 times each
        // over ten minutes, every one of them served in 4 ms. The film was dead
        // and no line said why.
        //
        // So the stamp follows the playlist whenever the two disagree by more
        // than a player will bridge. hls.js bridges up to `maxBufferHole`,
        // which it defaults to 0.5 s — that is the player's own published
        // figure, not a number chosen here. Within it the file's own position
        // is kept, because it is the honest one and it is what keeps speech and
        // subtitles together on a file whose index is slightly out (2026-08-06,
        // 4.17 s of drift on a Matroska index that lied).
        // STAMPED WITH ITS OWN TRUE START, always. Two attempts at moving it
        // toward the playlist both made things worse, and the reason is in what
        // the first segment of a run is: it is not CUT at all — it begins where
        // ffmpeg's seek landed. The picture must land on a keyframe; the sound
        // needs none and starts at the instant asked for. So after every
        // restart the two runs genuinely begin at different real times, and the
        // whole run carries that difference (field 2026-08-17: the sound's
        // #292 began at 1587.892 s and #293 at 1592.692 s — exactly one segment
        // apart, the whole run shifted 2.5 s from the grid).
        //
        // Labelling each track with its own true time is therefore what keeps
        // picture and sound together in real time. Moving them onto the
        // published grid — separately (2.24.1) or by one family offset (2.25.0)
        // — closes a gap that is real and opens one that is not: it desynced
        // playback in the field within the hour, twice.
        //
        // What that leaves unsolved is the reason those attempts were made: a
        // playlist that disagrees with the media by more than a player bridges
        // makes hls.js refetch the same fragment for ever (1908 times each for
        // two segments, measured). The answer to THAT is to make the published
        // grid agree with where the runs really begin — not to relabel the
        // media. Recorded as its own roadmap item rather than guessed at here.
        const stampStart = trueStart ?? publishedStart;
        if (trueStart !== null && Math.abs(trueStart - publishedStart) > PLAYER_BUFFER_HOLE_SEC) {
          this.outputTimes.notePlaylistDisagreement(session, index, trueStart, publishedStart);
        }
        const prepared = session.segmentFormat.prepareSegmentBytes(bytes, {
          startSeconds: stampStart,
          initBytes: session.initBytes ?? null
        });
        this.encodeRuns.noteRunProducedSegment(session, filePath);
        return {
          kind: "file",
          stream: Readable.from([prepared]),
          contentType: session.segmentFormat.segmentContentType,
          isPlaylist: false
        };
      }
      if (!isPlaylist) {
        this.encodeRuns.noteRunProducedSegment(session, filePath);
      }
      return {
        kind: "file",
        stream: isPlaylist
          ? createReadStream(filePath)
          : createReadStream(filePath, { highWaterMark: SEGMENT_READ_HIGH_WATER_MARK }),
        contentType: isPlaylist
          ? "application/vnd.apple.mpegurl"
          : session.segmentFormat.segmentContentType,
        isPlaylist
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        // The file went away between the check and the read — a leftover being
        // removed so it can be produced again. Means exactly what never having
        // existed means.
        return this.#holdForProduction(session, fileName, isPlaylist, options);
      }
      // Anything else is a fault in producing the answer. Name it: a request
      // answered "wait" for ever tells the viewer nothing and leaves no trace
      // of what actually happened.
      logger.error(
        `transcode ${session.id} could not serve ${fileName}: ${error?.message ?? error}` +
        (error?.stack ? `\n${error.stack}` : "")
      );
      return {
        kind: "failed",
        message: `Could not serve ${fileName}: ${error?.message ?? String(error)}`
      };
    }
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
   * Say WHY a segment is being held, at most once every few seconds per file.
   *
   * A hold is silent today, and that silence has now cost three releases: a
   * file that exists, a route that answers "not yet", and nothing anywhere
   * saying which of the several reasons applied. Measured 2026-08-09: a run
   * begun mid-file at segment #317 produced two minutes of video from #317
   * upwards at 10.5x, and #317 itself was held 46 s and then answered 404 once
   * the browser had given up — with not one line about the cause.
   *
   * @param {HlsSession} session
   * @param {string} fileName
   * @param {string} reason
   * @returns {void}
   */
  #explainHold(session, fileName, reason) {
    const now = Date.now();
    session.holdExplainedAt ??= new Map();
    const last = session.holdExplainedAt.get(fileName) ?? 0;
    if (now - last < 5_000) {
      return;
    }
    session.holdExplainedAt.set(fileName, now);
    const index = session.segmentFormat.segmentIndexFromName(fileName);
    // What the encoder has actually DONE since it restarted. "Alive at the right
    // index" was as far as the old line went, and it left the two possible
    // causes indistinguishable: an encoder waiting for torrent pieces looks
    // exactly like one that is encoding and simply has not finished. The
    // difference is whether its position has moved at all.
    // Where this run began, from the run — the same reckoning
    // `processedSeconds` is counted in. A table lookup here can disagree with
    // it by the distance between the two grids, which is enough to print a
    // negative "produced" and send the reader after the torrent when the
    // encoder is the subject.
    const progress = this.encodeRuns.progressOf(session, index);
    const runStartSeconds = Number.isFinite(progress?.startPositionSeconds)
      ? progress.startPositionSeconds
      : this.runStartTimeFor(session, earliestRunStart(this.encodeRuns.runsOf(session)) ?? 0);
    const position = Number(progress?.processedSeconds);
    const produced = Number.isFinite(position) ? position - runStartSeconds : null;
    const speed = progress?.speed || "n/a";
    logger.warn(
      `transcode ${session.id} holding ${fileName}: ${reason} ` +
      `(runs from #${earliestRunStart(this.encodeRuns.runsOf(session)) ?? "?"}, viewer at #${this.outputTimes.segmentIndexForTime(session, viewerSecondsOn(session))}, ` +
      `encoder ${this.encodeRuns.liveRunsOf(session).length > 0 ? "alive" : "stopped"}, index #${index}, ` +
      `produced ${produced === null ? "nothing yet — no position reported" : `${produced.toFixed(1)}s`} ` +
      `at ${speed}${produced !== null && produced <= 0 ? " — the encoder has not moved, so it is waiting on its input" : ""})`
    );
  }

  /**
   * A produced file that has anything in it, or null.
   *
   * For callers that need a file's CONTENTS and cannot judge them — deriving
   * the session's header is the case, since the header is what judging would
   * need. An empty file answers no question, so it is passed over.
   *
   * @param {HlsSession} session
   * @param {string} fileName
   * @returns {Promise<string | null>}
   */
  async #firstCopyWithBytes(session, fileName) {
    const held = this.segmentStore.pathOfName(session.outputKey ?? "", fileName);
    if (held === null) {
      return null;
    }
    try {
      const info = await stat(held);
      return info.size > 0 ? held : null;
    } catch {
      return null;
    }
  }

  /**
   * Every segment number this session's OUTPUT holds, whoever produced it.
   *
   * Public because it is the one thing worth asserting about the address
   * change: two sessions of one output answer with the same list, including
   * segments the other one's encoder made.
   *
   * @param {HlsSession} session
   * @returns {number[]}
   */
  producedSegmentNumbers(session) {
    return new Set(this.#producedNumbers(session));
  }

  /**
   * Take back what a previous life of this process left on the disk.
   *
   * Called once at startup, and it is the only record there is of an encoder
   * that ended without anything recording why: when the kernel kills this
   * process no exit handler runs, nothing is cleared up, and — measured on the
   * addon host 2026-09-04 — the files survive, because `/tmp` there is on the
   * overlay filesystem rather than in memory.
   *
   * What survived is kept rather than thrown away. A copied segment's bytes
   * depend only on the source, so it is as good as it was; re-encoding it would
   * cost the machine that is already the scarce thing.
   *
   * @returns {{ adopted: number, dropped: number, unprovenRemoved: number }}
   */
  adoptSegmentsLeftBehind() {
    return this.segmentStore.adoptWhatSurvived((key) => {
      // Which container the segments are in is stated by the key itself, so a
      // directory can be read back without any record kept elsewhere. A key in
      // a shape this version does not write — one naming the box a viewer
      // asked for rather than the format produced — cannot say what format is
      // inside, and the directory goes.
      const stated = OutputSpec.fromKey(key)?.segmentFormatId ?? "";
      return SEGMENT_FORMAT_IDS.includes(stated) ? resolveSegmentFormat(stated) : null;
    });
  }

  /**
   * What this session's OUTPUT holds, asked of the one thing that owns it.
   *
   * There were two owners of this fact over one directory: the store, addressed
   * by the output's own key, and a `ProducedIndex` built per SESSION over a
   * path the store had handed out. Two viewers of one output therefore built
   * two indexes over one directory, each with its own idea of what was in it.
   *
   * @param {HlsSession} session
   * @returns {number[]} Every segment number it holds, in order.
   */
  #producedNumbers(session) {
    return this.segmentStore.provenNumbers(session.outputKey ?? "");
  }

  #holdForProduction(session, fileName, isPlaylist, options) {
    /** @type {{ address: string, rank: number, topRank: number } | null} */
    let ranked = null;
    if (!isPlaylist) {
      this.#explainHold(session, fileName, "the file is not on disk");
    }
    // A segment was requested that ffmpeg has not produced yet.  Decide whether
    // to wait for the current encode run to reach it or to restart the encoder
    // at this position (server-side seeking).  The caller long-polls.
    if (!isPlaylist) {
      const requestedIndex = session.segmentFormat.segmentIndexFromName(fileName);
      // Unanswerable, and known to be: behind a run that only moves forward,
      // too far behind for the repair to fetch it, and no seek on its way to
      // move the encoder there. Holding it changes nothing about whether it can
      // be produced — it only spends the player's patience.
      //
      // This is what a track change costs when it is held instead: measured
      // 2026-08-15, hls.js asked the new track for segment #0 while the run was
      // at #354, the request was held for the full minute, and only when it
      // failed did the player move to the segment it actually needed — 63 s of
      // spinner after a track that had been made ready in 7.
      //
      // WHETHER ANYBODY IS COMING FOR IT, asked of the encoding (`rankAt`,
      // which also tells "in nobody's zone" from "no map yet"). The same walk
      // was written out here and could answer only yes or no, so the RANK was
      // discarded at the one point where a viewer measurably waits for a named
      // segment; it goes back out with the answer, because the wait is measured
      // by whoever holds the request.
      const address = session.outputKey ?? "";
      const { rank, topRank } = this.encodeOrchestrator.rankAt(address, requestedIndex);
      ranked = { address, rank, topRank };
      const nobodyIsComing = topRank > 0 && rank === 0;
      if (
        Number.isFinite(requestedIndex) &&
        requestedIndex < (earliestRunStart(this.encodeRuns.runsOf(session)) ?? 0) &&
        nobodyIsComing &&
        this.encodeRuns.liveRunsOf(session).length > 0
      ) {
        logger.info(
          `transcode ${session.id} segment #${requestedIndex} is ${(earliestRunStart(this.encodeRuns.runsOf(session)) ?? 0) - requestedIndex} ` +
          "segments behind the run and in nobody's zone; answered as absent rather than held"
        );
        return { kind: "not-found", ranked };
      }
      this.#ensureEncodingFor(
        session,
        requestedIndex,
        Number.isFinite(options?.requestSeq) ? options.requestSeq : Number.MAX_SAFE_INTEGER
      );
    }
    return { kind: "warming-up", ranked };
  }

  /**
   * Dispose all sessions that have been idle longer than `sessionTtlMs`.
   * Called automatically on the cleanup interval.
   *
   * @returns {Promise<void>}
   */
  async cleanupExpired() {
    const idsToDispose = this.outputs.expiredBefore(Date.now() - this.sessionTtlMs);
    for (const sessionId of idsToDispose) {
      await this.disposeSession(sessionId);
    }
    // A timeline nobody is reading any more. It is small — two arrays of a few
    // thousand numbers — but nothing removed it, and a proxy that has served a
    // hundred films would have held a hundred of them for the life of the
    // process. An unbounded map that only ever grows is the shape of half the
    // memory faults recorded in this repository.
    const timelinesInUse = new Set();
    for (const session of this.outputs.values()) {
      if (session.timeline) {
        timelinesInUse.add(session.timeline);
      }
    }
    this.timelines.forgetUnused(timelinesInUse);
    const filesInUse = new Set();
    const keyframesInUse = new Set();
    for (const session of this.outputs.values()) {
      if (session.file) {
        filesInUse.add(session.file);
      }
      if (session.spec?.audio) {
        filesInUse.add(this.sourceFiles.get(session.file.sourceKey, session.spec.audioFileIndex));
      }
      if (session.keyframes) {
        keyframesInUse.add(session.keyframes);
      }
    }
    this.sourceFiles.forgetUnused(filesInUse);
    this.keyframeTables.forgetUnused(keyframesInUse);
    // The segments outlive every session on them, so what they cost is decided
    // here rather than by anybody's departure: how long ago each output was
    // last read, and how much room the disk has for the lot.
    // The room is the disk owner's to divide; this asks what the share is now.
    await this.machineBudget.revise();
    // What viewers actually do, beside the period that stands in for it. Said
    // where it can be read against the disk figures rather than on its own.
    const returns = this.returns.describe(IDLE_KEEP_MS);
    if (returns !== null) {
      logger.info(returns);
    }
    this.segmentStore.enforce({
      idleMs: SEGMENT_STORE_IDLE_MS,
      maxBytes: this.machineBudget.segmentBytes(),
      viewersAt: (key) =>
        viewerSegmentsOn({
          outputs: this.outputs.values(),
          outputKey: key,
          segmentAt: (session, seconds) => this.outputTimes.segmentIndexForTime(session, seconds),
          now: Date.now(),
        })
    });
  }

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

  /**
   * This person has gone, and their connection is what said so.
   *
   * Departure is a fact about the PERSON, not about one of the three outputs
   * the browser happens to hold an id for, and their connection knows it before
   * any output does. Until 2026-09-05 nothing carried it: the only exits were
   * the browser's own `release`, which a killed tab never sends, and a silence
   * long enough to be called an absence, which a paused viewer produces without
   * having gone anywhere.
   *
   * Every output they were watching is told, and one with nobody left is
   * disposed by the same path a normal release takes.
   *
   * @param {string} consumerId
   * @param {string} [because]
   * @returns {Promise<number>} How many outputs they were let go of.
   */
  async viewerHasGone(consumerId, because = "their connection closed") {
    if (typeof consumerId !== "string" || consumerId.length === 0) {
      return 0;
    }
    const watched = this.viewers.get(consumerId)?.outputs;
    if (!watched || watched.size === 0) {
      return 0;
    }
    // Copied before anything is released: releasing walks the same set.
    const outputs = [...watched];
    for (const outputId of outputs) {
      await this.releaseSessionConsumer(outputId, consumerId, because);
    }
    return outputs.length;
  }

  /**
   * Remove a consumer from a session. Disposes the session when the last
   * consumer leaves.
   *
   * @param {string} sessionId
   * @param {string} [consumerId=""]
   * @param {string} [reason=""]     - Human-readable reason shown in logs.
   * @returns {Promise<boolean>} `false` if the session was not found.
   */
  async releaseSessionConsumer(sessionId, consumerId = "", reason = "") {
    if (!isOutputName(sessionId) || typeof consumerId !== "string" || consumerId.length === 0) {
      return false;
    }
    const session = this.outputs.get(sessionId);
    if (!session) {
      return false;
    }
    const internalClaim = isFamilyConsumerId(consumerId);
    if (internalClaim) {
      session.claims?.delete(consumerId);
    }
    // And everything that was true of them alone, in EVERY output of this film
    // they were watching — not only in the one the browser addresses. A viewer
    // watches a picture, a quality step and a soundtrack; the browser knows one
    // id of the three, so subtracting them here from that one left them counted
    // as watching the other two. This is the half of the relation the viewer
    // holds, and it exists for exactly this question.
    if (!internalClaim) {
      for (const outputId of this.viewers.watching(session, consumerId)) {
        const output = this.outputs.get(outputId);
        if (output) {
          this.#viewerLeaves(output, consumerId);
        }
      }
      this.#viewerLeaves(session, consumerId);
    }
    this.outputs.touch(session);
    const remaining = viewersOf(session).size + (session.claims?.size ?? 0);
    const logReason = typeof reason === "string" && reason.length > 0 ? reason : "unspecified";
    logger.info(
      `consumer released (${logReason}) session=${session.id} consumer=${consumerId} ` +
        `remaining=${remaining}`
    );
    if (remaining > 0) {
      return true;
    }
    // Read before the picture goes, because a family is found through the file
    // the sessions share and a disposed session is no longer among them.
    const family = this.outputs.familyOf(session).filter((other) => other !== session);
    await this.disposeSession(sessionId);
    // The quality steps and the soundtracks this picture had made. Nobody
    // outside this class knows their ids — the browser holds one id for the
    // whole film — so nothing else can ever let go of them, and each holds a
    // consumer, a claim on the torrent, a directory and, until the plan's next
    // pass, a live encoder. Left alone they would sit until the idle timer
    // noticed, half an hour later.
    //
    // The rule is the viewers and not the picture: an output with somebody
    // still watching stays, whoever made it. That is what makes this different
    // from the chain of links it replaced — a picture ending is not what kills
    // a soundtrack; having no listeners is.
    const familyConsumer = variantConsumerId(session.id);
    for (const output of family) {
      if (
        !this.outputs.has(output.id) ||
        viewersOf(output).size > 0 ||
        !(output.claims instanceof Set) ||
        !output.claims.has(familyConsumer)
      ) {
        continue;
      }
      await this.releaseSessionConsumer(
        output.id,
        familyConsumer,
        "nobody is watching it and the picture it was made for has ended"
      );
    }
    return true;
  }

  /**
   * Kill the ffmpeg process, remove it from all maps, and delete the temp dir.
   *
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async disposeSession(sessionId) {
    const session = this.outputs.get(sessionId);
    if (!session) {
      return;
    }
    this.outputs.delete(sessionId);
    this.outputTimes.logIndexAccuracy(session);

    // The chain that used to close here is gone. A picture session releasing a
    // consumer it held on every quality step and every soundtrack was a film
    // object in disguise: one part of a film deciding when another part dies,
    // which is exactly what the criterion refuses — the parts are born at
    // different times, die at different times and are addressed separately.
    //
    // What replaces it is the two sets. A step or a soundtrack nobody is
    // watching has no viewers, so the plan stops its encoders on the next pass
    // — that rule is `EncodePlan`'s and needs no list here — and what it made
    // stays servable until the disk budget says otherwise, which is what a
    // viewer coming back a minute later depends on.
    // A step that has gone must stop being answered with. Nothing has to reach
    // back into another session's map to arrange that: what the file records is
    // a HEIGHT, and the lookup finds no live session producing it, so the next
    // request builds one. What does have to be forgotten is what a VIEWER was
    // watching, because their next request would resolve a session that no
    // longer exists.
    for (const [consumerId] of [...viewersOf(session)]) {
      this.#viewerLeaves(session, consumerId);
    }
    for (const other of this.outputs.familyOf(session)) {
      for (const viewer of viewersOf(other).values()) {
        viewer.outputs.delete(session.id);
        if (viewer.activeVariantId === session.id) {
          viewer.activeVariantId = null;
        }
      }
    }

    // Whether the process is still RUNNING, not whether anyone has called kill
    // on it: `.killed` means only that a signal was sent, and a run that ended
    // by itself — the file watched through, or a failure — was never killed at
    // all. Asked the old way, every idle session on disposal signalled a dead
    // pid and claimed to be stopping a run that had already ended.
    for (const run of this.encodeRuns.liveRunsOf(session)) {
      const disposingProcess = run.process;
      if (!disposingProcess || hasChildExited(disposingProcess)) {
        continue;
      }
      // A run ends with the session, and it records that itself: left where it
      // was, its state would go on claiming a process that can be signalled and
      // an input that is being read, about a session that no longer exists.
      // `stop` also continues it first, since a suspended process does not act
      // on SIGTERM until it is let go.
      run.stop("the session was disposed");
      await waitForChildExit(disposingProcess);
    }
    this.encodeRuns.forgetEncodingOfGone(session);
    // The segments are NOT removed here, and that is the point of the address
    // change. They belong to the output, not to this session: another viewer
    // may be playing them right now, the viewer who just left may come back,
    // and a viewer who never had a session on this proxy may open the same film
    // a minute from now and find the work already done. A session ending says
    // nothing about any of that.
    //
    // What decides instead is when the material was last READ, and how much
    // room there is — `segmentStore.enforce`, run by the same timer that
    // expires sessions.
  }

  /**
   * Stop the cleanup timer, dispose all active sessions, and attempt to
   * remove the shared temp root directory if it is empty.
   * Called by Fastify's `onClose` hook during graceful shutdown.
   *
   * @returns {Promise<void>}
   */
  async disposeAll() {
    clearInterval(this.cleanupTimer);
    clearInterval(this.budgetTimer);
    const activeIds = Array.from(this.outputs.keys());
    for (const sessionId of activeIds) {
      await this.disposeSession(sessionId);
    }
    // Everything this process owns, root included. See SegmentStore.dropAll.
    this.segmentStore.dropAll("the proxy is shutting down");
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
}
