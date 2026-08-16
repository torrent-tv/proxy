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
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { logger } from "../utils/logger.js";
import { readKeyframeIndex } from "./container-index/index.js";
import { readMachineState, readProcessCpuSeconds, readProxyCpuSeconds, readSystemCpu, shareOfMachine } from "./host-load.js";

/** Own package version, stamped onto session-start log lines. */
const PROXY_VERSION = createRequire(import.meta.url)("../package.json").version;
import {
  softwareDescriptor,
  chooseSoftwareEncodeSettings,
  pickSoftwarePreset,
  canSustainOutput,
  REALTIME_SPEED_MARGIN,
  TRANSCODE_FPS,
  chooseOutputFps
} from "./hwaccel.js";
import {
  parseFfmpegBitrateKbps,
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
// The index of variants. Served from the same route as the media playlist, so
// it needs no path of its own.
const MASTER_PLAYLIST_FILE_NAME = "master.m3u8";
// Path prefix under a session for one of its variants: `v/<height>/<file>`. A
// directory level, so every relative name inside a variant's own playlist — its
// segments and its init — resolves to that variant without any of them changing.
const VARIANT_PATH_PREFIX = "v";
// Where an audio rendition lives, and the name the variants refer to it by. One
// directory level under the base session, exactly as a quality variant is, so
// every relative name inside its playlist resolves to it unchanged.
const AUDIO_PATH_PREFIX = "a";
const AUDIO_GROUP_ID = "aud";

/**
 * Quote a value for an HLS attribute list. Only the quote itself can end the
 * attribute early, and a track title comes from the file, so it is not ours to
 * trust.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeAttribute(value) {
  // The quote would end the attribute early; a line break would end the LINE,
  // splitting one `#EXT-X-MEDIA` into two and corrupting the master. Both come
  // from the file's own metadata, which is not ours to trust.
  return String(value ?? "").replace(/"/g, "'").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

// ISO 639-2 codes as ffmpeg reports them, against the RFC 5646 tags HLS asks
// for. Only the languages this serves in practice; anything else is passed
// through, which is what players other than iOS accept anyway.
const LANGUAGE_TAGS = new Map([
  ["rus", "ru"], ["eng", "en"], ["ukr", "uk"], ["deu", "de"], ["ger", "de"],
  ["fra", "fr"], ["fre", "fr"], ["spa", "es"], ["ita", "it"], ["jpn", "ja"],
  ["kor", "ko"], ["zho", "zh"], ["chi", "zh"], ["pol", "pl"], ["por", "pt"],
  ["tur", "tr"], ["ces", "cs"], ["cze", "cs"], ["nld", "nl"], ["dut", "nl"]
]);

/**
 * The RFC 5646 tag for a language ffmpeg named, or the name unchanged.
 *
 * @param {string} language
 * @returns {string}
 */
function languageTag(language) {
  const code = String(language ?? "").toLowerCase();
  return LANGUAGE_TAGS.get(code) ?? code;
}
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
 * What a source costs to DECODE, in the two figures the startup fit prices:
 * its pixel rate and its bitrate. Every re-encode of this file pays this,
 * whatever height it is encoded to, because the whole source is decoded first.
 *
 * Returns null when the probe did not report enough — the budget then prices
 * the encoder alone rather than inventing a figure.
 *
 * @param {{ width: number | null, height: number | null, fps: number | null, bitrateKbps: number | null }} mediaInfo
 * @returns {{ megapixelsPerSecond: number, megabitsPerSecond: number } | null}
 */
export function sourceDecodeCharacteristics(mediaInfo) {
  const width = Number(mediaInfo?.width);
  const height = Number(mediaInfo?.height);
  const fps = Number(mediaInfo?.fps);
  const kbps = Number(mediaInfo?.bitrateKbps);
  if (!(width > 0) || !(height > 0) || !(fps > 0) || !(kbps > 0)) {
    return null;
  }
  return {
    megapixelsPerSecond: (width * height * fps) / 1e6,
    megabitsPerSecond: kbps / 1000
  };
}

/**
 * A fresh tally of how well a container's keyframe index matches its file.
 *
 * @returns {{ checked: number, disagreed: number, maxDeviationSec: number, firstDisagreementIndex: number, seen: Set<number> }}
 */
export function newIndexCheck() {
  return {
    checked: 0,
    disagreed: 0,
    maxDeviationSec: 0,
    firstDisagreementIndex: -1,
    // Which boundaries have been counted. A segment can be requested again, and
    // a repeat is the same boundary, not new evidence.
    seen: new Set()
  };
}

/**
 * Add one produced segment's deviation to the tally.
 *
 * @param {ReturnType<typeof newIndexCheck>} check
 * @param {number} index - Segment index, so a repeat can be recognised.
 * @param {number} deviationSec - How far the piece's own start fell from the
 *   start the playlist declared for it.
 * @returns {void}
 */
export function noteIndexDeviation(check, index, deviationSec) {
  if (check.seen.has(index)) {
    return;
  }
  check.seen.add(index);
  check.checked += 1;
  if (deviationSec > SEGMENT_START_DISAGREEMENT_SEC) {
    check.disagreed += 1;
    if (check.firstDisagreementIndex < 0) {
      check.firstDisagreementIndex = index;
    }
  }
  if (deviationSec > check.maxDeviationSec) {
    check.maxDeviationSec = deviationSec;
  }
}

/**
 * The same budget, starting at the top of its own ladder.
 *
 * The automatic choice takes the highest rung this host can encode faster than
 * realtime. A viewer who names a resolution has already made that choice, so
 * the encode starts where they said — and the ladder stays, because a host that
 * turns out unable to keep up must still have somewhere to go.
 *
 * @param {{ ladder: { width: number, height: number }[], rungIndex: number } | null} budget
 * @param {number} outputFps
 * @param {unknown} benchmark
 * @param {{ decodeModel?: object | null, source?: { megapixelsPerSecond: number, megabitsPerSecond: number } | null }} [cost]
 * @returns {object | null}
 */
function startAtLadderTop(budget, outputFps, benchmark, cost = {}) {
  const ladder = budget?.ladder;
  const top = ladder?.[0];
  if (!top) {
    return null;
  }
  const fps = Number.isInteger(outputFps) && outputFps > 0 ? outputFps : TRANSCODE_FPS;
  // The top rung the viewer asked for, unless this host cannot hold it. A
  // request naming a height arrives from a browser that was told which heights
  // are on offer — but an older page, a stale tab or a repeated URL can still
  // name one that was refused, and starting there means the encode never
  // catches up. The runtime downshift would eventually step down; starting
  // where the host can hold it means the viewer does not watch that happen.
  // When NOTHING on the ladder can be held, start at its foot — the smallest
  // picture this host has, which is the automatic path's answer to the same
  // question and the best effort available. Starting at the top instead would
  // hand the weakest hosts, the ones this exists for, the heaviest rung.
  let startIndex = ladder.length - 1;
  for (let index = 0; index < ladder.length; index += 1) {
    const { sustainable } = canSustainOutput({
      benchmark,
      decodeModel: cost.decodeModel ?? null,
      source: cost.source ?? null,
      outputPixelsPerSec: ladder[index].width * ladder[index].height * fps,
      observedDecodeCostSec: cost.observedDecodeCostSec ?? null
    });
    if (sustainable) {
      startIndex = index;
      break;
    }
  }
  const start = ladder[startIndex];
  return {
    ...budget,
    width: start.width,
    height: start.height,
    // Priced the same way the offer was. Without the cost the preset came from
    // the encoder alone — so a rung offered on the combined figure was then
    // encoded with a preset chosen as if decoding were free, which is how the
    // check and the encode came to disagree on every rung a viewer picks.
    preset: pickSoftwarePreset(benchmark, start.width * start.height * fps, cost),
    rungIndex: startIndex
  };
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
function variantConsumerId(baseSessionId) {
  return `variant-of:${baseSessionId}`;
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
// How old a viewer's link report may be and still describe where they are. It
// is sent every 10 s, and a seek in between moves them somewhere this cannot
// predict — so anything older is treated as no report at all.
const NET_REPORT_FRESH_MS = 15_000;
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
// How long a segment BELOW the running encode's start may go unanswered before
// the encoder is moved back to it. Long enough that a burst around a reported
// seek settles on its own — the seek is what should move the encoder — and
// short enough that a session cannot sit on an unanswerable request, which
// measured two minutes forty-one before a viewer gave up.
// A request behind the run is acted on once it has been REPEATED, not once it
// has waited: repetition is the player saying it still needs this exact
// segment, while a delay only says time has passed. The floor below stays as a
// last guard against acting on a single stray poll.
const BEHIND_HEAD_REPAIR_MIN_ASKS = 2;
// More distinct indices than this behind the head at once is the player
// scanning the playlist rather than waiting for a frame.
const BEHIND_HEAD_SCAN_INDICES = 3;
// The window the count above is taken over. A player's scan lands inside half a
// second (field log 2026-08-02); a viewer waiting asks every few seconds.
const BEHIND_HEAD_SCAN_WINDOW_MS = 2_000;
const BEHIND_HEAD_REPAIR_MS = 400;
// How far behind the run a request may be and still be treated as the encoder
// standing in the wrong place rather than as a player scanning the playlist. A
// misplaced run is out by at most the buffer the player was holding — measured
// 2026-08-11 at 14 segments — while a scan probe is out by anything at all.
// Generous against that measurement, and far short of the hundreds of segments
// a scan reaches.
const BEHIND_HEAD_REPAIR_MAX_SEGMENTS = 60;
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
/** Below this, a tick has not moved enough of the torrent to price it. */
const TORRENT_COST_MIN_MEGABYTES = 2;
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
// How long an encode run must have been going before a reading of its speed is
// taken as evidence about decoding. `speed=` is cumulative over the run, so a
// restart after a seek, a resume after a suspension and the wait for the first
// pieces all sit in the denominator of an early reading.
const DECODE_LEARNING_SETTLE_MS = 20_000;
// How many readings the median is taken over. Long enough to outvote a single
// disturbed moment, short enough to follow a host whose load has changed.
const DECODE_LEARNING_READINGS = 7;
// A new median has to differ by this much to be adopted. Below it the answer is
// the same one, and re-publishing it would make every session recompute its
// offer on the path that serves every playlist, init and segment.
const DECODE_LEARNING_CHANGE = 0.05;
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
        bitrateKbps: parseFfmpegBitrateKbps(stderr),
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
 * Which grid applies is NOT the same question as whether the video is copied.
 * A copy has no choice — it can only be cut where the source already has a
 * keyframe. A re-encode normally takes the even grid, because it is producing
 * every frame and may put keyframes where it likes; but when it has to be
 * INTERCHANGEABLE with a copy — a quality variant of one — it takes the
 * source's grid instead and forces its keyframes onto it. So the caller says
 * which grid, and this stopped asking whether the video is re-encoded.
 *
 * @param {{ useKeyframeGrid: boolean, durationSeconds: number, segDur: number, keyframeTimes: number[] | null, startTime: number }} params
 * @returns {number[]}
 */
export function computeSegmentBoundaries({ useKeyframeGrid, durationSeconds, segDur, keyframeTimes, startTime }) {
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
  if (!useKeyframeGrid || !Array.isArray(keyframeTimes) || keyframeTimes.length === 0 || total <= 0) {
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
    // Both take the same list, and a keyframe-grid variant passes it twice.
    // `-force_key_frames` also takes an expression, which is short and is left
    // alone — only a list is folded.
    if (
      (value === "-segment_times" || value === "-force_key_frames") &&
      typeof args[index + 1] === "string" &&
      args[index + 1].includes(",")
    ) {
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
/**
 * How many megabytes a second of this source is, from what the probe read.
 *
 * A viewer consumes the file at its own rate, so this is also the rate at which
 * the machine must fetch, verify and deliver it while they watch.
 *
 * @param {HlsSession} session
 * @returns {number | null}
 */
function sourceMegabytesPerSecond(session) {
  const megabitsPerSecond = Number(session.sourceDecode?.megabitsPerSecond);
  if (!Number.isFinite(megabitsPerSecond) || megabitsPerSecond <= 0) {
    return null;
  }
  return megabitsPerSecond / 8;
}

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
   * What decoding costs for a source this proxy has actually run, keyed by
   * `sourceKey:fileIndex` — seconds of work per second of video, with a version
   * that rises whenever a faster reading replaces the one held.
   *
   * The startup clips are H.264 and a source that has to be re-encoded usually
   * is not, so their model is a first approximation. This is the file itself,
   * measured by the encoder that is running on it, and it replaces the model
   * for that file as soon as it exists. Held for the life of the process: it
   * describes a source, and the same source is commonly opened again.
   *
   * @type {Map<string, { costSec: number, version: number }>}
   */
  #observedDecodeCost = new Map();
  /**
   * What copying costs, per source file, learned the same way: `key ->
   * { costSec, readings, version }`. A copy is what runs BESIDE a rung being
   * warmed, and pricing it at nothing is what let a host be told it had a whole
   * machine for the rung.
   *
   * @type {Map<string, { costSec: number, readings: number[], version: number }>}
   */
  #observedCopyCost = new Map();
  /** The previous reading of the machine, to compare the next one against. */
  #hostLoadSample = null;
  /** The previous reading taken while nothing was encoding, for the torrent's own cost. */
  #idleLoadSample = null;
  /** Seconds of this process's CPU per megabyte the torrent moves, once measured. */
  #observedTorrentCostPerMegabyte = null;
  /** @type {number[]} Recent readings behind that median. */
  #torrentCostReadings = [];

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
    decodeCostModel = null,
    getSourceStats = null,
    tonemapSupported = false,
    getCachedMediaInfo = null,
    getCachedAudioTracks = null,
    segmentFormatId = undefined,
    stateDir = "",
    getTorrentTotals}) {
    this.enabled = Boolean(enabled);
    this.ffmpegBin = ffmpegBin;
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
    // Optional async accessor for a source's live download stats, used by the
    // realtime budget to tell a CPU limit from a download-starved input:
    // (sourceKey, fileIndex) => Promise<{ downloadSpeed, fileLength, fileProgress } | null>.
    this.getSourceStats = typeof getSourceStats === "function" ? getSourceStats : null;
    // Totals across every torrent this proxy holds, used to price what the
    // torrent itself costs the machine (item 7). Optional: a proxy wired
    // without it simply never learns that figure.
    this.getTorrentTotals = typeof getTorrentTotals === "function" ? getTorrentTotals : null;
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
      // What the output CARRIES. A picture without its audio, a single audio
      // track without a picture, and the two muxed together are three different
      // encodes of the same file, and nothing about them is interchangeable —
      // so they cannot share a session, a directory or an encoder.
      audioOnly === true ? "audio-only" : (audioRenditions === true ? "video-only" : "muxed"),
      String(normalizedStartPosition),
      // Two viewers asking for different containers cannot share one ffmpeg.
      segmentFormat.id,
      // A re-encoded session is NOT shared between viewers, because a quality
      // change acts on the session: it stops the encoder of the rung being left
      // and repositions the one being joined. Shared, one viewer's change would
      // stop the stream the other is watching, and that viewer's seek would
      // then be forwarded to a variant they never asked for. Sharing here was
      // always narrow — it needs two viewers to open the same file, at the same
      // size, within the same ten seconds — and a shared seek already dragged
      // both of them. Restoring it needs the active variant to be tracked per
      // consumer rather than per session, which is a change to three routes and
      // the variant path; recorded in the roadmap, not attempted here.
      transcodeVideo ? consumerId : "",
      // Two sessions at the same height cut on different grids are different
      // streams: one of them can be spliced into a copy of this file and the
      // other cannot.
      inheritedGrid ? "grid-keyframe" : "grid-own"
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
    // Which container supplied the index, carried so the accuracy summary can
    // say what it is a summary OF.
    let containerFormat = "";
    // A quality variant of a session whose cuts are the source's keyframes must
    // be cut at exactly those same times, or its segments cannot stand where
    // the other's would have. The grid arrives with the request rather than
    // being worked out again: it is the same file, so a second reading could
    // only agree — or, if the index were read differently, disagree silently.
    if (inheritedGrid) {
      keyframeTimes = inheritedGrid.keyframeTimes;
      containerFormat = inheritedGrid.containerFormat ?? "";
    } else if (hasDuration && !transcodeVideo && !audioOnly) {
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
      const index = await this.#readContainerKeyframes({ sourceKey, fileIndex, inputUrl, logName });
      keyframeTimes = index.times;
      containerFormat = index.format;
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
      Array.isArray(keyframeTimes) &&
      keyframeTimes.length > 0 &&
      (audioOnly ? inheritedGrid != null : (!transcodeVideo || inheritedGrid != null));
    // A rung takes the grid it was handed, rather than working one out again
    // from the same index. The two are not the same table: the one it is handed
    // has been CORRECTED wherever a produced segment showed the index to be
    // wrong, and it is those corrected times the copy actually cuts at. Building
    // it afresh here would put the rung back on the index's fiction and undo the
    // alignment it exists for.
    const segmentBoundaries = Array.isArray(inheritedGrid?.boundaries) && inheritedGrid.boundaries.length > 1
      ? [...inheritedGrid.boundaries]
      : (hasDuration
        ? computeSegmentBoundaries({
            useKeyframeGrid,
            durationSeconds,
            segDur: this.segmentDurationSec,
            keyframeTimes,
            startTime: sourceStartTime
          })
        : []);
    const usingKeyframeBoundaries = useKeyframeGrid;
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
    // What decoding this source costs, which every re-encode pays on top of
    // the encoder. Read from the probe; null when it did not say enough.
    const sourceDecode = sourceDecodeCharacteristics(mediaInfo);
    const chosenBudget = this.#chooseEncodeBudget({
      transcodeVideo,
      targetWidth: normalizedTargetWidth,
      targetHeight: normalizedTargetHeight,
      sourceWidth,
      sourceHeight,
      outputFps,
      source: sourceDecode
    });
    // A forced resolution starts at exactly that size — the viewer asked for it
    // — but KEEPS the ladder beneath it. Discarding the ladder is what left a
    // viewer with no picture at all on 2026-08-11: they picked 480p on a host
    // that encodes it at 0.27-0.78x, and with the runtime downshift disabled
    // nothing could step in, so the stream simply never caught up. A smaller
    // picture that plays beats a correct label that freezes. The rung's NAME is
    // settled separately and does not move with a downshift, so the player goes
    // on addressing it by the height it chose.
    const encodeBudget = forceManualQuality
      ? startAtLadderTop(chosenBudget, outputFps, this.softwarePresetBenchmark, {
          decodeModel: this.decodeCostModel,
          source: sourceDecode,
          observedDecodeCostSec: this.#observedDecodeCost.get(`${sourceKey}:${fileIndex}`)?.costSec ?? null
        })
      : chosenBudget;
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
      // What this session's output carries. `audioOnly` is a rendition — one
      // audio track, no picture; `videoOnly` is a stream whose audio the viewer
      // takes from such a rendition. Neither is set on the ordinary muxed
      // session, which is what every browser gets until it says otherwise.
      audioOnly: audioOnly === true,
      audioRenditions: audioRenditions === true,
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
      // The NAME of this rung, fixed at the height that was asked for. It is
      // deliberately not the height being encoded: a viewer who picked 480p on
      // a host that then starts them at 360p, or steps down to it later, goes
      // on addressing the rung as 480p — and a request under the old name must
      // not build a second session at a height this host has just refused.
      // Derived from `encodeHeight` when nothing was named, as before.
      variantHeight: forceManualQuality && normalizedTargetHeight > 0
        ? normalizedTargetHeight
        : undefined,
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
      // Pixel rate and bitrate of the source, for pricing a re-encode of it.
      sourceDecode,
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
      // Segment start times (0-based). The source's real keyframes when this
      // session is cut on that grid — always for copied video, and for a
      // re-encoded variant of such a session — otherwise a uniform grid.
      // Drives the playlist and seeking.
      segmentBoundaries,
      // Which of the two it is, as a fact about the session rather than
      // something re-derived from "is the video copied" at each call site. The
      // two questions came apart the moment a re-encode had to be cut like a
      // copy.
      cutGrid: useKeyframeGrid ? "keyframe" : "uniform",
      segmentCount,
      // Real source keyframe times (sorted seconds), or null when the probe
      // failed/timed out. Used by #startEncodeRun to snap a source seek onto a
      // KNOWN valid position instead of trusting the container's own on-the-fly
      // seek at an arbitrary target — see the probe call above for why.
      keyframeTimes,
      // Which container the index came from, and how well it has held up. The
      // cut times of a copied video ARE its index, and an index can be wrong —
      // measured 2026-08-06, one claimed a keyframe four seconds from where the
      // real ones were. Each produced segment states where it truly begins, so
      // the comparison costs a subtraction on a piece that is already being
      // read; this counts them so a session can report what it found. It is
      // what decides whether a re-encoded rung can be cut on this same grid and
      // spliced into the copy (roadmap item 28).
      containerFormat,
      indexCheck: newIndexCheck(),
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
    // Settled ONCE, here, and never derived again. Whether the audio travels
    // separately decides the ffmpeg arguments, what the master says and whether
    // the rendition route answers at all, and those three must agree for the
    // whole life of the session — a session whose picture was encoded without
    // audio cannot start muxing it in at the next restart without either
    // playing it twice or refusing the append.
    //
    // It cannot be answered before this point (it asks what heights this
    // session will be offered at, which needs the record) and it must not be
    // asked after it, because the answer moves: the offered list is recomputed
    // as the host learns what this source costs, and crossing "two rungs" would
    // flip the arrangement under a stream that is playing.
    session.audioSeparate = inheritedAudioSeparate === null
      ? audioRenditions === true &&
        this.#variantHeights(session).length >= 2 &&
        this.#audioRenditionsOf(session).length > 0
      : inheritedAudioSeparate === true;

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
        `${transcodeVideo && encodeBudget
          ? `enc=${encodeWidth}x${encodeHeight}@${outputFps} ` +
            `quality=${forceManualQuality ? "manual" : "auto"} ` +
            `budget=${encodeBudget.ladder ? `rung ${encodeBudget.rungIndex + 1}/${encodeBudget.ladder.length}` : "off"} `
          : ""}` +
        `${transcodeVideo && !encodeBudget && forceManualQuality ? `enc=${encodeWidth || "src"}x${encodeHeight || "src"}@${outputFps} quality=manual budget=off ` : ""}` +
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
    // What the SOURCE has, narrowed to what this session's output carries. A
    // rendition maps only audio and a stream whose audio travels separately
    // maps only video, so answering from the source alone would tell the
    // browser about a track that is not in the stream, and would leave
    // `#initFromFirstSegment` waiting for a second track that no init will ever
    // declare — its warning about a short header would then fire on every one.
    const carriesVideo = session.audioOnly !== true;
    const carriesAudio = !this.#servesAudioSeparately(session);
    return {
      video: carriesVideo && Boolean(probed?.videoCodec),
      audio: carriesAudio && Boolean(probed?.audioCodec)
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

  /**
   * The file's keyframe times from its container index, and which container it
   * turned out to be.
   *
   * @returns {Promise<{ times: number[] | null, format: string }>}
   */
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
      return { times: null, format: "unknown" };
    }
    if (fileSize <= 0) {
      return { times: null, format: "unknown" };
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

    const result = await readKeyframeIndex({ readRange, fileSize, label: logName });
    this.keyframeIndexCache.set(cacheKey, result);
    return result;
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
   * @param {{ transcodeVideo: boolean, targetWidth: number, targetHeight: number, sourceWidth: number | null, sourceHeight: number | null, outputFps: number, source?: { megapixelsPerSecond: number, megabitsPerSecond: number } | null }} params
   * @returns {{ width: number, height: number, preset: string } | null}
   */
  #chooseEncodeBudget({ transcodeVideo, targetWidth, targetHeight, sourceWidth, sourceHeight, outputFps, source = null }) {
    if (!transcodeVideo || this.videoEncoder?.kind !== "software" || !this.softwarePresetBenchmark) {
      return null;
    }
    const ceiling = computeOutputDimensions(targetWidth, targetHeight, sourceWidth, sourceHeight);
    if (!ceiling) {
      return null;
    }
    return chooseSoftwareEncodeSettings(
      this.softwarePresetBenchmark,
      { width: ceiling.w, height: ceiling.h },
      outputFps,
      { decodeModel: this.decodeCostModel, source }
    );
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
    const named = this.sessionsById.get(sessionId);
    if (!named || named.state === "disposed") {
      return false;
    }
    // The link carries the stream on screen, so the report belongs to the
    // variant producing it — that is the encoder whose bitrate it can bound.
    this.#activeVariant(named).netReport = { linkMbps, bufferedAheadSec, at: Date.now() };
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
    // Shared between the readers this file already has. The window is stated in
    // seconds of playback and the store's memory is one budget for the whole
    // torrent, so N readers asking for thirty seconds each ask for N times what
    // was provided for — and on 2026-08-15 that is exactly what happened: a
    // viewer with a picture and an audio track had every resident piece held at
    // once, a read ended with zero bytes, and every encoder on the file took
    // that for the end of it.
    //
    // Dividing keeps the promise the budget was written against. It is not the
    // sliding window of roadmap item 8 — pieces still leave only by the store's
    // own eviction — but it removes the multiplication that broke it.
    const readers = Math.max(1, this.#readersOn(sourceKey, fileIndex));
    const wanted = Math.round((bytesPerSecond * READ_WINDOW_SECONDS) / readers);
    return Math.min(READ_WINDOW_MAX_BYTES, Math.max(READ_WINDOW_MIN_BYTES, wanted));
  }

  /**
   * How many live sessions read this file: the picture, any rung being warmed
   * beside it, and any audio track published on its own.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {number}
   */
  #readersOn(sourceKey, fileIndex) {
    let readers = 0;
    for (const session of this.sessionsById.values()) {
      if (session?.sourceKey === sourceKey &&
          session.fileIndex === fileIndex &&
          session.state !== "disposed") {
        readers += 1;
      }
    }
    return readers;
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
  /**
   * What the torrent itself costs this machine, per megabyte it moves.
   *
   * Downloading, verifying every piece and pushing segments down a data channel
   * are work on the same box as the encoder, they scale with the file's own
   * bitrate, and the budget counts none of it. Measured on the addon host with
   * every encoder suspended, the machine was still 20-29 % busy.
   *
   * Taken only while NOTHING is encoding, because that is the only moment the
   * spending can be attributed without arithmetic: what this process uses then
   * is the torrent's.
   */
  async #learnTorrentCost() {
    const now = {
      takenAt: Date.now(),
      cpuSeconds: readProxyCpuSeconds(),
      bytes: await this.#torrentBytesMoved()
    };
    const previous = this.#idleLoadSample;
    this.#idleLoadSample = now;
    if (previous === null || now.bytes === null || previous.bytes === null) {
      return;
    }
    const elapsedSec = (now.takenAt - previous.takenAt) / 1000;
    const megabytes = (now.bytes - previous.bytes) / 1e6;
    const cpuSeconds = now.cpuSeconds - previous.cpuSeconds;
    // Enough movement to divide by: a tick with almost nothing downloaded
    // measures the idle loop, not the torrent.
    if (!(elapsedSec > 0) || !(megabytes >= TORRENT_COST_MIN_MEGABYTES) || !(cpuSeconds > 0)) {
      return;
    }
    const costPerMegabyte = cpuSeconds / megabytes;
    const readings = [...this.#torrentCostReadings, costPerMegabyte].slice(-DECODE_LEARNING_READINGS);
    this.#torrentCostReadings = readings;
    const sorted = [...readings].sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (this.#observedTorrentCostPerMegabyte !== null &&
        Math.abs(median - this.#observedTorrentCostPerMegabyte) / this.#observedTorrentCostPerMegabyte < DECODE_LEARNING_CHANGE) {
      return;
    }
    this.#observedTorrentCostPerMegabyte = median;
    logger.info(
      `host-load: the torrent costs ${(median * 1000).toFixed(1)}ms of CPU per MB on this host ` +
      `(median of ${readings.length}, latest ${(costPerMegabyte * 1000).toFixed(1)}ms over ${megabytes.toFixed(1)}MB)`
    );
  }

  /**
   * Bytes this proxy's torrents have moved in total, or null when it cannot be
   * asked.
   *
   * @returns {Promise<number | null>}
   */
  async #torrentBytesMoved() {
    if (typeof this.getTorrentTotals !== "function") {
      return null;
    }
    try {
      const totals = await this.getTorrentTotals();
      const moved = Number(totals?.bytesMoved);
      return Number.isFinite(moved) ? moved : null;
    } catch {
      return null; // the pool is busy or gone; a reading missed is not a fault
    }
  }

  async #reportHostLoad() {
    const encoding = [...this.sessionsById.values()].filter(
      (session) => session?.ffmpeg != null && !hasChildExited(session.ffmpeg) && session.state !== "disposed"
    );
    if (encoding.length === 0) {
      // Nothing is encoding, which is the ONLY moment the torrent's own cost
      // can be attributed cleanly: whatever this process spends now is the
      // download, the hashing, the piece store and the delivery. Item 7.
      await this.#learnTorrentCost();
      this.#hostLoadSample = null;
      return;
    }
    this.#idleLoadSample = null;
    // EVERY encoder, added up. One of them is meaningless on a host that runs a
    // picture and an audio track at once, and picking the first would have
    // reported whichever the map happened to hold.
    // Kept per PROCESS, not as one total. The set changes between readings —
    // a seek kills ffmpeg and starts another with a new pid whose counter
    // begins at zero, a session ends, a rendition begins — and subtracting one
    // total from another across a changed set produces nonsense: a restart
    // alone would print something like `ffmpeg=-598%`. Only pids present in
    // BOTH readings are counted, so a process that came or went contributes
    // nothing rather than a lie.
    const pids = encoding.map((session) => session.ffmpeg?.pid ?? null).filter((pid) => pid !== null);
    const [system, ...cpuReadings] = await Promise.all([
      readSystemCpu(),
      ...pids.map((pid) => readProcessCpuSeconds(pid))
    ]);
    /** @type {Map<number, number>} */
    const byPid = new Map();
    pids.forEach((pid, index) => {
      const seconds = cpuReadings[index];
      if (seconds !== null) {
        byPid.set(pid, seconds);
      }
    });
    const sample = {
      takenAt: Date.now(),
      byPid,
      system,
      // The proxy's own CPU, across every thread: the torrent, the hashing, the
      // piece store and the delivery. None of it is in the encode budget, and
      // on the addon host it is most of what the machine does while encoders
      // are suspended.
      proxyCpuSeconds: readProxyCpuSeconds()
    };
    const previous = this.#hostLoadSample;
    this.#hostLoadSample = sample;
    if (previous === null) {
      return; // the first reading is only something to compare against
    }
    // Summed over the pids both readings hold, so nothing is measured against a
    // process that was not there before. Unknown stays unknown: on a host with
    // no `/proc` there are no readings at all, and the share is null rather
    // than a confident zero.
    let encoderDelta = null;
    for (const [pid, seconds] of sample.byPid) {
      const before = previous.byPid?.get(pid);
      if (before !== undefined && seconds >= before) {
        encoderDelta = (encoderDelta ?? 0) + (seconds - before);
      }
    }
    const share = shareOfMachine(
      { takenAt: previous.takenAt, processCpuSeconds: encoderDelta === null ? null : 0, system: previous.system },
      { takenAt: sample.takenAt, processCpuSeconds: encoderDelta, system: sample.system }
    );
    if (share === null) {
      return;
    }
    // How many of them are stopped by the look-ahead cap. Without this a zero
    // share reads as an encoder being starved of the machine, when it is an
    // encoder deliberately not running — which is what the first readings on
    // the addon host actually were (2026-08-15: `ffmpeg=0% system=24%`, both
    // encoders suspended, and the speed beside it a stale figure from before
    // they stopped).
    const suspended = encoding.filter((session) => session.encoderPaused === true).length;
    const running = encoding.length - suspended;
    const machine = await readMachineState();
    const asPercent = (value) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
    const cores = Math.max(1, os.cpus().length);
    const proxyShare = Number.isFinite(previous.proxyCpuSeconds)
      ? (sample.proxyCpuSeconds - previous.proxyCpuSeconds) / (share.elapsedSec * cores)
      : null;
    logger.info(
      `host-load: ffmpeg=${asPercent(share.processShare)} proxy=${asPercent(proxyShare)} ` +
      `system=${asPercent(share.systemShare)} ` +
      `iowait=${asPercent(share.iowaitShare)} cpu=${machine.megahertz === null ? "n/a" : `${machine.megahertz}MHz`} ` +
      `temp=${machine.celsius === null ? "n/a" : `${machine.celsius}C`} ` +
      `encoders=${running} running` + (suspended > 0 ? ` +${suspended} suspended` : "") +
      ` over=${share.elapsedSec.toFixed(1)}s`
    );
  }

  async #enforceRealtimeBudget() {
    void this.#reportHostLoad();
    if (this.videoEncoder?.kind !== "software") {
      return;
    }
    // One tick at a time. It awaits torrent statistics per session now, so a
    // slow or stuck answer would otherwise let the next tick in behind it —
    // two passes over the same sessions, taking the same reading twice and
    // acting on the same speed twice.
    if (this.budgetTickRunning === true) {
      return;
    }
    this.budgetTickRunning = true;
    try {
      await this.#realtimeBudgetPass();
    } finally {
      this.budgetTickRunning = false;
    }
  }

  /** One pass over the sessions. See `#enforceRealtimeBudget`. */
  async #realtimeBudgetPass() {
    const now = Date.now();
    for (const session of this.sessionsById.values()) {
      // What this file costs to decode is learned from EVERY encoding session,
      // before any of the budget's own conditions are consulted. Those exist to
      // decide whether to step the quality down, and they exclude most of what
      // is worth measuring: a rung already at the foot of its ladder has
      // nowhere to step, and a 240p variant IS its whole ladder — which is
      // exactly the rung the field measured at 0.95x on 2026-08-15, learning
      // nothing from three minutes of it because the loop had already skipped
      // the session as un-actionable.
      await this.#learnFromEncoder(session);
      if (
        !session ||
        session.state === "disposed" ||
        session.state === "failed" ||
        !session.transcodeVideo ||
        // Nothing is encoding, so there is no speed to judge. A variant the
        // viewer has switched away from is left in exactly this state, and its
        // last recorded speed would otherwise buy it a downshift — which
        // restarts the encoder it was just stopped for.
        !session.ffmpeg ||
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
    // Priced the same way the offer and the starting rung are. Choosing the
    // preset on the encoder alone treats decoding as free, which is how the
    // check and the encode came to disagree in the first place — and here it
    // matters most, because this runs on a host that has already failed to keep
    // up and is spending one of its few downshifts.
    session.softwarePreset = pickSoftwarePreset(
      this.softwarePresetBenchmark,
      rung.width * rung.height * fps,
      {
        decodeModel: this.decodeCostModel,
        source: session.sourceDecode ?? null,
        observedDecodeCostSec: this.#observedDecodeCostFor(session)
      }
    );
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
    // When THIS run began. ffmpeg's `speed=` is cumulative over a run, so a
    // reading of it says something about the machine only once the run has left
    // its own start behind — see #learnDecodeCost.
    session.encodeRunStartedAt = Date.now();
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
    // Cleared with the run that could not answer them. These are "how long has
    // this segment gone unanswered", and the question only means anything about
    // the run in force: a timestamp kept from an abandoned scan probe minutes
    // ago says a fresh request has already waited long enough, which is how the
    // behind-head repair came to fire on the very first poll instead of waiting
    // for the seek that should move the encoder. It also stops the map growing
    // for the life of a session.
    session.firstWantedAt = new Map();
    session.behindHeadAsks = new Map();
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
    // 0-based output time of this segment, from the boundary table.
    const startSeconds = this.#segmentStartTime(session, safeIndex);
    const sourceStartTime = Number.isFinite(session.sourceStartTime) ? session.sourceStartTime : 0;
    // Cut where this session's grid says, whoever is producing the frames. The
    // times are measured from the start of THIS run; the same list serves as
    // the cut points and, when re-encoding, as the keyframes to force — one
    // list, so the two cannot drift apart.
    const explicitTimes = session.segmentFormat.explicitTimesMuxerArgs?.() ?? null;
    // A COPY is cut by this list whatever grid it ended up on. Even when no
    // keyframe index could be read and the boundaries are a plain grid, saying
    // them outright is what keeps the playlist and the muxer agreeing — ffmpeg
    // moves each cut forward to the first real keyframe, and serving reads back
    // where the piece truly begins. Requiring a keyframe grid here dropped a
    // copy with no index onto the `hls` muxer, which takes no cut list and
    // writes no self-contained pieces, so nothing could read a true start and
    // segments were stamped with times the file does not have — the 4.17 s
    // speech-against-subtitles drift, back again.
    const cutTimes = explicitTimes && (!session.transcodeVideo || session.cutGrid === "keyframe")
      ? segmentCutTimesFrom(session.segmentBoundaries, safeIndex)
      : null;

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
          tonemap: session.applyTonemap === true,
          // On the source's grid the cuts are not evenly spaced, so no frame
          // count can describe them: the encoder is told the times outright,
          // the same ones the muxer will cut at.
          forcedKeyframeTimes: cutTimes
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
    // Seek position in SOURCE time. On the keyframe grid `startSeconds` is a
    // real keyframe's offset from zero, so the container's own start time goes
    // back on to reach it; on the uniform grid it is a plain offset. This
    // follows the GRID, not whether the video is re-encoded — a variant cut on
    // the source's keyframes has to seek to them like the copy it accompanies.
    const seekSeconds = session.cutGrid === "keyframe"
      ? startSeconds + sourceStartTime
      : startSeconds;
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
    // Which timeline the output is labelled on. An audio rendition has no
    // picture of its own to follow, so it follows the grid it was given — the
    // same one the video it plays with is on. Deciding by `transcodeVideo`, as
    // everything else here does, would put the audio of a re-encoded stream on
    // the copy branch: `-copyts` and a shift by the container's start time,
    // against a picture labelled from zero. The two would be offset by
    // `sourceStartTime` for the whole file.
    const onKeyframeGrid = session.audioOnly === true
      ? session.cutGrid === "keyframe"
      : !session.transcodeVideo;
    if (!onKeyframeGrid) {
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
    if (session.audioOnly === true) {
      // An audio RENDITION: one track, no picture. Published as its own
      // `#EXT-X-MEDIA` and shared by every video variant, so the track is
      // encoded once for the file instead of once per rung, and changing it is
      // the player switching rendition rather than this proxy rebuilding the
      // session. Cut on the same grid as the video it accompanies, which is
      // what lets the two be played together.
      args.push("-vn", "-map", `0:a:${session.audioTrackIndex ?? 0}?`, ...audioCodecArgs);
    } else if (this.#servesAudioSeparately(session)) {
      // The other half of the same arrangement: the picture alone, because its
      // audio is published as a rendition and would otherwise play twice.
      args.push("-an", "-map", "0:v:0?", ...videoCodecArgs);
    } else {
      args.push(
        "-map",
        "0:v:0?",
        "-map",
        // Type-relative audio track chosen by the viewer (default 0).
        `0:a:${session.audioTrackIndex ?? 0}?`,
        ...videoCodecArgs,
        ...audioCodecArgs
      );
    }

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
    //
    // The list is built above, before the encoder args, because a re-encoded
    // variant of a copied stream needs the same times twice over: once as the
    // cuts, once as the keyframes to force at them.
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
    // How often each index behind the run has been asked for, and how many
    // distinct ones there are. The repair reads both: one index asked twice is
    // a viewer waiting, a dozen asked once each is the player scanning. Kept
    // only for what is behind the head — everything ahead is ordinary
    // read-ahead — and cleared with each run, like the record above.
    if (index < session.encodeStartIndex) {
      session.behindHeadAsks ??= new Map();
      const asked = session.behindHeadAsks.get(index);
      session.behindHeadAsks.set(index, { count: (asked?.count ?? 0) + 1, at: Date.now() });
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
      this.#repairBehindHead(session, index, head);
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
   * Move the encoder back to a segment it can no longer produce.
   *
   * A run only ever goes forward from where it began, so a request below that
   * point is not a claim the run may yet reach — it is a hole, and holding it
   * holds it for ever. Measured 2026-08-11: a run placed at #770 while the
   * player needed #757 held that request for two minutes forty-one, producing
   * 409 s of video nobody had asked for.
   *
   * Deliberately narrow, because moving the encoder from a segment REQUEST is
   * exactly what this codebase removed once already: a player that cannot get
   * what it wants scans the playlist, and those probes are scattered across the
   * whole file (field log: #178, #681, #725, #807, #74, #245, #387 within half
   * a second). Steering on the lowest of them put the encoder at the start of
   * the film and left the viewer's own requests unreachable ahead of it.
   *
   * What separates the two: a run placed wrongly is out by at most the buffer
   * the player had — 14 segments in the measured case — while a scan probe is
   * out by anything at all. So only a request within reach behind the head is
   * repaired; the rest are what they always were, claims that answer 503.
   *
   * @param {HlsSession} session
   * @param {number} index - The segment being held.
   * @param {number} head - Where the current run begins.
   * @returns {void}
   */
  #repairBehindHead(session, index, head) {
    if (head - index > BEHIND_HEAD_REPAIR_MAX_SEGMENTS) {
      return;
    }
    // Nothing is encoding: a rung the viewer has switched away from is left
    // exactly so, and its held requests must not bring its encoder back.
    if (session.ffmpeg == null || hasChildExited(session.ffmpeg)) {
      return;
    }
    // A seek already settling is about to move the encoder to where the VIEWER
    // said they are. That statement outranks anything inferred here.
    if (session.seekSettleTimer != null) {
      return;
    }
    // What separates a request the viewer is waiting for from the player
    // scanning the playlist is not TIME but what else it is asking for. On a
    // seek hls.js fires dozens of DIFFERENT indices within half a second (field
    // log: #178, #681, #725, #807, #74, #245, #387) and abandons them all; a
    // viewer waiting for audio asks for the SAME one, over and over, because it
    // is the only thing that will let playback continue.
    //
    // So: this index has been asked for at least twice, and it is the only
    // thing behind the head being asked for. Both are facts about the traffic,
    // available at once, where a delay is a guess about it — and it was three
    // seconds of the twenty a track change cost on 2026-08-15.
    const asked = session.behindHeadAsks?.get(index)?.count ?? 0;
    if (asked < BEHIND_HEAD_REPAIR_MIN_ASKS) {
      return;
    }
    // Counted over a WINDOW, not over the run: a scan is many indices at once,
    // while the same map left to accumulate would eventually hold every
    // behind-head request a long run ever saw and switch the repair off for
    // good.
    const scanSince = Date.now() - BEHIND_HEAD_SCAN_WINDOW_MS;
    let distinctBehind = 0;
    for (const record of session.behindHeadAsks?.values() ?? []) {
      if (record.at >= scanSince) {
        distinctBehind += 1;
      }
    }
    if (distinctBehind > BEHIND_HEAD_SCAN_INDICES) {
      // A scan, not a wait. Moving the encoder to one of these is moving it to
      // a number the player picked at random.
      return;
    }
    const wantedAt = session.firstWantedAt?.get(index);
    if (!Number.isFinite(wantedAt) || Date.now() - wantedAt < BEHIND_HEAD_REPAIR_MS) {
      return;
    }
    const target = Math.max(0, index - SEEK_BACKOFF_SEGMENTS);
    // The breaker has already refused this target repeatedly. Re-arming for it
    // would log and re-arm on every poll for as long as the request is held,
    // and move nothing.
    if (target === session.seekFailureTarget && session.seekFailureCount >= MAX_SEEK_FAILURES) {
      return;
    }
    logger.warn(
      `transcode ${session.id} segment #${index} is behind the run (#${head}) and has waited ` +
      `${Date.now() - wantedAt}ms — nothing this run does can produce it; moving the encoder there`
    );
    // Through the same settle a viewer's own seek goes through, so a burst of
    // behind-head requests produces one restart and not one each.
    session.seekTarget = target;
    session.seekFirstFarAt = Date.now();
    session.seekSettleTimer = setTimeout(() => this.#fireSettledSeek(session), SEEK_SETTLE_MS);
    session.seekSettleTimer.unref?.();
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
    const named = this.sessionsById.get(sessionId);
    if (!named || named.state === "disposed") {
      return false;
    }
    // The browser holds one session id for the whole file and knows nothing of
    // variants, so a seek it reports means the stream on screen.
    named.viewerPositionSeconds = positionSeconds;
    named.lastAccessedAt = Date.now();
    // The audio the viewer is listening to moves with them. It is a separate
    // encoder on a separate session that the browser cannot name, and nothing
    // else would ever reposition it: a request far AHEAD of its run is not
    // treated as a seek anywhere in this class, so after a forward jump the
    // audio would be held, refused, and left grinding forward from where it
    // was — the picture playing over silence for as long as the jump was.
    // Only the track being LISTENED to. A track the viewer left keeps its place
    // but not an encoder, and seeking it would start one for nobody — which is
    // how a single viewer came to have three ffmpeg processes and three readers
    // on one file (2026-08-15), enough to pin every resident piece and kill the
    // session outright.
    const listening = named.activeAudioTrackIndex ?? named.audioTrackIndex;
    for (const [trackIndex, renditionId] of named.audioRenditionSessions ?? []) {
      if (trackIndex !== listening) {
        continue;
      }
      const rendition = this.sessionsById.get(renditionId);
      if (rendition && rendition.state !== "disposed") {
        rendition.lastAccessedAt = Date.now();
        this.#seekSession(rendition, positionSeconds);
      }
    }
    return this.#seekSession(this.#activeVariant(named), positionSeconds);
  }

  /**
   * Reposition THIS session, with no forwarding.
   *
   * {@link requestSeek} exists for the browser, which names the base session and
   * means the rung on screen. Everything inside this class means the session it
   * is holding: warming a rung has to move THAT rung, and forwarding sent the
   * seek to the one already playing instead — measured 2026-08-12, warming the
   * base's own height moved the 540p rung and left the base parked at the start,
   * so the switch had nothing to fetch.
   *
   * @param {HlsSession} session
   * @param {number} positionSeconds
   * @returns {boolean}
   */
  #seekSession(session, positionSeconds) {
    if (!session || session.state === "disposed") {
      return false;
    }
    session.viewerPositionSeconds = positionSeconds;
    session.lastAccessedAt = Date.now();
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
   * Where this host's recorded timings live: `--state-dir` when the deployment
   * names one, otherwise beside the installed proxy, which is where they have
   * always been kept.
   *
   * The default is deliberately the old location and not the working directory:
   * measured on the addon, both are inside the container's writable layer and
   * both are discarded when an update rebuilds it, so moving there bought
   * nothing — while for an ordinary `npm i -g` install the working directory is
   * wherever the operator happened to launch from, which splits the history
   * between runs and drops a file into someone's project.
   *
   * A deployment that HAS a persistent directory says so: the addon passes
   * `/data`, the one path its supervisor keeps across updates. Naming it here
   * would put Home Assistant into proxy code, which this repo does not do.
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
    const stateDir = typeof this.stateDir === "string" && this.stateDir.length > 0
      ? this.stateDir
      : path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    return path.join(stateDir, "host-timings.json");
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
      const asMs = (value) => (value === null ? "n/a" : `${value}ms`);
      logger.info(
        `host timings loaded from ${this.#hostTimingsPath()}: ` +
        `first-segment ${asMs(this.expectedFirstSegmentMs())}, ` +
        `session-create ${asMs(this.expectedSessionCreateMs())}`
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
  #noteIndexAccuracy(session, index, trueStart, declaredStart) {
    const deviation = Math.abs(trueStart - declaredStart);
    session.indexCheck ??= newIndexCheck();
    noteIndexDeviation(session.indexCheck, index, deviation);
    if (deviation > SEGMENT_START_DISAGREEMENT_SEC) {
      // Which boundary the true start DOES match, if any. This is what tells
      // the two possible faults apart, and they need opposite fixes: matching
      // boundary #N-1 means our numbering is shifted by one — a fault in this
      // code, where the run begins — while matching nothing means the container
      // index describes times the file does not have. Measured 2026-08-11,
      // three samples all matched N-1, which is why the line now says so
      // instead of leaving it to be inferred from the numbers.
      const at = this.#boundaryIndexAt(session, trueStart);
      logger.warn(
        `transcode ${session.id} segment #${index} really starts at ` +
        `${trueStart.toFixed(3)}s (boundary ${at === null ? "none" : `#${at}`}), ` +
        `the playlist says ${declaredStart.toFixed(3)}s — ` +
        (session.transcodeVideo
          // A re-encode was TOLD to put a keyframe here and did not, so this
          // rung's segments no longer stand where the stream it accompanies
          // would have put them. That is a broken splice, not a wrong index.
          ? "this rung did not cut where its grid says; a switch to it will not join cleanly"
          : "the container's keyframe index disagrees with the file; using the file")
      );
    }
    this.correctBoundaryFromSegment(session, index, trueStart);
  }

  /**
   * Replace a boundary the index got wrong with the time the file actually has.
   *
   * The grid of a copied stream comes from the container's keyframe index,
   * because a copy can only be cut where a keyframe already is and nothing
   * cheaper than the index can say where that is before a single byte is
   * encoded. An index can be wrong — proven 2026-08-12 by reproducing both
   * cases against the same file: with an honest index every produced segment
   * started exactly where declared, and with one moved 1.8 s the segments
   * started 1.8 s early, matching no boundary at all. The field showed the
   * second shape.
   *
   * The truth arrives anyway, one segment at a time: a produced piece states
   * where it really begins. Writing it back makes the grid describe the file
   * instead of the index — and it is what lets a re-encoded rung be cut to
   * match a copied one, because the rung is then forced onto times the copy
   * really uses. The alternative considered and rejected was to stop offering
   * quality on files with a bad index, which is not a fix but a withdrawal.
   *
   * The whole family shares one grid, so a correction reaches all of it: a rung
   * created afterwards inherits a table that is true wherever anyone has looked.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @param {number} trueStart
   * @returns {void}
   */
  correctBoundaryFromSegment(session, index, trueStart) {
    const boundaries = session.segmentBoundaries;
    if (!Array.isArray(boundaries) || index <= 0 || index >= boundaries.length - 1) {
      // Index 0 is the start of the file and the last entry is its end; neither
      // is a cut, and neither can be learned from a segment.
      return;
    }
    if (Math.abs(boundaries[index] - trueStart) <= SEGMENT_START_DISAGREEMENT_SEC) {
      return;
    }
    // A correction that would put this boundary at or past its neighbours is not
    // a correction — it is a reading from a run that started somewhere else, and
    // applying it would make the table describe nothing at all.
    if (trueStart <= boundaries[index - 1] || trueStart >= boundaries[index + 1]) {
      return;
    }
    const wasAt = boundaries[index];
    for (const member of this.#familyOf(session)) {
      if (Array.isArray(member.segmentBoundaries) && member.segmentBoundaries.length === boundaries.length) {
        member.segmentBoundaries[index] = trueStart;
      }
    }
    logger.info(
      `transcode ${session.id} boundary #${index} corrected ${wasAt.toFixed(3)}s → ` +
      `${trueStart.toFixed(3)}s from the file itself`
    );
  }

  /**
   * The session a family answers as: the base a rung belongs to, or the session
   * itself when it is not a rung.
   *
   * A rung knows only its own encode, so anything that is a property of the
   * FILE rather than of one encode of it — what the source is, whether its
   * video can be copied, which heights this host can serve it at — has to be
   * asked here. A live base is required: a rung whose base has been disposed
   * answers for itself rather than following a dead reference.
   *
   * @param {HlsSession} session
   * @returns {HlsSession}
   */
  #baseOf(session) {
    if (!(session?.variantBases instanceof Set)) {
      return session;
    }
    for (const baseId of session.variantBases) {
      const base = this.sessionsById.get(baseId);
      if (base && base !== session && base.state !== "disposed") {
        return base;
      }
    }
    return session;
  }

  /**
   * Every session cut on one grid: a base and its quality rungs.
   *
   * @param {HlsSession} session
   * @returns {HlsSession[]}
   */
  #familyOf(session) {
    const bases = session.variantBases instanceof Set
      ? [...session.variantBases]
      : [];
    const roots = bases.length > 0 ? bases : [session.id];
    const family = new Set([session]);
    for (const rootId of roots) {
      const root = this.sessionsById.get(rootId);
      if (!root) {
        continue;
      }
      family.add(root);
      if (root.variants instanceof Map) {
        for (const variantId of root.variants.values()) {
          const variant = this.sessionsById.get(variantId);
          if (variant) {
            family.add(variant);
          }
        }
      }
    }
    return [...family];
  }

  /**
   * The boundary a time falls on, or null when it falls on none of them.
   *
   * Within the same tolerance a disagreement is judged by, so "matches boundary
   * #N-1" and "matches nothing" mean what they say.
   *
   * @param {HlsSession} session
   * @param {number} seconds
   * @returns {number | null}
   */
  #boundaryIndexAt(session, seconds) {
    const boundaries = session.segmentBoundaries;
    if (!Array.isArray(boundaries)) {
      return null;
    }
    for (let index = 0; index < boundaries.length; index += 1) {
      if (Math.abs(boundaries[index] - seconds) <= SEGMENT_START_DISAGREEMENT_SEC) {
        return index;
      }
    }
    return null;
  }

  /**
   * What this session learned about its container's keyframe index, as one
   * line, at the end.
   *
   * Written even when nothing disagreed, because that is the finding: with only
   * the per-boundary warning, silence could not be told from nobody having
   * watched. Skipped for a session that checked nothing, which says neither.
   *
   * @param {HlsSession} session
   * @returns {void}
   */
  #logIndexAccuracy(session) {
    const check = session.indexCheck;
    if (!check || check.checked === 0) {
      return;
    }
    logger.info(
      `keyframe-index ${session.containerFormat || "unknown"} "${session.fileName}": ` +
      `${check.disagreed} of ${check.checked} produced segments started away from the playlist, ` +
      `worst ${check.maxDeviationSec.toFixed(3)}s` +
      (check.firstDisagreementIndex >= 0 ? ` (first at #${check.firstDisagreementIndex})` : "") +
      ` [tolerance ${SEGMENT_START_DISAGREEMENT_SEC}s]`
    );
  }

  /**
   * Which variant a session IS, as a height. Zero encode height means "keep the
   * source", so the source's own height is the answer.
   *
   * Settled once and then kept, because it is a NAME — the player addresses the
   * variant by it for the whole session, having fetched the master exactly
   * once. The height a session encodes at is not stable: the realtime budget
   * steps it down when the host cannot keep up. Deriving the name afresh each
   * time would mean a downshift silently renames the variant the viewer is
   * watching, and the next segment request under the old name would build a
   * SECOND session at the height the host had just proved it could not manage.
   * A downshift changes the picture inside the variant instead, which is what
   * it has always done.
   *
   * @param {HlsSession} session
   * @returns {number}
   */
  variantHeightOf(session) {
    if (Number.isInteger(session.variantHeight) && session.variantHeight > 0) {
      return session.variantHeight;
    }
    const encodeHeight = Number(session.encodeHeight) || 0;
    session.variantHeight = encodeHeight > 0
      ? encodeHeight
      : Math.round(Number(session.sourceHeight) || 0);
    return session.variantHeight;
  }

  /**
   * The heights this session's file is offered at, largest first.
   *
   * The base session's OWN height is always among them, even when it is not a
   * ladder rung: it is whatever the realtime budget and the viewer's viewport
   * settled on, and an encoder is already producing it. Leaving it out would
   * mean the player, on loading the master, immediately asks for a rung nobody
   * is encoding — a second cold start in place of the run that is already
   * serving segments.
   *
   * @param {HlsSession} session
   * @returns {number[]}
   */
  #variantHeights(session) {
    // Always answered by the family's BASE, whichever member is asking. A rung
    // is a session of its own, and it knows only its own encode: asked while
    // the viewer watches 240p, the 240p session priced the 1080p rung as a
    // re-encode — because ITS video is re-encoded — and refused it on a host
    // that was serving that very height by COPY minutes earlier. Field
    // 2026-08-15: `proxy now offers 360p 240p` seconds after the switch, and
    // the viewer could not go back. Only the base knows what the family can do
    // with the source.
    // Answered ON the base, never recursively: the family is one level deep by
    // construction, and a `variantBases` cycle would otherwise blow the stack on
    // the path that serves every playlist, init and segment.
    const owner = this.#baseOf(session);
    // Settled once per session, and re-settled when this file's own decode cost
    // is measured or improves, or when the viewer moves to another rung — the
    // rung on screen is exempt from refusal, so it is an INPUT to this list and
    // belongs in what identifies a cached answer. Left out, the exemption
    // outlived the rung: a rung the host cannot hold went on being offered, and
    // went on passing every route guard, after the viewer had left it.
    // Everything else is fixed for the session's life.
    const observed = this.#observedDecodeCost.get(`${owner.sourceKey}:${owner.fileIndex}`) ?? null;
    const playing = this.variantHeightOf(this.#activeVariant(owner));
    const version = `${observed?.version ?? 0}:${playing}`;
    if (Array.isArray(owner.offeredHeightsCache) && owner.offeredHeightsVersion === version) {
      return owner.offeredHeightsCache;
    }
    const heights = new Set(variantHeightsFor(Number(owner.sourceHeight) || 0));
    const own = this.variantHeightOf(owner);
    if (own > 0) {
      heights.add(own);
    }
    const ordered = [...heights].sort((left, right) => right - left);
    // The rung ON SCREEN is never withdrawn while it is on screen. The list is
    // recomputed as the host learns what this source costs, and the reading
    // that teaches it comes from the rung the viewer has just switched to — so
    // the rung that taught the lesson would be the first to be dropped, and
    // every route guard reads this list: its next segment would 404 on a stream
    // that is playing, with its own encoder still running.
    const answer = this.#sustainableHeights({
      heights: ordered,
      ownHeight: own,
      playingHeight: playing,
      // What the family is already spending while a rung is considered. The
      // picture being COPIED is the common case and used to be priced at
      // nothing; measured, it is about an eighth of the machine.
      concurrentCostSec: this.#committedCostOf(owner),
      sourceWidth: Number(owner.sourceWidth) || 0,
      sourceHeight: Math.round(Number(owner.sourceHeight) || 0),
      fps: Number(owner.outputFps) || TRANSCODE_FPS,
      source: owner.sourceDecode ?? null,
      transcodeVideo: owner.transcodeVideo === true,
      observedDecodeCostSec: observed?.costSec ?? null
    });
    if (owner !== session) {
      // An orphan: its base is gone, so this is the family's last word and
      // there is nobody to keep it for. Answering is right — the viewer is
      // still watching it — but caching it on a session whose flags are its
      // own encode's is how the wrong answer became the family's in the first
      // place.
      return answer;
    }
    owner.offeredHeightsVersion = version;
    owner.offeredHeightsCache = answer;
    return answer;
  }

  /**
   * What decoding THIS source costs, learned from the encoder already running
   * on it — seconds of work per second of video, or null until it is known.
   *
   * @param {HlsSession} session
   * @returns {number | null}
   */
  #observedDecodeCostFor(session) {
    const entry = this.#observedDecodeCost.get(`${session.sourceKey}:${session.fileIndex}`);
    return entry ? entry.costSec : null;
  }

  /**
   * Take one reading of a running encode and turn it into the decode cost of
   * this source.
   *
   * A re-encode pays for both halves — unpacking the source and packing the
   * result — and the running session measures the SUM. The encode half is
   * priced by the startup benchmark for the preset and pixel rate actually in
   * use, so subtracting it leaves the half that no startup benchmark can know:
   * this file's own codec, resolution and grain, on this machine, under
   * whatever else it is doing.
   *
   * The MEDIAN of the recent readings is used, over a bounded window. Keeping
   * the fastest instead makes the figure a ratchet: `speed=` is cumulative over
   * a run, its maximum falls in the burst where the encoder races to the
   * look-ahead cap with the pieces already on disk and nothing competing, and
   * one such moment would re-admit — permanently — the very rung the field
   * measured at 0.388-0.947x. The median moves in both directions and describes
   * the machine as it usually is, which is what a viewer will meet.
   *
   * A reading is only taken from a run that has been going long enough to have
   * left its own start behind: ffmpeg's `speed=` is cumulative, so a restart
   * after a seek, a resume after a suspension, and the wait for the first
   * pieces are all in the denominator of an early reading.
   *
   * @param {HlsSession} session
   * @param {number} speed - The `speed=` ffmpeg reports, as a multiple of realtime.
   */
  /**
   * Take a reading off an encoder that is running, if this one is worth having.
   *
   * Separate from the realtime budget, which asks a different question — should
   * the quality step down — and answers it only where it CAN step down. Most of
   * what is worth measuring is excluded by that: a rung at the foot of its
   * ladder, a variant whose ladder is one rung long, a base whose video is
   * copied. Measuring has no such preconditions.
   *
   * What it does refuse: a suspended encoder (ffmpeg reports a CUMULATIVE
   * speed, so a look-ahead pause is divided into it and the figure decays while
   * nothing is being encoded), a reading that has not moved since the last one
   * (the loop runs every 5 s and a stalled encoder would otherwise fill the
   * whole window with one frozen sample), and a run short of input, where what
   * is short is the torrent rather than the machine.
   *
   * @param {HlsSession} session
   */
  async #learnFromEncoder(session) {
    if (
      !session ||
      session.state === "disposed" ||
      session.state === "failed" ||
      !session.ffmpeg ||
      session.encoderPaused === true ||
      session.transcodeVideo !== true
    ) {
      return;
    }
    const speed = this.#parseSpeed(session.progress?.speed);
    if (speed === null || speed === session.lastLearnedSpeed) {
      return;
    }
    if (speed < BUDGET_SPEED_OK && await this.#classifyTranscodeBound(session) === "download") {
      return; // the torrent is what is short; this says nothing about the host
    }
    session.lastLearnedSpeed = speed;
    this.#learnDecodeCost(session, speed);
  }

  /**
   * What COPYING this file costs on this host, learned from a session that is
   * doing it: seconds of work per second of video.
   *
   * A copy is not free. It demuxes, it re-encodes the audio, it writes
   * segments, and it runs BESIDE every rung warmed for a quality change — so a
   * budget that prices it at nothing predicts a machine that does not exist.
   * The figure is the reciprocal of the speed the session reports, which is the
   * measurement itself rather than a model of it.
   *
   * Median of recent readings, taken only from a run past its own start, for
   * the same reasons as the decode cost beside it.
   *
   * @param {HlsSession} session
   * @param {number} speed
   */
  async #learnCopyCost(session, speed) {
    const runStartedAt = Number(session.encodeRunStartedAt);
    if (!Number.isFinite(runStartedAt) || Date.now() - runStartedAt < DECODE_LEARNING_SETTLE_MS) {
      return;
    }
    if (session.encoderPaused === true) {
      return; // a suspended run reports a cumulative figure that is decaying
    }
    // Always asked, not only below realtime. A re-encode near 1x may be the
    // host; a COPY near 1x is a copy waiting for the torrent, because copying
    // is what a machine does at eight times realtime — and a starved reading
    // filed as the price of copying would refuse rungs on the download's
    // account.
    if (await this.#classifyTranscodeBound(session) === "download") {
      return;
    }
    const costSec = 1 / speed;
    if (!(costSec > 0) || !Number.isFinite(costSec)) {
      return;
    }
    const key = `${session.sourceKey}:${session.fileIndex}`;
    const known = this.#observedCopyCost.get(key);
    const readings = [...(known?.readings ?? []), costSec].slice(-DECODE_LEARNING_READINGS);
    const sorted = [...readings].sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (known && Math.abs(median - known.costSec) / known.costSec < DECODE_LEARNING_CHANGE) {
      this.#observedCopyCost.set(key, { ...known, readings });
      return;
    }
    this.#observedCopyCost.set(key, { costSec: median, readings, version: (known?.version ?? 0) + 1 });
    logger.info(
      `transcode: ${session.fileName} copies at ${(1 / median).toFixed(2)}x on this host ` +
        `(median of ${readings.length}, latest ${speed.toFixed(2)}x)`
    );
  }

  #learnDecodeCost(session, speed) {
    if (!(speed > 0)) {
      return;
    }
    if (session.transcodeVideo !== true) {
      // A copied video decodes nothing, so it says nothing about DECODING —
      // but it says exactly what COPYING costs, which the budget has been
      // treating as free. Field 2026-08-15: a copy ran at 7.92-8.02x, i.e.
      // about an eighth of a second of work per second of video, while a rung
      // warmed beside it needed the rest of the machine.
      //
      // An audio rendition also carries no video, and its speed is the cost of
      // encoding a soundtrack — a different quantity that must not be filed
      // under what copying the picture costs.
      if (session.audioOnly !== true) {
        void this.#learnCopyCost(session, speed);
      }
      return;
    }
    const runStartedAt = Number(session.encodeRunStartedAt);
    if (!Number.isFinite(runStartedAt) || Date.now() - runStartedAt < DECODE_LEARNING_SETTLE_MS) {
      return; // no run, or one still carrying its own start in the average
    }
    if (this.videoEncoder?.kind !== "software") {
      return; // the benchmark that prices the encode half is libx264 only
    }
    const benchmark = this.softwarePresetBenchmark;
    if (!Array.isArray(benchmark) || benchmark.length === 0) {
      return;
    }
    const entry = benchmark.find((item) => item.preset === session.softwarePreset);
    if (!entry || !(entry.pixelsPerSec > 0)) {
      return;
    }
    const height = Number(session.encodeHeight) || 0;
    const width = Number(session.encodeWidth) || 0;
    const fps = Number(session.outputFps) || TRANSCODE_FPS;
    if (height <= 0 || width <= 0) {
      return;
    }
    const encodeCostSec = (width * height * fps) / entry.pixelsPerSec;
    const decodeCostSec = 1 / speed - encodeCostSec;
    if (!(decodeCostSec > 0)) {
      // The encode half already accounts for everything measured. Nothing is
      // left to attribute to decoding, and a zero or negative cost would say
      // decoding is free, which is a claim this reading cannot support.
      return;
    }
    const key = `${session.sourceKey}:${session.fileIndex}`;
    const known = this.#observedDecodeCost.get(key);
    const readings = [...(known?.readings ?? []), decodeCostSec].slice(-DECODE_LEARNING_READINGS);
    const sorted = [...readings].sort((left, right) => left - right);
    const costSec = sorted[Math.floor(sorted.length / 2)];
    if (known && Math.abs(costSec - known.costSec) / known.costSec < DECODE_LEARNING_CHANGE) {
      // The same answer as before. Storing it would bump the version and make
      // every session recompute its offer, which is asked for on the path that
      // serves every playlist, init and segment.
      this.#observedDecodeCost.set(key, { ...known, readings });
      return;
    }
    this.#observedDecodeCost.set(key, { costSec, readings, version: (known?.version ?? 0) + 1 });
    logger.info(
      `transcode: ${session.fileName} decodes at ${(1 / costSec).toFixed(2)}x on this host ` +
        `(median of ${readings.length}, latest ${(1 / decodeCostSec).toFixed(2)}x from ${height}p ` +
        `at ${speed.toFixed(2)}x, preset ${session.softwarePreset})`
    );
  }

  /**
   * The heights this session's file will be served at, largest first — the
   * public form of the same answer the master playlist is built from.
   *
   * The browser asks because the master is not the only way quality changes: a
   * stream without variants changes it by re-opening the session at a chosen
   * height, and that list was being invented in the browser from the source
   * height alone. It has to come from the host that would have to encode it.
   *
   * @param {HlsSession} session
   * @returns {number[]}
   */
  offeredHeights(session) {
    if (!session || session.state === "disposed") {
      return [];
    }
    return this.#variantHeights(session);
  }

  /**
   * The heights this host would serve a file at, answered from the PROBE alone
   * — before any session exists.
   *
   * The viewer sees the quality menu the moment they open a file, so the list
   * cannot wait for an encoder to exist. Everything it needs is already known
   * by then: the source's size, rate and bitrate from the probe, and this
   * host's two benchmarks from startup.
   *
   * Both branches are answered because only the browser knows which one it will
   * take — it decides per track whether it can play the video as it is. With a
   * COPIED video the source height costs no encoder and is always there; with a
   * re-encoded one it is a prediction like every other rung.
   *
   * These are first figures, not final ones: what the encoder then really does
   * with this file replaces them (`offeredHeights` on a live session).
   *
   * @param {{ width: number | null, height: number | null, fps: number | null, bitrateKbps: number | null }} mediaInfo
   * @returns {{ copy: number[], transcode: number[] } | null}
   */
  predictOfferedHeights(mediaInfo) {
    const sourceHeight = Math.round(Number(mediaInfo?.height) || 0);
    const sourceWidth = Number(mediaInfo?.width) || 0;
    if (sourceHeight <= 0 || sourceWidth <= 0) {
      return null;
    }
    const fps = chooseOutputFps(Number(mediaInfo?.fps) || 0);
    const source = sourceDecodeCharacteristics(mediaInfo);
    const heights = variantHeightsFor(sourceHeight);
    // What an encoder has already been seen to cost on this very file, when it
    // has run before. Without it a second open of a file answers from the
    // startup clips again, undoing the correction the first playback earned.
    const observedDecodeCostSec = mediaInfo?.sourceKey !== undefined
      ? (this.#observedDecodeCost.get(`${mediaInfo.sourceKey}:${mediaInfo.fileIndex}`)?.costSec ?? null)
      : null;
    const forBranch = (transcodeVideo) =>
      this.#sustainableHeights({
        heights,
        observedDecodeCostSec,
        // Nothing is running yet, so nothing is exempt from being predicted —
        // except the copy itself, which the branch flag already covers.
        ownHeight: 0,
        sourceWidth,
        sourceHeight,
        fps,
        source,
        transcodeVideo
      });
    return { copy: forBranch(false), transcode: forBranch(true) };
  }

  /**
   * Drop the rungs this host cannot hold at realtime.
   *
   * Every rung below the source height is a full re-encode — decode the whole
   * source, encode a smaller picture — and on a weak host that is dearer than
   * the copy it replaces. Measured 2026-08-14: 1080p was copied at 7.8-8.9x
   * while the offered 240p rung ran at 0.388-0.947x, its first segment took
   * 30 s and later ones were held 22 s, so choosing a LOWER quality is what
   * broke playback. A rung that cannot be produced faster than it is watched
   * must not be offered at all.
   *
   * The session's OWN height always stays: an encoder is already producing it,
   * and removing it would point the player at a rung nobody is encoding.
   *
   * @param {{ heights: number[], ownHeight: number, sourceWidth: number, sourceHeight: number, fps: number, source: { megapixelsPerSecond: number, megabitsPerSecond: number } | null, transcodeVideo: boolean }} params
   * @returns {number[]}
   */
  /**
   * Seconds of work per second of video this family is ALREADY committed to,
   * beside any rung being considered.
   *
   * Today that is the copy of the picture, where the video is copied and its
   * cost has been observed. An encoded picture is not added: a viewer changing
   * quality leaves the rung they are on, so the two do not overlap for long,
   * and the warm-up that does overlap is bounded by the switch. An audio
   * rendition is not added either, until its cost is measured the same way —
   * counting it at a guess would refuse rungs on arithmetic nobody took.
   *
   * @param {HlsSession} session
   * @returns {number}
   */
  #committedCostOf(session) {
    let cost = 0;
    if (session.transcodeVideo !== true) {
      const observed = this.#observedCopyCost.get(`${session.sourceKey}:${session.fileIndex}`);
      cost += observed && observed.costSec > 0 ? observed.costSec : 0;
    }
    // And what the FILE costs simply by being fetched and delivered while it is
    // watched: a viewer consumes it at its own byte rate, and every one of
    // those bytes is downloaded, verified and pushed by this process. Priced
    // per megabyte from readings taken while nothing was encoding, so the two
    // measurements do not contain each other.
    const perMegabyte = this.#observedTorrentCostPerMegabyte;
    const megabytesPerSecond = sourceMegabytesPerSecond(session);
    if (perMegabyte !== null && megabytesPerSecond !== null) {
      cost += perMegabyte * megabytesPerSecond;
    }
    return cost;
  }

  #sustainableHeights({
    heights,
    ownHeight,
    playingHeight = 0,
    sourceWidth,
    sourceHeight,
    fps,
    source,
    transcodeVideo,
    observedDecodeCostSec = null,
    concurrentCostSec = 0
  }) {
    const benchmark = this.softwarePresetBenchmark;
    if (!Array.isArray(benchmark) || benchmark.length === 0 || sourceHeight <= 0 || sourceWidth <= 0) {
      return heights;
    }
    /** @type {number[]} */
    const kept = [];
    /** @type {string[]} */
    const dropped = [];
    for (const height of heights) {
      // The height an encoder is ALREADY producing, and the source's own height
      // when the FAMILY serves it by copy — neither has to be predicted,
      // because it is happening. A copied rung costs no encoder at all, so no
      // measurement of this host can ever be a reason to withdraw it, and the
      // whole point of it is that it is where a viewer on a rung the machine
      // cannot hold goes back to. `transcodeVideo` here is the base's, not the
      // asking session's: a 240p rung re-encodes, and reading its own flag is
      // what withdrew a copied 1080p in the field on 2026-08-15.
      //
      // A source height that would have to be RE-ENCODED is a prediction like
      // any other: on a session whose budget downshifted to 480p, the source's
      // 1080p is neither copied nor being produced, and keeping it unpriced
      // would offer exactly the kind of rung this refuses.
      if (
        height === ownHeight ||
        height === playingHeight ||
        (height === sourceHeight && !transcodeVideo)
      ) {
        kept.push(height);
        continue;
      }
      const width = Math.round(((sourceWidth / sourceHeight) * height) / 2) * 2;
      const { speed, sustainable } = canSustainOutput({
        benchmark,
        decodeModel: this.decodeCostModel,
        source,
        outputPixelsPerSec: width * height * fps,
        observedDecodeCostSec,
        concurrentCostSec
      });
      if (sustainable) {
        kept.push(height);
        continue;
      }
      dropped.push(`${height}p=${speed === null ? "n/a" : `${speed.toFixed(2)}x`}`);
    }
    if (dropped.length > 0) {
      logger.info(
        `transcode: not offering ${dropped.join(" ")} — below realtime × ${REALTIME_SPEED_MARGIN} ` +
          `(offering ${kept.map((height) => `${height}p`).join(" ")})`
      );
    }
    return kept;
  }

  /**
   * The variant of a session that the viewer is watching right now.
   *
   * Every request that names the base session — seek, progress, link report,
   * release — means the stream the viewer has on screen, and after a quality
   * change that is another session. The browser is not told about the swap: it
   * holds one session id for the whole file, which is what keeps the switch out
   * of the state machine on that side.
   *
   * @param {HlsSession} base
   * @returns {HlsSession}
   */
  #activeVariant(base) {
    const activeId = base.activeVariantId;
    if (!activeId || activeId === base.id) {
      return base;
    }
    const active = this.sessionsById.get(activeId);
    if (!active || active.state === "disposed") {
      base.activeVariantId = base.id;
      return base;
    }
    return active;
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
  #variantStartSeconds(base, wantedIndex) {
    if (Number.isInteger(wantedIndex) && wantedIndex >= 0) {
      return this.#segmentStartTime(base, wantedIndex);
    }
    return this.#viewerPositionOf(this.#activeVariant(base));
  }

  /**
   * Where to start a separately published audio track, in seconds.
   *
   * The player, on changing track, discards the audio it holds and refills from
   * the PICTURE onwards — so that is where the encoder has to begin. What this
   * class knows directly is the read head, which runs ahead of the picture by
   * the player's own buffer; the browser reports that buffer with every link
   * report, so the picture is the one subtraction below.
   *
   * One segment of margin, because the report is up to ten seconds old and the
   * picture has moved on since — a run that begins a little early costs a
   * segment of audio nobody plays, while one that begins a little late is
   * behind the viewer and can only be fixed by restarting it.
   *
   * With no fresh report, the whole look-ahead is subtracted instead: it is the
   * furthest the two can be apart, so it cannot leave the run ahead of them.
   *
   * @param {HlsSession} base
   * @returns {number}
   */
  #audioStartSecondsFor(base) {
    const watching = this.#activeVariant(base);
    const readHead = this.#viewerPositionOf(watching);
    const report = watching.netReport;
    const reportAge = Number.isFinite(report?.at) ? Date.now() - report.at : Number.POSITIVE_INFINITY;
    const buffered = reportAge <= NET_REPORT_FRESH_MS && Number.isFinite(report?.bufferedAheadSec)
      ? report.bufferedAheadSec
      : LOOKAHEAD_PAUSE_SECONDS;
    return Math.max(0, readHead - buffered - this.segmentDurationSec);
  }

  #viewerPositionOf(session) {
    if (Number.isFinite(session.viewerPositionSeconds) && session.viewerPositionSeconds > 0) {
      return session.viewerPositionSeconds;
    }
    if (Number.isInteger(session.lastRequestedSegment) && session.lastRequestedSegment > 0) {
      return this.#segmentStartTime(session, session.lastRequestedSegment);
    }
    return 0;
  }

  /**
   * Stop this session's encoder without replacing it.
   *
   * A variant nobody is watching must not go on encoding: the host has one
   * encoder's worth of capacity, and the whole point of switching quality
   * seamlessly is that the new rung gets it. The session itself stays — its
   * produced segments remain servable, and switching back restarts it from
   * where the viewer then is.
   *
   * @param {HlsSession} session
   * @param {string} reason - Named in the log; a stopped encoder is otherwise
   *   indistinguishable from one that died.
   * @returns {void}
   */
  #stopEncodeRun(session, reason) {
    // Everything armed to (re)start this session. A stop that leaves them
    // running is not a stop: the input-retry timer fires seconds later and
    // spawns a run for a variant nobody is watching — and torrent starvation,
    // which is what arms it, is routine here. The seek settle timer does the
    // same on a rapid second switch.
    if (session.seekSettleTimer) {
      clearTimeout(session.seekSettleTimer);
      session.seekSettleTimer = null;
    }
    session.seekTarget = null;
    if (session.inputRetryTimer) {
      clearTimeout(session.inputRetryTimer);
      session.inputRetryTimer = null;
    }
    const ffmpeg = session.ffmpeg;
    if (!ffmpeg) {
      return;
    }
    // A newer start may be waiting on an await inside #startEncodeRun; bumping
    // the generation makes it abort instead of spawning into a stopped session.
    session.encodeRunGeneration += 1;
    // A suspended process does not act on SIGTERM until it is continued.
    this.#resumeEncoder(session, reason);
    // Cleared BEFORE the signal: the exit handler checks identity against this
    // field, so a deliberate stop must not read as a run that failed.
    session.ffmpeg = null;
    if (!hasChildExited(ffmpeg)) {
      try {
        ffmpeg.kill("SIGTERM");
      } catch {
        // Best effort — the process may have exited between the two lines.
      }
    }
    logger.info(`transcode ${session.id} encoder stopped: ${reason}`);
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
  async resolveVariantSession(baseSessionId, height, wantedIndex = -1) {
    if (!isSafeSessionId(baseSessionId)) {
      return null;
    }
    const base = this.sessionsById.get(baseSessionId);
    if (!base || base.state === "disposed") {
      return null;
    }
    if (!Number.isInteger(height) || height <= 0) {
      return null;
    }
    // Only the heights the master offers. Anything else is a made-up request,
    // and honouring it would let a client start encoder runs at will.
    if (!this.#variantHeights(base).includes(height)) {
      return null;
    }
    if (height === this.variantHeightOf(base)) {
      return base;
    }
    base.variants ??= new Map();
    const existingId = base.variants.get(height);
    if (existingId) {
      const existing = this.sessionsById.get(existingId);
      if (existing && existing.state !== "disposed") {
        existing.lastAccessedAt = Date.now();
        return existing;
      }
      base.variants.delete(height);
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
      sourceKey: base.sourceKey,
      fileIndex: base.fileIndex,
      transcodeVideo: true,
      transcodeAudio: base.transcodeAudio,
      fileName: base.fileName,
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
      startPositionSeconds: Math.floor(this.#variantStartSeconds(base, wantedIndex) / 10) * 10,
      audioTrackIndex: base.audioTrackIndex,
      // A variant is a resolution the viewer chose, so it is encoded at exactly
      // that size and the realtime budget does not move it — otherwise two
      // variants could drift onto the same height and the choice would mean
      // nothing.
      manualQuality: true,
      // A rung of a session whose audio is published separately carries no
      // audio either — every rung of one master must agree about that, or
      // switching rung would start or stop a second copy of the same track.
      audioRenditions: base.audioRenditions === true,
      // Not re-decided here: asked on its own, a variant would answer about the
      // rungs IT would be offered at — a 540p rung of a copied 1080p source is
      // offered nothing but itself, so it would conclude "audio muxed" and
      // start carrying a second copy of a track the player is already fetching
      // from the rendition.
      inheritedAudioSeparate: base.audioSeparate === true,
      segmentFormatId: base.segmentFormat?.id ?? "",
      // Cut where the base is cut. Only for a base on the source's own keyframe
      // grid — a copy — where the variant has to land on those exact times to
      // be interchangeable with it. A base on the uniform grid needs nothing
      // passed: the variant computes the same even grid from the same duration.
      inheritedGrid: base.cutGrid === "keyframe"
        ? {
            // The table as it stands NOW, corrections included — not the index
            // it was first built from.
            boundaries: base.segmentBoundaries,
            keyframeTimes: base.keyframeTimes,
            containerFormat: base.containerFormat
          }
        : null,
      acquireSource: base.acquireSource
    })
      .then(async (variant) => {
        // Making a session takes seconds — a probe and a keyframe index — and
        // the viewer can leave inside that window. A variant registered onto a
        // disposed base is reachable by nobody: the browser never learns its
        // id, so nothing would release it and it would hold an encoder, a temp
        // directory and a claim on the torrent until its own idle timer noticed
        // half an hour later.
        if (base.state === "disposed") {
          await this.releaseSessionConsumer(
            variant.id,
            variantConsumerId(base.id),
            "the session it was made for ended while it was being made"
          );
          return null;
        }
        variant.variantHeight = height;
        (variant.variantBases ??= new Set()).add(base.id);
        base.variants.set(height, variant.id);
        return variant;
      })
      .finally(() => {
        base.variantPending.delete(height);
      });
    base.variantPending.set(height, creation);
    return creation;
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
   * @returns {Promise<{ sessionId: string | null, error?: string }>} The session
   *   to serve the file from; a null id means there is no such variant.
   */
  async resolveVariantFile(baseSessionId, height, fileName) {
    if (!isSafeSessionId(baseSessionId)) {
      return { sessionId: null };
    }
    const base = this.sessionsById.get(baseSessionId);
    if (!base || base.state === "disposed") {
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
    if (!this.#variantHeights(base).includes(height)) {
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
    // Only a SEGMENT says the viewer is watching this rung — and it says more
    // than that: it names the exact segment the player wants from it.
    if (isSegment) {
      this.#noteVariantActive(base, variant, variant.segmentFormat.segmentIndexFromName(fileName));
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
  async prepareAudioTrack(baseSessionId, trackIndex, positionSeconds) {
    const base = this.sessionsById.get(baseSessionId);
    if (!base || base.state === "disposed" || !this.#servesAudioSeparately(base)) {
      return null;
    }
    if (!this.#audioRenditionsOf(base).some((track) => track.trackIndex === trackIndex)) {
      return null;
    }
    const rendition = await this.#resolveAudioRenditionSession(base, trackIndex);
    if (!rendition) {
      return null;
    }
    // A track prepared for a change the viewer did not make would otherwise
    // encode for nobody until its own idle timer noticed — the same trap
    // warming a quality rung has, and the same answer.
    const stillWarming = base.warmingAudioSessionId;
    if (stillWarming && stillWarming !== rendition.id) {
      const abandoned = this.sessionsById.get(stillWarming);
      const listening = base.activeAudioTrackIndex ?? base.audioTrackIndex;
      const active = base.audioRenditionSessions?.get(listening);
      if (abandoned && abandoned.id !== active) {
        this.#stopEncodeRun(abandoned, "prepared for a track change the viewer did not make");
      }
    }
    base.warmingAudioSessionId = rendition.id;
    // Pointed at the position the switch will land on: an existing track is
    // parked wherever the viewer left it.
    this.#seekSession(rendition, positionSeconds);
    const index = this.#segmentIndexForTime(rendition, positionSeconds);
    return { sessionId: rendition.id, fileName: rendition.segmentFormat.segmentFileName(index) };
  }

  async prepareVariant(baseSessionId, height, positionSeconds) {
    if (!isSafeSessionId(baseSessionId)) {
      return null;
    }
    const base = this.sessionsById.get(baseSessionId);
    if (!base || base.state === "disposed") {
      return null;
    }
    if (!this.#variantHeights(base).includes(height)) {
      return null;
    }
    const index = this.#segmentIndexForTime(base, positionSeconds);
    const variant = await this.resolveVariantSession(baseSessionId, height, index);
    if (!variant) {
      return null;
    }
    // A rung warmed for a switch that was never made. Nothing else would ever
    // stop it: only becoming active stops the rung being left, so a viewer
    // trying two rungs in a row would leave the first encoding for nobody until
    // the look-ahead cap suspended it — three encoders at once on a host sized
    // for one, which is the opposite of what warming is for.
    const stillWarming = base.warmingVariantId;
    if (stillWarming && stillWarming !== variant.id) {
      const abandoned = this.sessionsById.get(stillWarming);
      if (abandoned && abandoned.id !== this.#activeVariant(base).id) {
        this.#stopEncodeRun(abandoned, "warmed for a switch the viewer did not make");
      }
    }
    base.warmingVariantId = variant.id === base.id ? null : variant.id;
    // An existing rung may be parked wherever it was left, so it is pointed at
    // the switch position exactly as an activation would — the difference is
    // only that the rung on screen keeps its own encoder meanwhile.
    variant.lastAccessedAt = Date.now();
    // Anything that is not the rung on screen has to be pointed at the switch
    // position — INCLUDING the base. Skipping it because it is the base was a
    // defect: the base is parked wherever it was when the viewer left it, and
    // its encoder was stopped then. Measured 2026-08-12, warming 400p at
    // 6506.5s found the base still at `run from #0`, so the segment the switch
    // needed was never produced and the viewer got nothing at all.
    if (variant.id !== this.#activeVariant(base).id) {
      this.#seekSession(variant, this.#segmentStartTime(base, index));
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
   * @returns {void}
   */
  #noteVariantActive(base, variant, wantedIndex = -1) {
    const previous = this.#activeVariant(base);
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
    const warmed = base.warmingVariantId;
    base.warmingVariantId = null;
    if (warmed && warmed !== variant.id && warmed !== previous.id) {
      const abandoned = this.sessionsById.get(warmed);
      if (abandoned) {
        this.#stopEncodeRun(abandoned, "warmed for a switch the viewer did not make");
      }
    }
    const position = this.#variantStartSeconds(base, wantedIndex);
    base.activeVariantId = variant.id;
    logger.info(
      `transcode ${base.id} variant now ${this.variantHeightOf(variant)}p ` +
      `(was ${this.variantHeightOf(previous)}p) at ${position.toFixed(1)}s`
    );
    // Every request still held on the old rung is for a segment nobody will
    // produce now — its encoder is about to be stopped — and the player has
    // already stopped waiting for them. Answering "retry" at once frees them
    // instead of holding each for the full minute.
    previous.waitEpoch = (previous.waitEpoch ?? 0) + 1;
    this.#stopEncodeRun(previous, `the viewer moved to ${this.variantHeightOf(variant)}p`);
    if (position > 0) {
      variant.viewerPositionSeconds = position;
      // The rung being switched TO, named literally: a warm-up may have left
      // the family pointing elsewhere, and forwarding would move that one
      // instead. A rung just created already starts here and is told so rather
      // than restarted; one that existed before is parked where it was left,
      // and this is what brings it to the viewer.
      this.#seekSession(variant, position);
    }
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
  buildMasterPlaylist(sessionId) {
    if (!isSafeSessionId(sessionId)) {
      return null;
    }
    const session = this.sessionsById.get(sessionId);
    if (!session || session.state === "disposed") {
      return null;
    }
    if (!session.transcodeVideo && session.cutGrid !== "keyframe") {
      return null;
    }
    const sourceHeight = Number(session.sourceHeight) || 0;
    const rungs = this.#variantHeights(session);
    if (rungs.length < 2) {
      return null;
    }
    const sourceWidth = Number(session.sourceWidth) || 0;
    const lines = ["#EXTM3U", `#EXT-X-VERSION:${session.segmentFormat.playlistVersion}`];
    // The audio tracks, published once for the whole file rather than muxed
    // into every rung. Two things follow from that: the same track is not
    // encoded once per rung on a host that struggles to encode it once, and
    // changing track becomes the player switching rendition instead of this
    // proxy rebuilding the session with another `audioTrackIndex`.
    //
    // Only for a session that asked for them. A browser that does not know
    // about renditions is served audio in its stream, as before, and gets no
    // `#EXT-X-MEDIA` lines to be confused by.
    const renditions = this.#servesAudioSeparately(session) ? this.#audioRenditionsOf(session) : [];
    const audioGroup = renditions.length > 0 ? AUDIO_GROUP_ID : "";
    for (const rendition of renditions) {
      lines.push(
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${audioGroup}",NAME="${escapeAttribute(rendition.name)}"` +
        (rendition.language ? `,LANGUAGE="${escapeAttribute(languageTag(rendition.language))}"` : "") +
        `,AUTOSELECT=YES,DEFAULT=${rendition.isDefault ? "YES" : "NO"}` +
        `,URI="${AUDIO_PATH_PREFIX}/${rendition.trackIndex}/${PLAYLIST_FILE_NAME}"`
      );
    }
    for (const height of rungs) {
      const width = sourceHeight > 0 && sourceWidth > 0
        ? Math.round((sourceWidth / sourceHeight) * height / 2) * 2
        : 0;
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${estimatedBitrateFor(height)}` +
        (width > 0 ? `,RESOLUTION=${width}x${height}` : "") +
        (audioGroup ? `,AUDIO="${audioGroup}"` : "")
      );
      lines.push(`${VARIANT_PATH_PREFIX}/${height}/${PLAYLIST_FILE_NAME}`);
    }
    return `${lines.join("\n")}\n`;
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
    return session.audioOnly !== true && session.audioSeparate === true;
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
   * @returns {Promise<{ sessionId: string | null, error?: string }>}
   */
  async resolveAudioRenditionFile(baseSessionId, trackIndex, fileName) {
    if (!isSafeSessionId(baseSessionId) || !Number.isInteger(trackIndex) || trackIndex < 0) {
      return { sessionId: null };
    }
    const base = this.sessionsById.get(baseSessionId);
    if (!base || base.state === "disposed" || !this.#servesAudioSeparately(base)) {
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
      rendition = await this.#resolveAudioRenditionSession(base, trackIndex);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `transcode ${baseSessionId} could not prepare audio track ${trackIndex}: ${message}` +
        (error instanceof Error && error.stack ? `\n${error.stack}` : "")
      );
      return { sessionId: null, error: message };
    }
    if (isSegment && rendition) {
      this.#noteAudioTrackActive(base, rendition, trackIndex);
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
   * @param {HlsSession} base
   * @param {HlsSession} active
   * @param {number} trackIndex
   */
  #noteAudioTrackActive(base, active, trackIndex) {
    if (base.activeAudioTrackIndex === trackIndex) {
      return;
    }
    base.activeAudioTrackIndex = trackIndex;
    for (const [otherIndex, sessionId] of base.audioRenditionSessions ?? []) {
      if (otherIndex === trackIndex) {
        continue;
      }
      const other = this.sessionsById.get(sessionId);
      if (!other || other.state === "disposed" || other.ffmpeg == null) {
        continue;
      }
      // Requests held on it are for segments nobody will produce now, and the
      // player stopped waiting for them the moment it changed track.
      other.waitEpoch = (other.waitEpoch ?? 0) + 1;
      this.#stopEncodeRun(other, `the viewer moved to audio track ${trackIndex}`);
    }
  }

  /**
   * The session producing one audio track of this file, made on first request.
   *
   * @param {HlsSession} base
   * @param {number} trackIndex
   * @returns {Promise<HlsSession | null>}
   */
  async #resolveAudioRenditionSession(base, trackIndex) {
    const existingId = base.audioRenditionSessions?.get(trackIndex);
    const existing = existingId ? this.sessionsById.get(existingId) : null;
    if (existing && existing.state !== "disposed") {
      existing.lastAccessedAt = Date.now();
      return existing;
    }
    const rendition = await this.createOrGetSession({
      sourceKey: base.sourceKey,
      fileIndex: base.fileIndex,
      // No picture at all: the video flag says what to do with a video stream
      // this output does not carry.
      transcodeVideo: false,
      transcodeAudio: base.transcodeAudio,
      fileName: base.fileName,
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
      startPositionSeconds: this.#audioStartSecondsFor(base),
      segmentFormatId: base.segmentFormat.id,
      // Cut where the picture is cut. Two streams meant to be played together
      // have to be divided at the same times, and the grid is the base's — the
      // table as it stands now, corrections included. A base on the uniform
      // grid passes nothing: the rendition computes the same even grid from the
      // same duration.
      inheritedGrid: base.cutGrid === "keyframe"
        ? {
            boundaries: base.segmentBoundaries,
            keyframeTimes: base.keyframeTimes,
            containerFormat: base.containerFormat
          }
        : null,
      acquireSource: base.acquireSource
    });
    if (!rendition) {
      return null;
    }
    if (!(base.audioRenditionSessions instanceof Map)) {
      base.audioRenditionSessions = new Map();
    }
    base.audioRenditionSessions.set(trackIndex, rendition.id);
    return rendition;
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
   * @returns {Array<{ trackIndex: number, name: string, language: string, isDefault: boolean }>}
   */
  #audioRenditionsOf(session) {
    const tracks = this.getCachedAudioTracks?.({
      sourceKey: session.sourceKey,
      fileIndex: session.fileIndex
    }) ?? [];
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return [];
    }
    const chosen = Number(session.audioTrackIndex) || 0;
    return tracks.map((track, order) => {
      const language = typeof track?.language === "string" ? track.language : "";
      const title = typeof track?.title === "string" && track.title.length > 0 ? track.title : "";
      return {
        trackIndex: order,
        name: title || language || `Track ${order + 1}`,
        language,
        isDefault: order === chosen
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

    // The index of variants. Served from here rather than a route of its own,
    // because to a player it is simply another playlist under the session.
    if (fileName === MASTER_PLAYLIST_FILE_NAME) {
      const masterText = this.buildMasterPlaylist(sessionId);
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
        // Where the viewer is, kept current. A reported seek is the only other
        // source of it and playback never issues one, so a position recorded at
        // a seek is stale for as long as the viewer then watches — and it is
        // read when a quality change has to place the next variant's first
        // encode run. The freshest evidence wins: a seek overwrites this, and
        // the first request after the seek overwrites it back.
        session.viewerPositionSeconds = this.#segmentStartTime(session, requested);
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
        if (trueStart !== null) {
          this.#noteIndexAccuracy(session, index, trueStart, declaredStart);
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
    // What the encoder has actually DONE since it restarted. "Alive at the right
    // index" was as far as the old line went, and it left the two possible
    // causes indistinguishable: an encoder waiting for torrent pieces looks
    // exactly like one that is encoding and simply has not finished. The
    // difference is whether its position has moved at all.
    const runStartSeconds = this.#segmentStartTime(session, session.encodeStartIndex ?? 0);
    const position = Number(session.progress?.processedSeconds);
    const produced = Number.isFinite(position) ? position - runStartSeconds : null;
    const speed = session.progress?.speed ?? "n/a";
    logger.warn(
      `transcode ${session.id} holding ${fileName}: ${reason} ` +
      `(run from #${session.encodeStartIndex ?? "?"}, viewer at #${session.lastRequestedSegment ?? "?"}, ` +
      `encoder ${session.ffmpeg ? "alive" : "stopped"}, index #${index}, ` +
      `produced ${produced === null ? "nothing yet — no position reported" : `${produced.toFixed(1)}s`} ` +
      `at ${speed}${produced !== null && produced <= 0 ? " — the encoder has not moved, so it is waiting on its input" : ""})`
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
      // Narrow on purpose. A request behind the head is USUALLY temporary: the
      // repair moves the encoder back for anything within its reach, and a
      // reported seek is about to move it anyway. Refusing those was 2.14.1,
      // and it left a viewer retrying a 404 for ever.
      if (
        Number.isFinite(requestedIndex) &&
        requestedIndex < (session.encodeStartIndex ?? 0) &&
        (session.encodeStartIndex ?? 0) - requestedIndex > BEHIND_HEAD_REPAIR_MAX_SEGMENTS &&
        session.ffmpeg != null &&
        session.seekTarget == null &&
        session.seekSettleTimer == null
      ) {
        logger.info(
          `transcode ${session.id} segment #${requestedIndex} is ${(session.encodeStartIndex ?? 0) - requestedIndex} ` +
          `segments behind the run and beyond the repair's reach; answered as absent rather than held`
        );
        return { kind: "not-found" };
      }
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
    const named = this.sessionsById.get(sessionId);
    if (!named) {
      return null;
    }
    named.lastAccessedAt = Date.now();
    // Progress is asked about the stream on screen, which after a quality
    // change is another session. Touching the named one as well is what keeps
    // the family alive: only the ACTIVE variant gets segment requests, so
    // without this the base session would idle out from under its own variants.
    const session = this.#activeVariant(named);
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
      // The id the caller asked about, not the variant it was answered from —
      // the browser tracks its sessions by the id it was given.
      sessionId: named.id,
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
      // The rungs still worth offering, as they stand NOW. The list the browser
      // was given when the file opened came from the startup benchmarks; this
      // one is corrected by what the encoder has since been seen to do with
      // this very source, so a rung that turns out to be beyond the host
      // disappears from the menu instead of being discovered by switching to it.
      offeredHeights: this.offeredHeights(session),
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
    this.#logIndexAccuracy(session);

    // A variant serves this session's viewer and nobody learns its id but us,
    // so it would otherwise encode and occupy disk for no one until its idle
    // timer noticed. Released rather than disposed: two families can land on
    // one variant (same file, same rung, same neighbourhood of the timeline),
    // and the existing consumer count is what already knows whether anyone else
    // is still watching it.
    if (session.variants instanceof Map) {
      const variantIds = [...session.variants.values()];
      session.variants.clear();
      for (const variantId of variantIds) {
        await this.releaseSessionConsumer(
          variantId,
          variantConsumerId(sessionId),
          "the session it was a variant of ended"
        );
      }
    }
    // The audio renditions of this session, for the same reason and in the same
    // way. Nobody outside this class knows their ids — the browser holds one id
    // for the whole file — so nothing else could ever release them, and each
    // holds a consumer, a claim on the torrent, a directory and a live encoder.
    if (session.audioRenditionSessions instanceof Map) {
      const renditionIds = [...session.audioRenditionSessions.values()];
      session.audioRenditionSessions.clear();
      for (const renditionId of renditionIds) {
        await this.releaseSessionConsumer(
          renditionId,
          variantConsumerId(sessionId),
          "the session its audio belonged to ended"
        );
      }
    }
    // Disposed on its own (idle, or with its last family): it must stop being
    // offered, or the next request for that height would be answered with a
    // session that no longer exists.
    if (session.variantBases instanceof Set) {
      for (const baseId of session.variantBases) {
        const base = this.sessionsById.get(baseId);
        if (!base) {
          continue;
        }
        if (base.variants instanceof Map && base.variants.get(session.variantHeight) === session.id) {
          base.variants.delete(session.variantHeight);
        }
        if (base.activeVariantId === session.id) {
          base.activeVariantId = base.id;
        }
      }
    }

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
