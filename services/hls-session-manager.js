/**
 * @file HLS transcode session manager.
 *
 * Spawns one ffmpeg process per unique source+settings combination and
 * streams the resulting HLS playlist and segments from a temporary directory.
 * Sessions are expired automatically via a periodic cleanup interval, or
 * immediately when all registered consumers release them.
 */

import { createReadStream } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { logger } from "../utils/logger.js";

/** Own package version, stamped onto session-start log lines. */
const PROXY_VERSION = createRequire(import.meta.url)("../package.json").version;
import {
  softwareDescriptor,
  chooseSoftwareEncodeSettings,
  pickSoftwarePreset,
  TRANSCODE_FPS,
  chooseOutputFps
} from "./hwaccel.js";
import {
  parseFfmpegDurationSeconds,
  parseFfmpegStartTimeSeconds,
  parseFfmpegVideoDimensions,
  parseFfmpegVideoFps,
  parseFfmpegHdr
} from "./ffmpeg-banner.js";
import { resolveSegmentFormat } from "./segment-formats/index.js";

const PLAYLIST_FILE_NAME = "index.m3u8";
const CLEANUP_INTERVAL_MS = 30_000;
const DEFAULT_SEGMENT_DURATION_SEC = 4;
// How many segments ahead of the current encode head a missing-segment request
// is allowed to be before we restart ffmpeg at that position (server-side seek).
// Requests within the window are served by waiting for the running encode.
const MAX_LOOKAHEAD_SEGMENTS = 8;
// After a seek-restart, ignore competing restart requests for this long. The
// synthetic VOD playlist lets the player request distant segments in quick
// succession (stall-recovery seeks); without a cooldown ffmpeg ping-pongs
// between positions, restarting endlessly and producing nothing.
const RESTART_COOLDOWN_MS = 4_000;
// How long a seek restart waits for the CURRENT run to produce its first
// segment before it is allowed to pre-empt it anyway. Generous, because the
// first segment after a seek is the slowest thing this pipeline does (ffmpeg
// restart + torrent pieces for a fresh position); still bounded so a wedged
// run cannot block seeking forever. See #fireSettledSeek.
const RUN_FIRST_SEGMENT_GRACE_MS = 30_000;
// Encoder stall watchdog. A running ffmpeg emits `-progress` output on stdout
// continuously while it encodes; when it hangs mid-file (alive, but producing
// no output and no stderr — a deadlock, e.g. a stalled input read), that output
// stops and `progress.updatedAt` freezes. If a segment INSIDE the look-ahead
// window is being demanded but progress has not advanced for this long, the
// encoder is wedged (observed: the segment 503s forever). Treat it like a seek
// and restart ffmpeg at the demanded segment. Conservative — a slow-but-moving
// encode keeps advancing `updatedAt`, so this only fires on a true freeze.
const ENCODER_STALL_MS = 12_000;
// Seek debounce. A far (out-of-window) segment request is a server-side seek.
// Rather than restart ffmpeg on the first one, wait a short quiet period:
// further far requests re-arm it and update the target to the latest index, so
// a scrub that emits a burst of scattered requests (e.g. iOS native HLS firing
// 367,732,369,368,370 seconds apart) collapses to ONE restart at the position
// the player ended on, instead of ping-ponging ffmpeg between positions and
// producing nothing.
const SEEK_SETTLE_MS = 1_200;
// Hard cap on the total settle wait, measured from the first far request of a
// burst, so a still-moving scrubber cannot delay a genuine seek forever.
const SEEK_SETTLE_MAX_MS = 2_500;
// Grace period to wait for the PREVIOUS ffmpeg process to exit (per signal
// escalation step: SIGTERM, then SIGKILL) before spawning its replacement into
// the same session directory. See #startEncodeRun.
const ENCODE_RUN_TERMINATE_GRACE_MS = 2_000;
// A seek-restart run that exits this fast never did real work — it failed at
// the seek/open step itself (container demux error, bad audio frame boundary,
// etc.), not mid-stream. Used to tell a genuine seek failure apart from a
// later, unrelated crash so the circuit breaker below only counts the former.
const SEEK_FAST_FAIL_MS = 2_000;
// Circuit breaker: consecutive fast failures AT THE SAME target before we stop
// auto-retrying and leave the session in its terminal "failed" state (surfaced
// to the client as a clean, retryable error) instead of looping forever. The
// keyframe-snap seek (see #startEncodeRun) already fixes the dominant failure
// mode (an unreliable container-computed seek position); this is a safety net
// for whatever residual case still fails — not a second competing "fix" that
// blindly retries the identical command hoping for a different result.
const MAX_SEEK_FAILURES = 3;
// Idle TTL: a session is disposed this long after the last segment/playlist
// access. Long enough that a viewer who pauses, backgrounds the tab, or briefly
// turns the phone off can resume WITHOUT a cold ffmpeg restart (the warm session
// also backs the seamless auto-reconnect). ffmpeg stops producing at the
// look-ahead cap when idle, so a lingering session costs retained segments on
// disk, not sustained CPU. Active playback refreshes the timer on every segment
// fetch, so it never expires mid-watch.
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_STARTUP_WAIT_MS = 5_000;
// Realtime budget — runtime downswitch (software encoder only). Periodically
// check each active software-transcode session's ffmpeg `speed`; when it stays
// below realtime for a sustained window AND the input is not download-starved
// (so the limit is the encoder, not the torrent), step down one resolution rung
// and restart at the current segment. Conservative so it never thrashes: a long
// sustained window, a post-action cooldown, a step cap, and no upswitch (v1).
const BUDGET_CHECK_INTERVAL_MS = 5_000;
// Speed below this (cumulative ffmpeg average) counts as "slow"; recovery to
// realtime resets the slow window (hysteresis).
const BUDGET_SPEED_SLOW = 0.95;
const BUDGET_SPEED_OK = 1.0;
// Slow must persist this long before a downshift (absorbs warm-up + brief
// complex scenes; the cumulative average won't dip this long unless the host
// genuinely can't keep up).
const BUDGET_SUSTAINED_MS = 15_000;
// After a downshift, wait this long before another (lets the new profile settle
// and a fresh cumulative average build).
const BUDGET_ACTION_COOLDOWN_MS = 30_000;
// Never step down more than this many rungs below the startup choice.
const BUDGET_MAX_DOWNSHIFTS = 3;
// The input counts as "keeping up" when the torrent downloads at least this
// multiple of the source's average byte rate. Below it (and not yet fully
// downloaded), a low speed is download-bound, not CPU-bound → do NOT downscale.
const BUDGET_DOWNLOAD_OK_FACTOR = 1.0;
// Viewer-link adaptation (adaptive bitrate, part b). The browser reports its
// measured data-channel throughput + buffered seconds every ~10 s; when a
// FRESH report shows the usable link (reported × safety margin) sustainedly
// below the observed produced bitrate AND the viewer's buffer is low, the
// budget loop steps the encode one rung down — same machinery, cooldown and
// floor as the CPU trigger. Manual-quality sessions are inherently exempt
// (their budgetLadder is null).
const LINK_REPORT_FRESH_MS = 30_000;
// Usable share of the reported link (protocol overhead + measurement noise).
const LINK_SAFETY = 0.8;
// Deficit must persist this long before acting (absorbs one slow segment).
const LINK_SLOW_WINDOW_MS = 15_000;
// Only act while the viewer is actually running dry; a comfortable buffer
// (e.g. paused playback filling ahead) suppresses the trigger.
const LINK_LOW_BUFFER_SEC = 10;
// Observed produced bitrate: average over this many recently completed
// segments (the newest file on disk may still be written and is excluded).
const LINK_OBSERVED_SEGMENTS = 5;
const MICROSECONDS_PER_SECOND = 1_000_000;
const PROGRESS_LOG_INTERVAL_MS = 5_000;
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
 * Return the temporary directory path for a given HLS session.
 *
 * @param {string} sessionId - UUID of the session.
 * @returns {string}
 */
function createSessionDirPath(sessionId) {
  return path.join(os.tmpdir(), "torrent-tv-hls", sessionId);
}

/**
 * Guard against path traversal by validating that a session ID is a UUID.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isSafeSessionId(value) {
  return /^[a-f0-9-]{36}$/i.test(value);
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
function parseFfmpegTimestamp(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const parts = value.split(":");
  if (parts.length !== 3) {
    return null;
  }
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = Number(parts[2]);
  if (![hours, minutes, seconds].every((item) => Number.isFinite(item))) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Format a seconds value as `HH:MM:SS`, or `"n/a"` if not finite.
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "n/a";
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

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
function computeProgressMetrics(processedSeconds, totalSeconds, startPositionSeconds = 0) {
  const processed = Number.isFinite(processedSeconds) ? Math.max(0, processedSeconds) : 0;
  const startOffset = Number.isFinite(startPositionSeconds) && startPositionSeconds > 0
    ? startPositionSeconds
    : 0;
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return { totalSeconds: null, percent: null, remainingSeconds: null, processedSeconds: processed };
  }
  const safeTotal = totalSeconds;
  const segmentDuration = Math.max(1, safeTotal - startOffset);
  const segmentProcessed = Math.max(0, processed - startOffset);
  const percent = Math.max(0, Math.min(100, (segmentProcessed / segmentDuration) * 100));
  const remainingSeconds = Math.max(0, safeTotal - processed);
  return {
    totalSeconds: safeTotal,
    percent,
    remainingSeconds,
    processedSeconds: processed
  };
}

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
        width: dims.width,
        height: dims.height,
        fps: parseFfmpegVideoFps(stderr),
        startTime: parseFfmpegStartTimeSeconds(stderr),
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
 * Compute the actual output resolution ffmpeg will produce: the target box
 * capped to the source (never upscaled), preserving aspect, divisible by 2.
 * Mirrors the `scale='min(w,iw)':'min(h,ih)':force_original_aspect_ratio=decrease`
 * filter. Returns `null` when the source size is unknown.
 *
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @param {number | null} sourceWidth
 * @param {number | null} sourceHeight
 * @returns {{ w: number, h: number } | null}
 */
function computeOutputDimensions(targetWidth, targetHeight, sourceWidth, sourceHeight) {
  const sw = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : 0;
  const sh = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 0;
  if (!sw || !sh) {
    return null;
  }
  const tw = Number.isInteger(targetWidth) && targetWidth > 0 ? targetWidth : sw;
  const th = Number.isInteger(targetHeight) && targetHeight > 0 ? targetHeight : sh;
  const scale = Math.min(tw / sw, th / sh, 1);
  let w = Math.round(sw * scale);
  let h = Math.round(sh * scale);
  w -= w % 2;
  h -= h % 2;
  return { w: Math.max(2, w), h: Math.max(2, h) };
}

/**
 * Resolve the ffprobe binary path from the ffmpeg path (same directory / name).
 *
 * @param {string} ffmpegBin
 * @returns {string}
 */
function ffprobeBinFor(ffmpegBin) {
  if (typeof ffmpegBin !== "string" || ffmpegBin.length === 0) {
    return "ffprobe";
  }
  if (/ffmpeg(\.exe)?$/i.test(ffmpegBin)) {
    return ffmpegBin.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  }
  return "ffprobe";
}

/**
 * Probe the source video stream's keyframe timestamps (seconds, in the source
 * timeline) via ffprobe packet flags. Used for the video-copy path, where we
 * cannot insert keyframes: the synthetic playlist's segment boundaries must
 * match the source's real keyframe positions or the player sees gaps on seek.
 *
 * Time-bounded; returns `null` on failure/timeout (caller falls back to a
 * uniform grid). NOTE: reading all video packets streams much of the file from
 * the torrent, so for large files this may time out and fall back.
 *
 * @param {string} ffmpegBin
 * @param {string | URL} inputUrl
 * @param {number} [timeoutMs]
 * @returns {Promise<number[] | null>} Sorted keyframe times, or null.
 */
async function probeVideoKeyframeTimes(ffmpegBin, inputUrl, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        ffprobeBinFor(ffmpegBin),
        [
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "packet=pts_time,flags",
          "-of", "csv=p=0",
          String(inputUrl)
        ],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
      );
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        if (!proc.killed) {
          proc.kill("SIGTERM");
        }
      } catch {
        // ignore
      }
      finish(null);
    }, timeoutMs);
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      const times = [];
      for (const line of stdout.split("\n")) {
        // Each line: "<pts_time>,<flags>" e.g. "12.345000,K__"
        const comma = line.indexOf(",");
        if (comma < 0) {
          continue;
        }
        const flags = line.slice(comma + 1);
        if (!flags.includes("K")) {
          continue;
        }
        const t = Number(line.slice(0, comma));
        if (Number.isFinite(t)) {
          times.push(t);
        }
      }
      times.sort((a, b) => a - b);
      finish(times.length > 0 ? times : null);
    });
  });
}

/**
 * Compute segment START times (a 0-based timeline) for a session.
 *
 * - Re-encoded video: a uniform grid (0, segDur, 2·segDur, …) — ffmpeg's fixed
 *   GOP makes the real cuts land exactly here.
 * - Copied video: the source's real keyframes, normalized to 0 (start time
 *   subtracted) and greedily grouped to ≥ segDur — these are exactly where
 *   `-hls_time segDur` cuts a copied stream, so the playlist matches reality.
 *
 * The returned array starts at 0 and ends at `durationSeconds` (so segment i
 * spans `[boundaries[i], boundaries[i+1])`). Falls back to a uniform grid when
 * keyframes are unavailable.
 *
 * @param {{ transcodeVideo: boolean, durationSeconds: number, segDur: number, keyframeTimes: number[] | null, startTime: number }} params
 * @returns {number[]}
 */
function computeSegmentBoundaries({ transcodeVideo, durationSeconds, segDur, keyframeTimes, startTime }) {
  const total = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const step = Number.isFinite(segDur) && segDur > 0 ? segDur : 4;
  const uniform = () => {
    const boundaries = [];
    for (let t = 0; t < total - 0.001; t += step) {
      boundaries.push(Number(t.toFixed(6)));
    }
    boundaries.push(total);
    return boundaries;
  };
  if (transcodeVideo || !Array.isArray(keyframeTimes) || keyframeTimes.length === 0 || total <= 0) {
    return uniform();
  }
  const base = Number.isFinite(startTime) ? startTime : 0;
  const norm = keyframeTimes
    .map((t) => t - base)
    .filter((t) => t >= -0.001 && t < total - 0.05)
    .sort((a, b) => a - b);
  const boundaries = [0];
  for (const kf of norm) {
    if (kf >= boundaries[boundaries.length - 1] + step - 0.05) {
      boundaries.push(Number(kf.toFixed(6)));
    }
  }
  boundaries.push(total);
  // Guard against a degenerate probe (e.g. a single keyframe) — fall back.
  return boundaries.length >= 2 ? boundaries : uniform();
}

/**
 * The largest keyframe time that does not exceed `target`, from a SORTED
 * (ascending) array of keyframe times such as {@link probeVideoKeyframeTimes}
 * returns. Null when `target` is before the first keyframe or the array is
 * empty — the caller then falls back to its unsnapped target.
 *
 * @param {number[]} keyframeTimes - Sorted ascending.
 * @param {number} target
 * @returns {number | null}
 */
function nearestKeyframeAtOrBefore(keyframeTimes, target) {
  let result = null;
  for (const time of keyframeTimes) {
    if (time > target) {
      break;
    }
    result = time;
  }
  return result;
}

function isWarmupTimeoutError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message === "HLS playlist is still warming up.";
}

function normalizeLogFileName(fileName, fileIndex) {
  const fallback = `file#${fileIndex}`;
  if (typeof fileName !== "string") {
    return fallback;
  }
  const value = fileName.trim();
  if (value.length === 0) {
    return fallback;
  }
  return value;
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
 * @property {string}  id            - UUID of the session.
 * @property {string}  sourceMapKey  - Cache key combining source + transcode settings.
 * @property {string}  fileName      - Display name of the file being transcoded.
 * @property {string}  dirPath       - Temp directory containing HLS output.
 * @property {"starting" | "ready" | "failed" | "disposed"} state
 * @property {number}  startedAt     - Unix ms timestamp when the session was created.
 * @property {number}  lastAccessedAt - Unix ms timestamp of the last consumer access.
 * @property {import("node:child_process").ChildProcess} ffmpeg
 * @property {string}  lastError
 * @property {Set<string>} consumers  - Consumer IDs currently using this session.
 * @property {object}  progress       - Live progress metrics updated from ffmpeg stdout.
 * @property {number}  encodeRunGeneration - Bumped on every #startEncodeRun call;
 *   lets a call that awaited the previous ffmpeg's exit detect it was superseded
 *   by a newer restart request and abort instead of spawning a second process.
 * @property {number[] | null} keyframeTimes - Real source keyframe times
 *   (sorted seconds), or null when the probe failed/timed out. Used to snap a
 *   source seek onto a known-valid position (see #startEncodeRun).
 * @property {number}  seekFailureTarget - Segment index of the last fast seek
 *   failure, for the consecutive-failure circuit breaker (see MAX_SEEK_FAILURES).
 * @property {number}  seekFailureCount  - Consecutive fast failures at seekFailureTarget.
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
    videoEncoder = null,
    softwarePresetBenchmark = null,
    getSourceStats = null,
    tonemapSupported = false,
    getCachedMediaInfo = null,
    segmentFormatId = undefined
  }) {
    this.enabled = Boolean(enabled);
    this.ffmpegBin = ffmpegBin;
    // Output container (fMP4/CMAF or MPEG-TS). Everything container-specific —
    // muxer args, file naming, playlist header, per-segment correction — lives
    // in this module; nothing here branches on the format.
    this.segmentFormat = resolveSegmentFormat(segmentFormatId);
    // Optional accessor for media info the playback planner already probed for
    // (sourceKey, fileIndex), so session create can skip its own ffmpeg scan.
    this.getCachedMediaInfo = typeof getCachedMediaInfo === "function" ? getCachedMediaInfo : null;
    // Optional async accessor for a source's live download stats, used by the
    // realtime budget to tell a CPU limit from a download-starved input:
    // (sourceKey, fileIndex) => Promise<{ downloadSpeed, fileLength, fileProgress } | null>.
    this.getSourceStats = typeof getSourceStats === "function" ? getSourceStats : null;
    // Detected H.264 encoder descriptor (hardware or software). Defaults to
    // software libx264 when no detection result is supplied. May be downgraded
    // to software at runtime if a hardware encode fails.
    this.videoEncoder = videoEncoder ?? softwareDescriptor();
    // Per-preset software encode throughput (pixels/sec) measured at startup,
    // used to pick the best preset per stream. Null when unavailable (hardware
    // encoder, or benchmark skipped/failed).
    this.softwarePresetBenchmark = Array.isArray(softwarePresetBenchmark) ? softwarePresetBenchmark : null;
    // Whether this ffmpeg build can tone-map HDR→SDR (zscale + tonemap filters).
    // Gates the tonemap chain for HDR sources on the software path.
    this.tonemapSupported = Boolean(tonemapSupported);
    this.segmentDurationSec = segmentDurationSec;
    this.sessionTtlMs = sessionTtlMs;
    this.startupWaitMs = startupWaitMs;
    this.localBaseUrl = buildHttpBaseUrl(localBindHost, localPort);
    this.sessionsById = new Map();
    this.sessionIdBySource = new Map();
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired();
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
    // Realtime-budget monitor: only meaningful for the software encoder with a
    // benchmark (the only path that can pick/step resolution). Cheap no-op scan
    // otherwise.
    this.budgetTimer = setInterval(() => {
      void this.#enforceRealtimeBudget();
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
   * @param {boolean} [options.manualQuality=false]      - User-forced resolution: encode the target box exactly (capped to source), no budget downscale / runtime downswitch.
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
    manualQuality = false
  }) {
    if (!this.enabled) {
      const error = new Error("Audio transcoding is disabled on this proxy.");
      error.code = "TRANSCODE_DISABLED";
      throw error;
    }

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
    const forceManualQuality = manualQuality === true && transcodeVideo;
    const sourceMapKey = [
      sourceKey,
      String(fileIndex),
      transcodeVideo ? "video" : "audio",
      transcodeAudio ? "a1" : "a0",
      `t${normalizedAudioTrack}`,
      String(normalizedTargetWidth),
      String(normalizedTargetHeight),
      forceManualQuality ? "q-manual" : "q-auto",
      String(normalizedStartPosition)
    ].join(":");
    const existingId = this.sessionIdBySource.get(sourceMapKey);
    if (existingId) {
      const existing = this.sessionsById.get(existingId);
      if (existing && existing.state !== "failed") {
        existing.fileName = normalizeLogFileName(fileName, fileIndex);
        if (consumerId) {
          existing.consumers.add(consumerId);
        }
        existing.lastAccessedAt = Date.now();
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

    const sessionId = randomUUID();
    const createEntryMs = Date.now();
    const sessionDir = createSessionDirPath(sessionId);
    await mkdir(sessionDir, { recursive: true });
    const inputUrl = new URL("/stream", `${this.localBaseUrl}/`);
    inputUrl.searchParams.set("sourceKey", sourceKey);
    inputUrl.searchParams.set("fileIndex", String(fileIndex));

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
    const mediaInfo = cachedUsable
      ? cachedMediaInfo
      : await probeInputMediaInfo(this.ffmpegBin, inputUrl.toString());
    const mediaInfoMs = Date.now() - mediaInfoStartMs;
    const mediaInfoSource = cachedUsable ? "cached" : "probed";
    const durationSeconds = mediaInfo.durationSeconds;
    const sourceWidth = mediaInfo.width;
    const sourceHeight = mediaInfo.height;
    const sourceStartTime = Number.isFinite(mediaInfo.startTime) ? mediaInfo.startTime : 0;
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
    const logName = normalizeLogFileName(fileName, fileIndex);
    if (!hasDuration) {
      logger.warn(
        `transcode ${sessionId}: could not probe duration; falling back to ` +
          `ffmpeg-managed (growing) playlist for "${logName}"`
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
    let keyframeTimes = null;
    let keyframeMs = -1; // -1 = not run (skipped), -2 = running in the background
    if (hasDuration && !transcodeVideo) {
      // Video-COPY path: keyframeTimes are REQUIRED to build correct segment
      // boundaries (the playlist itself), so this MUST block session creation —
      // an incorrect playlist is worse than a slower start. Short timeout: mp4
      // keyframes come from the moov index (fast); containers that force a full
      // packet scan time out and fall back to a uniform grid, so this never adds
      // more than ~6 s to session start.
      const keyframeStartMs = Date.now();
      keyframeTimes = await probeVideoKeyframeTimes(this.ffmpegBin, inputUrl.toString(), 6_000);
      keyframeMs = Date.now() - keyframeStartMs;
      if (!keyframeTimes) {
        logger.warn(
          `transcode ${sessionId}: keyframe probe unavailable; using uniform grid ` +
            `for "${logName}" (seek precision may be reduced)`
        );
      }
    } else if (hasDuration && transcodeVideo) {
      // Re-encode path: keyframeTimes are ONLY used to snap a LATER seek (see
      // #startEncodeRun) — segment boundaries stay on the uniform grid either
      // way. So this does NOT need to block session creation / the first
      // segment's start. Run it in the background with a FULL budget instead of
      // the 6 s cap: AVI-class containers need a full packet scan, which 6 s can
      // never afford without delaying playback start — that starved budget is
      // exactly why the probe kept missing on the container where the seek bug
      // was field-diagnosed. #startEncodeRun reads session.keyframeTimes fresh
      // on every call, so a seek that happens AFTER this finishes picks it up
      // automatically; one that happens before falls back to the existing
      // circuit breaker as a safety net (no regression either way).
      keyframeMs = -2;
      const backgroundStartedAt = Date.now();
      void probeVideoKeyframeTimes(this.ffmpegBin, inputUrl.toString(), 25_000).then((times) => {
        const liveSession = this.sessionsById.get(sessionId);
        if (!liveSession || liveSession.state === "disposed") {
          return; // Session gone before the probe finished — nothing to update.
        }
        liveSession.keyframeTimes = times;
        const elapsedMs = Date.now() - backgroundStartedAt;
        logger.info(
          times
            ? `transcode ${sessionId}: background keyframe probe found ${times.length} keyframes ` +
                `(${elapsedMs}ms) for "${logName}" — later seeks will snap to them`
            : `transcode ${sessionId}: background keyframe probe unavailable (${elapsedMs}ms) for "${logName}" ` +
                `— seeks keep using the raw target (falls back to the circuit breaker on failure)`
        );
      });
    }
    logger.info(
      `cold-start ${sessionId.slice(0, 8)}: media-info=${mediaInfoMs}ms (${mediaInfoSource}) ` +
        `keyframes=${keyframeMs === -1 ? "skipped" : keyframeMs === -2 ? "background" : `${keyframeMs}ms`} ` +
        `create-total=${Date.now() - createEntryMs}ms`
    );
    const segmentBoundaries = hasDuration
      ? computeSegmentBoundaries({
          transcodeVideo,
          durationSeconds,
          segDur: this.segmentDurationSec,
          keyframeTimes,
          startTime: sourceStartTime
        })
      : [];
    const usingKeyframeBoundaries = hasDuration && !transcodeVideo && Array.isArray(keyframeTimes);
    const segmentCount = segmentBoundaries.length > 1 ? segmentBoundaries.length - 1 : 0;

    // Realtime budget (software encoder): pick the output resolution + libx264
    // preset this host can encode faster than realtime. On a weak host this
    // downscales below the client target (the orientation-independent ceiling)
    // instead of dropping into sub-realtime playback. Null for hardware
    // encoders or when the source size / benchmark is unavailable — the encode
    // then keeps the client target box and buildVideoArgs's default preset.
    //
    // Manual quality bypasses the budget entirely: the user forced a specific
    // resolution, so encode exactly that box (capped to source by the scale
    // filter) with the default preset, and the runtime downswitch is skipped
    // for the session (budgetLadder stays null).
    const encodeBudget = forceManualQuality
      ? null
      : this.#chooseEncodeBudget({
          transcodeVideo,
          targetWidth: normalizedTargetWidth,
          targetHeight: normalizedTargetHeight,
          sourceWidth,
          sourceHeight,
          outputFps
        });
    const softwarePreset = encodeBudget?.preset ?? null;
    // Effective encode box: the budget's downscaled resolution when applied,
    // otherwise the client target (0 = keep source, handled by buildVideoArgs).
    const encodeWidth = encodeBudget?.width ?? normalizedTargetWidth;
    const encodeHeight = encodeBudget?.height ?? normalizedTargetHeight;

    const session = {
      id: sessionId,
      sourceMapKey,
      fileName: logName,
      dirPath: sessionDir,
      state: "starting",
      startedAt: Date.now(),
      lastAccessedAt: Date.now(),
      ffmpeg: null,
      encodeRunGeneration: 0,
      lastError: "",
      // Cold-start timing: entry timestamp + a once-guard so the first servable
      // segment logs its latency exactly once.
      createEntryMs,
      firstSegmentLogged: false,
      consumers: new Set(consumerId ? [consumerId] : []),
      // Transcode parameters retained so the encode run can be restarted at an
      // arbitrary segment when the player seeks (server-side seeking).
      sourceKey,
      fileIndex,
      transcodeVideo,
      transcodeAudio,
      audioTrackIndex: normalizedAudioTrack,
      outputFps,
      // Client-requested target box (the orientation-independent ceiling). Kept
      // for the session key and reference; the actual encode uses encodeWidth/
      // encodeHeight, which the realtime budget may have downscaled below this.
      targetWidth: normalizedTargetWidth,
      targetHeight: normalizedTargetHeight,
      // Effective encode resolution handed to ffmpeg (budget-selected on weak
      // software hosts, else the client target). 0 = keep source.
      encodeWidth,
      encodeHeight,
      // Whether to insert the HDR→SDR tone-map chain (software path only).
      applyTonemap,
      // Realtime-budget runtime state (software encoder only). The ladder is the
      // resolution rungs from the ceiling down; rungIndex is the current rung.
      // The monitor steps rungIndex down when the encoder is sustainedly
      // CPU-bound and restarts ffmpeg at the current segment.
      budgetLadder: encodeBudget?.ladder ?? null,
      budgetRungIndex: Number.isInteger(encodeBudget?.rungIndex) ? encodeBudget.rungIndex : 0,
      budgetDownshifts: 0,
      budgetSlowSince: 0,
      budgetLastActionAt: 0,
      // Latest viewer link report ({ linkMbps, bufferedAheadSec, at }) and the
      // link-deficit slow window (mirrors budgetSlowSince for the CPU path).
      netReport: null,
      linkSlowSince: 0,
      sourceWidth,
      sourceHeight,
      // Container start time (seconds); subtracted on the copy path so the
      // output timeline is 0-based even when the source starts at e.g. 0.1 s.
      sourceStartTime,
      // Chosen libx264 preset for this stream (software only), or null.
      softwarePreset,
      inputUrl: inputUrl.toString(),
      // VOD playlist bookkeeping.
      useSyntheticPlaylist: hasDuration,
      totalDurationSeconds: hasDuration ? durationSeconds : null,
      // Segment start times (0-based). Uniform grid for re-encoded video; real
      // keyframe positions for copied video. Drives the playlist and seeking.
      segmentBoundaries,
      segmentCount,
      // Real source keyframe times (sorted seconds), or null when the probe
      // failed/timed out. Used by #startEncodeRun to snap a source seek onto a
      // KNOWN valid position instead of trusting the container's own on-the-fly
      // seek at an arbitrary target — see the probe call above for why.
      keyframeTimes,
      playlistText: hasDuration ? this.#buildVodPlaylist(segmentBoundaries) : "",
      // Segment index the current ffmpeg run started producing from.
      encodeStartIndex: 0,
      // Guards against repeatedly restarting to the same seek position.
      pendingRestartIndex: -1,
      // Timestamp of the last encode (re)start, for the restart cooldown.
      lastRestartAt: 0,
      // Seek debounce: pending settle timer, the far segment index to restart
      // at once the burst settles, and the timestamp of the burst's first far
      // request (for the SEEK_SETTLE_MAX_MS cap).
      seekSettleTimer: null,
      seekTarget: null,
      // Monotonic sequence of INCOMING segment requests (see #ensureEncodingFor
      // and nextRequestSeq): a request is issued one number when it arrives and
      // keeps it across all its long-poll iterations, so a burst of requests
      // from one scrub cannot take turns steering the encoder.
      requestSeqCounter: 0,
      latestRequestSeq: 0,
      seekFirstFarAt: 0,
      // Circuit breaker: consecutive FAST failures (see SEEK_FAST_FAIL_MS) at
      // seekFailureTarget. Reset whenever a run starts at a DIFFERENT target or
      // survives past the fast-fail window. See the exit handler in
      // #wireEncodeProcess and MAX_SEEK_FAILURES.
      seekFailureTarget: -1,
      seekFailureCount: 0,
      progress: {
        state: "starting",
        processedSeconds: 0,
        startPositionSeconds: 0,
        totalSeconds: hasDuration ? durationSeconds : null,
        percent: null,
        remainingSeconds: hasDuration ? durationSeconds : null,
        speed: "",
        updatedAt: Date.now(),
        lastLoggedAt: 0
      }
    };
    this.sessionsById.set(sessionId, session);
    this.sessionIdBySource.set(sourceMapKey, sessionId);

    logger.info(
      // Proxy version on the session-start line: a field report always includes
      // one of these, so "is the host actually running the build I published?"
      // is answered by the log itself instead of a round trip to the machine.
      `transcode ${sessionId} start (proxy ${PROXY_VERSION}) "${logName}" ` +
        `video=${transcodeVideo ? `${this.videoEncoder.name}${softwarePreset ? `/${softwarePreset}` : ""}` : "copy"} ` +
        `audio=${transcodeAudio ? "aac" : "copy"} ` +
        // Branch tag for log correlation: A = video re-encode (fixed GOP, grid
        // aligned, ts-offset); B = video copy (cut at source keyframes, copyts).
        `branch=${transcodeVideo ? "A(reencode,fixed-gop)" : "B(copy,copyts)"} ` +
        `seg=${usingKeyframeBoundaries ? "keyframe" : "uniform"} ` +
        `${sourceWidth && sourceHeight ? `src=${sourceWidth}x${sourceHeight} ` : ""}` +
        // Effective encode resolution: budget-on (auto downscale from the
        // ceiling), manual (user-forced, budget off), or unset (keep source).
        `${transcodeVideo && encodeBudget ? `enc=${encodeWidth}x${encodeHeight}@${outputFps} budget=on ` : ""}` +
        `${transcodeVideo && forceManualQuality ? `enc=${encodeWidth || "src"}x${encodeHeight || "src"}@${outputFps} quality=manual ` : ""}` +
        // HDR source and whether the tone-map chain was applied (vs washed-out
        // fallback when the filters are missing or on a hardware encoder).
        `${transcodeVideo && mediaInfo.isHdr ? `hdr=1 tonemap=${applyTonemap ? "on" : "off"} ` : ""}` +
        `${sourceStartTime ? `start=${sourceStartTime.toFixed(3)} ` : ""}` +
        `duration=${hasDuration ? formatSeconds(durationSeconds) : "unknown"} segments=${segmentCount}`
    );

    await this.#startEncodeRun(session, 0);

    try {
      await this.waitUntilReady(session);
      return session;
    } catch (error) {
      if (session.state === "failed") {
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
  #buildVodPlaylist(boundaries) {
    const count = Math.max(0, boundaries.length - 1);
    let maxDuration = 0;
    for (let index = 0; index < count; index += 1) {
      const duration = Math.max(0.1, boundaries[index + 1] - boundaries[index]);
      if (duration > maxDuration) {
        maxDuration = duration;
      }
    }
    const lines = [
      "#EXTM3U",
      // The container decides the minimum version (fMP4 + `#EXT-X-MAP` needs 7,
      // MPEG-TS is fine at 3).
      `#EXT-X-VERSION:${this.segmentFormat.playlistVersion}`,
      `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      // Container-specific header lines (e.g. fMP4's `#EXT-X-MAP`).
      ...this.segmentFormat.playlistHeaderLines()
    ];
    for (let index = 0; index < count; index += 1) {
      const duration = Math.max(0.1, boundaries[index + 1] - boundaries[index]);
      lines.push(`#EXTINF:${duration.toFixed(6)},`);
      lines.push(this.segmentFormat.segmentFileName(index));
    }
    lines.push("#EXT-X-ENDLIST");
    return `${lines.join("\n")}\n`;
  }

  /**
   * Start time (seconds, 0-based) of segment `index`, from the session's
   * boundary table. Clamped to valid range.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @returns {number}
   */
  #segmentStartTime(session, index) {
    const boundaries = Array.isArray(session.segmentBoundaries) ? session.segmentBoundaries : [];
    if (boundaries.length === 0) {
      return index * this.segmentDurationSec;
    }
    const clamped = Math.max(0, Math.min(index, boundaries.length - 1));
    return boundaries[clamped];
  }

  /**
   * Segment index whose span contains time `t` (0-based), via the boundary
   * table.
   *
   * @param {HlsSession} session
   * @param {number} t
   * @returns {number}
   */
  #segmentIndexForTime(session, t) {
    const boundaries = Array.isArray(session.segmentBoundaries) ? session.segmentBoundaries : [];
    if (boundaries.length < 2) {
      return Math.max(0, Math.floor(t / this.segmentDurationSec));
    }
    // boundaries is sorted ascending; find the last boundary <= t.
    let lo = 0;
    let hi = boundaries.length - 1;
    let result = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (boundaries[mid] <= t) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return Math.min(result, boundaries.length - 2);
  }

  /**
   * Realtime budget (software encoder only): choose the output resolution AND
   * libx264 preset this host can encode faster than realtime, from the startup
   * benchmark. The ceiling is the client-requested box capped to the source
   * (never upscaled); the budget picks the highest resolution rung at or below
   * that ceiling that clears realtime × margin, then the best preset at that
   * resolution. On a weak host this downscales below the client target instead
   * of dropping into sub-realtime playback. Returns null when not applicable
   * (no video transcode, hardware encoder, or missing benchmark/source size) —
   * the encode then keeps the ceiling resolution and the default preset.
   *
   * @param {{ transcodeVideo: boolean, targetWidth: number, targetHeight: number, sourceWidth: number | null, sourceHeight: number | null, outputFps: number }} params
   * @returns {{ width: number, height: number, preset: string } | null}
   */
  #chooseEncodeBudget({ transcodeVideo, targetWidth, targetHeight, sourceWidth, sourceHeight, outputFps }) {
    if (!transcodeVideo || this.videoEncoder?.kind !== "software" || !this.softwarePresetBenchmark) {
      return null;
    }
    const ceiling = computeOutputDimensions(targetWidth, targetHeight, sourceWidth, sourceHeight);
    if (!ceiling) {
      return null;
    }
    return chooseSoftwareEncodeSettings(this.softwarePresetBenchmark, { width: ceiling.w, height: ceiling.h }, outputFps);
  }

  /**
   * Parse ffmpeg's `speed` progress value (e.g. "0.903x", "1.6x", "N/A") into a
   * number. Returns null when it cannot be parsed (no data yet).
   *
   * @param {string} value
   * @returns {number | null}
   */
  #parseSpeed(value) {
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }
    const numeric = Number.parseFloat(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }

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
   * Record the latest viewer link report for a session (adaptive bitrate).
   * Returns false for an unknown/disposed session.
   *
   * @param {string} sessionId
   * @param {{ linkMbps: number, bufferedAheadSec: number }} report
   * @returns {boolean}
   */
  recordNetReport(sessionId, { linkMbps, bufferedAheadSec }) {
    const session = this.sessionsById.get(sessionId);
    if (!session || session.state === "disposed") {
      return false;
    }
    session.netReport = { linkMbps, bufferedAheadSec, at: Date.now() };
    return true;
  }

  /**
   * Observed produced bitrate (Mbit/s) averaged over the last few COMPLETED
   * segment files (the newest file may still be being written and is
   * excluded). Transcode sessions only — their segment grid is uniform, so
   * bytes / (count × segDur) is exact. Returns null when there is not enough
   * material to measure.
   *
   * @param {HlsSession} session
   * @returns {Promise<number | null>}
   */
  async #observedStreamMbps(session) {
    let names;
    try {
      names = await readdir(session.dirPath);
    } catch {
      return null;
    }
    const indices = [];
    for (const name of names) {
      const index = this.segmentFormat.segmentIndexFromName(name);
      if (index >= 0) {
        indices.push(index);
      }
    }
    if (indices.length < 3) {
      return null; // need ≥2 completed segments after dropping the newest
    }
    indices.sort((a, b) => a - b);
    const completed = indices.slice(0, -1).slice(-LINK_OBSERVED_SEGMENTS);
    let bytes = 0;
    try {
      for (const index of completed) {
        const st = await stat(path.join(session.dirPath, this.segmentFormat.segmentFileName(index)));
        bytes += st.size;
      }
    } catch {
      return null; // a segment vanished mid-measure (seek-restart cleanup)
    }
    return (bytes * 8) / (completed.length * this.segmentDurationSec) / 1e6;
  }

  /**
   * Viewer-link deficit check for one session (adaptive bitrate, part b).
   * Mirrors the CPU slow-window pattern; shares the action cooldown and the
   * downshift machinery. Returns true when a downshift was applied this tick.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @returns {Promise<boolean>}
   */
  async #checkLinkBudget(session, now) {
    const report = session.netReport;
    if (!report || now - report.at > LINK_REPORT_FRESH_MS) {
      session.linkSlowSince = 0; // no fresh data — old clients / stopped reporter
      return false;
    }
    if (report.bufferedAheadSec >= LINK_LOW_BUFFER_SEC) {
      session.linkSlowSince = 0; // viewer is comfortable — nothing to fix
      return false;
    }
    const observed = await this.#observedStreamMbps(session);
    if (observed === null) {
      return false; // not enough produced material to compare against
    }
    if (report.linkMbps * LINK_SAFETY >= observed) {
      session.linkSlowSince = 0; // link keeps up
      return false;
    }
    if (session.linkSlowSince === 0) {
      session.linkSlowSince = now;
      return false;
    }
    if (now - session.linkSlowSince < LINK_SLOW_WINDOW_MS) {
      return false; // not sustained yet
    }
    if (now - session.budgetLastActionAt < BUDGET_ACTION_COOLDOWN_MS) {
      return false; // let the previous action settle
    }
    await this.#applyBudgetDownshift(
      session,
      `link=${report.linkMbps.toFixed(2)}Mbps stream=${observed.toFixed(2)}Mbps buffer=${report.bufferedAheadSec.toFixed(1)}s`,
      "link"
    );
    session.linkSlowSince = 0;
    return true;
  }

  async #enforceRealtimeBudget() {
    if (this.videoEncoder?.kind !== "software") {
      return;
    }
    const now = Date.now();
    for (const session of this.sessionsById.values()) {
      if (
        !session ||
        session.state === "disposed" ||
        session.state === "failed" ||
        !session.transcodeVideo ||
        !Array.isArray(session.budgetLadder) ||
        session.budgetLadder.length < 2
      ) {
        continue;
      }
      // Already at the floor or out of steps — nothing more to give.
      if (
        session.budgetRungIndex >= session.budgetLadder.length - 1 ||
        session.budgetDownshifts >= BUDGET_MAX_DOWNSHIFTS
      ) {
        continue;
      }
      // Viewer-link deficit first (adaptive bitrate): independent of encoder
      // speed — a thin cellular link starves even a faster-than-realtime
      // encode. When it acts, skip the CPU check this tick (shared cooldown
      // guards double-firing anyway).
      if (await this.#checkLinkBudget(session, now)) {
        continue;
      }
      const speed = this.#parseSpeed(session.progress?.speed);
      if (speed === null) {
        continue; // no measurement yet
      }
      if (speed >= BUDGET_SPEED_OK) {
        session.budgetSlowSince = 0; // recovered — reset the slow window
        continue;
      }
      if (speed >= BUDGET_SPEED_SLOW) {
        continue; // in the hysteresis band; neither slow nor ok
      }
      // speed < BUDGET_SPEED_SLOW — track how long it has been slow.
      if (session.budgetSlowSince === 0) {
        session.budgetSlowSince = now;
        continue;
      }
      if (now - session.budgetSlowSince < BUDGET_SUSTAINED_MS) {
        continue; // not sustained yet
      }
      if (now - session.budgetLastActionAt < BUDGET_ACTION_COOLDOWN_MS) {
        continue; // let the previous action settle
      }
      // Sustained sub-realtime. Only downscale if the encoder — not a
      // download-starved input — is the limit.
      const bound = await this.#classifyTranscodeBound(session);
      if (bound === "download") {
        logger.info(
          `[budget] transcode ${session.id} speed=${speed.toFixed(2)}x but download-limited ` +
            `"${session.fileName}"; not downscaling (torrent is the bottleneck)`
        );
        session.budgetSlowSince = 0; // re-evaluate fresh; don't thrash on this
        continue;
      }
      await this.#applyBudgetDownshift(session, `speed=${speed.toFixed(2)}x`, bound);
    }
  }

  /**
   * Decide whether a sustained sub-realtime transcode is limited by the encoder
   * (CPU) or by a download-starved input. Compares the torrent's download rate
   * with the source's average byte rate; a fully-downloaded file can never be
   * download-bound. Returns "cpu" | "download" | "unknown" ("unknown" is treated
   * as CPU by the caller — the common case, logged as such).
   *
   * @param {HlsSession} session
   * @returns {Promise<"cpu" | "download" | "unknown">}
   */
  async #classifyTranscodeBound(session) {
    if (!this.getSourceStats) {
      return "unknown";
    }
    let stats;
    try {
      stats = await this.getSourceStats(session.sourceKey, session.fileIndex);
    } catch {
      return "unknown";
    }
    if (!stats) {
      return "unknown";
    }
    // A fully (or almost fully) downloaded file cannot be download-bound.
    if (typeof stats.fileProgress === "number" && stats.fileProgress >= 0.999) {
      return "cpu";
    }
    const duration = Number.isFinite(session.totalDurationSeconds) ? session.totalDurationSeconds : 0;
    const length = Number.isFinite(stats.fileLength) && stats.fileLength > 0 ? stats.fileLength : 0;
    const downloadSpeed = Number.isFinite(stats.downloadSpeed) ? stats.downloadSpeed : 0;
    if (duration <= 0 || length <= 0) {
      return "unknown"; // cannot compute the source byte rate
    }
    const sourceByteRate = length / duration;
    return downloadSpeed >= sourceByteRate * BUDGET_DOWNLOAD_OK_FACTOR ? "cpu" : "download";
  }

  /**
   * Step a session one resolution rung down the budget ladder and restart the
   * encode at the current segment with the lighter profile.
   *
   * @param {HlsSession} session
   * @param {string} reasonText - Measurement summary for the log line.
   * @param {"cpu" | "unknown" | "link"} bound
   * @returns {Promise<void>}
   */
  async #applyBudgetDownshift(session, reasonText, bound) {
    const nextIndex = session.budgetRungIndex + 1;
    const rung = session.budgetLadder[nextIndex];
    if (!rung) {
      return;
    }
    const fps = Number.isInteger(session.outputFps) && session.outputFps > 0 ? session.outputFps : TRANSCODE_FPS;
    session.budgetRungIndex = nextIndex;
    session.budgetDownshifts += 1;
    session.budgetLastActionAt = Date.now();
    session.budgetSlowSince = 0;
    session.encodeWidth = rung.width;
    session.encodeHeight = rung.height;
    session.softwarePreset = pickSoftwarePreset(this.softwarePresetBenchmark, rung.width * rung.height * fps);
    // Restart at the current live-edge segment so the lighter profile takes over
    // from where the viewer is watching (hard-restart tier).
    const head = session.encodeStartIndex;
    const processed = Number.isFinite(session.progress?.processedSeconds)
      ? session.progress.processedSeconds
      : this.#segmentStartTime(session, head);
    const currentSeg = Math.max(head, this.#segmentIndexForTime(session, processed));
    const boundLabel =
      bound === "link" ? "viewer-link-bound" : bound === "unknown" ? "assuming CPU-bound" : "CPU-bound";
    logger.info(
      `[budget] transcode ${session.id} ${boundLabel} ` +
        `${reasonText} → downscale to ${rung.width}x${rung.height}/${session.softwarePreset} ` +
        `(rung ${nextIndex + 1}/${session.budgetLadder.length}, downshift ${session.budgetDownshifts}/${BUDGET_MAX_DOWNSHIFTS}), ` +
        `restart at segment #${currentSeg} "${session.fileName}"`
    );
    await this.#startEncodeRun(session, currentSeg);
  }

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
   * one is still waiting for the previous process to die. `encodeRunGeneration`
   * resolves that: each call captures its own generation number, and after the
   * await, a call whose generation was superseded aborts without spawning —
   * only the LATEST requested target ever actually starts a process.
   *
   * Segment files are named with a global index (`-start_number`) so they
   * always line up with the synthetic VOD playlist regardless of where
   * encoding started — this is what makes server-side seeking work.
   *
   * @param {HlsSession} session
   * @param {number} startIndex
   * @returns {Promise<void>}
   */
  async #startEncodeRun(session, startIndex) {
    const generation = ++session.encodeRunGeneration;
    const previousFfmpeg = session.ffmpeg;
    if (previousFfmpeg && !hasChildExited(previousFfmpeg)) {
      try {
        previousFfmpeg.kill("SIGTERM");
      } catch {
        // Best effort.
      }
      await waitForChildExit(previousFfmpeg, ENCODE_RUN_TERMINATE_GRACE_MS);
      if (!hasChildExited(previousFfmpeg)) {
        try {
          previousFfmpeg.kill("SIGKILL");
        } catch {
          // Best effort.
        }
        await waitForChildExit(previousFfmpeg, ENCODE_RUN_TERMINATE_GRACE_MS);
      }
    }
    // A newer restart (or disposal) won the race while we were waiting for the
    // old process to die — it either already spawned its own replacement or
    // there is nothing left to start. Do not also spawn from this stale call.
    if (session.encodeRunGeneration !== generation || session.state === "disposed") {
      return;
    }

    const safeIndex = Number.isInteger(startIndex) && startIndex > 0 ? startIndex : 0;
    // 0-based output time of this segment, from the boundary table (uniform for
    // re-encode, real keyframe for copy).
    const startSeconds = this.#segmentStartTime(session, safeIndex);
    const sourceStartTime = Number.isFinite(session.sourceStartTime) ? session.sourceStartTime : 0;

    // Terminate any existing encode process before starting a new one.  The
    // old process's exit handler no-ops because session.ffmpeg is reassigned
    // below (it checks identity).
    if (session.ffmpeg && !session.ffmpeg.killed) {
      try {
        session.ffmpeg.kill("SIGTERM");
      } catch (_error) {
        // Best effort.
      }
    }

    // Video: re-encode only when required, using the detected encoder
    // (hardware-accelerated or software). The descriptor builds the filter +
    // codec args (including keyframe alignment on segment boundaries).
    const videoCodecArgs = session.transcodeVideo
      ? this.videoEncoder.buildVideoArgs({
          // Budget-selected encode box (may be below the client target on weak
          // software hosts); falls back to the client target for hardware.
          targetWidth: session.encodeWidth,
          targetHeight: session.encodeHeight,
          segmentDurationSec: this.segmentDurationSec,
          // Source-inherited output rate (integer, capped); descriptors that
          // use time-based keyframes just apply it as the frame rate.
          fps: session.outputFps,
          // Software-only; hardware descriptors ignore it.
          preset: session.softwarePreset ?? undefined,
          // HDR→SDR tone map (software path only; gated on filter availability).
          tonemap: session.applyTonemap === true
        })
      : ["-c:v", "copy"];
    const audioCodecArgs = session.transcodeAudio
      ? ["-c:a", "aac", "-ac", "2", "-b:a", "128k"]
      : ["-c:a", "copy"];

    const args = ["-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1"];
    // Hardware decode/encode setup (e.g. VAAPI device) must precede -i, and
    // only applies when we actually re-encode the video track.
    if (session.transcodeVideo && Array.isArray(this.videoEncoder.inputArgs)) {
      args.push(...this.videoEncoder.inputArgs);
    }
    // Seek position in SOURCE time. For copy we seek to the real keyframe
    // (startSeconds is already a real-keyframe offset from 0, so add back the
    // container start time); for re-encode startSeconds is a plain grid offset.
    const seekSeconds = session.transcodeVideo ? startSeconds : startSeconds + sourceStartTime;
    // Two-step seek when we have a real keyframe map: jump to a KNOWN-valid
    // keyframe (coarse, before -i — safe because WE sourced it from ffprobe,
    // not the container's own on-the-fly seek/index) and trim the short
    // residual (bounded by the keyframe interval) precisely AFTER -i, which is
    // always frame-accurate regardless of -accurate_seek.
    //
    // Root cause this works around: `-accurate_seek -ss X` before -i trusts the
    // CONTAINER's own seek to land near X. For some containers (observed: AVI
    // with VBR MP3 audio) that on-the-fly seek can point at a position with no
    // valid frame boundary at all — ffmpeg fails outright ("Seek failed" /
    // "Header missing"), not just imprecisely, and repeatedly so since every
    // retry re-tries the SAME bad container-computed position. A keyframe we
    // read directly from the packet list is a position ffmpeg has already
    // proven it can decode.
    const snappedKeyframe = Array.isArray(session.keyframeTimes) && session.keyframeTimes.length > 0
      ? nearestKeyframeAtOrBefore(session.keyframeTimes, seekSeconds)
      : null;
    if (snappedKeyframe !== null) {
      const residualSeconds = Math.max(0, seekSeconds - snappedKeyframe);
      if (snappedKeyframe > 0) {
        args.push("-ss", String(snappedKeyframe));
      }
      args.push("-i", session.inputUrl);
      if (residualSeconds > 0) {
        args.push("-ss", String(residualSeconds));
      }
    } else {
      if (seekSeconds > 0) {
        // No keyframe map (probe failed/timed out) — fall back to the previous
        // behaviour: trust the container's own accurate seek.
        args.push("-accurate_seek", "-ss", String(seekSeconds));
      }
      args.push("-i", session.inputUrl);
    }
    if (session.transcodeVideo) {
      // Branch A (re-encode): fixed GOP makes keyframes land exactly on the
      // segment grid; relabel output onto the original timeline so segment N
      // carries PTS = N × segmentDuration.
      if (startSeconds > 0) {
        args.push("-output_ts_offset", String(startSeconds));
      }
    } else {
      // Branch B (video copied — only audio is transcoded): we cannot insert
      // keyframes, so segments are cut at the source's own keyframes (the
      // playlist boundaries were built from those keyframes). Keep the source's
      // real timestamps (`-copyts`) so copied frames stay continuous across
      // boundaries/seeks, and shift by -startTime so the output timeline is
      // 0-based (a non-zero container start otherwise puts a hole at the very
      // beginning and desyncs audio/video). Audio is transcoded on this timeline.
      args.push("-copyts");
      if (sourceStartTime !== 0) {
        args.push("-output_ts_offset", String(-sourceStartTime));
      }
    }
    args.push(
      "-map",
      "0:v:0?",
      "-map",
      // Type-relative audio track chosen by the viewer (default 0).
      `0:a:${session.audioTrackIndex ?? 0}?`,
      ...videoCodecArgs,
      ...audioCodecArgs,
      "-f",
      "hls",
      "-hls_time",
      String(this.segmentDurationSec),
      "-hls_list_size",
      "0",
      "-hls_flags",
      "independent_segments+temp_file",
      // Container selection + segment naming, from the active format module.
      ...this.segmentFormat.muxerArgs(),
      "-start_number",
      String(safeIndex),
      // ffmpeg writes its own playlist here; we ignore it and serve the
      // synthetic VOD playlist instead (see getFileStream).
      PLAYLIST_FILE_NAME
    );

    const ffmpeg = spawn(this.ffmpegBin, args, {
      cwd: session.dirPath,
      stdio: ["ignore", "pipe", "pipe"]
    });
    session.ffmpeg = ffmpeg;
    session.encodeStartIndex = safeIndex;
    session.pendingRestartIndex = -1;
    session.lastRestartAt = Date.now();
    session.state = session.state === "disposed" ? "disposed" : "starting";
    session.progress.state = "running";
    session.progress.processedSeconds = startSeconds;
    session.progress.startPositionSeconds = startSeconds;
    session.progress.updatedAt = Date.now();
    // Any (re)start resets the cumulative `speed` ffmpeg reports, so reset the
    // realtime-budget slow window too — otherwise warm-up right after a user
    // seek could be mis-counted as sustained sub-realtime and trigger a
    // premature downscale.
    session.budgetSlowSince = 0;

    logger.info(
      `transcode ${session.id} encode-run from segment #${safeIndex} ` +
        `(${formatSeconds(startSeconds)}) "${session.fileName}"`
    );

    this.#wireEncodeProcess(session, ffmpeg);
  }

  /**
   * Rebase ffmpeg's `-progress` `out_time`/`out_time_ms` onto the SOURCE
   * (absolute) timeline, so `session.progress.processedSeconds` is always
   * comparable to `session.progress.startPositionSeconds` — which
   * `computeProgressMetrics` and the client's own cushion-percent/ETA math
   * both assume.
   *
   * ffmpeg's `-progress` output counts from the START OF THIS RUN on BOTH
   * branches — neither `-output_ts_offset` (branch A, re-encode) nor
   * `-copyts` (branch B, video copy) changes it: both relabel the MUXED
   * output's timestamps, which is a different thing from what `-progress`
   * reports. Verified empirically on each branch separately against a real
   * file on the field host:
   *   - branch A: a clip encoded with `-output_ts_offset 100` reports
   *     `out_time` counting 0→5, not 100→105;
   *   - branch B: `-ss 600 … -copyts -c:v copy` reports `out_time` =
   *     0, 40.7, 54.9, 90.9 — relative, NOT 600, 640.7, …
   * The branch-B half was originally ASSUMED to be absolute (because of
   * `-copyts`) and left unrebased in 2.9.53; that assumption was wrong and
   * cost a field session — hence both measurements above are recorded here,
   * and neither branch may be exempted again without a fresh measurement.
   *
   * Left unrebased, `processedSeconds` jumps from the post-restart
   * placeholder (`session.progress.startPositionSeconds`, absolute) down to a
   * near-zero RELATIVE value the moment real ffmpeg progress starts flowing —
   * `processedSeconds - startPositionSeconds` then goes deeply negative,
   * clamps to 0, and the client's cushion percent/ETA reads as permanently
   * stuck at 0% for the whole run even while the encode is actively
   * producing (field-diagnosed 2026-08-01: `processed=39.5 startPos=1824` at
   * a healthy 6x speed on branch A; `processed=12.638 startPos=3312` at 12.6x
   * on branch B).
   *
   * @param {HlsSession} session
   * @param {number} rawSeconds - As parsed from `out_time`/`out_time_ms`.
   * @returns {number}
   */
  #toAbsoluteProcessedSeconds(session, rawSeconds) {
    const offset = Number.isFinite(session.progress?.startPositionSeconds)
      ? session.progress.startPositionSeconds
      : 0;
    return rawSeconds + offset;
  }

  /**
   * Wire stdout (progress), stderr (errors) and exit handlers for an ffmpeg
   * encode process.  Handlers no-op when the process has been superseded by a
   * later encode run (identity check against `session.ffmpeg`).
   *
   * @param {HlsSession} session
   * @param {import("node:child_process").ChildProcess} ffmpeg
   * @returns {void}
   */
  #wireEncodeProcess(session, ffmpeg) {
    ffmpeg.stdout.on("data", (chunk) => {
      const lines = String(chunk).split(/\r?\n/);
      for (const line of lines) {
        const normalized = line.trim();
        if (!normalized) {
          continue;
        }
        const separator = normalized.indexOf("=");
        if (separator <= 0) {
          continue;
        }
        const key = normalized.slice(0, separator);
        const value = normalized.slice(separator + 1);

        if (key === "out_time_ms") {
          const numeric = Number(value);
          if (Number.isFinite(numeric) && numeric >= 0) {
            session.progress.processedSeconds = this.#toAbsoluteProcessedSeconds(session, numeric / MICROSECONDS_PER_SECOND);
          }
        } else if (key === "out_time") {
          const parsed = parseFfmpegTimestamp(value);
          if (parsed != null) {
            session.progress.processedSeconds = this.#toAbsoluteProcessedSeconds(session, parsed);
          }
        } else if (key === "speed") {
          session.progress.speed = value;
        } else if (key === "progress") {
          session.progress.state = value === "end" ? "ready" : "running";
        }
        const metrics = computeProgressMetrics(
          session.progress.processedSeconds,
          session.progress.totalSeconds,
          session.progress.startPositionSeconds
        );
        session.progress.percent = metrics.percent;
        session.progress.remainingSeconds = metrics.remainingSeconds;
        session.progress.updatedAt = Date.now();
        const shouldLog =
          session.progress.percent != null &&
          session.progress.updatedAt - session.progress.lastLoggedAt >= PROGRESS_LOG_INTERVAL_MS;
        if (shouldLog) {
          session.progress.lastLoggedAt = session.progress.updatedAt;
          logger.info(
            `transcode ${session.id} "${session.fileName}" ${session.progress.percent.toFixed(1)}% ` +
              `(${formatSeconds(session.progress.processedSeconds)} / ${formatSeconds(session.progress.totalSeconds)})` +
              ` speed=${session.progress.speed || "n/a"}`
          );
        }
      }
    });

    ffmpeg.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (line.length > 0) {
        session.lastError = line;
        logger.warn(`ffmpeg ${session.id}: ${line}`);
      }
    });

    ffmpeg.on("error", (error) => {
      if (session.ffmpeg !== ffmpeg) {
        return;
      }
      session.state = "failed";
      session.lastError = error instanceof Error ? error.message : String(error);
      session.progress.state = "failed";
      session.progress.updatedAt = Date.now();
      logger.error(`ffmpeg ${session.id} process error: ${session.lastError}`);
    });

    ffmpeg.on("exit", (code, signal) => {
      // Ignore the exit of a process that was superseded by a seek-restart.
      if (session.ffmpeg !== ffmpeg) {
        return;
      }
      if (session.state === "disposed") {
        return;
      }
      if (code === 0) {
        session.state = "ready";
        session.progress.state = "ready";
        session.progress.updatedAt = Date.now();
        logger.info(`transcode ${session.id} encode-run complete "${session.fileName}"`);
        return;
      }
      if (!session.lastError) {
        session.lastError = `ffmpeg exited with code ${code ?? -1}${signal ? ` (signal ${signal})` : ""}`;
      }
      // Runtime safety net: if a hardware encode fails, downgrade this proxy to
      // software encoding for all sessions and restart this one, so playback is
      // never permanently broken by a hardware/driver issue.
      if (session.transcodeVideo && this.videoEncoder.kind !== "software") {
        const failedEncoder = this.videoEncoder.name;
        this.videoEncoder = softwareDescriptor();
        logger.warn(
          `transcode ${session.id} hardware encoder ${failedEncoder} failed ` +
            `(${session.lastError}); falling back to software libx264 and restarting`
        );
        void this.#startEncodeRun(session, session.encodeStartIndex);
        return;
      }
      // Circuit-breaker bookkeeping: a seek-restart run that exits THIS fast
      // never did real work — it failed at the seek/open step itself, not
      // mid-stream (see SEEK_FAST_FAIL_MS). Track consecutive fast failures at
      // the SAME target so #ensureEncodingFor/#fireSettledSeek (which check
      // this below) can stop retrying instead of looping forever on a position
      // that keeps failing even with the keyframe-snapped seek.
      const elapsedMs = Date.now() - session.lastRestartAt;
      if (elapsedMs < SEEK_FAST_FAIL_MS && session.encodeStartIndex > 0) {
        if (session.seekFailureTarget === session.encodeStartIndex) {
          session.seekFailureCount += 1;
        } else {
          session.seekFailureTarget = session.encodeStartIndex;
          session.seekFailureCount = 1;
        }
        logger.warn(
          `transcode ${session.id} fast failure at segment #${session.encodeStartIndex} ` +
            `(${elapsedMs}ms) — ${session.seekFailureCount}/${MAX_SEEK_FAILURES} consecutive`
        );
      } else {
        // Real progress was made (or this was the very first run) — not a
        // repeating seek failure. Reset the breaker.
        session.seekFailureTarget = -1;
        session.seekFailureCount = 0;
      }
      session.state = "failed";
      session.progress.state = "failed";
      session.progress.updatedAt = Date.now();
      logger.error(`transcode ${session.id} encode-run failed: ${session.lastError}`);
    });
  }

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
    if (!session || session.state === "disposed" || index < 0) {
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
    const head = session.encodeStartIndex;
    // Anchor the look-ahead window on the CURRENT encode position (start index +
    // seconds already processed), not the run's start index. Otherwise a long
    // run that has encoded well past `head` would needlessly restart for a
    // request just ahead of the live edge.
    const processed = Number.isFinite(session.progress?.processedSeconds)
      ? session.progress.processedSeconds
      : this.#segmentStartTime(session, head);
    const currentSeg = Math.max(head, this.#segmentIndexForTime(session, processed));
    const withinWindow = index >= head && index <= currentSeg + MAX_LOOKAHEAD_SEGMENTS;
    if (withinWindow) {
      return;
    }
    // Circuit breaker: this exact target has already failed MAX_SEEK_FAILURES
    // times in a row (fast failures — see #wireEncodeProcess's exit handler).
    // Stop auto-retrying it; session.state stays "failed" so getFileStream
    // reports a clean, retryable error instead of looping forever. A DIFFERENT
    // target (the viewer seeking elsewhere) is unaffected — it gets its own
    // fresh attempt budget.
    if (index === session.seekFailureTarget && session.seekFailureCount >= MAX_SEEK_FAILURES) {
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
   * Fire a settled server-side seek: restart the encoder once at the target
   * recorded during the settle window. Enforces the restart cooldown as a
   * floor between actual restarts (re-arming for the remainder if still
   * cooling down). No-op for a disposed session or a cleared target.
   *
   * @param {HlsSession} session
   * @returns {void}
   */
  /**
   * Content-seconds the CURRENT encode run has produced, from ffmpeg's own
   * progress. Both branches report on the absolute source timeline (the copy
   * branch via `-copyts`, the re-encode branch rebased by
   * {@link #toAbsoluteProcessedSeconds}), so subtracting the run's start
   * position gives what THIS run has made — 0 right after a restart.
   *
   * @param {HlsSession} session
   * @returns {number} Seconds produced by the current run; 0 when unknown.
   */
  #producedSecondsThisRun(session) {
    const processed = session.progress?.processedSeconds;
    const startPosition = session.progress?.startPositionSeconds;
    if (!Number.isFinite(processed) || !Number.isFinite(startPosition)) {
      return 0;
    }
    return Math.max(0, processed - startPosition);
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
  requestSeek(sessionId, positionSeconds) {
    const session = this.sessionsById.get(sessionId);
    if (!session || session.state === "disposed") {
      return false;
    }
    const index = this.#segmentIndexForTime(session, positionSeconds);
    const head = session.encodeStartIndex;
    const processed = Number.isFinite(session.progress?.processedSeconds)
      ? session.progress.processedSeconds
      : this.#segmentStartTime(session, head);
    const currentSeg = Math.max(head, this.#segmentIndexForTime(session, processed));
    // Already covered by the running encode — the data is on its way, so
    // restarting would only destroy work the viewer is waiting for.
    if (index >= head && index <= currentSeg + MAX_LOOKAHEAD_SEGMENTS) {
      logger.info(
        `transcode ${session.id} seek to ${positionSeconds.toFixed(1)}s (#${index}) ` +
          `already within the running encode (#${head}..#${currentSeg}) — not restarting`
      );
      return true;
    }
    logger.info(
      `transcode ${session.id} viewer seek to ${positionSeconds.toFixed(1)}s → segment #${index}`
    );
    session.seekTarget = index;
    if (session.seekSettleTimer) {
      clearTimeout(session.seekSettleTimer);
    } else {
      session.seekFirstFarAt = Date.now();
    }
    const waited = Date.now() - session.seekFirstFarAt;
    const delay = waited >= SEEK_SETTLE_MAX_MS ? 0 : Math.min(SEEK_SETTLE_MS, SEEK_SETTLE_MAX_MS - waited);
    session.seekSettleTimer = setTimeout(() => this.#fireSettledSeek(session), delay);
    session.seekSettleTimer.unref?.();
    return true;
  }

  #fireSettledSeek(session) {
    const target = session.seekTarget;
    session.seekSettleTimer = null;
    if (!session || session.state === "disposed" || target == null) {
      session.seekTarget = null;
      session.seekFirstFarAt = 0;
      return;
    }
    // Circuit breaker (defense in depth): a timer armed before the cap was hit
    // could still be pending when it was reached — do not fire the restart it
    // was going to make. See the matching check in #ensureEncodingFor.
    if (target === session.seekFailureTarget && session.seekFailureCount >= MAX_SEEK_FAILURES) {
      session.seekTarget = null;
      session.seekFirstFarAt = 0;
      return;
    }
    // Already encoding exactly this position — there is nothing to seek TO, so
    // restarting can only destroy the very work being waited for. The player
    // keeps re-requesting the target segment while it is still being produced,
    // and every such request looks "far" from where the encoder USED to be, so
    // without this check each one re-triggered a restart at the position we had
    // only just moved to: field log 2026-08-02 shows `restart at #865` twice in
    // ten seconds, each killing a run that was encoding #865. The guard below
    // did not catch it — it only decides whether to let the current run finish,
    // not whether a new run is needed at all.
    if (target === session.encodeStartIndex && session.ffmpeg != null && !hasChildExited(session.ffmpeg)) {
      logger.info(
        `transcode ${session.id} seek #${target} ignored — the current run already starts there`
      );
      session.seekTarget = null;
      session.seekFirstFarAt = 0;
      return;
    }
    // Minimum gap between actual restarts (the settle already collapses bursts;
    // this only guards back-to-back seeks). If still cooling down, re-arm once
    // for the remaining cooldown instead of restarting now.
    const sinceLastRestart = Date.now() - (session.lastRestartAt ?? 0);
    if (sinceLastRestart < RESTART_COOLDOWN_MS) {
      session.seekSettleTimer = setTimeout(() => this.#fireSettledSeek(session), RESTART_COOLDOWN_MS - sinceLastRestart);
      session.seekSettleTimer.unref?.();
      return;
    }
    // Let the CURRENT run finish what it started. Restarting a run that has not
    // yet produced a single segment destroys all its work and starts the wait
    // over — and after a seek the first segment is always the slowest, so this
    // is self-perpetuating: field log (2026-08-02, one user seek) shows
    // restarts at #617 → #717 → #732 → #732 every 5-7 s, none of which ever
    // produced anything, leaving the viewer with a flickering loading pill and
    // no playback at all.
    //
    // These extra targets are NOT further user seeks: when the player cannot
    // get its segment it SCANS the playlist (every segment is listed in our
    // synthetic VOD playlist, so from its point of view they all exist), and
    // each far-enough probe looked like a fresh seek to us. Waiting for the
    // first segment makes the scan harmless — it can no longer steer the
    // encoder — and one genuine seek now reliably completes.
    //
    // Bounded by RUN_FIRST_SEGMENT_GRACE_MS so a wedged run cannot block seeks
    // forever; the encoder-stall watchdog and the exit handler cover a run that
    // dies outright.
    const producedThisRun = this.#producedSecondsThisRun(session);
    const runIsAlive = session.ffmpeg != null && !hasChildExited(session.ffmpeg);
    if (
      runIsAlive &&
      producedThisRun < this.segmentDurationSec &&
      sinceLastRestart < RUN_FIRST_SEGMENT_GRACE_MS
    ) {
      logger.info(
        `transcode ${session.id} seek #${target} HELD — current run has produced ` +
          `${producedThisRun.toFixed(1)}s of the ${this.segmentDurationSec}s first segment ` +
          `(${(sinceLastRestart / 1000).toFixed(1)}s into a ${RUN_FIRST_SEGMENT_GRACE_MS / 1000}s grace)`
      );
      session.seekSettleTimer = setTimeout(() => this.#fireSettledSeek(session), SEEK_SETTLE_MS);
      session.seekSettleTimer.unref?.();
      return;
    }
    // Why the restart was allowed — the counterpart of the HELD line above.
    // Without it a restart is indistinguishable from the runaway ping-pong this
    // guard exists to stop, and diagnosing a field report becomes guesswork.
    const allowedBecause = !runIsAlive
      ? "run is dead"
      : producedThisRun >= this.segmentDurationSec
        ? `run produced ${producedThisRun.toFixed(1)}s (first segment done)`
        : `grace of ${RUN_FIRST_SEGMENT_GRACE_MS / 1000}s expired`;
    session.seekTarget = null;
    session.seekFirstFarAt = 0;
    logger.info(`transcode ${session.id} seek settle → restart at segment #${target} (${allowedBecause})`);
    void this.#startEncodeRun(session, target);
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
      if (session.state === "failed") {
        throw new Error(session.lastError || "ffmpeg failed to start HLS session.");
      }
      session.state = "ready";
      return;
    }

    const playlistPath = path.join(session.dirPath, PLAYLIST_FILE_NAME);
    const deadline = Date.now() + this.startupWaitMs;

    while (Date.now() < deadline) {
      if (session.state === "failed") {
        throw new Error(session.lastError || "ffmpeg failed to start HLS session.");
      }
      try {
        await access(playlistPath);
        const text = await readFile(playlistPath, "utf8");
        if (text.includes("#EXTM3U")) {
          session.state = "ready";
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
    const session = isSafeSessionId(sessionId) ? this.sessionsById.get(sessionId) : null;
    if (!session) {
      return 0;
    }
    session.requestSeqCounter += 1;
    return session.requestSeqCounter;
  }

  /**
   * Open a read stream for an HLS segment or playlist file from a session.
   *
   * @param {string} sessionId
   * @param {string} fileName - Must match the playlist or segment name pattern.
   * @param {{ requestSeq?: number }} [options] - `requestSeq` from
   *   {@link nextRequestSeq}, constant across one request's long-poll loop.
   * @returns {Promise<
   *   | { kind: "not-found" }
   *   | { kind: "warming-up" }
   *   | { kind: "failed"; message: string }
   *   | { kind: "file"; stream: import("node:fs").ReadStream; contentType: string; isPlaylist: boolean }
   * >}
   */
  async getFileStream(sessionId, fileName, options = {}) {
    if (!isSafeSessionId(sessionId) || !isSafeFileName(fileName, this.segmentFormat)) {
      return { kind: "not-found" };
    }
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return { kind: "not-found" };
    }
    if (session.state === "failed") {
      return {
        kind: "failed",
        message: session.lastError || "ffmpeg failed for this transcode session."
      };
    }
    session.lastAccessedAt = Date.now();

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
    const { initFileName } = this.segmentFormat;
    if (initFileName !== null && fileName === initFileName) {
      if (session.initBytes && session.initBytes.length > 0) {
        return {
          kind: "file",
          stream: Readable.from([session.initBytes]),
          contentType: this.segmentFormat.initContentType,
          isPlaylist: false
        };
      }
      try {
        const bytes = await readFile(path.join(session.dirPath, initFileName));
        if (bytes.length === 0) {
          return { kind: "warming-up" };
        }
        session.initBytes = bytes;
        return {
          kind: "file",
          stream: Readable.from([bytes]),
          contentType: this.segmentFormat.initContentType,
          isPlaylist: false
        };
      } catch {
        // Not produced yet — the encode run started at session creation writes
        // it early; the caller long-polls until it appears.
        return { kind: "warming-up" };
      }
    }

    const filePath = path.join(session.dirPath, fileName);
    const isPlaylist = fileName === PLAYLIST_FILE_NAME;
    try {
      await access(filePath);
      // Cold-start: log the first servable SEGMENT of this session exactly once
      // — the time from session-create entry to a playable first segment.
      if (!isPlaylist && !session.firstSegmentLogged) {
        session.firstSegmentLogged = true;
        logger.info(
          `cold-start ${sessionId.slice(0, 8)}: first-segment ready +${Date.now() - session.createEntryMs}ms`
        );
      }
      // Formats whose segments need correcting before they are valid against
      // the session's cached init are read whole and passed through the format
      // module; the rest stream straight off disk.
      if (!isPlaylist && this.segmentFormat.needsSegmentRewrite) {
        const index = this.segmentFormat.segmentIndexFromName(fileName);
        const bytes = await readFile(filePath);
        const prepared = this.segmentFormat.prepareSegmentBytes(bytes, {
          startSeconds: this.#segmentStartTime(session, index),
          initBytes: session.initBytes ?? null
        });
        return {
          kind: "file",
          stream: Readable.from([prepared]),
          contentType: this.segmentFormat.segmentContentType,
          isPlaylist: false
        };
      }
      return {
        kind: "file",
        stream: isPlaylist
          ? createReadStream(filePath)
          : createReadStream(filePath, { highWaterMark: SEGMENT_READ_HIGH_WATER_MARK }),
        contentType: isPlaylist
          ? "application/vnd.apple.mpegurl"
          : this.segmentFormat.segmentContentType,
        isPlaylist
      };
    } catch (_error) {
      // File not produced yet.
    }

    // A segment was requested that ffmpeg has not produced yet.  Decide whether
    // to wait for the current encode run to reach it or to restart the encoder
    // at this position (server-side seeking).  The caller long-polls.
    if (!isPlaylist) {
      this.#ensureEncodingFor(
        session,
        this.segmentFormat.segmentIndexFromName(fileName),
        Number.isFinite(options?.requestSeq) ? options.requestSeq : Number.MAX_SAFE_INTEGER
      );
    }
    return { kind: "warming-up" };
  }

  /**
   * Dispose all sessions that have been idle longer than `sessionTtlMs`.
   * Called automatically on the cleanup interval.
   *
   * @returns {Promise<void>}
   */
  async cleanupExpired() {
    const now = Date.now();
    const idsToDispose = [];
    for (const [sessionId, session] of this.sessionsById.entries()) {
      if (now - session.lastAccessedAt > this.sessionTtlMs) {
        idsToDispose.push(sessionId);
      }
    }
    for (const sessionId of idsToDispose) {
      await this.disposeSession(sessionId);
    }
  }

  /**
   * Return a progress snapshot for the given session, or `null` if not found.
   * Also refreshes `lastAccessedAt` to prevent the session from expiring.
   *
   * @param {string} sessionId
   * @returns {Promise<object | null>}
   */
  async getSessionProgress(sessionId) {
    if (!isSafeSessionId(sessionId)) {
      return null;
    }
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return null;
    }
    session.lastAccessedAt = Date.now();
    const warmupTotalSeconds = this.startupWaitMs / 1000;
    const warmupElapsedSeconds = Math.max(0, (Date.now() - session.startedAt) / 1000);
    const isWarmupPhase = session.state === "starting" || session.progress.state === "starting";
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
    const outputMbps = await this.#observedStreamMbps(session);
    return {
      sessionId: session.id,
      state: session.progress.state,
      processedSeconds: session.progress.processedSeconds,
      startPositionSeconds: session.progress.startPositionSeconds ?? 0,
      totalSeconds: session.progress.totalSeconds,
      percent: session.progress.percent,
      remainingSeconds: session.progress.remainingSeconds,
      warmupPercent,
      warmupRemainingSeconds,
      // Segment length, so the browser can show progress toward the FIRST
      // segment (the only thing it waits for before playback starts) instead
      // of a percentage of the whole-file transcode.
      segmentDurationSec: this.segmentDurationSec,
      speed: session.progress.speed,
      outputMbps,
      updatedAt: session.progress.updatedAt,
      error: session.state === "failed" ? session.lastError : ""
    };
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
    if (!isSafeSessionId(sessionId) || typeof consumerId !== "string" || consumerId.length === 0) {
      return false;
    }
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return false;
    }
    if (!(session.consumers instanceof Set)) {
      session.consumers = new Set();
    }
    session.consumers.delete(consumerId);
    session.lastAccessedAt = Date.now();
    const logReason = typeof reason === "string" && reason.length > 0 ? reason : "unspecified";
    logger.info(
      `consumer released (${logReason}) session=${session.id} consumer=${consumerId} ` +
        `remaining=${session.consumers.size}`
    );
    if (session.consumers.size > 0) {
      return true;
    }
    await this.disposeSession(sessionId);
    return true;
  }

  /**
   * Kill the ffmpeg process, remove it from all maps, and delete the temp dir.
   *
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async disposeSession(sessionId) {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return;
    }
    session.state = "disposed";
    this.sessionsById.delete(sessionId);
    this.sessionIdBySource.delete(session.sourceMapKey);

    // Clear any pending seek-settle timer so it cannot fire and restart a
    // disposed session.
    if (session.seekSettleTimer) {
      clearTimeout(session.seekSettleTimer);
      session.seekSettleTimer = null;
    }

    if (session.ffmpeg && !session.ffmpeg.killed) {
      session.ffmpeg.kill("SIGTERM");
      await waitForChildExit(session.ffmpeg);
    }
    try {
      await rm(session.dirPath, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`failed to cleanup HLS temp dir: ${message}`);
    }
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
    const activeIds = Array.from(this.sessionsById.keys());
    for (const sessionId of activeIds) {
      await this.disposeSession(sessionId);
    }
    const rootDir = path.join(os.tmpdir(), "torrent-tv-hls");
    try {
      const dirs = await readdir(rootDir);
      if (dirs.length === 0) {
        await rm(rootDir, { recursive: true, force: true });
      }
    } catch (_error) {
      // Best effort cleanup.
    }
  }
}
