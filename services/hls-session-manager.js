/**
 * @file HLS transcode session manager.
 *
 * Spawns one ffmpeg process per unique source+settings combination and
 * streams the resulting HLS playlist and segments from a temporary directory.
 * Sessions are expired automatically via a periodic cleanup interval, or
 * immediately when all registered consumers release them.
 */

import { createReadStream, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { logger } from "../utils/logger.js";
import { readKeyframeIndex } from "./container-index/index.js";

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
import { resolveSegmentFormat, SEGMENT_FORMAT_IDS } from "./segment-formats/index.js";

/**
 * Whether an encoder run died because its INPUT went away, rather than because
 * of anything about the encode itself.
 *
 * These are the messages the read path and ffmpeg's HTTP client produce when
 * the torrent is gone, being re-added, or has no data for the range yet — all
 * of them temporary by nature: the source can be added again and the pieces
 * fetched again.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function isInputUnavailable(message) {
  const text = typeof message === "string" ? message : "";
  return (
    /Error reading HTTP response/i.test(text) ||
    /not found in (?:magnet|torrent):/i.test(text) ||
    /Unknown source/i.test(text) ||
    /is gone and cannot be re-added/i.test(text) ||
    /Read error at pos/i.test(text) ||
    /Server returned 5\d\d/i.test(text) ||
    /Input\/output error/i.test(text) ||
    /Connection reset by peer/i.test(text) ||
    /End of file/i.test(text)
  );
}

const PLAYLIST_FILE_NAME = "index.m3u8";
// The resolutions a viewer may choose between. Only rungs at or below the
// source are offered: upscaling invents detail and costs the encoder more than
// the source itself.
const VARIANT_LADDER = [2160, 1440, 1080, 720, 540, 480, 360, 240];

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
 * The heights offered for a source of this height, largest first.
 *
 * @param {number} sourceHeight
 * @returns {number[]}
 */
export function variantHeightsFor(sourceHeight) {
  if (!Number.isFinite(sourceHeight) || sourceHeight <= 0) {
    return [];
  }
  const rungs = VARIANT_LADDER.filter((height) => height < sourceHeight);
  return [Math.round(sourceHeight), ...rungs];
}

/**
 * A rough bitrate for a height, in bits per second.
 *
 * `BANDWIDTH` is required on every variant by the HLS specification, and the
 * player uses it to order them. It does not have to be exact — nothing here
 * adapts on it, because the viewer chooses — so it is the usual H.264 rule of
 * thumb rather than a measurement we do not have before encoding starts.
 *
 * @param {number} height
 * @returns {number}
 */
export function estimatedBitrateFor(height) {
  return Math.max(400_000, Math.round(height * height * 3.2));
}
const CLEANUP_INTERVAL_MS = 30_000;
const DEFAULT_SEGMENT_DURATION_SEC = 4;
// How many segments ahead of the current encode head a missing-segment request
// is allowed to be before we restart ffmpeg at that position (server-side seek).
// Requests within the window are served by waiting for the running encode.
const MAX_LOOKAHEAD_SEGMENTS = 8;
// Floor between actual restarts. It used to be 4 s, from when a far segment
// REQUEST could steer the encoder and a playlist scan produced a burst of them.
// Requests no longer steer anything (see #ensureEncodingFor) — every restart
// now comes from a position the viewer stated — so this is no longer a policy
// about noise, only a guard against a client that spams the seek endpoint.
// Measured cost of the old value 2026-08-04: two seeks 1.3 s apart produced two
// restarts 4.4 s apart, the first encoding 119.5 s of content nobody wanted
// before the second killed it.
const RESTART_COOLDOWN_MS = 500;
// How far ahead of the viewer the encoder may run before it is stopped, and how
// far it must fall back to before it is let go again.
//
// Nothing used to bound this. Measured 2026-08-04 on the copy path: three
// minutes after a film was opened the encode had reached 00:39:24 of a 01:26:51
// source at 12.8x while the viewer was still at the start, and the torrent had
// pulled 80% of 4.7 GB to feed it. That costs the pool owner's bandwidth and
// disk for a viewer who may watch two minutes, evicts from memory the pieces
// the viewer is actually reading, and competes for the swarm with the segment
// being waited on.
//
// In seconds of content rather than segments, because a segment is 4 s of
// re-encoded video but a whole keyframe interval on the copy path. Generous
// enough that ordinary watching never touches it: the encoder fills two minutes
// ahead, stops, and is released as soon as the viewer has spent a minute of it.
// How far ahead of its own read head a reader asks the swarm for, expressed in
// seconds of PLAYBACK. The torrent thread can only think in bytes, and a fixed
// byte window is wrong at both ends of the range: 32 MB is half a minute of a
// 1080p film and about four seconds of a disc remux. Duration and file size are
// both known here, so the window is sized where the knowledge is and sent down
// on the ffmpeg input URL.
const READ_WINDOW_SECONDS = 30;
// Bounds, so a wrong or unusual byte rate cannot ask for something absurd. The
// floor keeps a few pieces in flight on a low-bitrate file; the ceiling keeps
// one reader from claiming more than a fraction of the piece store.
const READ_WINDOW_MIN_BYTES = 16 * 1024 * 1024;
const READ_WINDOW_MAX_BYTES = 96 * 1024 * 1024;
const LOOKAHEAD_PAUSE_SECONDS = 120;
const LOOKAHEAD_RESUME_SECONDS = 60;
// Seek debounce. A far (out-of-window) segment request is a server-side seek.
// Rather than restart ffmpeg on the first one, wait a short quiet period:
// further far requests re-arm it and update the target to the latest index, so
// a scrub that emits a burst of scattered requests (e.g. iOS native HLS firing
// 367,732,369,368,370 seconds apart) collapses to ONE restart at the position
// the player ended on, instead of ping-ponging ffmpeg between positions and
// producing nothing.
// How many segments BEFORE the requested position the encoder starts.
//
// A player given a position decodes from the nearest keyframe PRECEDING it
// (Apple HLS authoring guidance), so it fetches segments below the target and
// an encoder starting exactly on it produces nothing anyone waits for.
//
// ONE segment is now enough. Since 2.9.65 every boundary IS a real keyframe
// (read from the container index), so the segment before the target is
// guaranteed to start on one. The old value of 12 dates from the invented 4 s
// grid, where the distance to a usable keyframe was unknown — and it became
// actively harmful once boundaries turned real: with 10.43 s segments it meant
// encoding 125 s of content before reaching the viewer's position. Field
// 2026-08-02: a seek took 56 s, of which ~50 s was this backoff.
const SEEK_BACKOFF_SEGMENTS = 1;
// How long to wait for a scrub to stop moving before acting on it. Small,
// because the browser already collapses a drag into ONE report
// (`SEEK_REPORT_DEBOUNCE_MS`, 300 ms) and only reports where it settled — this
// is a second debounce on an already-debounced signal, and every millisecond of
// it is dead time in front of the viewer. It was 1.2 s when the encoder was
// also steered by segment requests, which arrive in bursts of dozens; measured
// 2026-08-04, that cost 1.2 s of every seek.
const SEEK_SETTLE_MS = 300;
// Hard cap on the total settle wait, measured from the first request of a
// burst, so a still-moving scrubber cannot delay a genuine seek forever.
const SEEK_SETTLE_MAX_MS = 1_000;
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
// A run that lost its INPUT is retried rather than condemned: the torrent can
// be added again and the pieces downloaded again, so the data being gone is a
// wait, not a verdict. Backed off so a source that is truly unavailable costs a
// process every few seconds rather than continuously, and never given up on —
// the session's own idle TTL is what ends it if the viewer leaves.
const INPUT_RETRY_BASE_MS = 2_000;
const INPUT_RETRY_MAX_MS = 15_000;
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
// How many recent runs the two cold-start estimates keep. Both the
// session-create time and the first-segment time are reported to the browser as
// the median of this many samples, so it has to be long enough that one slow run
// does not move the figure and short enough that the estimate still follows the
// host: a proxy whose swarm has warmed up, or which has just picked up a second
// viewer, should stop quoting the numbers from ten minutes ago.
const FIRST_SEGMENT_SAMPLES = 20;
const MICROSECONDS_PER_SECOND = 1_000_000;
const PROGRESS_LOG_INTERVAL_MS = 5_000;
// Read segment files in large blocks so the body is delivered to the data
// channel in few, big chunks. On a busy ARM host the in-process WebTorrent
// hashing starves the event loop in bursts, so fewer read iterations means
// far less time lost between chunks while serving the first segments.
const SEGMENT_READ_HIGH_WATER_MARK = 4 * 1024 * 1024;
// How far a segment's own recorded start may sit from the one the playlist
// assigned it before the disagreement is worth a log line. The two are built
// from the same keyframe index and normally match to the sample; a quarter of a
// second is below any drift a viewer could notice, so anything above it is the
// index being wrong about where a keyframe is rather than rounding.
const SEGMENT_START_DISAGREEMENT_SEC = 0.25;

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
          // `-skip_frame nokey` makes the decoder discard non-keyframes, so the
          // probe reads only what it needs. Without it a full packet scan of a
          // ~5 GB MKV cannot finish inside any sane budget over a torrent-backed
          // input, the probe returns nothing, and the playlist falls back to a
          // uniform grid — which on the COPY path is a lie: cuts land on the
          // source's real keyframes, not on a 4 s ruler. The player then finds
          // the declared times do not match the media, stops trusting the
          // playlist and walks the file from segment #1 to locate the seek
          // position by hand (field 2026-08-02: a seek to 1:30 produced requests
          // #1, #2, #45, #86, #123 … #1187, taking minutes and never arriving).
          "-skip_frame", "nokey",
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
 * A number of seconds as ffmpeg will accept it.
 *
 * `String(n)` switches to exponential notation below 1e-6, and ffmpeg's
 * duration parser rejects that outright: a field session died on
 * `Invalid duration for option ss: 3.3333333249174757e-7`, after which the
 * transcode was in state `failed` and every segment request answered 500 for
 * as long as the viewer kept trying. Anything under a millisecond is also not a
 * real offset — it is the residue of subtracting two nearly equal floats — so
 * it is dropped rather than passed on.
 *
 * @param {number} value
 * @returns {string}
 */
export function ffmpegSeconds(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.001) {
    return "0";
  }
  // Microsecond resolution, fixed notation, no trailing zero noise.
  return value.toFixed(6).replace(/\.?0+$/, "");
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
 * The cut times to hand ffmpeg for a run that starts at `startIndex`.
 *
 * Two adjustments, both of which cost a broken session to learn:
 *
 *  - **Rebased.** `-segment_times` is measured from the start of the run, not
 *    of the file. Measured: starting at 12 s and asking for a cut at 18 s put
 *    it at 29.4 s — 12 + 18. So every boundary has the run's own start
 *    subtracted.
 *  - **Interior only.** The first boundary is where the run begins and the last
 *    is where the file ends; neither is a cut. Sending them would produce an
 *    empty leading segment and a spurious trailing one.
 *
 * @param {number[]} boundaries - Segment start times, ascending, ending at the
 *   file duration (as {@link computeSegmentBoundaries} returns).
 * @param {number} startIndex - Segment this run starts at.
 * @returns {number[] | null} Times relative to the run start, or null when the
 *   boundaries cannot serve (missing, or the index is outside them).
 */
/**
 * The ffmpeg command as one readable line.
 *
 * Everything is shown as passed except the list of cut times, which is one
 * value per segment — 830 of them on a two-hour film, about 7 KB of log for a
 * single run, repeated on every restart. The count and the two ends say
 * everything the list is ever consulted for: whether cutting was explicit at
 * all, how far it reaches, and where it starts.
 *
 * @param {string[]} args
 * @returns {string}
 */
export function describeFfmpegArgs(args) {
  const parts = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "-segment_times" && typeof args[index + 1] === "string") {
      const times = args[index + 1].split(",");
      parts.push(value, `<${times.length} cuts ${times[0]}..${times[times.length - 1]}>`);
      index += 1;
      continue;
    }
    parts.push(value);
  }
  return parts.join(" ");
}

export function segmentCutTimesFrom(boundaries, startIndex) {
  if (!Array.isArray(boundaries) || boundaries.length < 2) {
    return null;
  }
  const index = Number.isInteger(startIndex) && startIndex > 0 ? startIndex : 0;
  if (index >= boundaries.length - 1) {
    return null;
  }
  const base = boundaries[index];
  const times = [];
  for (let at = index + 1; at < boundaries.length - 1; at += 1) {
    times.push(Number((boundaries[at] - base).toFixed(6)));
  }
  return times;
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
   * Recent times from session-create to a servable first segment, in ms.
   * See #rememberFirstSegmentLatency.
   *
   * @type {number[]}
   */
  #firstSegmentLatencies = [];

  /**
   * Recent times to create a session, in ms — the second term of the browser's
   * estimate. Measured for the same reason as the first: it is 116-843 ms
   * depending on whether the keyframe index is already in hand, and guessing it
   * was one of the ways the shown figure stopped describing the whole wait.
   *
   * @type {number[]}
   */
  #sessionCreateLatencies = [];

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
    // What this host learned last time it ran. Without it every restart shows
    // the first viewer a figure with no measurement behind it.
    this.#loadHostTimings();
    // Container keyframe index per (source, file). Immutable per file, so one
    // read serves every session, re-open and seek. Null means "this file has no
    // readable index" and is cached too — no point retrying a scan that cannot
    // succeed.
    this.keyframeIndexCache = new Map();
    this.sessionIdBySource = new Map();
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired();
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
    // Realtime-budget monitor: only meaningful for the software encoder with a
    // benchmark (the only path that can pick/step resolution). Cheap no-op scan
    // otherwise.
    this.budgetTimer = setInterval(() => {
      this.#enforceLookAhead();
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
    manualQuality = false,
    segmentFormatId = "",
    // Called once for a session that is actually created, and expected to
    // return a function that lets the source go. It is what keeps the torrent's
    // data alive for as long as a viewer has a session on it — see
    // disposeSession.
    acquireSource = null
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
      String(normalizedStartPosition),
      // Two viewers asking for different containers cannot share one ffmpeg.
      segmentFormat.id
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

    // Size the reader's window in seconds of playback rather than bytes. Needs
    // the file's own average byte rate, which is size ÷ duration; the size
    // comes from the same stats call the realtime budget uses. Best effort —
    // without it the reader keeps its own byte default.
    const readWindowBytes = await this.#readWindowBytesFor(sourceKey, fileIndex, durationSeconds);
    if (readWindowBytes > 0) {
      inputUrl.searchParams.set("windowBytes", String(readWindowBytes));
      // This read, and only this read, follows the viewer. The codec probe and
      // the keyframe index also go through `/stream`, and they jump between the
      // first bytes and the last ones — which is indistinguishable, from byte
      // offsets alone, from someone dragging the slider. Saying so here is
      // cheaper and more truthful than guessing from the offsets.
      inputUrl.searchParams.set("reader", "playback");
    }
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
      // Read the container's OWN keyframe table (Cues/stss) rather than
      // scanning the media. On the copy path ffmpeg can only cut at the
      // source's existing keyframes, so these times ARE the segment
      // boundaries — declaring an even grid instead is a falsehood the player
      // punishes: it walks the whole file to rebuild the timeline, or presents
      // audio with no picture because a segment starts with nothing decodable
      // (both field-observed 2026-08-02). Scanning cannot supply them here —
      // the file comes off a torrent, and a full packet scan of 5.5 GB found 77
      // keyframes in 45 s without finishing, while the container index yields
      // all 570 in 0.8 s from two point reads (16 KB).
      keyframeTimes = await this.#readContainerKeyframes({ sourceKey, fileIndex, inputUrl, logName });
      keyframeMs = Date.now() - keyframeStartMs;
      if (!keyframeTimes) {
        logger.warn(
          `transcode ${sessionId}: no container keyframe index for "${logName}"; ` +
            `falling back to a uniform grid — segment boundaries will not match the media`
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
    this.#rememberSessionCreateLatency(Date.now() - createEntryMs);
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

    // Only now, when nothing above can still throw. Everything from the probe
    // to the keyframe index used to run with the directory already made, so a
    // failure between the two left it behind: nothing tracks a directory whose
    // session was never registered, and no sweep looks for one. Proxy
    // 2.9.101-2.9.102 failed here on every single request and the leftovers
    // were the only trace of it on disk.
    await mkdir(sessionDir, { recursive: true });

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
      // The container this session produces. Per session, not per proxy: the
      // viewer's browser decides, because it is the one that has to decode the
      // result (see createOrGetSession).
      segmentFormat,
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
      playlistText: hasDuration ? this.#buildVodPlaylist(segmentBoundaries, segmentFormat) : "",
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
      // Bumped by every viewer seek; a held segment request that started under
      // an older value gives up at once. See requestSeek.
      waitEpoch: 0,
      // Highest segment the viewer has actually asked for, and whether the
      // encoder is currently suspended for running too far past it.
      // See #enforceLookAhead.
      lastRequestedSegment: null,
      encoderPaused: false,
      encoderPauseUnsupported: false,
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
    // Kept so a variant of this session can take its own hold on the same
    // source: a variant is another encode of the same file and must keep the
    // torrent's data alive exactly as this one does.
    session.acquireSource = typeof acquireSource === "function" ? acquireSource : null;
    if (typeof acquireSource === "function") {
      try {
        session.releaseSource = acquireSource();
      } catch {
        session.releaseSource = null;
      }
    }
    this.sessionsById.set(sessionId, session);
    this.sessionIdBySource.set(sourceMapKey, sessionId);

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

    // Begin where the viewer asked, not at the top of the file. The position
    // was already honoured everywhere EXCEPT here: it went into the session key
    // and into the log line, and then the first run started at index 0 anyway.
    // Measured 2026-08-06 on a Retry after the proxy restarted — the session
    // was created with `start=1580s`, the encoder began at #0, the player
    // asked for #152, and 45 s later the browser gave up with "no data arrived
    // from the proxy" while the transcode ran happily at 9.9x through the
    // opening credits.
    const firstIndex = normalizedStartPosition > 0
      ? this.#segmentIndexForTime(session, normalizedStartPosition)
      : 0;
    await this.#startEncodeRun(session, firstIndex);

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
      sourceKey: session.sourceKey,
      fileIndex: session.fileIndex
    }) ?? null;
    return {
      video: Boolean(probed?.videoCodec),
      audio: Boolean(probed?.audioCodec)
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
      names = (this.#runDirs(session).flatMap((dir) => {
        try { return readdirSync(dir, { withFileTypes: false }); } catch { return []; }
      }))
        .filter((name) => session.segmentFormat.isSegmentFileName(name))
        .sort();
    } catch {
      return null;
    }
    // First pass: what do the produced pieces actually carry? The answer is the
    // requirement — no assumption about the source is involved.
    if (typeof session.segmentFormat.countSegmentTracks === "function") {
      for (const name of names) {
        try {
          const found = await this.#findProducedFile(session, name);
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
        const found = cached ? name : await this.#findProducedFile(session, name);
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
   * Read the file's keyframe index into the cache before a session needs it.
   *
   * The index lives at the END of a Matroska file, which is also where the
   * codec probe reads — both wait for the same piece to arrive, and they used
   * to do it one after the other: measured 2026-08-04, a probe of 722-1206 ms
   * followed by an index read of 311-430 ms, all of it before the first
   * segment. Started together, the second costs nothing.
   *
   * Never rejects and is never awaited by the caller: a session that finds
   * nothing cached simply reads it itself, as before.
   *
   * @param {{ sourceKey: string, fileIndex: number, inputUrl: URL, logName: string }} params
   * @returns {Promise<void>}
   */
  async warmKeyframeIndex({ sourceKey, fileIndex, inputUrl, logName }) {
    try {
      await this.#readContainerKeyframes({ sourceKey, fileIndex, inputUrl, logName });
    } catch {
      // Best effort by construction.
    }
  }

  async #readContainerKeyframes({ sourceKey, fileIndex, inputUrl, logName }) {
    const cacheKey = `${sourceKey}:${fileIndex}`;
    if (this.keyframeIndexCache.has(cacheKey)) {
      return this.keyframeIndexCache.get(cacheKey);
    }

    const url = inputUrl.toString();
    let fileSize = 0;
    try {
      const head = await fetch(url, { method: "HEAD" });
      fileSize = Number(head.headers.get("content-length")) || 0;
    } catch {
      return null;
    }
    if (fileSize <= 0) {
      return null;
    }

    const readRange = async (start, end) => {
      try {
        const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
        if (!response.ok && response.status !== 206) {
          return null;
        }
        return Buffer.from(await response.arrayBuffer());
      } catch {
        return null;
      }
    };

    const times = await readKeyframeIndex({ readRange, fileSize, label: logName });
    this.keyframeIndexCache.set(cacheKey, times);
    return times;
  }

  #buildVodPlaylist(boundaries, segmentFormat) {
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
      `#EXT-X-VERSION:${segmentFormat.playlistVersion}`,
      `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      // Container-specific header lines (e.g. fMP4's `#EXT-X-MAP`).
      ...segmentFormat.playlistHeaderLines()
    ];
    for (let index = 0; index < count; index += 1) {
      const duration = Math.max(0.1, boundaries[index + 1] - boundaries[index]);
      lines.push(`#EXTINF:${duration.toFixed(6)},`);
      lines.push(segmentFormat.segmentFileName(index));
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
      names = this.#runDirs(session).flatMap((dir) => {
        try { return readdirSync(dir, { withFileTypes: false }); } catch { return []; }
      });
    } catch {
      return null;
    }
    const indices = [];
    for (const name of names) {
      const index = session.segmentFormat.segmentIndexFromName(name);
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
        const segmentPath = await this.#findProducedFile(session, session.segmentFormat.segmentFileName(index));
        if (!segmentPath) {
          break;
        }
        const st = await stat(segmentPath);
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
   * The read-ahead window for a file, in bytes, sized from how many seconds of
   * playback it holds.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @param {number} durationSeconds
   * @returns {Promise<number>} Zero when the byte rate cannot be established,
   *   which leaves the reader on its own default.
   */
  async #readWindowBytesFor(sourceKey, fileIndex, durationSeconds) {
    if (!this.getSourceStats || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return 0;
    }
    let fileLength = 0;
    try {
      const stats = await this.getSourceStats(sourceKey, fileIndex);
      fileLength = Number(stats?.fileLength);
    } catch {
      return 0;
    }
    if (!Number.isFinite(fileLength) || fileLength <= 0) {
      return 0;
    }
    const bytesPerSecond = fileLength / durationSeconds;
    const wanted = Math.round(bytesPerSecond * READ_WINDOW_SECONDS);
    return Math.min(READ_WINDOW_MAX_BYTES, Math.max(READ_WINDOW_MIN_BYTES, wanted));
  }

  #enforceLookAhead() {
    for (const session of this.sessionsById.values()) {
      this.#enforceLookAheadFor(session);
    }
  }

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
  #enforceLookAheadFor(session) {
    if (!session || session.state === "disposed" || !session.ffmpeg) {
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
    // Where the viewer is. Before the first segment request, the position the
    // run started at — so a session nobody has read from yet is bounded too.
    const viewerSegment = Number.isInteger(session.lastRequestedSegment)
      ? session.lastRequestedSegment
      : (session.encodeStartIndex ?? 0);

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
      // The segment the viewer needs does not exist. Whatever else is on disk,
      // this encoder has work to do right now.
      if (session.encoderPaused) {
        this.#resumeEncoder(session, "the viewer needs a segment nobody has made");
      }
      return;
    }

    // Worth knowing when ffmpeg's own report and what exists disagree wildly —
    // it is the only trace of whatever made it claim a position it had not
    // reached. Reported on its EDGES, because it is a state and not a stream.
    const claimed = Number(session.progress?.processedSeconds);
    const encodedTo = this.#segmentStartTime(session, viewerSegment) + aheadSeconds;
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

    if (!session.encoderPaused && aheadSeconds > LOOKAHEAD_PAUSE_SECONDS) {
      // The decision names what it was taken on. Suspending the encoder stops
      // the only thing that reads the input, so a wrong reading here stops the
      // download too — measured 2026-08-06: the log said "135s ahead" while
      // three segments totalling 31 s lay on disk, and neither figure could be
      // checked against the other because the line carried no evidence. The
      // directory holds segments from every run this session has had, so which
      // ones were counted is the whole question.
      this.#pauseEncoder(
        session,
        `${Math.round(aheadSeconds)}s ahead of the viewer ` +
          `(viewer at #${viewerSegment}, unbroken through #${reading.lastCovered}, ` +
          `${reading.total} segment file(s) present)`
      );
    } else if (session.encoderPaused && aheadSeconds <= LOOKAHEAD_RESUME_SECONDS) {
      this.#resumeEncoder(session, `${Math.round(aheadSeconds)}s ahead of the viewer`);
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
      present = new Set();
      for (const name of this.#runDirs(session).flatMap((dir) => {
        try { return readdirSync(dir, { withFileTypes: false }); } catch { return []; }
      })) {
        if (!this.segmentFormat.isSegmentFileName(name)) {
          continue;
        }
        const index = this.segmentFormat.segmentIndexFromName(name);
        if (index >= 0) {
          present.add(index);
        }
      }
    } catch {
      return null;
    }
    const lastCovered = contiguousEnd(present, viewerSegment);
    if (lastCovered === null) {
      return null;
    }
    const from = this.#segmentStartTime(session, viewerSegment);
    const to = this.#segmentStartTime(session, lastCovered + 1);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return null;
    }
    return { seconds: Math.max(0, to - from), lastCovered, total: present.size };
  }

  /**
   * Suspend a session's encoder. No-op when already paused or unsupported here.
   *
   * @param {HlsSession} session
   * @param {string} reason
   * @returns {void}
   */
  #pauseEncoder(session, reason) {
    if (session.encoderPaused || session.encoderPauseUnsupported || !session.ffmpeg?.pid) {
      return;
    }
    try {
      process.kill(session.ffmpeg.pid, "SIGSTOP");
    } catch (error) {
      session.encoderPauseUnsupported = true;
      logger.info(
        `transcode ${session.id} cannot suspend the encoder on this platform ` +
          `(${error instanceof Error ? error.message : String(error)}); look-ahead stays unbounded`
      );
      return;
    }
    session.encoderPaused = true;
    logger.info(
      `transcode ${session.id} encoder suspended — ${reason} ` +
        `"${session.fileName}"`
    );
  }

  /**
   * Let a suspended encoder run again.
   *
   * @param {HlsSession} session
   * @param {string} reason
   * @returns {void}
   */
  #resumeEncoder(session, reason) {
    if (!session.encoderPaused || !session.ffmpeg?.pid) {
      return;
    }
    try {
      process.kill(session.ffmpeg.pid, "SIGCONT");
    } catch {
      // The process is gone; the exit handler will deal with it.
    }
    session.encoderPaused = false;
    logger.info(`transcode ${session.id} encoder resumed — ${reason} "${session.fileName}"`);
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
    // Where a restart's seconds go. A seek costs 5-8 s in the field and the
    // recorded reason — waiting for the previous ffmpeg to exit, measured at
    // 0.54-1.47 s — does not account for it. Before rebuilding the hottest path
    // in the proxy on a guess, make each stage state its own cost.
    const restartEnteredAt = Date.now();
    // One directory per run. Two runs writing the same segment name at once
    // produce a file that is neither, which is the only reason a restart ever
    // had to wait for its predecessor to die.
    session.runSerial = (session.runSerial ?? 0) + 1;
    session.runDirPath = path.join(session.dirPath, `run-${session.runSerial}`);
    await mkdir(session.runDirPath, { recursive: true });
    // The restart backs off a segment or two from what was asked for, so the
    // request that prompted it is recorded under a HIGHER index than the run
    // starts at. Looking it up by the start index alone found nothing and the
    // line never printed once.
    let wantedAt = null;
    for (const [index, at] of session.firstWantedAt ?? []) {
      if (index >= startIndex && (wantedAt === null || at < wantedAt)) {
        wantedAt = at;
      }
    }
    if (typeof wantedAt === "number") {
      logger.info(
        `transcode ${session.id} restart for #${startIndex} decided ` +
        `${restartEnteredAt - wantedAt}ms after it was first asked for`
      );
    }
    const generation = ++session.encodeRunGeneration;
    const previousFfmpeg = session.ffmpeg;
    // A suspended process does not act on SIGTERM until it is continued, so the
    // wait below would never end. Let it run before asking it to stop.
    this.#resumeEncoder(session, "terminating for a new run");
    if (previousFfmpeg && !hasChildExited(previousFfmpeg)) {
      try {
        previousFfmpeg.kill("SIGTERM");
      } catch {
        // Best effort.
      }
      // NOT awaited. The previous run has its own directory, so it cannot
      // corrupt this one's output by still writing; letting it die in the
      // background removes 0.7-1.3 s from every seek (measured 2.9.132, where
      // that wait was essentially the whole cost of a restart).
      const termSentAt = Date.now();
      void waitForChildExit(previousFfmpeg, ENCODE_RUN_TERMINATE_GRACE_MS).then(() => {
        logger.info(
          `transcode ${session.id} restart: previous run took ${Date.now() - termSentAt}ms to exit after SIGTERM`
        );
      });
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
    this.#resumeEncoder(session, "terminating");
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
        args.push("-ss", ffmpegSeconds(snappedKeyframe));
      }
      args.push("-i", session.inputUrl);
      if (residualSeconds > 0) {
        args.push("-ss", ffmpegSeconds(residualSeconds));
      }
    } else {
      if (seekSeconds > 0) {
        // No keyframe map (probe failed/timed out) — fall back to the previous
        // behaviour: trust the container's own accurate seek.
        args.push("-accurate_seek", "-ss", ffmpegSeconds(seekSeconds));
      }
      args.push("-i", session.inputUrl);
    }
    if (session.transcodeVideo) {
      // Branch A (re-encode): fixed GOP makes keyframes land exactly on the
      // segment grid; relabel output onto the original timeline so segment N
      // carries PTS = N × segmentDuration.
      if (startSeconds > 0) {
        args.push("-output_ts_offset", ffmpegSeconds(startSeconds));
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
        args.push("-output_ts_offset", ffmpegSeconds(-sourceStartTime));
      }
    }
    args.push(
      "-map",
      "0:v:0?",
      "-map",
      // Type-relative audio track chosen by the viewer (default 0).
      `0:a:${session.audioTrackIndex ?? 0}?`,
      ...videoCodecArgs,
      ...audioCodecArgs
    );

    // Where the cuts come from. On the copy path they are the source's own
    // keyframes, and until now they were only ever GUESSED: ffmpeg got a target
    // duration and chose its own cut points, while the playlist was built from
    // the container index — two independent calculations with nothing tying
    // them together but the hope that they agree. They do not. The index is a
    // navigation table and is not obliged to list every keyframe; for a field
    // file it held 1902 while ffmpeg found roughly twice as many and cut twice
    // as often. Segment #876 then meant 1:26:50 to the player and about minute
    // 58 to ffmpeg, which is why a seek landed nowhere near where it was aimed
    // and the reported duration drifted.
    //
    // So stop guessing and say it: the `segment` muxer takes the list of times
    // outright. Passing the very boundaries the playlist was built from makes
    // the two agree by construction. Only cut points already known to be real
    // keyframes are sent, so ffmpeg never has to move one forward.
    const explicitTimes = session.segmentFormat.explicitTimesMuxerArgs?.() ?? null;
    const cutTimes = explicitTimes && !session.transcodeVideo
      ? segmentCutTimesFrom(session.segmentBoundaries, safeIndex)
      : null;

    if (cutTimes && cutTimes.length > 0) {
      args.push(
        "-f",
        "segment",
        // Times are measured from the START OF THIS RUN, not from the start of
        // the file — verified: starting at 12 s and asking for a cut at 18 s
        // produced one at 29.4 s. `segmentCutTimesFrom` rebases them.
        "-segment_times",
        cutTimes.join(","),
        // A cut lands on the first keyframe at or after its time, so a boundary
        // recorded a hair late would skip to the next one and double the
        // segment. The tolerance absorbs that rounding.
        "-segment_time_delta",
        "0.05",
        "-segment_start_number",
        String(safeIndex),
        ...explicitTimes,
        session.segmentFormat.segmentFileNameTemplate()
      );
    } else {
      args.push(
        "-f",
        "hls",
        "-hls_time",
        String(this.segmentDurationSec),
        "-hls_list_size",
        "0",
        "-hls_flags",
        "independent_segments+temp_file",
        // Container selection + segment naming, from the active format module.
        ...session.segmentFormat.muxerArgs(),
        "-start_number",
        String(safeIndex),
        // ffmpeg writes its own playlist here; we ignore it and serve the
        // synthetic VOD playlist instead (see getFileStream).
        PLAYLIST_FILE_NAME
      );
    }

    // The exact command, every run. An encode failure is otherwise reported
    // with ffmpeg's message and nothing about what it was asked to do, and the
    // two are not always deducible from each other: 2026-08-04 a run died with
    // "Cannot write moov atom before AC3 packets" although both muxing paths
    // were verified to handle a copied AC-3 track on this very host, so the
    // arguments that run actually received are the missing evidence. One line
    // per run, and a run happens at most every few seconds.
    // Numbered, because a burst of seeks starts several runs in one second and
    // every line about them carries the SESSION id, which is the same for all.
    // Without a run number the command that failed cannot be told from the two
    // that succeeded around it — which is exactly the state the unexplained
    // `Cannot write moov atom before AC3 packets` was found in.
    session.runCounter = (session.runCounter ?? 0) + 1;
    const runLabel = `run#${session.runCounter}`;
    session.runLabel = runLabel;
    logger.info(`transcode ${session.id} ${runLabel} ffmpeg ${describeFfmpegArgs(args)}`);

    const ffmpeg = spawn(this.ffmpegBin, args, {
      cwd: session.runDirPath ?? session.dirPath,
      stdio: ["ignore", "pipe", "pipe"]
    });
    session.ffmpeg = ffmpeg;
    // Whether this run cuts at times we gave it. Decides how a segment is
    // judged finished — see getFileStream.
    session.usesExplicitCuts = Boolean(cutTimes && cutTimes.length > 0);
    session.encodeStartIndex = safeIndex;
    session.encoderPaused = false;
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
      `transcode ${session.id} ${session.runLabel} encode-run from segment #${safeIndex} ` +
      `(+${Date.now() - restartEnteredAt}ms since the restart was asked for) ` +
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
        // ffmpeg exits 0 both when it reaches the end of the file and when its
        // input simply stops producing bytes — over HTTP the two look identical
        // to it. Field 2026-08-05: the torrent's download died, the read ended,
        // and a run that had made 188 segments of 624 reported itself complete;
        // the player then consumed what was on disk and froze on the first
        // segment nobody was making. So the claim is checked against the
        // playlist we published, and a run that stopped short is a FAILURE that
        // can be restarted, not a finished file.
        const producedThrough = this.#latestProducedSegment(session);
        const expectedLast = session.segmentCount > 0 ? session.segmentCount - 1 : null;
        if (expectedLast !== null && producedThrough !== null && producedThrough < expectedLast) {
          session.state = "failed";
          session.progress.state = "failed";
          session.progress.updatedAt = Date.now();
          session.lastError =
            `input ended after segment #${producedThrough} of ${expectedLast} — ` +
            "the source stopped delivering data";
          logger.error(
            `transcode ${session.id} ${session.runLabel ?? "run#?"} encode-run ended early: ` +
            `${session.lastError} "${session.fileName}"`
          );
          return;
        }
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
      // Losing the INPUT is not the session failing — it is the data not being
      // there YET. The torrent can be re-added and re-downloaded, so the
      // honest answer to the viewer is "still working", not an error screen.
      // Field 2026-08-06: a torrent evicted mid-seek took the film with it, the
      // run died on `File 0 not found`, the session went terminal and answered
      // 500 to every request from then on — although the swarm was there and
      // the data would have come back in seconds. The circuit breaker below
      // stays for what it was built for, a target that genuinely cannot be
      // encoded; it must not condemn a session whose data merely went away.
      if (isInputUnavailable(session.lastError)) {
        session.state = "recovering";
        // On the wire it is simply "not ready yet" — a state the browser has
        // always known how to wait through. Only the proxy needs the
        // distinction between waiting for data and having given up.
        session.progress.state = "starting";
        session.progress.updatedAt = Date.now();
        session.inputRetryCount = (session.inputRetryCount ?? 0) + 1;
        const delayMs = Math.min(
          INPUT_RETRY_MAX_MS,
          INPUT_RETRY_BASE_MS * 2 ** Math.min(session.inputRetryCount - 1, 6)
        );
        logger.warn(
          `transcode ${session.id} ${session.runLabel ?? "run#?"} lost its input ` +
            `(${session.lastError}); retrying in ${Math.round(delayMs / 1000)}s ` +
            `(attempt ${session.inputRetryCount})`
        );
        session.inputRetryTimer = setTimeout(() => {
          session.inputRetryTimer = null;
          if (session.state !== "recovering") {
            return;
          }
          const at = Number.isInteger(session.lastRequestedSegment)
            ? session.lastRequestedSegment
            : (session.encodeStartIndex ?? 0);
          this.#startEncodeRun(session, at).catch(() => {});
        }, delayMs);
        session.inputRetryTimer.unref?.();
        return;
      }
      session.state = "failed";
      session.progress.state = "failed";
      session.progress.updatedAt = Date.now();
      logger.error(
        `transcode ${session.id} ${session.runLabel ?? "run#?"} encode-run failed: ${session.lastError}`
      );
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
    // When this segment was FIRST asked for and nobody was producing it. The
    // restart itself costs 0.7-1.3 s (measured 2.9.132), while a seek costs
    // 5-8 s end to end — so most of the wait happens before a restart is even
    // decided on, and that is what this records.
    session.firstWantedAt ??= new Map();
    if (!session.firstWantedAt.has(index)) {
      session.firstWantedAt.set(index, Date.now());
    }
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
    // Every segment request being held right now was made for the position the
    // viewer has just left. Release them: hls.js keeps ONE fragment load
    // outstanding, so until the one in flight answers, the player cannot ask
    // for the segment it now needs — measured 2026-08-04, a backward seek into
    // fully-downloaded data waited 57 s for a held request for #609 to time
    // out, then fetched the segment it wanted in 15 ms. Bumping the epoch makes
    // those waits answer "retry" on their next poll instead of running out the
    // 60 s hold. Prescribed by `hls-media-server` (one outstanding wait per
    // session) in research/hls-seek-prior-art-2026-08-02.md.
    session.waitEpoch = (session.waitEpoch ?? 0) + 1;
    const index = this.#segmentIndexForTime(session, positionSeconds);
    const head = session.encodeStartIndex;
    const processed = Number.isFinite(session.progress?.processedSeconds)
      ? session.progress.processedSeconds
      : this.#segmentStartTime(session, head);
    const currentSeg = Math.max(head, this.#segmentIndexForTime(session, processed));
    // Already covered by the running encode — the data is on its way, so
    // restarting would only destroy work the viewer is waiting for. The run has
    // to be ALIVE for that to hold: after a run died, `session.ffmpeg` still
    // pointed at the dead process and every later seek was waved through as
    // "already covered", so nothing could ever restart it. Measured 2026-08-04:
    // one ffmpeg failure turned into a session that answered 500 to every
    // segment for as long as the viewer kept trying.
    const runIsAlive = session.ffmpeg != null && !hasChildExited(session.ffmpeg);
    if (runIsAlive && index >= head && index <= currentSeg + MAX_LOOKAHEAD_SEGMENTS) {
      logger.info(
        `transcode ${session.id} seek to ${positionSeconds.toFixed(1)}s (#${index}) ` +
          `already within the running encode (#${head}..#${currentSeg}) — not restarting`
      );
      return true;
    }
    // Start BEFORE the requested position (see SEEK_BACKOFF_SEGMENTS): the
    // player needs a segment containing the preceding keyframe, so one that
    // begins exactly at the target is useless to it.
    const startIndex = Math.max(0, index - SEEK_BACKOFF_SEGMENTS);
    logger.info(
      `transcode ${session.id} viewer seek to ${positionSeconds.toFixed(1)}s → segment #${index}, ` +
        `starting at #${startIndex} (${SEEK_BACKOFF_SEGMENTS} back for the preceding keyframe)`
    );
    session.seekTarget = startIndex;
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
    // A run in progress is NOT protected any more. It used to be: a restart was
    // held for up to 30 s while the current run reached its first segment,
    // because a far segment REQUEST could steer the encoder and the player's
    // playlist scan produced dozens of them — restarts at #617 → #717 → #732 →
    // #732 every 5-7 s, none producing anything (field 2026-08-02). Requests
    // stopped steering anything when the position became explicit, so the only
    // thing that can arrive here is a position the viewer has stated, and
    // finishing a segment for where they no longer are is work nobody wants.
    // Holding it was also expensive in the other direction: a genuine second
    // seek could be delayed by the whole grace.
    const producedThisRun = this.#producedSecondsThisRun(session);
    const runIsAlive = session.ffmpeg != null && !hasChildExited(session.ffmpeg);
    const allowedBecause = !runIsAlive
      ? "run is dead"
      : `viewer moved; run had produced ${producedThisRun.toFixed(1)}s`;
    // The start is exactly what requestSeek computed — one segment before the
    // viewer's position — and nothing else may move it.
    //
    // An earlier version pulled it down to the lowest segment the player had
    // outstanding, guessing how far back the preceding keyframe lay. That guess
    // is unnecessary now (boundaries ARE keyframes since 2.9.65) and was
    // actively wrong: during a scrub the player loads from wherever the slider
    // paused on its way, so those requests describe INTERMEDIATE positions, not
    // the destination. Measured 2026-08-02: dragging from 0 to 23:34 paused at
    // 863.4 s, the player fetched #82 for it, and a seek correctly resolved to
    // #134 was dragged back to #82. The browser's 300 ms debounce exists to
    // discard those intermediate positions — reading them back off the request
    // stream defeated it.
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
  /**
   * Where this host's recorded timings live: one file, always the same path,
   * beside the proxy's own installation.
   *
   * Kept so a proxy that has just restarted is not back to knowing nothing —
   * the browser was shown an assumed rate for the whole of the first wait after
   * every restart. It is meant to be TEMPORARY: if the synthetic figure tracks
   * the measured one closely enough (see #compareSyntheticWithMeasured) this
   * file can go, and every machine is then right from its first second without
   * carrying anything between runs.
   *
   * @returns {string}
   */
  #hostTimingsPath() {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "host-timings.json");
  }

  /** Load them, if any were ever written. Never throws. */
  #loadHostTimings() {
    try {
      const raw = JSON.parse(readFileSync(this.#hostTimingsPath(), "utf8"));
      if (Array.isArray(raw?.firstSegment)) {
        this.#firstSegmentLatencies = raw.firstSegment.filter((value) => Number.isFinite(value) && value > 0);
      }
      if (Array.isArray(raw?.sessionCreate)) {
        this.#sessionCreateLatencies = raw.sessionCreate.filter((value) => Number.isFinite(value) && value > 0);
      }
      logger.info(
        `host timings loaded: first-segment ${this.expectedFirstSegmentMs() ?? "n/a"}ms, ` +
        `session-create ${this.expectedSessionCreateMs() ?? "n/a"}ms`
      );
    } catch {
      // No file yet, or it is unreadable. The synthetic figure answers instead.
    }
  }

  /** Write them. Best effort: losing them costs a first estimate, nothing more. */
  #saveHostTimings() {
    try {
      writeFileSync(this.#hostTimingsPath(), JSON.stringify({
        firstSegment: this.#firstSegmentLatencies,
        sessionCreate: this.#sessionCreateLatencies
      }));
    } catch {
      // Read-only install, no permission — not worth failing a session over.
    }
  }

  syntheticFirstSegmentMs(output = {}) {
    const benchmark = this.softwarePresetBenchmark;
    if (!Array.isArray(benchmark) || benchmark.length === 0) {
      return null;
    }
    const width = Number.isFinite(output.width) && output.width > 0 ? output.width : 1920;
    const height = Number.isFinite(output.height) && output.height > 0 ? output.height : 1080;
    const fps = Number.isFinite(output.fps) && output.fps > 0 ? output.fps : TRANSCODE_FPS;
    // The preset actually chosen sits somewhere in the middle of the ladder;
    // the median entry is the representative one and involves no choice.
    const sorted = [...benchmark].sort((left, right) => left.pixelsPerSec - right.pixelsPerSec);
    const pixelsPerSec = sorted[Math.floor(sorted.length / 2)]?.pixelsPerSec;
    if (!Number.isFinite(pixelsPerSec) || pixelsPerSec <= 0) {
      return null;
    }
    const pixels = this.segmentDurationSec * width * height * fps;
    return (pixels / pixelsPerSec) * 1000;
  }

  /**
   * Say how the synthetic figure compares with what actually happened.
   *
   * The point is to learn whether the startup benchmark alone can carry the
   * estimate. If the two track each other, the recorded history can go and
   * every machine is right from its first second; if they do not, the log says
   * by how much and in which direction, which is the beginning of knowing why.
   *
   * @param {number} measuredMs
   * @returns {void}
   */
  #compareSyntheticWithMeasured(measuredMs) {
    const synthetic = this.syntheticFirstSegmentMs();
    if (synthetic === null) {
      return;
    }
    const ratio = measuredMs / synthetic;
    logger.info(
      `first-segment synthetic=${Math.round(synthetic)}ms measured=${Math.round(measuredMs)}ms ` +
      `ratio=${ratio.toFixed(2)} (1.00 would mean the startup benchmark alone suffices)`
    );
  }

  #rememberSessionCreateLatency(latencyMs) {
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
      return;
    }
    this.#sessionCreateLatencies.push(latencyMs);
    if (this.#sessionCreateLatencies.length > FIRST_SEGMENT_SAMPLES) {
      this.#sessionCreateLatencies.shift();
    }
    this.#saveHostTimings();
  }

  /**
   * What this host typically takes to create a session, in ms — the median of
   * recent ones, or null before any has finished.
   *
   * @returns {number | null}
   */
  expectedSessionCreateMs() {
    if (this.#sessionCreateLatencies.length === 0) {
      return null;
    }
    const sorted = [...this.#sessionCreateLatencies].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  }

  #rememberFirstSegmentLatency(latencyMs) {
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
      return;
    }
    this.#compareSyntheticWithMeasured(latencyMs);
    this.#firstSegmentLatencies.push(latencyMs);
    if (this.#firstSegmentLatencies.length > FIRST_SEGMENT_SAMPLES) {
      this.#firstSegmentLatencies.shift();
    }
    this.#saveHostTimings();
  }

  /**
   * What this host typically takes to produce a session's first segment, in
   * milliseconds — the median of recent runs, or null before any has finished.
   *
   * @returns {number | null}
   */
  expectedFirstSegmentMs() {
    if (this.#firstSegmentLatencies.length === 0) {
      // Nothing recorded yet — a machine's first run, or one whose history has
      // not been written. The startup benchmark answers without any history at
      // all, which is why the browser was showing an assumed rate here.
      return this.syntheticFirstSegmentMs();
    }
    const sorted = [...this.#firstSegmentLatencies].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /**
   * The highest segment index this session has on disk, or null when it has
   * none. Used to tell "the file ended" from "the data ran out".
   *
   * @param {HlsSession} session
   * @returns {number | null}
   */
  #latestProducedSegment(session) {
    let highest = null;
    for (const name of this.#runDirs(session).flatMap((dir) => {
      try { return readdirSync(dir, { withFileTypes: false }); } catch { return []; }
    })) {
      if (!this.segmentFormat.isSegmentFileName(name)) {
        continue;
      }
      const index = this.segmentFormat.segmentIndexFromName(name);
      if (index >= 0 && (highest === null || index > highest)) {
        highest = index;
      }
    }
    return highest;
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
   * @returns {Promise<HlsSession | null>} Null when the base session is unknown.
   */
  async getVariantSession(baseSessionId, height) {
    const base = this.sessionsById.get(baseSessionId);
    if (!base || base.state === "disposed") {
      return null;
    }
    if (!Number.isInteger(height) || height <= 0) {
      return null;
    }
    // Where the viewer is now, so a variant created mid-film starts there
    // rather than at the beginning.
    const processed = Number.isFinite(base.progress?.processedSeconds)
      ? base.progress.processedSeconds
      : 0;
    return this.createOrGetSession({
      sourceKey: base.sourceKey,
      fileIndex: base.fileIndex,
      transcodeVideo: true,
      transcodeAudio: base.transcodeAudio,
      fileName: base.fileName,
      targetWidth: 0,
      targetHeight: height,
      startPositionSeconds: processed,
      audioTrackIndex: base.audioTrackIndex,
      // A variant is a resolution the viewer chose, so it is encoded at exactly
      // that size and the realtime budget does not move it — otherwise two
      // variants could drift onto the same height and the choice would mean
      // nothing.
      manualQuality: true,
      segmentFormatId: base.segmentFormat?.id ?? "",
      acquireSource: base.acquireSource
    });
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
   * @param {string} sessionId
   * @returns {string | null} The playlist text, or null when there is nothing
   *   to choose between — a copied video, or a source too small to step down.
   */
  buildMasterPlaylist(sessionId) {
    const session = this.sessionsById.get(sessionId);
    if (!session || session.state === "disposed" || !session.transcodeVideo) {
      return null;
    }
    const sourceHeight = Number(session.sourceHeight) || 0;
    const rungs = variantHeightsFor(sourceHeight);
    if (rungs.length < 2) {
      return null;
    }
    const sourceWidth = Number(session.sourceWidth) || 0;
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
    for (const height of rungs) {
      const width = sourceHeight > 0 && sourceWidth > 0
        ? Math.round((sourceWidth / sourceHeight) * height / 2) * 2
        : 0;
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${estimatedBitrateFor(height)}` +
        (width > 0 ? `,RESOLUTION=${width}x${height}` : "")
      );
      // A subdirectory, so every relative name inside the variant's own
      // playlist — its segments and its init — resolves to that variant
      // without any of them having to change.
      lines.push(`v/${height}/${PLAYLIST_FILE_NAME}`);
    }
    return `${lines.join("\n")}\n`;
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
    const session = isSafeSessionId(sessionId) ? this.sessionsById.get(sessionId) : null;
    return session?.waitEpoch ?? 0;
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
    if (!isSafeSessionId(sessionId)) {
      return { kind: "not-found" };
    }
    const session = this.sessionsById.get(sessionId);
    // The session is looked up BEFORE the name is validated, because what
    // counts as a valid segment name depends on the container this session
    // chose — `.mp4` for fMP4, `.ts` for MPEG-TS.
    if (!session || !isSafeFileName(fileName, session.segmentFormat)) {
      return { kind: "not-found" };
    }
    if (session.state === "recovering") {
      // The data went away and is being fetched again. Holding the request is
      // the truthful answer: nothing is broken and there is nothing for the
      // viewer to retry.
      return { kind: "warming-up" };
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
        const bytes = session.usesExplicitCuts
          ? await this.#initFromFirstSegment(session)
          : await readFile((await this.#findProducedFile(session, initFileName)) ?? path.join(session.dirPath, initFileName));
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

    const filePath = (await this.#findProducedFile(session, fileName)) ?? path.join(session.dirPath, fileName);
    const isPlaylist = fileName === PLAYLIST_FILE_NAME;
    if (!isPlaylist) {
      // Where the viewer actually is. Recorded for every segment request,
      // served or not, because it is what bounds how far ahead the encoder is
      // allowed to run — see #enforceLookAhead.
      const requested = session.segmentFormat.segmentIndexFromName(fileName);
      if (requested >= 0) {
        session.lastRequestedSegment = requested;
        // A viewer who has caught up must not wait out the monitor's interval —
        // but only if they HAVE caught up, which is why this re-evaluates the
        // same condition instead of resuming outright.
        this.#enforceLookAheadFor(session);
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
      if (!isPlaylist && session.usesExplicitCuts) {
        const index = session.segmentFormat.segmentIndexFromName(fileName);
        const isLast = index >= Math.max(0, (session.segmentBoundaries?.length ?? 1) - 2);
        if (!isLast && session.ffmpeg) {
          const nextName = session.segmentFormat.segmentFileName(index + 1);
          const nextPath = (await this.#findProducedFile(session, nextName)) ?? path.join(session.dirPath, nextName);
          // The FIRST segment of a run cannot be judged by "the next one
          // exists": nothing is producing a next one yet, because the run has
          // only just begun here. Waiting for it holds precisely the segment a
          // resume depends on — measured 2026-08-09, #807 held while it lay on
          // disk, and in August the same shape held #317 for 46 s and then
          // answered 404 to a browser that had given up.
          //
          // What "finished" means for it is that the encoder has moved PAST the
          // end of its span. ffmpeg reports the output timestamp of its last
          // encoded frame, so a run whose position is beyond this segment's end
          // has necessarily closed it.
          const isRunStart = index === (session.encodeStartIndex ?? -1);
          const encoderPosition = Number(session.progress?.processedSeconds);
          const segmentEnd = this.#segmentStartTime(session, index + 1);
          if (isRunStart && Number.isFinite(encoderPosition) && encoderPosition > segmentEnd) {
            // Past its end — it is complete, whatever the directory says about
            // what comes next.
          } else {
          try {
            await access(nextPath);
          } catch {
            this.#explainHold(
              session,
              fileName,
              `it exists, but the next segment (#${index + 1}) has not been started yet`
            );
            return { kind: "warming-up" };
          }
          }
        }
      }
      // Cold-start: log the first servable SEGMENT of this session exactly once
      // — the time from session-create entry to a playable first segment.
      if (!isPlaylist && !session.firstSegmentLogged) {
        session.firstSegmentLogged = true;
        // Data is flowing again, so the next loss starts its backoff afresh
        // rather than inheriting the delay of the last one.
        session.inputRetryCount = 0;
        this.#rememberFirstSegmentLatency(Date.now() - session.createEntryMs);
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
        const bytes = session.usesExplicitCuts && session.segmentFormat.stripInit
          ? session.segmentFormat.stripInit(raw)
          : raw;
        // A segment that is short of a track is not servable, whatever the
        // directory says about it. A terminated run closes its current output
        // file properly — trailing index and all — but with only what had been
        // muxed by then, and after a seek-restart that is routinely one track
        // of two. The file exists and so does the next one, so the readiness
        // rule calls it done. Measured 2026-08-06: segment #133 held one track
        // where its neighbours held two, the proxy answered every request for
        // it in 98 ms, and the viewer's seek never completed. Treated as not
        // ready, so the encoder makes it again.
        if (
          typeof session.segmentFormat.hasEveryTrack === "function" &&
          !session.segmentFormat.hasEveryTrack(bytes, session.initBytes ?? null)
        ) {
          // Short of a track means one of two very different things, and the
          // first version of this check treated them alike — deleting the file
          // an encoder was writing INTO, so it went on writing to something
          // nobody could open and the segment never appeared. Measured
          // 2026-08-06: segment #225 was deleted 14 s into the run producing
          // it, and answered 404 thirty-three seconds later.
          //
          // The run that is producing this segment right now has simply not
          // finished it: wait, exactly as for a segment that does not exist
          // yet. Only a segment the CURRENT run has already moved past — the
          // next one exists, or no run is producing at all — is a leftover, and
          // only that one is worth removing so it can be made again.
          // Whose file is this? The current run writes from
          // `encodeStartIndex` upwards, so anything at or above that index
          // while the run is alive may simply be unfinished — the readiness
          // rule can wave it through on the strength of a NEXT segment left by
          // an older run, which is exactly how the file being written came to
          // be read. Anything below it, or any file at all once no run is
          // producing, belongs to a run that has ended.
          const stale = session.ffmpeg === null || index < (session.encodeStartIndex ?? 0);
          logger.warn(
            `transcode ${session.id} segment #${index} is short of a track — ` +
            (stale
              ? "left behind by a run that was terminated; producing it again"
              : "still being written; waiting for it")
          );
          if (stale) {
            try {
              await unlink(filePath);
            } catch {
              // Already gone, or being rewritten: either way nothing to do.
            }
          }
          return { kind: "warming-up" };
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
        const trueStart = session.usesExplicitCuts
          ? session.segmentFormat.readSegmentStartSeconds?.(raw) ?? null
          : null;
        const declaredStart = this.#segmentStartTime(session, index);
        if (trueStart !== null && Math.abs(trueStart - declaredStart) > SEGMENT_START_DISAGREEMENT_SEC) {
          logger.warn(
            `transcode ${session.id} segment #${index} really starts at ` +
            `${trueStart.toFixed(3)}s, the playlist says ${declaredStart.toFixed(3)}s — ` +
            "the container's keyframe index disagrees with the file; using the file"
          );
        }
        const prepared = session.segmentFormat.prepareSegmentBytes(bytes, {
          startSeconds: trueStart ?? declaredStart,
          initBytes: session.initBytes ?? null
        });
        return {
          kind: "file",
          stream: Readable.from([prepared]),
          contentType: session.segmentFormat.segmentContentType,
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
    logger.warn(
      `transcode ${session.id} holding ${fileName}: ${reason} ` +
      `(run from #${session.encodeStartIndex ?? "?"}, viewer at #${session.lastRequestedSegment ?? "?"}, ` +
      `encoder ${session.ffmpeg ? "alive" : "stopped"}, index #${index})`
    );
  }

  /**
   * The directories runs have written into, newest first.
   *
   * Runs used to share one directory, which is why a restart had to wait for
   * the previous ffmpeg to die: two processes writing `segment-00042.mp4` at
   * once produce a file that is neither. Measured 2.9.132, that wait was
   * 0.7-1.3 s of every seek and essentially the whole cost of a restart.
   * Given a directory each they cannot collide, so the new run starts at once
   * and the old one is left to die in the background.
   *
   * Newest first because a later run's answer for a segment supersedes an
   * earlier one's: the older file may be the truncated output of a run that was
   * killed mid-write, which is exactly what sharing a directory used to hide.
   *
   * @param {HlsSession} session
   * @returns {string[]}
   */
  #runDirs(session) {
    try {
      return readdirSync(session.dirPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
        .map((entry) => entry.name)
        .sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)))
        .map((name) => path.join(session.dirPath, name));
    } catch {
      return [];
    }
  }

  /**
   * Where a produced file actually is, or null when no run has written it.
   *
   * @param {HlsSession} session
   * @param {string} fileName
   * @returns {Promise<string | null>}
   */
  async #findProducedFile(session, fileName) {
    for (const dir of this.#runDirs(session)) {
      const candidate = path.join(dir, fileName);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Not this run's; try an older one.
      }
    }
    return null;
  }

  #holdForProduction(session, fileName, isPlaylist, options) {
    if (!isPlaylist) {
      this.#explainHold(session, fileName, "the file is not on disk");
    }
    // A segment was requested that ffmpeg has not produced yet.  Decide whether
    // to wait for the current encode run to reach it or to restart the encoder
    // at this position (server-side seeking).  The caller long-polls.
    if (!isPlaylist) {
      const requestedIndex = session.segmentFormat.segmentIndexFromName(fileName);
      this.#ensureEncodingFor(
        session,
        requestedIndex,
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
      // The height the viewer is WATCHING right now, which is what the menu
      // has to say next to "Auto". When the video is re-encoded that is the
      // rung the proxy has settled on — it steps down when the host cannot keep
      // up or the link cannot carry the stream. When the video is COPIED it is
      // the source's own height, and reporting zero there was simply wrong:
      // most sessions copy the video, so the menu read a bare "Auto" almost
      // always, which is exactly the question it was supposed to answer.
      currentHeight: session.transcodeVideo
        ? (session.encodeHeight ?? session.sourceHeight ?? 0)
        : (session.sourceHeight ?? 0),
      // What this host takes to create a session and to make a first segment.
      // Also on the playback plan, but the browser reads that once per file:
      // measured 2026-08-06 across four seeks, a proxy that had just restarted
      // answered null for both, and every later seek then computed its estimate
      // with one term of four — the figure hit zero after 3.5 s of an 11.8 s
      // wait and read "starting now" for the remaining 8.4 s. This response is
      // polled about every 1.5 s, so carrying them here keeps them current.
      expectedSessionCreateMs: this.expectedSessionCreateMs(),
      expectedFirstSegmentMs: this.expectedFirstSegmentMs(),
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

    // Let go of the source. While a session exists its torrent must survive
    // both cleanups the pool runs, and until now neither knew about it: the
    // only claim on a file is taken by a READ, and during a seek there is no
    // read at all — the old encoder is dead and the new one has not started.
    // Field 2026-08-06, that window met the thirty-second disk sweep and the
    // film being watched was evicted mid-seek, six gigabytes deleted, after
    // which the new encoder had nothing to read. The session's own thirty
    // minutes governed the session, never the data under it.
    if (typeof session.releaseSource === "function") {
      try {
        session.releaseSource();
      } catch {
        // Best effort — a session must always finish being disposed.
      }
      session.releaseSource = null;
    }

    // Clear any pending seek-settle timer so it cannot fire and restart a
    // disposed session.
    if (session.seekSettleTimer) {
      clearTimeout(session.seekSettleTimer);
      session.seekSettleTimer = null;
    }
    if (session.inputRetryTimer) {
      clearTimeout(session.inputRetryTimer);
      session.inputRetryTimer = null;
    }

    this.#resumeEncoder(session, "session disposed");
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
