/**
 * @file HLS transcode session manager.
 *
 * Spawns one ffmpeg process per unique source+settings combination and
 * streams the resulting HLS playlist and segments from a temporary directory.
 * Sessions are expired automatically via a periodic cleanup interval, or
 * immediately when all registered consumers release them.
 */

import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { access, readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { logger } from "../utils/logger.js";
import { ContainerFactory } from "./container/ContainerFactory.js";
import { readMachineState, readProcessCpuSeconds, readProxyCpuSeconds, readSystemCpu, shareOfMachine } from "./host-load.js";
import { speedFromReadings } from "./encoder-readings.js";
import { availableShareFrom } from "./available-share.js";
import { contentionPenalty } from "./contention.js";
import { minimumBufferFrom } from "./supply-margin.js";
import { mapForViewer } from "./priority/PriorityMap.js";
import { PriorityOrchestrator } from "./priority/PriorityOrchestrator.js";
import { baseDrawFrom, costPerMegabyteFrom } from "./torrent-cost.js";
import { medianOf, movedBeyondScatter, scatterOf } from "./learned-median.js";
import {
  ENCODE_RUN_EVENT,
  ENCODE_RUN_STATE,
  INITIAL_RUN_STATE,
  liveRunsOf,
  runStateOf,
  processCanBeSignalled,
  wireState
} from "./encode/encode-run-state.js";
import { ENCODE_EXIT } from "./encode/encode-exit.js";
import { EncodeRun } from "./encode/EncodeRun.js";

/** Own package version, stamped onto session-start log lines. */
const PROXY_VERSION = createRequire(import.meta.url)("../package.json").version;
import {
  softwareDescriptor,
  chooseSoftwareEncodeSettings,
  pickSoftwarePreset,
  canSustainOutput,
  maxrateKbpsFor,
  nominalKbpsForHeight,
  nominalKbpsForMaxrate,
  TRANSCODE_FPS,
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
} from "./ffmpeg-banner.js";
import { resolveSegmentFormat, SEGMENT_FORMAT_IDS } from "./segment-formats/index.js";
import { audioRenditionName } from "./audio-inventory.js";
import { AudioOutput, CutGrid, OutputSpec, VideoOutput } from "./output/index.js";
import { newIndexCheck, Timeline, Timelines } from "./output/Timeline.js";
export { newIndexCheck };
import { Output, Outputs } from "./output/Output.js";
import { masterPlaylistText, mediaPlaylistText, segmentIndexForTime } from "./output/playlists.js";
import { SourceFiles, sourceDecodeCharacteristics } from "./source/SourceFile.js";
import { ProducedIndex } from "./produced-index.js";
import { discardOpenPiece } from "./encode/open-piece.js";
import { SegmentStore } from "./encode/SegmentStore.js";
import { EncodeCost } from "./quality/EncodeCost.js";
import {
  buildRunCommand,
  ffmpegSeconds,
  onKeyframeGridFor,
  PLAYLIST_FILE_NAME,
  publishedGridFor as publishedGridOf,
  publishedStartTime,
  seekLandingOffsetFor,
  segmentCutTimesFrom
} from "./encode/run-command.js";
// Re-exported because four of them are read by tests that name this module, and
// what they pin — where a run begins, where it cuts, which timeline it works on
// — did not move when the code did.
export { ffmpegSeconds, onKeyframeGridFor, seekLandingOffsetFor, segmentCutTimesFrom };
import { viewersOf } from "./viewer/Viewer.js";
import { Viewers } from "./viewer/Viewers.js";
import { LiveOutputs } from "./output/LiveOutputs.js";
import { variantHeightsFor } from "./output/ladder.js";
import { EncodeOrchestrator } from "./orchestrators/EncodeOrchestrator.js";
import { readDiskFree } from "./memory-report.js";

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
 * Add one produced segment's deviation to the tally.
 *
 * @param {ReturnType<typeof newIndexCheck>} check
 * @param {number} index - Segment index, so a repeat can be recognised.
 * @param {number} deviationSec - How far the piece's own start fell from the
 *   start the playlist declared for it.
 * @returns {void}
 */
export function noteIndexDeviation(check, index, deviationSec, landedOnKeyframe = null) {
  if (check.seen.has(index)) {
    return;
  }
  check.seen.add(index);
  check.checked += 1;
  check.deviations ??= [];
  check.deviations.push(deviationSec);
  if (landedOnKeyframe === true) {
    check.landedOnAnotherKeyframe = (check.landedOnAnotherKeyframe ?? 0) + 1;
  }
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
 * @param {{ decodeModel?: object | null, source?: { megapixelsPerSecond: number, megabitsPerSecond: number } | null, requiredSpeed?: number | null }} [cost]
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
      observedDecodeCostSec: cost.observedDecodeCostSec ?? null,
      requiredSpeed: cost.requiredSpeed ?? null
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

// How long a session waits for the file's keyframe table before giving up on
// copying the picture and re-encoding it instead.
//
// Measured on the addon host, 2026-09-04, over seventeen files from
// `Dropbox/trn` — four containers, pieces from 0.25 to 16 MB, files from 0.36 to
// 20 GB, each torrent registered fresh so nothing of it was downloaded
// (`research/keyframe-table-read-2026-09-04.md`). Every table that arrived did
// so within 24.8 s, most within half a second; the two files that answered
// nothing took 120.9 s and 120.5 s.
//
// Those two figures are not a coincidence and they are what fixes this one:
// they are TWO of the bound the read already has — `READ_ABANDON_MS` in
// `torrent-worker/container-tracks.js`, one for the wait on the file's edges and
// one for the read itself, in series. A session waiting for two of them is the
// defect; waiting for one is the bound, and it leaves 2.4x over the slowest
// table that did arrive. The line printed when it fires names which case
// happened, so the field can move it rather than an argument.
const KEYFRAME_TABLE_BUDGET_MS = 60_000;

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
// How often each session says what its cushion is. Half a minute: the link
// reports that feed it arrive every ten seconds, and a line per session per
// ten seconds would drown the log on a host serving several.
const CUSHION_REPORT_MS = 30_000;
// How old a viewer's link report may be and still describe where they are. It
// is sent every 10 s, and a seek in between moves them somewhere this cannot
// predict — so anything older is treated as no report at all.
const NET_REPORT_FRESH_MS = 15_000;
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

// How many produced segments' true start times to remember, so a player's
// report about one of them can be answered. Two hundred is about twenty
// minutes of playback at these segment lengths — far more than the recent past
// a stall report can be about, and small enough to be free.
const TRUE_START_MEMORY = 200;
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
// How far the accounting of a backward restart looks for work about to be done
// twice. It runs on the restart path and a session an hour in has thousands of
// segments; the figure is for a comparison, not an inventory.
const BACKWARD_RESTART_SCAN_SEGMENTS = 300;
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
const START_FAST_FAIL_MS = 2_000;
// Circuit breaker: consecutive fast failures AT THE SAME target before we stop
// auto-retrying and leave the session in its terminal "failed" state (surfaced
// to the client as a clean, retryable error) instead of looping forever. The
// keyframe-snap seek (see #startEncodeRun) already fixes the dominant failure
// mode (an unreliable container-computed seek position); this is a safety net
// for whatever residual case still fails — not a second competing "fix" that
// blindly retries the identical command hoping for a different result.
const MAX_FAILED_STARTS = 3;
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
const SEGMENT_STORE_IDLE_MS = 6 * 60 * 60 * 1000;
/**
 * The share of FREE disk the produced segments may take.
 *
 * A share of what is free NOW, re-read on every sweep, for the same reason the
 * piece store re-derives its memory allowance every minute: a machine that
 * fills up after this proxy started would otherwise go on spending an allowance
 * taken when it was empty. A Home Assistant install often runs from a 32 GB
 * card carrying everything else in the house.
 */
const SEGMENT_STORE_FREE_SHARE = 0.25;
/** What the store may hold where the free space cannot be read at all. */
const SEGMENT_STORE_FALLBACK_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * What it costs to stop an encoder and start another where the material is
 * missing. Measured on the addon host 2026-09-04: a spawn with its input open
 * is 0.12 s there, 0.5-0.6 s on a developer's desktop.
 */
const RUN_RESTART_COST_SEC = 0.12;
const DEFAULT_STARTUP_WAIT_MS = 5_000;
// Realtime budget — runtime downswitch (software encoder only). Periodically
// check each active software-transcode session's ffmpeg `speed`; when it stays
// below realtime for a sustained window AND the input is not download-starved
// (so the limit is the encoder, not the torrent), step down one resolution rung
// and restart at the current segment. Conservative so it never thrashes: a long
// sustained window, a post-action cooldown, a step cap, and no upswitch (v1).
const BUDGET_CHECK_INTERVAL_MS = 5_000;
/** The narrowest stretch of uninterrupted encoding a speed may be read from. */
const LEARN_WINDOW_MIN_SEC = 3;
// Speed below this (cumulative ffmpeg average) counts as "slow"; recovery to
// realtime resets the slow window (hysteresis).
const BUDGET_SPEED_SLOW = 0.95;
const BUDGET_SPEED_OK = 1.0;
// Slow must persist this long before a downshift (absorbs warm-up + brief
// complex scenes; the cumulative average won't dip this long unless the host
// genuinely can't keep up).
const BUDGET_SUSTAINED_MS = 15_000;
// After a step, wait this long before another (lets the new picture settle and
// a fresh slope build).
const BUDGET_ACTION_COOLDOWN_MS = 30_000;
// The step BACK UP has to be slower to fire than the step down, or the two
// take turns: a rung that has just been left is by definition one the arithmetic
// still thinks this machine can hold, so it would be asked for again as soon as
// the cooldown expired. Four times the down window is a statement about how long
// a machine has to look able before it is believed, not a measured quantity, and
// it is written here rather than dressed up as one.
const BUDGET_UP_SUSTAINED_MS = 60_000;
// How long a request to the player to change variant stands before it is
// treated as unanswered. A progress report is polled about every 1.5 s and the
// switch itself needs the rung warmed, which is the cold start this host
// measures; this is long enough for both and short enough that a browser which
// cannot honour the request (no master playlist, a viewer on a manual pick) is
// not chased for the rest of the film.
const QUALITY_ASK_TTL_MS = 45_000;
// How many readings the median is taken over. This one is a statement about
// how much of the past still describes the host, not a measured quantity, and
// it is written here rather than dressed up as one.
const DECODE_LEARNING_READINGS = 7;
// The input counts as "keeping up" when the torrent downloads at least this
// multiple of the source's average byte rate. Below it (and not yet fully
// downloaded), a low speed is download-bound, not CPU-bound → do NOT downscale.
const BUDGET_DOWNLOAD_OK_FACTOR = 1.0;
// Viewer-link adaptation (adaptive bitrate, part b). The browser reports its
// measured data-channel throughput + buffered seconds every ~10 s; when a
// FRESH report shows the usable link (reported × safety margin) sustainedly
// below the observed produced bitrate AND the viewer's buffer is low, the
// budget loop bounds the encode's bitrate by that measured link — same
// machinery and cooldown as the CPU trigger. On a COPIED picture there is no
// encoder to bound, so the same finding asks the player for a re-encoded rung
// instead. Which of the two, and whether a viewer's own pick may be moved at
// all, is decided where the viewer's choice lives: in the browser, which
// honours the request only in automatic mode.
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
 * How far a fragment may land from where the playlist put it before the player
 * stops recognising it as buffered.
 *
 * hls.js's own `maxBufferHole`, whose default is 0.5 s: a gap smaller than this
 * is skipped, a gap larger is a hole, and a fragment appended across one is
 * judged not to have loaded — so the player asks for it again, and again.
 * Taken from the player's published default rather than chosen here.
 */
const PLAYER_BUFFER_HOLE_SEC = 0.5;

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


/**
 * Where the viewer is, from the three things that can say so.
 *
 * In order, because each is a better answer than the next and each may be
 * absent:
 *
 * 1. a position they seeked to — they said it themselves;
 * 2. the start of the last segment this session actually served — where the
 *    reading is;
 * 3. **the position the file was OPENED at.**
 *
 * The third used to be missing, and its absence made the answer zero at exactly
 * the moment it is asked. Both of the others are written by things that have
 * not happened yet when a file is opened at a position — the first by a seek,
 * the second by a segment served — so a session created to begin at 3130 s
 * answered "the viewer is at the beginning". That is not a cautious default; it
 * is a wrong answer, and the soundtrack acts on it.
 *
 * Field 2026-08-21, `Minions.and.Monsters.1080p.mkv` reopened from the address
 * bar at 52:07: the picture session was created at `start=3130s` and ran from
 * segment #781; half a second later the audio rendition was created from this
 * reading — `start=0s`, no `-ss` at all — and set about re-encoding the film
 * from the beginning. The player asked both for #782. The picture had it. The
 * sound reached 57.5 s of 3130 in the 45 s the request lasted, then answered
 * 404, which the viewer was shown as "the proxy accepted the request but sent
 * no video".
 *
 * @param {{ seeked?: number, lastRequestedStart?: number | null, openedAt?: number }} readings
 * @returns {number} Seconds, never negative.
 */
/**
 * Where each viewer of a session is, creating the map when a session was built
 * without one.
 *
 * Every session this class makes carries it, but a session object is also
 * assembled by hand in a dozen tests, and code that writes a field should not
 * depend on some other code having created it first.
 *
 * @param {HlsSession} session
 * @returns {Map<string, { segment: number, seconds: number, at: number }>}
 */
function headsOf(session) {
  return viewersOf(session);
}

/**
 * WHICH of the three readings answered, which is a different question from what
 * the answer was.
 *
 * It matters for one thing: `openedAt` is not a request edge. The other two are
 * — a seek and a requested segment are both places a viewer has moved to while
 * holding a buffer, so the picture is behind them by however deep that buffer
 * is. `openedAt` is where a session was created and nothing has been asked for
 * since, so the picture is exactly there and there is nothing to subtract.
 * Reading the number without knowing which of the three it was is what started
 * a cold open's audio two minutes early on 2026-08-31.
 *
 * @param {{ seeked?: number, lastRequestedStart?: number | null, openedAt?: number }} readings
 * @returns {"seeked" | "requested" | "opened" | "none"}
 */
export function viewerPositionSource({ seeked, lastRequestedStart, openedAt }) {
  if (Number.isFinite(seeked) && seeked > 0) {
    return "seeked";
  }
  if (Number.isFinite(lastRequestedStart) && lastRequestedStart > 0) {
    return "requested";
  }
  if (Number.isFinite(openedAt) && openedAt > 0) {
    return "opened";
  }
  return "none";
}

export function resolveViewerPosition({ seeked, lastRequestedStart, openedAt }) {
  if (Number.isFinite(seeked) && seeked > 0) {
    return seeked;
  }
  if (Number.isFinite(lastRequestedStart) && lastRequestedStart > 0) {
    return lastRequestedStart;
  }
  if (Number.isFinite(openedAt) && openedAt > 0) {
    return openedAt;
  }
  return 0;
}

/**
 * How far the live boundary table has moved from the one the player holds, said
 * in words.
 *
 * The corrections are applied one boundary at a time and each is small enough
 * to look harmless; what nobody was watching is the total. It matters because a
 * run positioned on one table and cut on the other carries their difference into
 * every cut it makes — the fault of 2026-08-21, where the distance reached two
 * whole segments after one seek and four after the next. Printed beside each
 * correction so the total is visible while it is still small.
 *
 * @param {number[]} published - The table the playlist text was written from.
 * @param {number[]} live - The table corrected from produced segments.
 * @returns {string} A phrase, always readable, never throwing on odd input.
 */
export function describeGridDrift(published, live) {
  if (!Array.isArray(published) || !Array.isArray(live) || published.length === 0) {
    return "not comparable";
  }
  if (published.length !== live.length) {
    return `a different length (${published.length} against ${live.length})`;
  }
  let apart = 0;
  let worst = 0;
  let worstAt = -1;
  for (let index = 0; index < published.length; index += 1) {
    // Rounded to the millisecond BEFORE comparing, not only before printing.
    // Two boundaries moved by the same amount differ in the last bits of a
    // double, so an unrounded comparison picks between them by an accident
    // invisible in the printed figure — and the line would name a boundary the
    // reader cannot tell apart from the one before it. Rounded, ties keep the
    // earliest, which is also the one worth looking at first.
    const distance = Math.round(Math.abs(live[index] - published[index]) * 1000) / 1000;
    if (distance <= 0.001) {
      continue;
    }
    apart += 1;
    if (distance > worst) {
      worst = distance;
      worstAt = index;
    }
  }
  if (apart === 0) {
    return "identical";
  }
  return `${apart} of ${published.length} boundaries apart, worst ${worst.toFixed(3)}s at #${worstAt}`;
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
  return session.transcodeVideo !== true || session.timeline?.cutGrid === "keyframe";
}

/**
 * Where this session's encoding begins: the earliest number any live run of it
 * was given.
 *
 * @param {{ runs?: Set<object> }} session
 * @returns {number | null}
 */
function earliestRunStart(session) {
  const runs = liveRunsOf(session);
  return runs.length > 0 ? runs[0].from : null;
}

/**
 * A live run of this session that begins exactly at this number, if there is
 * one.
 *
 * @param {{ runs?: Set<object> }} session
 * @param {number} index
 * @returns {object | null}
 */
function runStartingAt(session, index) {
  return liveRunsOf(session).find((run) => run.from === index) ?? null;
}

/**
 * The live run of this session that was given this number, if any.
 *
 * A run with an explicit stretch owns the whole of it. One WITHOUT an end owns
 * only as far as it has actually got: claiming the rest of the film would make
 * it the owner of every number in front of it, including ones another run was
 * expressly given.
 *
 * @param {{ runs?: Set<object> }} session
 * @param {number} index
 * @returns {object | null}
 */
function ownRunMaking(session, index) {
  let answer = null;
  for (const run of liveRunsOf(session)) {
    if (run.from > index) {
      break; // Ordered by start, so nothing further can hold this number.
    }
    if (Number.isInteger(run.to) && run.to >= run.from && index > run.to) {
      continue; // Its stretch ends before this number.
    }
    answer = run;
  }
  return answer;
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
 * @property {string}  id            - UUID of the session.
 * @property {string}  sourceMapKey  - Cache key combining source + transcode settings.
 * @property {string}  fileName      - Display name of the file being transcoded.
 * @property {string}  dirPath       - Temp directory containing HLS output.
 * @property {"starting" | "ready" | "failed" | "disposed"} state
 * @property {number}  startedAt     - Unix ms timestamp when the session was created.
 * @property {number}  lastAccessedAt - Unix ms timestamp of the last consumer access.
 * @property {import("./encode/EncodeRun.js").EncodeRun | null} run - The one
 *   running encoder of this session: its process, the stretch it was given, its
 *   state, what it has produced and how it ended.
 * @property {object | null} pendingRun - The attempt whose spawn is still
 *   pending, so that a newer attempt can tell an older one it was overtaken.
 * @property {string}  lastError
 * @property {Set<string>} consumers  - Consumer IDs currently using this session.
 * @property {object}  progress       - Live progress metrics updated from ffmpeg stdout.
 * @property {number[] | null} keyframeTimes - Real source keyframe times
 *   (sorted seconds), or null when the probe failed/timed out. Used to snap a
 *   source seek onto a known-valid position (see #startEncodeRun).
 * @property {number}  failedStartAt - Segment index of the last fast seek
 *   failure, for the consecutive-failure circuit breaker (see MAX_FAILED_STARTS).
 * @property {number}  failedStartCount  - Consecutive fast failures at failedStartAt.
 */

/**
 * Manages HLS transcode sessions backed by ffmpeg child processes.
 *
 * One session is created per unique (source, fileIndex, transcode settings)
 * combination. Sessions are reused across consumers and are automatically
 * expired after {@link HlsSessionManagerOptions.sessionTtlMs} of idle time.
 */
/**
 * Which cost a speed reading from this session is a measurement OF.
 *
 * Three encodes share one reading path and price three different things: a
 * soundtrack published on its own, a picture being re-encoded (whose reading
 * prices this source's DECODING, the encode half being known from the startup
 * benchmark), and a picture being copied (which prices copying).
 *
 * Exported because the routing is where the fault was: a rendition was refused
 * a reading by one guard while the call that would have priced it sat behind
 * another, so the soundtrack was charged at nothing no matter how long it ran.
 * A pure function makes that a test rather than a field session.
 *
 * @param {{ audioOnly?: boolean, transcodeVideo?: boolean }} session
 * @returns {"audio" | "decode" | "copy"}
 */
export function costKindForSession(session) {
  if (session?.audioOnly === true) {
    return "audio";
  }
  return session?.transcodeVideo === true ? "decode" : "copy";
}

export class HlsSessionManager {
  /**
   * Recent times from session-create to a servable first segment, in ms.
   * See #rememberFirstSegmentLatency.
   *
   * @type {number[]}
   */
  /**
   * Whether a re-decision of what encoders should exist is already queued for
   * the end of this turn. See `planEncodersSoon`.
   * @type {boolean}
   */
  #planScheduled = false;

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

  // What an encoder taught this host — the cost of decoding a file, of
  // copying its picture, of each of its soundtracks — is held by the object
  // that reads it (`quality/EncodeCost.js`), together with the last refusal
  // it printed. The three methods that LEARN those costs are still here and
  // write into it; moving them is the next step, and until then there must
  // not be two copies of one reading.
  /** The previous reading of the machine, to compare the next one against. */
  #hostLoadSample = null;
  /** The previous reading taken while nothing was encoding, for the torrent's own cost. */
  #idleLoadSample = null;
  /**
   * How long each file is in bytes, from the stats call the read window already
   * makes. The torrent moves the CONTAINER, so this — not the video stream's
   * bitrate — is what its work should be priced against.
   *
   * @type {Map<string, number>}
   */
  #fileLengthByKey = new Map();
  /** Seconds of this process's CPU per megabyte the torrent moves, once measured. */
  #observedTorrentCostPerMegabyte = null;
  /** @type {number[]} Recent readings behind that median. */
  #torrentCostReadings = [];
  /**
   * The share of one core this process draws with nothing encoding and the
   * torrents moving nothing — the spending that would have happened anyway, and
   * which must come off a reading before the rest is called the torrent's.
   */
  #observedBaseDraw = null;
  /** @type {number[]} Recent readings behind that median. */
  #baseDrawReadings = [];
  /**
   * What each watched TORRENT is measured to be moving right now, in bytes per
   * second, keyed by source. Rebuilt every budget tick from the live sessions,
   * so an entry that is present was taken this tick.
   *
   * @type {Map<string, number>}
   */
  #downloadRateByKey = new Map();
  /**
   * The speed each file's own interruptions were last measured to demand,
   * keyed `sourceKey:fileIndex`. Kept per source rather than per session
   * because the first offer for a file is made before any session of it exists,
   * and a file that has been watched before has already told the reader what
   * its swarm does.
   *
   * @type {Map<string, number>}
   */
  #requiredSpeedByKey = new Map();

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
    // How long a session waits for the file's keyframe table before it
    // re-encodes the picture instead of copying it. Measured, not chosen —
    // see KEYFRAME_TABLE_BUDGET_MS. A parameter so a check can name a
    // shorter one rather than sitting out the real wait.
    keyframeTableBudgetMs = KEYFRAME_TABLE_BUDGET_MS,
    videoEncoder = null,
    softwarePresetBenchmark = null,
    decodeCostModel = null,
    getSourceStats = null,
    setPriorityMap = null,
    // What a second job costs on this host, measured at startup. Null when it
    // could not be measured, and then nothing is corrected — the alternative
    // is inventing a penalty, which is the same fault as inventing a fill rate.
    contentionPenalties = null,
    tonemapSupported = false,
    getCachedMediaInfo = null,
    getCachedAudioTracks = null,
    getContainerMediaInfo = null,
    getContainerKeyframes = null,
    fetchWholeFile = null,
    segmentFormatId = undefined,
    stateDir = "",
    segmentStore = null,
    getTorrentTotals}) {
    this.enabled = Boolean(enabled);
    this.ffmpegBin = ffmpegBin;
    this.keyframeTableBudgetMs = Number.isFinite(keyframeTableBudgetMs) && keyframeTableBudgetMs > 0
      ? keyframeTableBudgetMs
      : KEYFRAME_TABLE_BUDGET_MS;
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
    // Where the file's keyframes are, from the same container. A file has one
    // answer to this and it is read once; without this path the session reads
    // the table itself over the proxy's own HTTP, which is what every unit test
    // does and what the field did until 2.76.0.
    this.getContainerKeyframes =
      typeof getContainerKeyframes === "function" ? getContainerKeyframes : null;
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
    this.sessionsById = new Map();
    // Everyone watching anything, one object per person rather than one per
    // person per output. What a viewer chose, where they are and which outputs
    // they are watching are facts about the person; kept per output they were
    // three copies of which two were always stale.
    // Every change to who is watching what re-decides which encoders should
    // exist, because that decision reads nothing else about viewers. It used to
    // be re-taken on a five-second timer instead, which made a just-created
    // output wait up to five seconds before anything noticed it had a viewer.
    this.viewers = new Viewers({ onChange: () => this.planEncodersSoon() });
    // Which outputs of one file exist right now, and what each of them is: the
    // picture a step belongs to, the steps, the soundtracks, the height a
    // session is named by. Read-only over the register above, and the layer the
    // quality budget and the serving path both stand on.
    this.liveOutputs = new LiveOutputs({ sessionsById: this.sessionsById });
    // What this host learned last time it ran. Without it every restart shows
    // the first viewer a figure with no measurement behind it.
    this.#loadHostTimings();
    // Container keyframe index per (source, file). Immutable per file, so one
    // read serves every session, re-open and seek. Null means "this file has no
    // readable index" and is cached too — no point retrying a scan that cannot
    // succeed.
    this.keyframeIndexCache = new Map();
    // Reads of that table that have not answered yet, one per file. What makes
    // the wait belong to the FILE rather than to a session: everybody joins the
    // same one, so two viewers of one film get one answer and one read.
    this.keyframeIndexPending = new Map();
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
      liveOutputs: this.liveOutputs,
      host: () => ({
        benchmark: this.softwarePresetBenchmark,
        decodeModel: this.decodeCostModel,
        contentionPenalties: this.contentionPenalties,
        availability: this.hostAvailability
      }),
      audioCostKey: (session) => this.#audioCostKey(session),
      runningEncoders: () => this.#runningEncoders(),
      encodersRunningNow: () => this.#encodersRunningNow(),
      torrentCostSecFor: (session) => this.#torrentCostSecFor(session)
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
      allowanceFor: (session) => minimumBufferFrom({
        segmentSeconds: this.segmentDurationSec,
        worstSupplyWaitSec: session.supplyFigures?.worstWaitSec
      })?.seconds ?? this.segmentDurationSec
    });
    this.encodeOrchestrator = new EncodeOrchestrator({
      maxRunsFor: (address) => this.maxRunsForOutput(address),
      makeRun: ({ address, from, to }) => this.#makeRunAt(address, from, to),
      segmentSeconds: this.segmentDurationSec,
      restartCostSec: RUN_RESTART_COST_SEC,
      segmentStore: this.segmentStore,
      logger
    });
    // Where each file is cut, held once per file and grid rather than once per
    // session. Two sessions of one film MUST agree about this to the
    // millisecond — a segment made by either has to be appendable where the
    // other's would have gone — and until now they agreed by copying, which is
    // a thing somebody has to remember to do and which drifted twice in the
    // field. They share the table now.
    this.timelines = new Timelines();
    // The shape each output is encoded AS, decided once. The realtime budget
    // decides it from what this machine could hold at that moment, so two
    // sessions of one output made minutes apart could otherwise be given
    // different sizes while claiming the same identity — and everything
    // downstream assumes they cannot be, from a segment of one standing in for
    // a segment of the other to the single RESOLUTION the master names.
    this.outputs = new Outputs();
    // The files this proxy is serving, one object per file however many
    // sessions are of it. It holds the file's key — which every cache about a
    // file is keyed by — its name, and the facts a probe returned.
    this.sourceFiles = new SourceFiles();
    this.sessionIdBySource = new Map();
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired();
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
    // Realtime-budget monitor: only meaningful for the software encoder with a
    // benchmark (the only path that can pick/step resolution). Cheap no-op scan
    // otherwise.
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
    const forceManualQuality = manualQuality === true && transcodeVideo;
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
    const spec = new OutputSpec({
      sourceKey,
      segmentFormatId: segmentFormat.id,
      // What this session INTENDS to cut on, which is all that can be known
      // before the file's keyframe table has been read. A copy asks for the
      // source's own keyframes; a member of a family takes the grid it was
      // handed; everything else is the even grid. The one case where the intent
      // is not met is a copy whose container has no readable index — the video
      // is then re-encoded onto the even grid instead, which is logged where it
      // happens, and both viewers of that file ask the same thing of it and so
      // still land on one session.
      grid: new CutGrid({
        kind: inheritedGrid || (!transcodeVideo && !audioOnly) ? "keyframe" : "uniform",
        // Whose grid it is: the picture's file. A soundtrack has no keyframes
        // of its own and is cut where the picture it accompanies is cut.
        fileIndex
      }),
      video: carriesVideo
        ? new VideoOutput({
            fileIndex,
            encode: transcodeVideo
              ? {
                  width: normalizedTargetWidth,
                  height: normalizedTargetHeight,
                  manual: forceManualQuality
                }
              : null
          })
        : null,
      audio: carriesAudio
        ? new AudioOutput({
            fileIndex: audioSource.fileIndex,
            trackIndex: audioSource.sourceTrackIndex,
            transcode: transcodeAudio === true
          })
        : null
    });
    // One field that is not a property of the output and is on its way out:
    // where production BEGAN. It says nothing about what is produced, and it is
    // here only because a session cannot yet serve a position behind its
    // running encode without dragging that encode back — so a viewer joining
    // far from one would take the picture away from whoever is already
    // watching. What removes it is a run of their own (roadmap item 61).
    // The output's own parameters, and nothing about the request. The start
    // position used to be here, and what it was for — that two viewers of one
    // film should not each make their own copy of the same segments — is
    // settled in the ADDRESS of the segments, which it never entered. What kept
    // it here afterwards was that a session held one run, so merging two
    // viewers would leave the one behind stalled or dragging that run back. A
    // session holds as many runs as the machine affords now, so it goes.
    const sourceMapKey = spec.toKey();
    const existingId = this.sessionIdBySource.get(sourceMapKey);
    if (existingId) {
      const existing = this.sessionsById.get(existingId);
      if (existing && existing.state !== "failed") {
        const joined = Boolean(consumerId) && !existing.consumers.has(consumerId);
        if (consumerId) {
          existing.consumers.add(consumerId);
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
        }
        // Reuse said nothing at all before this, so a session serving two
        // viewers looked exactly like a session serving one — and the whole
        // question this key exists to answer is which of the two happened.
        if (joined) {
          logger.info(
            `transcode ${existing.id} joined by ${consumerId} ` +
            `(${existing.consumers.size} viewer(s)) key=${sourceMapKey}`
          );
        }
        // Where the joining viewer is opening the film. The start position is
        // no longer part of the key — it changes no byte of what is produced —
        // so a viewer joining somewhere else joins THIS session and is given a
        // run of their own there, rather than a second session of the same
        // output. Nothing is started where something is already being made:
        // `planRunInterval` answers that, and answers it with nothing.
        if (normalizedStartPosition > 0 || existing.runs.size === 0) {
          const at = this.#segmentIndexForTime(existing, normalizedStartPosition);
          if (runStartingAt(existing, at) === null && ownRunMaking(existing, at) === null) {
            this.#startEncodeRun(existing, at, normalizedStartPosition, "a viewer opened the film here");
          }
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
    // The directory belongs to the OUTPUT, not to this session: two sessions
    // whose parameters agree produce interchangeable segments, so they write
    // into one place and each serves what the other has already made. The start
    // position is deliberately not part of it — segment 42 covers the same span
    // whoever began where.
    const sessionDir = this.segmentStore.pathFor(spec.toKey());
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
    const inputUrl = inputFile.streamUrl(this.localBaseUrl, { sessionId });
    // The second input, for a muxed session whose sound comes from another file.
    // A picture whose sound is published separately reads ONE file: it maps no
    // audio (`-an`), so a second input would open a read on a file this output
    // does not carry a frame of, and hold that file against the disk sweep for
    // the whole session.
    const audioInputUrl =
      carriesAudio && inputFile !== audioFile && audioSource.isSidecar
        ? audioFile.streamUrl(this.localBaseUrl, { sessionId })
        : null;

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
    const pictureUrl = inputFile === file ? inputUrl : file.streamUrl(this.localBaseUrl);
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
    const readWindowBytes = await this.#readWindowBytesFor(
      inputFile.sourceKey,
      inputFile.fileIndex,
      durationSeconds
    );
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
    // How far a time in `keyframeTimes` may sit from the instant it names. Only
    // AVI has anything to declare here: it stores frame NUMBERS and the time is
    // that number times the frame duration, which lands 10-44 ms from the
    // presentation time the demuxer computes (measured 2026-08-21). A seek made
    // at such a name can fall just BELOW the real keyframe and land on the one
    // before it, which is the same fault the landing offset exists for.
    let keyframeTolerance = 0;
    let keyframeMs = -1; // -1 = not run (skipped), -2 = running in the background
    // Which container supplied the index, carried so the accuracy summary can
    // say what it is a summary OF.
    let containerFormat = "";
    // A quality variant of a session whose cuts are the source's keyframes must
    // be cut at exactly those same times, or its segments cannot stand where
    // the other's would have. Nothing has to be handed over for that any more:
    // the table is the FILE's, and a variant is a session of the same file, so
    // it reads the one answer. What the inherited grid still carries is the
    // CORRECTED boundaries and the published playlist, which are properties of
    // the family rather than of the file.
    if (inheritedGrid) {
      keyframeTimes = file.keyframeTimes;
      containerFormat = file.containerFormat;
      keyframeTolerance = file.keyframeTolerance;
    } else if (hasDuration && !transcodeVideo && !audioOnly) {
      // Video-COPY path: keyframeTimes are REQUIRED to build correct segment
      // boundaries (the playlist itself), so this MUST block session creation —
      // an incorrect playlist is worse than a slower start.
      //
      // The wait is bounded (KEYFRAME_TABLE_BUDGET_MS), and the bound is what
      // the read costs on a real host rather than a figure picked here. A
      // comment in this place used to promise a short timeout and "never more
      // than ~6 s to session start" when no timeout existed at all; the file
      // comes off a torrent, so the bytes the table lives in may still be
      // arriving, and a session used to wait for them without limit.
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
      const index = await this.readKeyframeTableWithin({ sourceKey, fileIndex, inputUrl, logName });
      keyframeTimes = index.times;
      containerFormat = index.format;
      keyframeTolerance = Number.isFinite(index.tolerance) ? index.tolerance : 0;
      keyframeMs = Date.now() - keyframeStartMs;
      // Onto the file only when the file has ANSWERED. A read that ran out of
      // its budget is still running, and writing its absence onto the file would
      // make a passing shortage of bytes look like a property of the bytes —
      // every later session of the file would then re-encode a picture that can
      // be copied.
      if (index.arrived) {
        // The table is a property of immutable bytes, like the duration and the
        // track list, and every session of the file reads the one answer.
        file.learn({ keyframeTimes, keyframeTolerance, containerFormat });
      } else {
        logger.warn(
          `transcode ${sessionId}: the keyframe table for "${logName}" has not arrived in ` +
            `${Math.round(this.keyframeTableBudgetMs / 1000)}s, so this session re-encodes the picture ` +
            "instead of copying it; the read goes on and the next session of this file gets the copy"
        );
      }
      if (!keyframeTimes) {
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
        if (index.arrived) {
          logger.warn(
            `transcode ${sessionId}: no keyframe index in the ${containerFormat} container for ` +
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
      // was field-diagnosed. #startEncodeRun reads session.file.keyframeTimes fresh
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
        // Onto the FILE, so every session of it — the picture, its quality
        // steps, a second viewer's — snaps a seek to the same table. It used to
        // land on the cut table, which is per file AND grid, so a re-encoded
        // step of a copied picture never saw what this probe found.
        liveSession.file.learn({ keyframeTimes: times });
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
    // The file's own table, made once and shared by every session of it. A
    // quality step is a different OUTPUT and the same cuts — which is exactly
    // the agreement `inheritedGrid` used to arrange by handing a copy to each
    // new session — so it is keyed by the file and the kind of grid, and
    // nothing else.
    const timeline = this.timelines.get(
      Timelines.keyFor(sourceKey, fileIndex, useKeyframeGrid ? "keyframe" : "uniform"),
      () => new Timeline({
        boundaries: Array.isArray(inheritedGrid?.boundaries) && inheritedGrid.boundaries.length > 1
          ? [...inheritedGrid.boundaries]
          : (hasDuration
            ? computeSegmentBoundaries({
                useKeyframeGrid,
                durationSeconds,
                segDur: this.segmentDurationSec,
                keyframeTimes,
                startTime: sourceStartTime
              })
            : []),
        cutGrid: useKeyframeGrid ? "keyframe" : "uniform"
      })
    );
    // What this session will PUBLISH. A member of a family takes its base's
    // published table verbatim; a session with no base publishes what it cuts
    // at. The two differ exactly by the corrections made since the family's
    // first playlist was written, and that difference is what must never reach
    // the player as two different timelines.
    const publishedGrid = timeline.published.length > 1 ? timeline.published : null;
    const segmentCount = timeline.segmentCount;

    // Realtime budget (software encoder): pick the output resolution + libx264
    // preset this host can encode faster than realtime. On a weak host this
    // downscales below the client target (the orientation-independent ceiling)
    // instead of dropping into sub-realtime playback. Null for hardware
    // encoders or when the source size / benchmark is unavailable — the encode
    // then keeps the client target box and buildVideoArgs's default preset.
    //
    // Manual quality bypasses the budget entirely: the user forced a specific
    // resolution, so encode exactly that box (capped to source by the scale
    // filter) with the default preset.
    // What decoding this source costs, which every re-encode pays on top of
    // the encoder. Derived from the file's own facts; null when the probe did
    // not say enough.
    const sourceDecode = file.decode;
    const chosenBudget = this.#chooseEncodeBudget({
      transcodeVideo,
      targetWidth: normalizedTargetWidth,
      targetHeight: normalizedTargetHeight,
      sourceWidth,
      sourceHeight,
      outputFps,
      source: sourceDecode,
      requiredSpeed: this.#requiredSpeedFor(sourceKey, fileIndex)
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
          observedDecodeCostSec: this.encodeCost.decodeCost.get(SourceFiles.keyFor(sourceKey, fileIndex))?.costSec ?? null,
          requiredSpeed: this.#requiredSpeedFor(sourceKey, fileIndex)
        })
      : chosenBudget;
    // Decided once for this output, whoever asks and whenever. The budget above
    // reads the machine as it is NOW; a second session of the same output
    // arriving a minute later must not be given a different picture on the
    // strength of a different moment.
    const output = this.outputs.get(spec.toKey(), () => new Output({
      // The budget's downscaled resolution when it applied, otherwise the
      // client target (0 = keep source, handled by buildVideoArgs).
      encodeWidth: encodeBudget?.width ?? normalizedTargetWidth,
      encodeHeight: encodeBudget?.height ?? normalizedTargetHeight,
      outputFps,
      softwarePreset: encodeBudget?.preset ?? null,
      applyTonemap
    }));

    // Only now, when nothing above can still throw. Everything from the probe
    // to the keyframe index used to run with the directory already made, so a
    // failure between the two left it behind: nothing tracks a directory whose
    // session was never registered, and no sweep looks for one. Proxy
    // 2.9.101-2.9.102 failed here on every single request and the leftovers
    // were the only trace of it on disk.
    this.segmentStore.directoryFor(spec.toKey());
    this.segmentStore.useFormat(spec.toKey(), segmentFormat);

    const session = {
      id: sessionId,
      sourceMapKey,
      // What this session PRODUCES, which is the address of its segments and
      // the thing another session may share with it. `sourceMapKey` is this
      // plus the start position, and the start position is a fact about a
      // request rather than about the material.
      outputKey: spec.toKey(),
      // The file this session is of: its key, its name and what a probe of it
      // said. One object per file, shared by every session of it.
      file,
      dirPath: sessionDir,
      // The SESSION's own lifetime, and nothing else: it exists, or it has been
      // disposed. It used to carry the encoder run's status as well, which is
      // why one line in the spawn path read `state === "disposed" ? "disposed"
      // : "starting"` — two lifetimes in one variable. The run's status lives
      // in `runState`.
      state: "live",
      startedAt: Date.now(),
      lastAccessedAt: Date.now(),
      ffmpeg: null,
      // The attempt whose spawn is still pending, so a newer one can tell it
      // has been overtaken. It replaced a counter compared against a copy of
      // itself: the attempt is a thing, and comparing the thing says the same
      // without a number to keep in step.
      pendingRun: null,
      // Every encoder this session has going. As many as the machine affords,
      // because one output can be watched from more than one place: a viewer
      // who jumps back gets a run of their own rather than dragging the picture
      // away from a viewer watching ahead.
      runs: new Set(),
      // What the ENCODER RUN is doing, as one control state from the table in
      // `encode-run-state.js`. Every question about the run is now answered
      // from here: whether a process can be signalled, whether anything is
      // reading the input, what a missing segment is answered with, and what
      // the browser is told. The three representations it replaced — a status
      // string, a second status string on the wire, and a child-process handle
      // consulted at ten sites — could disagree with each other, and did.
      runState: INITIAL_RUN_STATE,
      lastError: "",
      // Cold-start timing: entry timestamp + a once-guard so the first servable
      // segment logs its latency exactly once.
      createEntryMs,
      firstSegmentLogged: false,
      consumers: new Set(consumerId ? [consumerId] : []),
      // What each viewer is listening to: which soundtrack, and whether their
      // browser can decode it as it stands. Both are properties of a VIEWER and
      // neither is a property of a picture that carries no sound, now that two
      // viewers who chose different languages share one picture — so they are
      // fields of the viewer, along with the step on their screen, the step and
      // the track being warmed for them, where they are and what their link
      // carries. Seeded with the viewer who created the session, so a browser
      // that names itself never depends on having asked for a segment first.
      // Transcode parameters retained so the encode run can be restarted at an
      // arbitrary segment when the player seeks (server-side seeking).
      transcodeVideo,
      transcodeAudio,
      // The soundtrack this session was CREATED for. Still what an output
      // carrying sound maps, and, for one that does not, the answer given to a
      // viewer who cannot name themselves — a transport that carries no
      // consumer id, which is one viewer by construction.
      audioTrackIndex: normalizedAudioTrack,
      // Where that soundtrack actually is. The number above is flat across the
      // picture's own tracks and the files beside it, and these two are what it
      // resolves to: which file, and which `0:a:N` inside that file. Equal to
      // `fileIndex` and to the flat number for an ordinary embedded track, which
      // is what every session was before soundtracks in their own files existed.
      audioSourceTrackIndex: audioSource.sourceTrackIndex,
      // The file the chosen soundtrack lives in, and the file this session's
      // encoder reads. Both are the picture's own file for an ordinary embedded
      // track, which is what every session was before soundtracks in their own
      // files existed.
      //
      // Four fields came off the session when these two went on: which file the
      // sound is in, where each of the two timelines begins, and a boolean
      // saying whether the one input IS the sidecar — which is
      // `inputFile !== file` and nothing more. Each was a copy of something the
      // file states, and the start times were worse than copies: they were read
      // from a map of their own because a file could not be asked.
      //
      // The input ADDRESS stays on the session, because it is not a fact about
      // the file: it carries this session's id, so the stream route can count
      // the bytes it delivers against it, and the width of the window this
      // read keeps.
      audioFile,
      inputFile,
      // The second input, present only for a muxed session whose sound is in
      // another file. An audio rendition reads its sidecar as its only input, so
      // it has none.
      audioInputUrl: audioInputUrl ? audioInputUrl.toString() : "",
      // What this session's output carries. `audioOnly` is a rendition — one
      // audio track, no picture; `videoOnly` is a stream whose audio the viewer
      // takes from such a rendition. Neither is set on the ordinary muxed
      // session, which is what every browser gets until it says otherwise.
      audioOnly: audioOnly === true,
      audioRenditions: audioRenditions === true,
      // Client-requested target box (the orientation-independent ceiling). Kept
      // for the session key and reference; the actual encode uses encodeWidth/
      // encodeHeight, which the realtime budget may have downscaled below this.
      targetWidth: normalizedTargetWidth,
      targetHeight: normalizedTargetHeight,
      // What this output is encoded AS — the box, the frame rate, the speed
      // setting, the tone map — decided once for the output rather than once
      // per session, because two sessions of one output must not be given
      // different pictures on the strength of two different moments.
      output,
      // What the offer predicted this height would do on this machine, so the
      // field can say what the prediction was worth once the step runs. Null
      // when the step was never judged — a copied stream needs no encoder and
      // is never predicted.
      predictedSpeedWhenOffered: this.encodeCost.lastPredictedByHeight?.get(output.encodeHeight) ?? null,
      lastPredictionRatio: null,
      // The NAME of this rung, fixed at the height that was asked for. It is
      // deliberately not the height being encoded: a viewer who picked 480p on
      // a host that then starts them at 360p, or steps down to it later, goes
      // on addressing the rung as 480p — and a request under the old name must
      // not build a second session at a height this host has just refused.
      // Derived from `encodeHeight` when nothing was named, as before.
      variantHeight: forceManualQuality && normalizedTargetHeight > 0
        ? normalizedTargetHeight
        : undefined,
      // Realtime-budget runtime state. The ladder that chose the STARTING rung
      // is not kept: a step is a change of VARIANT now, and a variant is a
      // session with its own init segment, so there is no per-session rung
      // index to walk. What is kept is when this session last looked slow, when
      // it last looked able, and when the family last acted.
      budgetSlowSince: 0,
      budgetLastActionAt: 0,
      // A standing request to the player to move to another variant, or null.
      // Kept on the family's BASE — it is the base's id the browser polls
      // progress with, and the request outlives the rung that raised it.
      qualityAsk: null,
      // The last disagreement between the size a run encodes and the size the
      // served init describes, so the same one is not repeated every run.
      initSizeSaid: "",
      // The window in which the machine has looked able to carry a HIGHER rung.
      // The way back up, which for most of this project's life did not exist:
      // `budgetRungIndex` was written in exactly one place, `+ 1`.
      budgetUpSince: 0,
      // The last speed read as a SLOPE between two progress reports, with the
      // moment it was read. ffmpeg's own `speed=` is cumulative — output time
      // over wall time since the run began — so a run starved early carries
      // that average for the rest of its life, and a decision taken on it is
      // taken on a figure that stopped being true. Measured 2026-08-21: a
      // cumulative 0.39x bought a downshift on a run whose own progress lines
      // showed 1.30x at that moment.
      recentSpeed: null,
      // A peak this encode must not exceed, in kbit/s of nominal rate, when the
      // VIEWER's measured link is what cannot carry the stream. Null while
      // nothing has measured a limit. It moves `-maxrate`/`-bufsize` and
      // nothing else: they do not appear in the SPS, so one init segment goes
      // on describing every fragment — which the picture's SIZE cannot do.
      rateCapKbps: null,
      // The latest link report of EACH viewer, keyed by consumer id
      // ({ linkMbps, bufferedAheadSec, positionSeconds, at }), and the
      // link-deficit slow window (mirrors budgetSlowSince for the CPU path).
      //
      // One per viewer rather than one per session, because a copied picture is
      // shared: the session key carries the consumer id only where the video is
      // re-encoded. A single field was whichever viewer reported last, so the
      // budget could act on one viewer's link while the other was the one
      // running dry, and the audio rendition's start subtracted one viewer's
      // buffer from another viewer's read head.
      /** @type {Map<string, { linkMbps: number, bufferedAheadSec: number, positionSeconds: number | null, at: number }>} */
      // When this session last said what its cushion is (see #sayCushion).
      cushionSaidAt: 0,
      linkSlowSince: 0,
      inputUrl: inputUrl.toString(),
      // The container this session produces. Per session, not per proxy: the
      // viewer's browser decides, because it is the one that has to decode the
      // result (see createOrGetSession).
      segmentFormat,
      // VOD playlist bookkeeping.
      useSyntheticPlaylist: hasDuration,
      // Segment start times (0-based). The source's real keyframes when this
      // session is cut on that grid — always for copied video, and for a
      // re-encoded variant of such a session — otherwise a uniform grid.
      // Drives the playlist and seeking.
      // The file's own table. `segmentBoundaries` and `publishedBoundaries`
      // below are references into it, kept under their old names because every
      // reader of them is asking the same question they always were: where is
      // this file cut, and what was the player told.
      // The file's own table: where it is cut, what the player was told,
      // the container's keyframe index and how well it has matched. Every
      // session of one file holds the same one, so a correction found by
      // any of them is a correction for all — including sessions made
      // afterwards, which used to inherit a copy taken at that moment.
      timeline,
      // Which of the two it is, as a fact about the session rather than
      // something re-derived from "is the video copied" at each call site. The
      // two questions came apart the moment a re-encode had to be cut like a
      // copy.
      // Real source keyframe times (sorted seconds), or null when the probe
      // failed/timed out. Used by #startEncodeRun to snap a source seek onto a
      // KNOWN valid position instead of trusting the container's own on-the-fly
      // seek at an arbitrary target — see the probe call above for why.
      // How far those times may sit from the instants they name — nonzero only
      // for AVI, which computes them from frame numbers.
      // Which container the index came from, and how well it has held up. The
      // cut times of a copied video ARE its index, and an index can be wrong —
      // measured 2026-08-06, one claimed a keyframe four seconds from where the
      // real ones were. Each produced segment states where it truly begins, so
      // the comparison costs a subtraction on a piece that is already being
      // read; this counts them so a session can report what it found. It is
      // what decides whether a re-encoded rung can be cut on this same grid and
      // spliced into the copy (roadmap item 28).
      playlistText: hasDuration ? mediaPlaylistText({ boundaries: publishedGrid, segmentFormat }) : "",
      // The table AS PUBLISHED — what every playlist of this family states, and
      // what every segment of it is stamped against. Inherited whole from the
      // base when there is one, so a rung or a soundtrack created later
      // publishes the same timeline as the picture it plays with; only a family
      // with no base freezes a copy of its own.
      //
      // `segmentBoundaries` keeps being corrected from produced segments — that
      // is what makes a re-encoded rung cut like the copy it joins — and those
      // corrections deliberately do NOT reach this copy: the player's timeline
      // was sent once and cannot be revised.
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
      // See #reportCushions. With several viewers on one session it is the
      // FURTHEST of them, derived from the viewers below.
      lastRequestedSegment: null,
      // Where each viewer of this session is, separately: the segment they last
      // asked for and the position that implies, or the position they seeked
      // to. One session serves everyone watching a copied picture, and the two
      // fields above can only hold one answer — so a request held for the
      // viewer who is behind used to be released by a seek made by the viewer
      // in front. What must stay shared is what the single encoder does; what
      // must not is the question "is THIS request still wanted".
      /** @type {Map<string, { segment: number, seconds: number, at: number }>} */
      // Everyone watching this session, one object each. It was six parallel
      // maps keyed by consumer id — what they are listening to, the step on
      // their screen, the step and the track being warmed for them, where they
      // are, what their link carries — with six places to remember to update
      // and six to remember to forget. The forgetting was already wrong:
      // releasing a consumer emptied none of them.
      viewers: new Map(),
      encoderPauseUnsupported: false,
      seekFirstFarAt: 0,
      // Circuit breaker: consecutive FAST failures (see START_FAST_FAIL_MS) at
      // failedStartAt. Reset whenever a run starts at a DIFFERENT target or
      // survives past the fast-fail window. See the exit handler in
      // the run ending handler and MAX_FAILED_STARTS.
      failedStartAt: -1,
      failedStartCount: 0,
      progress: {
        // No `state` here. What the browser is told is `wireState(runState)`,
        // computed where it is sent — a Moore output rather than a field
        // maintained by hand at seven sites, which is how it came to be read
        // together with `session.state` under an `||`.
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
      // One claim per file this session READS. Almost always that is one file;
      // a muxed session whose soundtrack ships beside the picture reads two, and
      // holding only the picture would leave the sound to be swept off the disk
      // from under a running encoder.
      const claim = (heldFileIndex) => {
        try {
          const release = acquireSource(heldFileIndex);
          return typeof release === "function" ? release : null;
        } catch {
          return null;
        }
      };
      const releases = [claim(undefined)];
      if (audioInputUrl) {
        releases.push(claim(audioSource.fileIndex));
      }
      const held = releases.filter((release) => typeof release === "function");
      session.releaseSource = held.length > 0
        ? () => {
            for (const release of held) {
              try {
                release();
              } catch {
                // Best effort — a session must always finish being disposed.
              }
            }
          }
        : null;
    }
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
    }
    this.sessionsById.set(sessionId, session);
    this.sessionIdBySource.set(sourceMapKey, sessionId);
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
    session.audioSeparate = audioSeparate;

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
        // Effective encode resolution: budget-on (auto downscale from the
        // ceiling), manual (user-forced, budget off), or unset (keep source).
        `${transcodeVideo && encodeBudget
          ? `enc=${output.encodeWidth}x${output.encodeHeight}@${output.outputFps} ` +
            `quality=${forceManualQuality ? "manual" : "auto"} ` +
            `budget=${encodeBudget.ladder ? `rung ${encodeBudget.rungIndex + 1}/${encodeBudget.ladder.length}` : "off"} `
          : ""}` +
        `${transcodeVideo && !encodeBudget && forceManualQuality ? `enc=${output.encodeWidth || "src"}x${output.encodeHeight || "src"}@${output.outputFps} quality=manual budget=off ` : ""}` +
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
        `key=${sourceMapKey}`
    );

    // Begin where the viewer asked, not at the top of the file. The position
    // was already honoured everywhere EXCEPT here: it went into the session key
    // and into the log line, and then the first run started at index 0 anyway.
    // Measured 2026-08-06 on a Retry after the proxy restarted — the session
    // was created with `start=1580s`, the encoder began at #0, the player
    // asked for #152, and 45 s later the browser gave up with "no data arrived
    // from the proxy" while the transcode ran happily at 9.9x through the
    // opening credits.
    // From what the viewer ASKED for, not from the rounded figure. The rounding
    // exists to answer one question — is this the same session as somebody
    // else's — and it is the wrong number for this one, because `Math.round`
    // can move the position FORWARD: 588s became 590s, which falls in segment
    // #85 while the viewer at 588s is inside #84. The player then asked for a
    // segment behind the run, the run was restarted onto it, and the 4.5s it
    // had produced were thrown away (field 2026-08-31,
    // `research/cold-open-audio-start-2026-08-31.md`).
    const requestedStart = Number.isFinite(startPositionSeconds) && startPositionSeconds > 0
      ? startPositionSeconds
      : 0;
    const firstIndex = requestedStart > 0
      ? this.#segmentIndexForTime(session, requestedStart)
      : 0;
    await this.#startEncodeRun(session, firstIndex);

    try {
      await this.waitUntilReady(session);
      return session;
    } catch (error) {
      if (runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED) {
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
    const carriesVideo = session.audioOnly !== true;
    const carriesAudio = !this.#servesAudioSeparately(session);
    // The soundtrack of this session may not be in the file that was probed. A
    // release that ships its dub as a separate file often ships the picture with
    // no sound of its own at all, and then the picture's probe says there is no
    // audio while the output plainly carries some — which would leave the header
    // check expecting one track where two arrive, and tell the browser its sound
    // was lost.
    const audioFromAnotherFile = session.audioFile !== session.file;
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
      names = this.#producedIndex(session)
        .fileNames()
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
    const cacheKey = SourceFiles.keyFor(sourceKey, fileIndex);
    if (this.keyframeIndexCache.has(cacheKey)) {
      return this.keyframeIndexCache.get(cacheKey);
    }
    // One read per file, and one WAIT per file. Two sessions created in the
    // same moment used to miss the cache together and read the table twice —
    // which is what two viewers opening one film do, measured 13 ms apart on
    // 2026-09-03. Whoever asks second joins the read already running.
    const running = this.keyframeIndexPending.get(cacheKey);
    if (running) {
      return running;
    }
    // The WHOLE wait, as whoever asked for the table experiences it: the swarm
    // delivering the head and tail of the file, the parse over those bytes, and
    // the crossing to the torrent thread and back. The worker's own line
    // (`container-keyframes:`) reports the last two apart from the first, and
    // reading the two lines as one figure is what led to a wrong conclusion on
    // 2026-09-04 — they differ by up to sixty seconds on a thin swarm.
    const startedMs = Date.now();
    const work = this.#readContainerKeyframesOnce({ sourceKey, fileIndex, inputUrl, logName })
      .then((result) => {
        this.keyframeIndexCache.set(cacheKey, result);
        const tookMs = Date.now() - startedMs;
        const found = Array.isArray(result?.times) ? result.times.length : 0;
        logger.info(
          `keyframe index "${logName}": ${found > 0 ? `${found} times` : "none"} from the ` +
            `${result?.format ?? "unrecognised"} container, waited ${tookMs}ms`
        );
        return result;
      })
      .catch((error) => {
        logger.warn(
          `keyframe index "${logName}": the read failed after ${Date.now() - startedMs}ms — ` +
            `${error?.message ?? error}`
        );
        throw error;
      })
      .finally(() => {
        this.keyframeIndexPending.delete(cacheKey);
      });
    this.keyframeIndexPending.set(cacheKey, work);
    return work;
  }

  /**
   * The same read, with a bound on how long a session will wait for it.
   *
   * The read itself is NOT cancelled when the bound is reached — it goes on in
   * the background, is memoized on the file, and is there for the next session
   * of it. What the bound decides is only whether THIS session waits: a copied
   * picture cannot be cut without the table, so the answer to "not yet" is to
   * re-encode, which needs no table because it places the keyframes itself.
   *
   * Public because it is what decides which branch a picture takes, and a
   * private method cannot be pinned by a check.
   *
   * @param {{ sourceKey: string, fileIndex: number, inputUrl?: URL, logName: string }} params
   * @returns {Promise<{ times: number[] | null, format: string, tolerance?: number, arrived: boolean }>}
   */
  async readKeyframeTableWithin(params) {
    const read = this.#readContainerKeyframes(params);
    let timer = null;
    const budget = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), this.keyframeTableBudgetMs);
      // A session must not be held open by this timer alone.
      timer?.unref?.();
    });
    const answer = await Promise.race([read.then((result) => ({ ...result, arrived: true })), budget]);
    clearTimeout(timer);
    if (answer) {
      return answer;
    }
    // Nothing is added here to swallow a late rejection: the race is holding a
    // handler on that promise already, and a second one would only look like it
    // was doing something.
    return { times: null, format: "not yet read", tolerance: 0, arrived: false };
  }

  /**
   * The read itself, made exactly once per file by the caller above.
   *
   * Asked of the container layer, which holds ONE container per file and
   * already answers the track table and the media info from it — so the table
   * is read by the same reader as everything else the file states about itself,
   * over the torrent rather than over this proxy's own HTTP. The HTTP read
   * below is what happens when nothing supplied that path (a manager built
   * without it, which is every unit test).
   *
   * @returns {Promise<{ times: number[] | null, format: string, tolerance?: number }>}
   */
  async #readContainerKeyframesOnce({ sourceKey, fileIndex, inputUrl, logName }) {
    if (typeof this.getContainerKeyframes === "function") {
      const index = await this.getContainerKeyframes({ sourceKey, fileIndex });
      const times = Array.isArray(index?.times) && index.times.length > 0 ? index.times : null;
      return {
        times,
        // Which container answered, whether or not it produced a table: the
        // refusal that follows names it, and "unknown" would make that line say
        // nothing about the file it is refusing.
        format: typeof index?.format === "string" && index.format ? index.format : "unrecognised",
        tolerance: Number.isFinite(index?.tolerance) ? index.tolerance : 0
      };
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

    return ContainerFactory.readKeyframeIndex({ readRange, fileSize, label: logName });
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
    // The LIVE table, deliberately: this is where the file is cut now, which is
    // a different question from what the player was told. The published table
    // is passed as absent so that one arithmetic serves both.
    return publishedStartTime({ boundaries: session.timeline.boundaries }, index, this.segmentDurationSec);
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
   * The boundary table the player is working from: the one its playlist was
   * written from, falling back to the live table when no playlist was built
   * from a table at all (no duration, so no synthetic playlist — and then
   * nothing the player holds contradicts it).
   *
   * @param {HlsSession} session
   * @returns {number[]}
   */
  publishedGridFor(session) {
    return publishedGridOf(session.timeline);
  }

  /**
   * Where a run beginning at `index` must be positioned: the time the PLAYER
   * was told that segment starts at.
   *
   * Public because it is the invariant this class has broken twice, and a
   * private one cannot be pinned by a test. It must always be the table the cut
   * list is taken from — see the comment where a run is started.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @returns {number}
   */
  runStartTimeFor(session, index) {
    return this.#publishedStartTime(session, index);
  }

  #publishedStartTime(session, index) {
    return publishedStartTime(session.timeline, index, this.segmentDurationSec);
  }

  /**
   * Report a segment whose own timeline disagrees with the playlist by more
   * than a player will bridge.
   *
   * Once per segment per five seconds, like every other repeating condition
   * here: the same segment is requested again and again while it is refused,
   * and a line each time buries the first one.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @param {number} trueStart
   * @param {number} publishedStart
   * @returns {void}
   */
  #notePlaylistDisagreement(session, index, trueStart, publishedStart) {
    const now = Date.now();
    session.stampWarnedAt ??= new Map();
    if (now - (session.stampWarnedAt.get(index) ?? 0) < 5_000) {
      return;
    }
    session.stampWarnedAt.set(index, now);
    logger.warn(
      `transcode ${session.id} segment #${index} carries ${trueStart.toFixed(3)}s while the playlist ` +
      `the player holds says ${publishedStart.toFixed(3)}s — a gap of ` +
      `${Math.abs(trueStart - publishedStart).toFixed(3)}s, beyond the ${PLAYER_BUFFER_HOLE_SEC}s a player ` +
      "bridges; stamping it where the playlist says so the fragment lands where it was asked for"
    );
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
    // The player's grid, for the same reason the cut list uses it: the time
    // being resolved came from the playlist the player holds, so the index it
    // means is the index that playlist gives it.
    return segmentIndexForTime(this.publishedGridFor(session), t, this.segmentDurationSec);
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
  #chooseEncodeBudget({
    transcodeVideo,
    targetWidth,
    targetHeight,
    sourceWidth,
    sourceHeight,
    outputFps,
    source = null,
    requiredSpeed = null
  }) {
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
      { decodeModel: this.decodeCostModel, source, requiredSpeed }
    );
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
   * Kept per viewer. A browser that does not say who it is lands under one
   * shared key, which is exactly the old behaviour for that browser and no
   * worse: with one viewer the two are the same thing.
   *
   * @param {string} sessionId
   * @param {{ linkMbps: number, bufferedAheadSec: number, consumerId?: string, positionSeconds?: number }} report
   * @returns {boolean}
   */
  recordNetReport(sessionId, { linkMbps, bufferedAheadSec, consumerId, positionSeconds, playing }) {
    const named = this.sessionsById.get(sessionId);
    if (!named || named.state === "disposed") {
      return false;
    }
    // A throughput that is not a positive finite number is not a measurement,
    // and it reaches an encoder's `-maxrate` from here.
    if (!Number.isFinite(linkMbps) || !(linkMbps > 0) || !Number.isFinite(bufferedAheadSec)) {
      return false;
    }
    // The link carries the stream on screen, so the report belongs to the
    // variant producing it — that is the encoder whose bitrate it can bound.
    // Whose screen, is the reporter's own: with two viewers on two rungs, the
    // report of one of them says nothing about the other's encoder.
    const session = this.#activeVariant(named, typeof consumerId === "string" ? consumerId : "");
    const now = Date.now();
    this.viewers
      .of(session, typeof consumerId === "string" && consumerId.length > 0 ? consumerId : "")
      .report({ linkMbps, bufferedAheadSec, positionSeconds, playing }, now);
    // A stale reading must not go on deciding for the viewers still here: a
    // report describes a link at a moment, and a viewer who seeked since then
    // is somewhere else entirely.
    //
    // Only the READING expires. Whether the person is still watching is a
    // different question with its own answer — their connection — and a viewer
    // who has simply stopped reporting is not thereby gone. Answering both from
    // this one place is what stopped a soundtrack's encoder on 2026-09-05.
    for (const viewer of viewersOf(session).values()) {
      const report = viewer.netReport;
      if (report !== null && now - report.at > LINK_REPORT_FRESH_MS) {
        viewer.netReport = null;
      }
    }
    return true;
  }

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
   * A head is forgotten once it is older than the whole cushion plus a segment:
   * a viewer who is playing asks for a segment every segment of playback, and
   * one whose buffer is full asks again by the time it has drained, so a longer
   * silence than that means they are paused or gone. Neither needs data ahead
   * of them, so neither should hold the encoder there. The figure is the
   * proxy's own look-ahead, not a chosen interval.
   *
   * @param {HlsSession} session
   * @param {string} consumerId
   * @param {number} segment
   * @param {number} seconds
   * @returns {{ segment: number, seconds: number }} The furthest live head.
   */
  #noteConsumerHead(session, consumerId, segment, seconds) {
    const now = Date.now();
    const heads = headsOf(session);
    // What this viewer STATED, kept across their requests. A request is
    // evidence about where their player is reading; a seek is the viewer saying
    // where they are, and the two answer different questions — see
    // `viewerPositionSource`. Only a seek writes it, so a request does not erase
    // it.
    const viewer = this.viewers.of(session, consumerId, now);
    viewer.moveTo(seconds, now);
    this.planEncodersSoon();
    const staleAfterMs = this.presenceStaleAfterMs();
    let furthest = { segment, seconds };
    for (const [key, other] of heads) {
      if (!other.isPresent(now, staleAfterMs)) {
        // Nothing has been heard from them for longer than any silence a
        // watching viewer can produce — not merely longer than a segment. They
        // go through the one exit, which also releases what they had claimed of
        // production.
        this.#viewerLeaves(session, key);
        continue;
      }
      const theirs = other.positionSeconds();
      if (theirs !== null && theirs > furthest.seconds) {
        furthest = { segment: this.#segmentIndexForTime(session, theirs), seconds: theirs };
      }
    }
    return furthest;
  }

  /**
   * Where one named viewer is, or null when this session has never heard from
   * them — an older browser, a transport that cannot carry the id, or a viewer
   * whose head has expired.
   *
   * @param {HlsSession} session
   * @param {string} consumerId
   * @returns {number | null} Seconds.
   */
  #consumerPositionOf(session, consumerId) {
    if (!consumerId) {
      return null;
    }
    const head = session.viewers?.get(consumerId)?.position;
    return head && Number.isFinite(head.seconds) ? head.seconds : null;
  }

  /**
   * The worst of what the viewers of this session report, as one reading.
   *
   * The budget asks one question — is anybody failing to keep up — so both
   * terms are the worst case: the slowest link and the emptiest buffer, which
   * may belong to different people. That is deliberate. Taking the last report
   * instead meant a session with two viewers acted on whichever of them
   * happened to report most recently.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @returns {{ linkMbps: number, bufferedAheadSec: number, at: number, viewers: number } | null}
   *   Null when nothing fresh measures the link, which is the silence every
   *   caller already treats as "no opinion".
   */
  #worstNetReport(session, now) {
    let worst = null;
    for (const viewer of viewersOf(session).values()) {
      const report = viewer.netReport;
      if (report === null || now - report.at > LINK_REPORT_FRESH_MS) {
        continue;
      }
      if (worst === null) {
        worst = {
          linkMbps: report.linkMbps,
          bufferedAheadSec: report.bufferedAheadSec,
          at: report.at,
          viewers: 1
        };
        continue;
      }
      worst.linkMbps = Math.min(worst.linkMbps, report.linkMbps);
      worst.bufferedAheadSec = Math.min(worst.bufferedAheadSec, report.bufferedAheadSec);
      worst.at = Math.max(worst.at, report.at);
      worst.viewers += 1;
    }
    return worst;
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
    const named = this.sessionsById.get(sessionId);
    if (!named || named.state === "disposed") {
      return false;
    }
    // Which of the two streams the report is about. The browser addresses
    // everything to the video session's id — the soundtrack is served under
    // `/a/<n>/` on that same id — but it is a session of its own, with its own
    // run and its own position, and that is exactly the pair this report exists
    // to tell apart. Answering an audio report from the picture's records would
    // state, confidently, something about the wrong stream.
    const onScreen = this.#activeVariant(named);
    const session = track === "audio"
      ? ([...this.liveOutputs.familyOf(onScreen)].find((member) => member.audioOnly === true) ?? onScreen)
      : onScreen;
    const gap = fragStartSec - bufferEndSec;
    const declared = this.#publishedStartTime(session, sn);
    const trueStart = session.trueStartByIndex instanceof Map ? session.trueStartByIndex.get(sn) : undefined;
    const verdict = trueStart === undefined
      // Where a segment truly began is only ever read off one that was cut on
      // an explicit list — a uniform grid has nothing to read back — so this is
      // "not recorded", which is not the same as "not produced", and the line
      // must not claim the second.
      ? "where that segment began is not recorded on this side, so the gap cannot be attributed here"
      : (() => {
        const at = this.#boundaryIndexAt(session, trueStart, this.publishedGridFor(session));
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
      `transcode ${session.id} the player is stuck: ${session.audioOnly === true ? "sound" : "picture"} ` +
      `fragment #${sn} starts ${gap.toFixed(1)}s past ` +
      `the end of its buffer (${bufferEndSec.toFixed(1)}s, viewer at ${currentTimeSec.toFixed(1)}s, ` +
      `the playlist puts it at ${declared.toFixed(3)}s) — ${verdict}`
    );
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
      names = this.#producedIndex(session).fileNames();
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
    const report = this.#worstNetReport(session, now);
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
    session.linkSlowSince = 0;
    // How many viewers the two figures were taken over, because with more than
    // one they are the worst of each and need not belong to the same person.
    const reasonText =
      `link=${report.linkMbps.toFixed(2)}Mbps stream=${observed.toFixed(2)}Mbps ` +
      `buffer=${report.bufferedAheadSec.toFixed(1)}s` +
      (report.viewers > 1 ? ` (worst of ${report.viewers} viewers)` : "");
    // Which lever this branch HAS, which is not the same on both paths.
    //
    // A re-encoded picture can simply be told to make fewer bits at the size it
    // is already making, and the target is not chosen — it is the link the
    // browser just measured. Nothing about the picture's size moves, so the one
    // init segment the player holds goes on describing every fragment.
    //
    // A COPIED picture is not being encoded at all, so it has no rate to lower:
    // its bitrate is the source's. The only way to send fewer bits is to send
    // another rendering of the film, which is a re-encoded rung — a change of
    // variant, and the player's own switch. This is the whole of what "a change
    // of resolution must exist on the copy path too" asks for.
    if (session.transcodeVideo === true && this.videoEncoder?.kind === "software") {
      return await this.#applyRateCap(session, report.linkMbps, reasonText);
    }
    return this.#askLowerHeight(session, `viewer-link-bound ${reasonText}`);
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
    // The length read here is also what prices the torrent's own work for this
    // file, so it is remembered rather than discarded.

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
    this.#fileLengthByKey.set(SourceFiles.keyFor(sourceKey, fileIndex), fileLength);
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
      if (session?.file.sourceKey === sourceKey &&
          session.file.fileIndex === fileIndex &&
          session.state !== "disposed") {
        readers += 1;
      }
    }
    return readers;
  }

  /**
   * One viewer's demand map, translated into this output's segment numbers.
   *
   * The map itself is seconds of film and knows nothing about cut grids
   * (`services/priority/PriorityMap.js`). The translation is this output's own
   * business, and it is exact: the timeline holds the boundaries.
   *
   * Two measurements feed it, and neither is chosen here:
   *
   * 1. the allowance below which an interruption reaches the viewer, from this
   *    file's own recent interruptions (`minimumBufferFrom`). Null until the
   *    reader has seen two of them, and then only the segment itself counts;
   * 2. how fast this machine encodes THIS track, from ffmpeg's own progress.
   *    Below realtime it decides how much has to exist before playback starts;
   *    above it, nothing beyond the allowance is needed.
   *
   * @param {object} session
   * @param {number} atSegment - Where the viewer is.
   * @returns {{from: number, to: number, priority: number}[]} In segment
   *   numbers, both ends inclusive.
   */
  #demandZonesFor(session, atSeconds, playing = true) {
    const boundaries = session.timeline?.boundaries ?? [];
    const segmentCount = Number(session.timeline?.segmentCount) || 0;
    // Where they are, in this output's own numbering. The viewer holds seconds;
    // every cut grid turns them into its own numbers, and two grids of one film
    // give different numbers for the same second.
    const atSegment = segmentCount > 0 ? this.#segmentIndexForTime(session, atSeconds) : 0;
    if (segmentCount <= 0) {
      // No playlist yet: the only thing that can be said is that they want
      // where they are.
      return [{ from: atSegment, to: atSegment, priority: 3 }];
    }
    const durationSeconds = Number(boundaries[boundaries.length - 1]) ||
      segmentCount * this.segmentDurationSec;
    const zones = mapForViewer({
      atSeconds,
      durationSeconds,
      allowanceSeconds: minimumBufferFrom({
        segmentSeconds: this.segmentDurationSec,
        worstSupplyWaitSec: session.supplyFigures?.worstWaitSec
      })?.seconds ?? this.segmentDurationSec,
      playing
    });
    /** @type {{from: number, to: number, priority: number}[]} */
    const inSegments = [];
    for (const zone of zones) {
      const from = Math.max(atSegment, this.#segmentIndexForTime(session, zone.from));
      const to = Math.min(segmentCount - 1, this.#segmentIndexForTime(session, zone.to));
      if (to >= from) {
        inSegments.push({ from, to, priority: zone.priority });
      }
    }
    return inSegments.length > 0
      ? inSegments
      : [{ from: atSegment, to: atSegment, priority: 3 }];
  }

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
    for (const session of this.sessionsById.values()) {
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
      const index = this.#segmentIndexForTime(session, seconds);
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
   * How long nothing may be heard from a viewer before this process concludes
   * they are gone.
   *
   * A backstop and nothing more. A viewer leaves by SAYING so — the browser
   * releases the session, or their connection closes — and this covers only the
   * case where nothing said it: a data channel's close event does not always
   * come, and a transport that is not a data channel may have nothing to say at
   * all.
   *
   * The figure is the proxy's own cushion plus a segment, which is the longest
   * silence a watching viewer can produce: one holding a full cushion asks for
   * nothing until it has drained, and one playing asks once a segment.
   *
   * @returns {number}
   */
  presenceStaleAfterMs() {
    return (this.lookaheadSeconds + this.segmentDurationSec) * 1000;
  }

  /**
   * Re-decide what encoders should exist, once, after the change that is being
   * made now.
   *
   * COALESCED, NOT DELAYED. One turn of the event loop may carry several
   * changes — a viewer arrives and is placed and states their soundtrack — and
   * each of them is a reason to re-decide, while re-deciding three times in a
   * row would give the same answer three times and could act on a half-built
   * state. So the decision is taken once, after the current turn, and no
   * interval is involved: there is nothing to choose and nothing to tune.
   *
   * @returns {void}
   */
  planEncodersSoon() {
    if (this.#planScheduled) {
      return;
    }
    this.#planScheduled = true;
    queueMicrotask(() => {
      this.#planScheduled = false;
      try {
        this.planEncodersNow();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`transcode could not re-plan encoders: ${message}`);
      }
    });
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
  planEncodersNow() {
    /** @type {Map<string, HlsSession[]>} */
    const byOutput = new Map();
    for (const session of this.sessionsById.values()) {
      const address = session.outputKey ?? "";
      if (!address || session.state === "disposed") {
        continue;
      }
      byOutput.set(address, [...(byOutput.get(address) ?? []), session]);
    }
    const staleAfterMs = this.presenceStaleAfterMs();
    const now = Date.now();
    for (const [address, sessions] of byOutput) {
      const coverage = this.encodeOrchestrator.coverageOf(address);
      // From the TIMELINE, which is where how a file is cut has lived since
      // 2.76.0. Read off the session it left, this was `undefined` on every
      // session ever made: the map then held no length, and the walk that
      // gives a run its end ran to MAX_SAFE_INTEGER — the main thread spun at
      // 100% and the proxy answered nothing, measured on the addon host
      // 2026-09-05 with the stack read out of the live process.
      const segmentCount = Number(sessions[0].timeline?.segmentCount) || 0;
      if (segmentCount > 0) {
        coverage.setSegmentCount(segmentCount);
      }
      coverage.markReadyAll(this.segmentStore.provenNumbers(address));
      for (const session of sessions) {
        for (const run of this.#runsOfSession(session)) {
          this.encodeOrchestrator.adopt(address, run);
        }
        // What the viewers of this session are waiting for, as spans. A viewer
        // wants the segment they are at and the cushion in front of it, which
        // is what the encoder is steered by everywhere else in this class.
        //
        // PRESENCE AND POSITION ARE ASKED SEPARATELY, and that is the whole of
        // the 2026-09-05 fix. Presence decides whether this viewer states a
        // want at all; position decides what the want is. Asked as one question
        // — which is what a single field written only by segment requests
        // amounted to — a viewer who had just arrived answered "absent", every
        // encoder on their output was stopped for having nobody, and the
        // `init.mp4` they were waiting for in order to request their first
        // segment was therefore never made.
        for (const [consumerId, viewer] of viewersOf(session)) {
          if (!viewer.isPresent(now, staleAfterMs)) {
            this.encodeOrchestrator.release(`${session.id}:${consumerId}`);
            continue;
          }
          // Placed when they arrived, from the position their own request
          // named. A viewer with no position is one assembled by hand outside
          // this class; they want the beginning, which is where an output
          // starts when nobody says otherwise.
          // SECONDS, and turned into this output's own numbering below. A
          // segment number taken off the viewer would mean two different
          // moments of film on the picture and on the soundtrack, which are cut
          // independently: 454 pieces against 401 on the field file.
          const at = viewer.positionSeconds() ?? 0;
          // Their own map, in seconds of film, from measurements: how much must
          // be ready before they set off so that they never stop — the observed
          // allowance for this file plus what an encoder at THIS machine's
          // measured speed will fail to deliver in time — then what it reaches
          // while they watch that, then the rest of the track. No constant is
          // consulted: the 120 seconds that used to size this window were the
          // suspended encoder's threshold, one chosen number answering seven
          // different questions.
          for (const zone of this.#demandZonesFor(session, at, viewer.playing !== false)) {
            this.encodeOrchestrator.want({
              // The claimant is the PERSON, without the priority in it: their
              // zones are separate windows, but they leave together, and
              // `release` matches on this name.
              claimant: `${session.id}:${consumerId}`,
              address,
              from: zone.from,
              to: zone.to,
              priority: zone.priority
            });
          }
        }
      }
    }
    this.priority.publishFor({
      sessionGroups: byOutput.values(),
      staleAfterMs: this.presenceStaleAfterMs()
    });
    this.encodeOrchestrator.reconcile();
  }

  /**
   * Make an encoder for this output, beginning at this segment.
   *
   * Another run of the SAME session, not another session. A run at another
   * position is not a different output — the material, the tracks, the grid and
   * the box are all the same, and only where it begins differs, which changes
   * no byte of what is produced. Both write into the output's one directory and
   * either viewer is served whatever either has made.
   *
   * @param {string} address
   * @param {number} from
   * @returns {object | null}
   */
  #makeRunAt(address, from, to) {
    let base = null;
    for (const session of this.sessionsById.values()) {
      if (session.outputKey === address && session.state !== "disposed") {
        base = session;
        break;
      }
    }
    if (!base) {
      return null;
    }
    // A position that has already failed to start, this many times running,
    // will fail again: nothing about it has changed between the attempts, which
    // is exactly why the attempts keep taking the same fraction of a second and
    // ending the same way.
    //
    // The plan is arithmetic over coverage and demand, and neither of them
    // knows that a process refused to start — so without asking here, the plan
    // commands the same start, the run ends, the ended stretch goes back to the
    // map, and the plan commands it again. Measured 2026-09-05 with ffmpeg
    // absent: fifty passes of the plan in the time a probe took to notice, as
    // fast as spawning could fail. The five-second timer this decision used to
    // sit on hid that, at the price of hiding it in the field too — the loop
    // seen there ran for sixteen minutes and read as "a restart every five
    // seconds".
    //
    // A DIFFERENT position is unaffected and gets its own budget, and the count
    // resets the moment a run at this one does real work.
    if (base.failedStartAt === from && base.failedStartCount >= MAX_FAILED_STARTS) {
      return null;
    }
    // The encoder is built and handed back in this same call. Nothing here
    // waits: the one thing this path used to wait for was the death of the run
    // it was replacing, and that killing is gone. Answering with nothing while
    // the encoder was built behind the answer is what let the same stretch be
    // started over and over — 684 starts in 482 seconds of field 2026-09-05.
    try {
      return this.#startEncodeRun(base, from, undefined, "the plan asked for an encoder here", { to });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`transcode could not start a run at #${from} of ${address}: ${message}`);
      return null;
    }
  }

  /**
   * This session's run, told what the disk holds before it is asked where it
   * has got to.
   *
   * A run learns of its own segments as they are SERVED, which is not when they
   * are made — a viewer two minutes behind the encoder has asked for none of
   * what is in front of them. The store knows, so the run is told, and its head
   * is then the same figure the look-ahead and the plan have always used.
   *
   * @param {HlsSession} session
   * @returns {import("./encode/EncodeRun.js").EncodeRun[]}
   */
  #runsOfSession(session) {
    const runs = liveRunsOf(session);
    if (runs.length === 0) {
      return runs;
    }
    const produced = this.producedSegmentNumbers(session);
    for (const run of runs) {
      for (const index of produced) {
        if (index >= run.from) {
          run.noteProduced(index);
        }
      }
    }
    return runs;
  }

  /**
   * How many encoders this machine can afford on one output at once.
   *
   * Measured rather than chosen, and it is the same arithmetic that decides
   * which quality steps are offered: what a second job costs here is not
   * assumed to be nothing. Field 2026-09-03 on the addon host, `testsrc2`
   * through libx264 `ultrafast` — at 854x480 one run makes 7.12x and two make
   * 4.20x and 4.16x, so both stay far above realtime and a second is
   * affordable; at 1920x1080 one makes 1.96x and two make 0.99x and 0.98x, so
   * the machine is full at one.
   *
   * @param {string} address
   * @returns {number}
   */
  maxRunsForOutput(address) {
    let alone = 0;
    for (const session of this.sessionsById.values()) {
      if (session.outputKey !== address || session.state === "disposed") {
        continue;
      }
      const measured = Number(session.recentSpeed?.speed);
      if (Number.isFinite(measured) && measured > alone) {
        alone = measured;
      }
    }
    if (!(alone > 0)) {
      // Nothing measured on this output yet. One encoder is what it has, and
      // what it has is what it keeps until there is a reading to argue with.
      return 1;
    }
    let affordable = 1;
    for (;;) {
      const { penalty, measured, from } = contentionPenalty(affordable, this.contentionPenalties);
      // An UNMEASURED penalty is 1, and that is the honest answer to "what does
      // a second job cost" only in the sense that nothing has been measured —
      // it is not a statement that a second job is free. Measured on the addon
      // host it is 1.70x at 854x480 and 1.98x at 1920x1080, so taking 1 would
      // let a machine that cannot hold two runs start two. Where nothing has
      // been measured, one is what it has.
      //
      // `from` is the concurrency the reading came from, and past the measured
      // range `contentionPenalty` HOLDS the largest reading rather than continue
      // a curve two points cannot describe. Held is the right answer to "what
      // does this cost", and the wrong one to "may I start another": it would
      // price a fifth encoder at what a second was measured to cost, and a fast
      // host would keep dividing until some chosen ceiling stopped it. So the
      // ladder stops where the measurements stop — the bound on how many
      // encoders may run is measured, like the budget itself, and there is no
      // constant here to overrule it.
      if (!measured || from !== affordable || !(alone / penalty >= 1)) {
        break;
      }
      affordable += 1;
    }
    return affordable;
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
  #reportCushionFor(session) {
    if (!session || session.state === "disposed" || liveRunsOf(session).length === 0) {
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
      : (earliestRunStart(session) ?? 0);

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
    const claimed = Number(session.progress?.processedSeconds);
    const encodedTo = this.#segmentStartTime(session, viewerSegment) + aheadSeconds;
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
    const fileLength = this.#fileLengthByKey.get(session.file.key);
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
      present = this.#producedIndex(session).segmentNumbers();
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
   * A segment this run made has just been served.
   *
   * The one event whose raising is guarded by the state, and the guard is a
   * READ of the state rather than a second copy of it: "something has been
   * produced" is a level, not an edge, so without the guard every served
   * segment would raise it and the log would fill with refusals.
   *
   * Whose file it is decides the rest, and the directory answers that outright:
   * runs write into one each, and serving searches them newest-first, so a
   * segment left by an EARLIER run is served routinely. Comparing indices
   * instead would have been fooled by the ordinary case of a backward seek —
   * the new run starts at #10, the old one left #50 on disk, and #50 is above
   * the new run's start index while saying nothing about it.
   *
   * @param {HlsSession} session
   * @param {string} filePath - Where the served segment was actually found.
   * @returns {void}
   */
  #noteRunProducedSegment(session, filePath) {
    if (typeof filePath !== "string" || path.dirname(filePath) !== session.dirPath) {
      return;
    }
    const index = session.segmentFormat.segmentIndexFromName(path.basename(filePath));
    if (index === null) {
      return;
    }
    // Whichever run was given this number. A session has as many runs as the
    // machine affords, and a segment moves the one it belongs to out of
    // starting — not whichever happens to be listed first.
    ownRunMaking(session, index)?.noteProduced(index);
  }

  /**
   * How many of this proxy's encoders are running right now.
   *
   * Suspended runs are not counted: a process stopped by the look-ahead cap
   * competes for nothing, and counting it would price a machine as busier than
   * it is — the same distinction the host-load line had to learn (2026-08-15,
   * `ffmpeg=0% system=24%` with both encoders parked).
   *
   * @returns {number}
   */
  #encodersRunningNow() {
    let running = 0;
    for (const session of this.sessionsById.values()) {
      const state = runStateOf(session);
      if (state === ENCODE_RUN_STATE.STARTING || state === ENCODE_RUN_STATE.PRODUCING) {
        running += 1;
      }
    }
    return running;
  }

  /**
   * Suspend a session's encoder. No-op when already paused or unsupported here.
   *
   * @param {HlsSession} session
   * @param {string} reason
   * @returns {void}
   */
  #pauseEncoder(session, reason) {
    // Any pair spanning this would count a stopped encoder as slow.
    session.learnSample = null;
    for (const run of liveRunsOf(session)) {
      run.pause(reason);
    }
  }

  /**
   * Let a suspended encoder run again.
   *
   * Answers whether a process was actually continued, because three of the four
   * callers do this in order to KILL it — a suspended process ignores SIGTERM
   * until it is running — and only the two look-ahead callers mean "carry on".
   * The run's state is theirs to move; a continue-then-kill is not a resume.
   *
   * @param {HlsSession} session
   * @param {string} reason
   * @returns {boolean} True when a live process was continued.
   */
  #resumeEncoder(session, reason) {
    // Any pair spanning this would count a stopped encoder as slow.
    session.learnSample = null;
    let resumed = false;
    for (const run of liveRunsOf(session)) {
      resumed = run.resume(reason) || resumed;
    }
    return resumed;
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
    // Divided by the cores, because `process.cpuUsage()` adds up every thread
    // while everything this figure is later added to is measured in WALL
    // seconds per second of video. Left undivided on the four-core addon host
    // it overstated the torrent by four times, which on the field's own rung
    // was the difference between offering it and refusing it.
    const cores = Math.max(1, os.cpus().length);
    const cpuSeconds = (now.cpuSeconds - previous.cpuSeconds) / cores;
    if (megabytes === 0) {
      // Nothing encoding and not one byte moved: whatever this process spent in
      // that interval, it spends whether or not there is a torrent. Measuring
      // it is what lets the next interval be attributed instead of divided
      // whole — see `torrent-cost.js` for the readings that forced this.
      this.#learnBaseDraw(baseDrawFrom({ cpuSeconds, elapsedSeconds: elapsedSec }));
      return;
    }
    const costPerMegabyte = costPerMegabyteFrom({
      cpuSeconds,
      elapsedSeconds: elapsedSec,
      megabytes,
      baseDraw: this.#observedBaseDraw,
      // How much the draw's own readings disagree, which is how much of this
      // interval's remainder means nothing.
      drawScatter: scatterOf(this.#baseDrawReadings)
    });
    if (costPerMegabyte === null) {
      return;
    }
    const readings = [...this.#torrentCostReadings, costPerMegabyte].slice(-DECODE_LEARNING_READINGS);
    this.#torrentCostReadings = readings;
    const median = medianOf(readings);
    if (!movedBeyondScatter(this.#observedTorrentCostPerMegabyte, median, readings)) {
      return;
    }
    this.#observedTorrentCostPerMegabyte = median;
    logger.info(
      `host-load: the torrent costs ${(median * 1000).toFixed(1)}ms of CPU per MB on this host ` +
      `(median of ${readings.length}, latest ${(costPerMegabyte * 1000).toFixed(1)}ms over ${megabytes.toFixed(1)}MB, ` +
      `base draw ${((this.#observedBaseDraw ?? 0) * 100).toFixed(1)}% of a core already taken off)`
    );
  }

  /**
   * What each watched file's torrent is moving right now.
   *
   * The torrent is priced per megabyte it moves, so the price has to be charged
   * against the megabytes it IS moving. Charged against the file's own byte
   * rate — what the viewer consumes — it asks for payment on a fully downloaded
   * file that is moving nothing, and it under-charges a file being fetched
   * ahead of the viewer, which is the state every session starts in.
   *
   * Rebuilt whole each tick from the live sessions, so an entry that is here
   * was taken this tick and a source nobody is watching leaves by itself.
   *
   * @returns {Promise<void>}
   */
  async #sampleDownloadRates() {
    if (!this.getSourceStats) {
      return;
    }
    /** @type {Map<string, { sourceKey: string, fileIndex: number }>} */
    const wanted = new Map();
    for (const session of this.sessionsById.values()) {
      if (!session || session.state === "disposed") {
        continue;
      }
      wanted.set(session.file.key, {
        sourceKey: session.file.sourceKey,
        fileIndex: session.file.fileIndex
      });
    }
    /** @type {Map<string, number>} */
    const measured = new Map();
    for (const [key, source] of wanted) {
      try {
        const stats = await this.getSourceStats(source.sourceKey, source.fileIndex);
        // The TORRENT's rate, which is what it is: one swarm feeding one
        // client, whichever of its files are being read. Kept per source and
        // divided among the files being watched, so two episodes of one pack
        // do not each charge the machine for the whole download.
        const rate = Number(stats?.downloadSpeed);
        if (Number.isFinite(rate) && rate >= 0) {
          measured.set(source.sourceKey, rate);
        }
        // Kept, not rebuilt: the demand a swarm made on this file does not stop
        // being true when a tick fails to fetch it, and it is what the FIRST
        // offer of the next session will be judged against.
        const demanded = Number(stats?.supply?.requiredSpeed);
        if (Number.isFinite(demanded) && demanded > 0) {
          this.#requiredSpeedByKey.set(key, demanded);
        }
        // And onto the sessions themselves, which is where the browser's
        // minimum buffer is read from. Set only by the downshift check until
        // now, it stood still on every session that never fell below realtime,
        // so the figures the viewer waits on were minutes old or absent.
        if (stats?.supply) {
          for (const session of this.sessionsById.values()) {
            if (session?.file.sourceKey === source.sourceKey && session.file.fileIndex === source.fileIndex) {
              session.supplyFigures = stats.supply;
            }
          }
        }
      } catch {
        // The pool is busy or gone. A reading missed is not a fault, and the
        // key simply does not appear this tick.
      }
    }
    this.#downloadRateByKey = measured;
  }

  /**
   * How many files of one torrent have a live session reading them.
   *
   * @param {string} sourceKey
   * @returns {number} At least one, so the rate is never divided by nothing.
   */
  #filesWatchedOn(sourceKey) {
    const files = new Set();
    for (const session of this.sessionsById.values()) {
      if (session && session.state !== "disposed" && session.file.sourceKey === sourceKey) {
        files.add(session.file.fileIndex);
      }
    }
    return Math.max(1, files.size);
  }

  /**
   * The speed this file's supply demands, as last measured on this swarm.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {number | null}
   */
  #requiredSpeedFor(sourceKey, fileIndex) {
    return this.#requiredSpeedByKey.get(SourceFiles.keyFor(sourceKey, fileIndex)) ?? null;
  }

  /**
   * How many megabytes a second the torrent is moving for this file — measured
   * where a reading exists, and otherwise the rate the file has to be moved at
   * to be watched at all (its length over its duration), which is what the
   * measured rate averages to over a viewing.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @param {number | null} fileLengthBytes
   * @param {number | null} durationSeconds
   * @returns {number | null}
   */
  #torrentMegabytesPerSecond(sourceKey, fileIndex, fileLengthBytes, durationSeconds) {
    const measured = this.#downloadRateByKey.get(sourceKey);
    if (Number.isFinite(measured)) {
      return measured / 1e6 / this.#filesWatchedOn(sourceKey);
    }
    // The FILE's rate, not the video stream's. What the torrent moves is the
    // container: on the releases this serves, two or three AC-3 tracks add
    // 10-25 % to what the picture alone would suggest.
    const fileLength = Number(fileLengthBytes);
    const duration = Number(durationSeconds);
    if (Number.isFinite(fileLength) && fileLength > 0 && Number.isFinite(duration) && duration > 0) {
      return fileLength / duration / 1e6;
    }
    return null;
  }

  /**
   * Record what this process draws when it is doing none of the work that gets
   * priced.
   *
   * @param {number | null} share - Of one core, over the interval just read.
   * @returns {void}
   */
  #learnBaseDraw(share) {
    if (share === null) {
      return;
    }
    const readings = [...this.#baseDrawReadings, share].slice(-DECODE_LEARNING_READINGS);
    this.#baseDrawReadings = readings;
    const median = medianOf(readings);
    if (!movedBeyondScatter(this.#observedBaseDraw, median, readings)) {
      return;
    }
    this.#observedBaseDraw = median;
    logger.info(
      `host-load: this process draws ${(median * 100).toFixed(1)}% of a core with nothing encoding and ` +
      `nothing downloading (median of ${readings.length}, latest ${(share * 100).toFixed(1)}%)`
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
      // Downloaded bytes only. Every one of them is verified against the piece
      // hash and written to the store; a byte sent back to the swarm is neither,
      // and adding the two would price both at whatever the mixture happened to
      // be on the day.
      const downloaded = Number(totals?.downloaded);
      return Number.isFinite(downloaded) ? downloaded : null;
    } catch {
      return null; // the pool is busy or gone; a reading missed is not a fault
    }
  }

  async #reportHostLoad() {
    const encoding = [...this.sessionsById.values()].filter(
      (session) => processCanBeSignalled(runStateOf(session)) && session.state !== "disposed"
    );
    const runningNow = encoding.filter((session) => runStateOf(session) !== ENCODE_RUN_STATE.SUSPENDED);
    if (runningNow.length === 0) {
      // No encoder is RUNNING. A suspended one costs nothing, and counting it
      // as work meant this was never reached: measured 2026-08-15, four minutes
      // in which every encoder was suspended, the torrent's price could have
      // been taken, and none was. What this process spends now is the download,
      // the verification, the piece store and the delivery. Item 7.
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
    const pids = encoding.flatMap((session) => liveRunsOf(session).map((run) => run.process?.pid ?? null)).filter((pid) => pid !== null);
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
    const suspended = encoding.filter((session) => runStateOf(session) === ENCODE_RUN_STATE.SUSPENDED).length;
    const running = encoding.length - suspended;
    const machine = await readMachineState();
    const asPercent = (value) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
    const cores = Math.max(1, os.cpus().length);
    const proxyShare = Number.isFinite(previous.proxyCpuSeconds)
      ? (sample.proxyCpuSeconds - previous.proxyCpuSeconds) / (share.elapsedSec * cores)
      : null;
    // Kept for the quality offer, which predicts from a benchmark taken on a
    // QUIET host: the same reading that is printed here says how much of the
    // machine a new encoder could actually have. Only what nobody has been
    // charged for is subtracted — see `available-share.js`.
    this.hostAvailability = availableShareFrom({
      systemBusy: share.systemShare,
      encoderShare: share.processShare,
      proxyShare
    });
    logger.info(
      `host-load: ffmpeg=${asPercent(share.processShare)} proxy=${asPercent(proxyShare)} ` +
      `system=${asPercent(share.systemShare)} ` +
      `iowait=${asPercent(share.iowaitShare)} cpu=${machine.megahertz === null ? "n/a" : `${machine.megahertz}MHz`} ` +
      `temp=${machine.celsius === null ? "n/a" : `${machine.celsius}C`} ` +
      `encoders=${running} running` + (suspended > 0 ? ` +${suspended} suspended` : "") +
      ` over=${share.elapsedSec.toFixed(1)}s` +
      // What the offer will multiply a prediction by, in the same line as the
      // readings it comes from.
      ` available=${asPercent(this.hostAvailability.share)}`
    );
  }

  /**
   * One pass of the quality budget: learn what this host is doing with each
   * running encode, and act on it.
   *
   * Public because it is an operation with a name, not an implementation
   * detail of a timer — and because a loop that decides what the viewer sees
   * and can only be reached through `setInterval` is a loop nothing can check.
   * The timer calls exactly this.
   *
   * @returns {Promise<void>}
   */
  async runQualityBudgetOnce() {
    void this.#reportHostLoad();
    // One tick at a time. Both halves await torrent statistics per source, so a
    // slow or stuck answer would otherwise let the next tick in behind it — two
    // passes over the same sessions, taking the same reading twice and acting
    // on the same speed twice, and an earlier tick's rates landing on top of a
    // later tick's.
    if (this.budgetTickRunning === true) {
      return;
    }
    this.budgetTickRunning = true;
    try {
      // Taken whatever the encoder is: the torrent's price is charged against
      // this rate on every host, not only on the ones that re-encode.
      await this.#sampleDownloadRates();
      if (this.videoEncoder?.kind !== "software") {
        return;
      }
      await this.#realtimeBudgetPass();
    } finally {
      this.budgetTickRunning = false;
    }
  }

  /** One pass over the sessions. See {@link runQualityBudgetOnce}. */
  async #realtimeBudgetPass() {
    const now = Date.now();
    for (const session of this.sessionsById.values()) {
      // What this file costs to decode is learned from EVERY encoding session,
      // before any of the budget's own conditions are consulted. Those exist to
      // decide whether to step the quality, and they exclude most of what is
      // worth measuring: a rung already at the foot of its ladder has nowhere
      // to step, and a 240p variant IS its whole ladder — which is exactly the
      // rung the field measured at 0.95x on 2026-08-15, learning nothing from
      // three minutes of it because the loop had already skipped the session as
      // un-actionable.
      await this.#learnFromEncoder(session);
      if (
        !session ||
        session.state === "disposed" ||
        runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED ||
        // Nothing is encoding, so there is no speed to judge. A variant the
        // viewer has switched away from is left in exactly this state, and its
        // last recorded speed would otherwise buy it a step — which restarts
        // the encoder it was just stopped for.
        liveRunsOf(session).length === 0 ||
        // A soundtrack published on its own carries no picture, so no quality
        // step is its to make; its price is learned above and that is all.
        session.audioOnly === true
      ) {
        continue;
      }
      // The cooldown belongs to the FAMILY, not to one rung of it. A step asks
      // the player to move to another session, so the rung that acted and the
      // rung that then runs are different objects, and a cooldown kept on each
      // separately would let the new one act again immediately.
      if (now - this.liveOutputs.pictureOf(session).budgetLastActionAt < BUDGET_ACTION_COOLDOWN_MS) {
        continue;
      }
      // Viewer-link deficit first (adaptive bitrate): independent of encoder
      // speed — a thin cellular link starves even a faster-than-realtime
      // encode.
      if (await this.#checkLinkBudget(session, now)) {
        continue;
      }
      if (await this.#checkEncoderBudget(session, now)) {
        continue;
      }
      await this.#checkStepUp(session, now);
    }
  }

  /**
   * The speed this run is making RIGHT NOW, or null when nothing recent enough
   * says.
   *
   * Read as the slope between two progress reports, never as ffmpeg's own
   * `speed=`. That figure is cumulative — output time over wall time since the
   * run began — so a run starved of torrent data early carries the average of
   * that starvation for the rest of its life. Measured 2026-08-21: a run whose
   * progress lines showed 1.30x at that moment (13 s of video in 10.02 s of
   * clock) still reported a cumulative 0.39x from four minutes on a ~100 KB/s
   * swarm, and the budget stepped the picture down on it. The same mistake was
   * found and solved once already — the startup decode benchmark reads the
   * slope between two progress reports for exactly this reason.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @returns {number | null}
   */
  #recentSpeedOf(session, now) {
    const reading = session.recentSpeed;
    if (!reading || !session.runs?.has(reading.run)) {
      return null; // nothing from THIS run
    }
    // Two budget ticks. A reading older than that is not about the machine as
    // it stands, and the loop takes a fresh one every pass anyway.
    if (now - reading.at > BUDGET_CHECK_INTERVAL_MS * 2) {
      return null;
    }
    return reading.speed;
  }

  /**
   * The encoder-speed check for one session: sustained sub-realtime, and the
   * encoder — not a download-starved input — is the limit.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @returns {Promise<boolean>} True when a step was asked for this tick.
   */
  async #checkEncoderBudget(session, now) {
    if (session.transcodeVideo !== true) {
      // A copy has no encoder to make cheaper. Whatever the machine is short
      // of, moving this viewer to a RE-ENCODED rung costs it more, not less —
      // so the copy path's only lever is the viewer's link, above.
      return false;
    }
    const speed = this.#recentSpeedOf(session, now);
    if (speed === null) {
      return false; // no measurement yet
    }
    if (speed >= BUDGET_SPEED_OK) {
      session.budgetSlowSince = 0; // recovered — reset the slow window
      return false;
    }
    if (speed >= BUDGET_SPEED_SLOW) {
      return false; // in the hysteresis band; neither slow nor ok
    }
    if (session.budgetSlowSince === 0) {
      session.budgetSlowSince = now;
      return false;
    }
    if (now - session.budgetSlowSince < BUDGET_SUSTAINED_MS) {
      return false; // not sustained yet
    }
    const bound = await this.#classifyTranscodeBound(session);
    if (bound === "download") {
      logger.info(
        `[budget] transcode ${session.id} speed=${speed.toFixed(2)}x but download-limited ` +
          `"${session.file.name}"; not stepping down (torrent is the bottleneck)`
      );
      session.budgetSlowSince = 0; // re-evaluate fresh; don't thrash on this
      return false;
    }
    session.budgetSlowSince = 0;
    session.budgetUpSince = 0;
    const boundLabel = bound === "unknown" ? "assuming CPU-bound" : "CPU-bound";
    return this.#askLowerHeight(session, `${boundLabel} speed=${speed.toFixed(2)}x`);
  }

  /**
   * Ask the player to move down one offered rung.
   *
   * THE SIZE OF THE PICTURE IS NEVER REWRITTEN UNDERNEATH A RUNNING SESSION.
   * The fMP4 init segment is fetched once — a player reads `#EXT-X-MAP` and
   * never asks again — and `avc1` keeps SPS and PPS in it rather than in the
   * fragments, so every fragment produced after a size change is decoded
   * against parameter sets describing a picture that is no longer being made.
   * Measured 2026-08-21 on two files: one browser went on reporting
   * `size=1280x720` for three and a half minutes over a band of macroblock
   * garbage after the encoder had left for 960x540; the other errored on the
   * first mismatched fragment, closed the MediaSource and sat at `size=0x0`
   * for four and a half minutes. Which of the two happens is the decoder's
   * choice, not ours, and no layer reported an error either time.
   *
   * A change of resolution is a change of VARIANT, as the standard has it.
   * Every height is already published in the master with its own init, so the
   * step is made by ASKING the browser to move — the same act the manual menu
   * performs, which has never had this fault.
   *
   * @param {HlsSession} session
   * @param {string} reasonText
   * @returns {boolean} True when an ask was recorded.
   */
  #askLowerHeight(session, reasonText) {
    const base = this.liveOutputs.pictureOf(session);
    const current = this.liveOutputs.variantHeightOf(session);
    const offered = this.offeredHeights(base);
    // The highest rung strictly below the one on screen that this host is still
    // willing to serve. `offeredHeights` has already refused everything the
    // machine cannot hold, so a rung that survives it is one worth moving to.
    const next = this.liveOutputs.splicableHeights(base)
      .find((height) => height < current && offered.includes(height));
    if (next === undefined) {
      // Nothing lower — but "lower" is not the same question as "cheaper", and
      // on a source that is COPIED the answer is above, not below. A copied
      // rung costs no encoder at all, whatever its size, so when a re-encode
      // cannot keep up it is both the fastest thing this host can serve AND the
      // best picture it has.
      //
      // Field 2026-08-31, and it cost the viewer the whole film: an ultrafast
      // 444x240 encode ran at 0.43-0.94x for fifty minutes while the source's
      // own 1038p sat on offer beside it, copied and free. This line printed
      // fifty times — "nothing lower is on offer; leaving the picture alone" —
      // and the picture stood still 161 times for 940 seconds. The rescue was
      // on the screen the whole time and the rule could only look down.
      const copied = this.#copiedHeightOf(base);
      if (copied > 0 && copied !== current && offered.includes(copied)) {
        logger.info(
          `[budget] transcode ${session.id} ${reasonText} at ${current}p and nothing lower is on offer, ` +
            `but ${copied}p is COPIED on this file — no encoder at all, and a better picture. ` +
            `Asking for it instead of leaving the viewer on an encode that cannot keep up`
        );
        return this.#askQualityHeight(base, copied, reasonText);
      }
      logger.info(
        `[budget] transcode ${session.id} ${reasonText} at ${current}p, but nothing lower is on offer ` +
          `for "${session.file.name}"; leaving the picture alone`
      );
      return false;
    }
    return this.#askQualityHeight(base, next, reasonText);
  }

  /**
   * The height this family serves by COPY, or zero when every rung is encoded.
   *
   * The one rung whose cost does not depend on the machine: the source's own
   * height, on a base whose video is not re-encoded. `offeredHeights` never
   * withdraws it for that reason, so it is always available as somewhere to
   * return to — which is exactly what {@link HlsSessionManager##askLowerHeight}
   * had no way to say.
   *
   * @param {HlsSession} base
   * @returns {number}
   */
  #copiedHeightOf(base) {
    if (!base || base.transcodeVideo === true) {
      return 0;
    }
    return Math.round(Number(base.file.height) || 0);
  }

  /**
   * Record a request to the viewer's player to move to another variant.
   *
   * The proxy cannot move a player between variants; it can only say which one
   * it would rather serve. The request travels in every progress report, and
   * the browser honours it ONLY in automatic mode — a height the viewer picked
   * by hand is theirs, and nothing here may take it away.
   *
   * @param {HlsSession} base
   * @param {number} height
   * @param {string} reasonText
   * @returns {boolean}
   */
  #askQualityHeight(base, height, reasonText) {
    if (!this.liveOutputs.publishesVariants(base)) {
      // Said once for the session. Repeating it is not information: the answer
      // is a property of the stream and cannot change while it plays.
      if (base.saidNoVariants !== true) {
        base.saidNoVariants = true;
        logger.info(
          `[budget] transcode ${base.id} would ask for ${height}p, but this stream publishes no ` +
            `variants to move between; leaving the picture alone for the rest of the session`
        );
      }
      return false;
    }
    const playing = this.liveOutputs.variantHeightOf(this.#activeVariant(base));
    if (height === playing) {
      return false;
    }
    const now = Date.now();
    const standing = base.qualityAsk;
    if (standing && standing.height === height && now - standing.at < QUALITY_ASK_TTL_MS) {
      return false; // already asked, and the request has not run out
    }
    base.qualityAsk = { height, at: now, reason: reasonText };
    base.budgetLastActionAt = now;
    logger.info(
      `[budget] transcode ${base.id} asks the player to move ${playing}p → ${height}p: ${reasonText} ` +
        `"${base.file.name}" (a change of size is a change of variant — its own init describes it)`
    );
    return true;
  }

  /**
   * The step BACK UP, in two stages: first give this picture its own bitrate
   * back, then give it its own size back.
   *
   * The order matters. A rate cap was imposed because the viewer's link could
   * not carry the stream; lifting it is cheaper than enlarging the picture and
   * is what the viewer notices first. Only a session under no cap is considered
   * for a higher rung.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @returns {Promise<void>}
   */
  async #checkStepUp(session, now) {
    const base = this.liveOutputs.pictureOf(session);
    const current = this.liveOutputs.variantHeightOf(session);
    // What the machine and the link would have to look like for a step up, held
    // for a window four times the one a step DOWN needs. Anything that fails
    // resets it, so the window measures an unbroken stretch.
    if (!(await this.#couldCarryMore(session, now, current))) {
      session.budgetUpSince = 0;
      return;
    }
    if (session.budgetUpSince === 0) {
      session.budgetUpSince = now;
      return;
    }
    if (now - session.budgetUpSince < BUDGET_UP_SUSTAINED_MS) {
      return;
    }
    if (Number.isFinite(session.rateCapKbps) && session.rateCapKbps > 0) {
      // A different question from the one above: can the link carry THIS
      // picture with no cap on it. Asked separately because a session at the
      // top offered height has no next rung at all, and answering "nothing to
      // step to, so yes" is how a cap came off a link measured at a fifth of
      // what the picture needs.
      if (!this.#linkCouldCarry(session, this.#peakMbpsForHeight(this.liveOutputs.pictureOf(session), current), now)) {
        return;
      }
      session.budgetUpSince = 0;
      await this.#liftRateCap(session);
      return;
    }
    session.budgetUpSince = 0;
    // One rung at a time: the lowest height above the one on screen, never
    // above the source (upscaling invents detail and costs more than the
    // source itself). A second step follows a second unbroken window.
    const higher = this.#nextHeightUp(base, current);
    if (higher === undefined) {
      return;
    }
    this.#askQualityHeight(
      base,
      higher,
      `the machine and the link have carried ${current}p for ` +
        `${Math.round(BUDGET_UP_SUSTAINED_MS / 1000)}s with room to spare`
    );
  }

  /**
   * Whether this session has room to spare — the encoder ahead of realtime, the
   * torrent not the limit, and the viewer's link able to carry what the next
   * rung is allowed to peak at.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @param {number} current - The height on screen.
   * @returns {Promise<boolean>}
   */
  async #couldCarryMore(session, now, current) {
    if (session.transcodeVideo === true) {
      const speed = this.#recentSpeedOf(session, now);
      if (speed === null || speed < BUDGET_SPEED_OK) {
        return false;
      }
    }
    // A run in either slow window is one the budget is already unhappy with.
    if (session.linkSlowSince !== 0 || session.budgetSlowSince !== 0) {
      return false;
    }
    const report = this.#worstNetReport(session, now);
    if (!report || now - report.at > LINK_REPORT_FRESH_MS) {
      // Nothing fresh measures the link, so it has no opinion either way — the
      // same silence that stops #checkLinkBudget from acting.
      return true;
    }
    const base = this.liveOutputs.pictureOf(session);
    const next = this.#nextHeightUp(base, current);
    if (next === undefined) {
      return true; // nothing to step to; only the cap decision is left
    }
    return this.#linkCouldCarry(session, this.#peakMbpsForHeight(base, next), now);
  }

  /**
   * Whether the viewer's measured link can carry a given number of Mbit/s.
   *
   * A link nobody has measured recently has no opinion either way — the same
   * silence that stops `#checkLinkBudget` from acting — so it answers yes.
   *
   * @param {HlsSession} session
   * @param {number} wantedMbps
   * @param {number} now
   * @returns {boolean}
   */
  #linkCouldCarry(session, wantedMbps, now) {
    // The SLOWEST link among the viewers: a step up has to be carried by all of
    // them, not by whichever reported last.
    const report = this.#worstNetReport(session, now);
    if (!report || now - report.at > LINK_REPORT_FRESH_MS) {
      return true;
    }
    return report.linkMbps * LINK_SAFETY >= wantedMbps;
  }

  /**
   * The next offered height above `current`, never above the source.
   *
   * @param {HlsSession} base
   * @param {number} current
   * @returns {number | undefined}
   */
  #nextHeightUp(base, current) {
    const ceiling = Math.round(Number(base.file.height) || 0);
    return this.offeredHeights(base)
      .filter((height) => height > current && height <= ceiling)
      .sort((left, right) => left - right)[0];
  }

  /**
   * What a rung is ALLOWED to peak at, in Mbit/s.
   *
   * For a re-encoded rung that is the constrained-CRF cap this proxy imposes on
   * it, which is a figure we set rather than one we hope for. For the height
   * the family serves by COPY there is no encoder and no cap, so the source's
   * own bitrate is what will be sent.
   *
   * @param {HlsSession} base
   * @param {number} height
   * @returns {number}
   */
  #peakMbpsForHeight(base, height) {
    const sourceHeight = Math.round(Number(base.file.height) || 0);
    if (height === sourceHeight && base.transcodeVideo !== true) {
      const sourceMbps = Number(base.file.decode?.megabitsPerSecond);
      if (Number.isFinite(sourceMbps) && sourceMbps > 0) {
        return sourceMbps;
      }
    }
    return maxrateKbpsFor(nominalKbpsForHeight(height)) / 1000;
  }

  /**
   * Bound this encode's bitrate by the viewer's MEASURED link.
   *
   * The one lever that reduces what is sent without touching the picture's
   * size: `-maxrate`, `-bufsize` and CRF do not appear in the SPS (x264 writes
   * no HRD parameters unless asked), so the init segment already in the
   * player's hands goes on describing every fragment. The target is not chosen
   * — it is the link the browser reported, less the share protocol overhead and
   * measurement noise take out of it.
   *
   * @param {HlsSession} session
   * @param {number} linkMbps
   * @param {string} reasonText
   * @returns {Promise<boolean>}
   */
  async #applyRateCap(session, linkMbps, reasonText) {
    const usableKbps = Math.round(linkMbps * LINK_SAFETY * 1000);
    const wanted = nominalKbpsForMaxrate(usableKbps);
    if (!(wanted > 0)) {
      return false;
    }
    // The floor: what the SMALLEST picture this file is offered at is sized to
    // carry. Below that, the link is not short of bitrate at this size — it is
    // short of the size, and the answer is a smaller variant rather than a
    // number that would make this one unwatchable.
    const base = this.liveOutputs.pictureOf(session);
    const offered = this.offeredHeights(base);
    const smallest = offered.length > 0 ? Math.min(...offered) : this.liveOutputs.variantHeightOf(session);
    const floor = nominalKbpsForHeight(smallest);
    if (wanted < floor) {
      if (this.#askLowerHeight(session, `viewer-link-bound ${reasonText}`)) {
        return true;
      }
      logger.info(
        `[budget] transcode ${session.id} the link carries ${maxrateKbpsFor(wanted)}kbps and the ` +
          `smallest picture on offer (${smallest}p) is sized for ${maxrateKbpsFor(floor)}kbps; ` +
          `capping at the floor rather than below it "${session.file.name}"`
      );
    }
    const nominal = Math.max(wanted, floor);
    const standing = Number.isFinite(session.rateCapKbps) ? session.rateCapKbps : null;
    if (standing !== null && nominal >= standing) {
      return false; // this would loosen a cap, which is the step UP's business
    }
    session.rateCapKbps = nominal;
    session.budgetSlowSince = 0;
    session.budgetUpSince = 0;
    base.budgetLastActionAt = Date.now();
    // What this run was last seen doing described an encode at another bitrate.
    // A cheaper one encodes faster, so keeping the figure would price the new
    // picture at the old one's cost.
    session.lastAloneSpeed = null;
    session.recentSpeed = null;
    logger.info(
      `[budget] transcode ${session.id} viewer-link-bound ${reasonText} → capping the picture at ` +
        `${maxrateKbpsFor(nominal)}kbps peak, size unchanged at ${session.output.encodeWidth}x${session.output.encodeHeight} ` +
        `"${session.file.name}"`
    );
    await this.#restartAtViewer(session);
    return true;
  }

  /**
   * Give a capped picture its own bitrate back.
   *
   * @param {HlsSession} session
   * @returns {Promise<void>}
   */
  async #liftRateCap(session) {
    const lifted = session.rateCapKbps;
    session.rateCapKbps = null;
    session.lastAloneSpeed = null;
    session.recentSpeed = null;
    this.liveOutputs.pictureOf(session).budgetLastActionAt = Date.now();
    logger.info(
      `[budget] transcode ${session.id} the link has carried this picture with room to spare; ` +
        `lifting the ${maxrateKbpsFor(lifted)}kbps cap "${session.file.name}"`
    );
    await this.#restartAtViewer(session);
  }

  /**
   * Restart this session's encode run at the segment the viewer is on, so a
   * changed setting takes over from where they are watching.
   *
   * @param {HlsSession} session
   * @returns {Promise<void>}
   */
  async #restartAtViewer(session) {
    const head = earliestRunStart(session);
    const processed = Number.isFinite(session.progress?.processedSeconds)
      ? session.progress.processedSeconds
      : this.runStartTimeFor(session, head);
    const currentSeg = Math.max(head, this.#segmentIndexForTime(session, processed));
    await this.#startEncodeRun(session, currentSeg);
  }

  /**
   * Say so when a run is about to encode a picture the init segment already in
   * the player's hands does not describe.
   *
   * This is the whole class of fault named in one line, and it exists because
   * the fault is otherwise SILENT: no layer reports an error, the encoder is
   * healthy, segments are served in milliseconds, and what the viewer gets is
   * either a band of macroblock garbage or a picture that never appears. The
   * shape is the one 2.48.0 uses for the TIME a run begins at — a run states
   * where it really landed, and a disagreement with what was published is
   * named rather than left to be inferred from a browser's own reading.
   *
   * The size the init describes is read from the init's own bytes, not taken
   * from our record of what the encoder was told, because those two disagreeing
   * IS the fault. The size the run will produce is computed by the same
   * arithmetic the scale filter performs, so a source smaller than the target
   * box is not reported as a disagreement.
   *
   * Said once per distinct pair of sizes: a run repeated at the same wrong size
   * has nothing further to say.
   *
   * @param {HlsSession} session
   * @returns {void}
   */
  #warnIfRunLeavesTheInitBehind(session) {
    if (session.transcodeVideo !== true || !session.initBytes || session.initBytes.length === 0) {
      return; // nothing served yet, or nothing being encoded
    }
    const format = session.segmentFormat;
    if (typeof format?.initVideoSize !== "function") {
      return; // a self-describing container (MPEG-TS) cannot have this fault
    }
    const described = format.initVideoSize(session.initBytes);
    if (!described) {
      return;
    }
    if (!(session.output.encodeWidth > 0) || !(session.output.encodeHeight > 0)) {
      return; // the run keeps the encoder's own default box; nothing was told
    }
    const producing = computeOutputDimensions(
      session.output.encodeWidth,
      session.output.encodeHeight,
      session.file.width,
      session.file.height
    );
    if (!producing) {
      return; // the source size is unknown, so nothing can be predicted
    }
    if (described.width === producing.w && described.height === producing.h) {
      return;
    }
    const said = `${described.width}x${described.height}->${producing.w}x${producing.h}`;
    if (session.initSizeSaid === said) {
      return;
    }
    session.initSizeSaid = said;
    logger.warn(
      `transcode ${session.id} is about to encode ${producing.w}x${producing.h} while the init segment ` +
        `the player holds describes ${described.width}x${described.height} "${session.file.name}" — ` +
        `every fragment of this run will be decoded against parameter sets for a picture that is not ` +
        `being made. A change of size is a change of variant; nothing here should have moved it.`
    );
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
      stats = await this.getSourceStats(session.file.sourceKey, session.file.fileIndex);
    } catch {
      return "unknown";
    }
    if (!stats) {
      return "unknown";
    }
    // What this file's own interruptions demand, measured by the reader. Kept
    // on the session because the browser is told the buffer that follows from
    // it, and because the quality offer will be held to the speed it names.
    if (stats.supply) {
      session.supplyFigures = stats.supply;
    }
    // A fully (or almost fully) downloaded file cannot be download-bound.
    if (typeof stats.fileProgress === "number" && stats.fileProgress >= 0.999) {
      return "cpu";
    }
    const duration = Number.isFinite(session.file.durationSeconds) ? session.file.durationSeconds : 0;
    const length = Number.isFinite(stats.fileLength) && stats.fileLength > 0 ? stats.fileLength : 0;
    const downloadSpeed = Number.isFinite(stats.downloadSpeed) ? stats.downloadSpeed : 0;
    if (duration <= 0 || length <= 0) {
      return "unknown"; // cannot compute the source byte rate
    }
    const sourceByteRate = length / duration;
    return downloadSpeed >= sourceByteRate * BUDGET_DOWNLOAD_OK_FACTOR ? "cpu" : "download";
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
   * The run of another session that was given this segment number, if any.
   *
   * Only a run that is actually going: a stretch given to a run that has ended
   * is free again, and nothing has to release it.
   *
   * @param {HlsSession} session - The one asking, which does not count itself.
   * @param {number} index
   * @returns {string | null} The other session's id.
   */
  runMakingSegment(session, index, exceptRun = null) {
    const key = session.outputKey ?? "";
    if (!key) {
      return null;
    }
    for (const run of this.#runsOnOutput(key)) {
      if (run === exceptRun) {
        continue;
      }
      // A run with an explicit stretch owns the whole of it. One WITHOUT an end
      // owns only as far as it will actually get — its head plus the look-ahead
      // — because claiming the rest of the film would make it the owner of
      // every number in front of it, including ones another run was expressly
      // given, and a viewer opening the same film further on would get no
      // encoder at all.
      const to = Number.isInteger(run.to) && run.to >= run.from
        ? run.to
        : run.head + Math.ceil(this.lookaheadSeconds / this.segmentDurationSec);
      if (index >= run.from && index <= to) {
        return run;
      }
    }
    return null;
  }

  /**
   * Every live run of one output, whichever session started it.
   *
   * @param {string} key
   * @returns {import("./encode/EncodeRun.js").EncodeRun[]}
   */
  #runsOnOutput(key) {
    const runs = [];
    for (const session of this.sessionsById.values()) {
      if (session.outputKey !== key || session.state === "disposed") {
        continue;
      }
      runs.push(...liveRunsOf(session));
    }
    return runs;
  }

  /**
   * How far a run starting here may work before it meets somebody else's
   * material — read off the ONE coverage map, never worked out again here.
   *
   * This replaced `planRunInterval`, which was a second authority over the same
   * question and answered it by different rules: it walked the whole track for
   * the first free number, MOVED the start there itself, and counted every live
   * run as claiming up to `head + look-ahead`. Measured in the field
   * 2026-09-05: the plan commanded a start at #46, this moved it to #78 — the
   * "run moved forward from #46 to #78" line — and the plan, seeing a run
   * outside the window it had asked for, killed it as unwanted and commanded
   * the same start again, 350-700ms per cycle, dozens of times, the viewer's
   * picture stopped for 125 seconds.
   *
   * Where a run STARTS is the plan's decision and arrives here as an argument.
   * All this answers is where it must stop, and the answer is a fact of the
   * map: the free stretch from that number on. `-1` means the end of the track,
   * which is what "no end" is written as everywhere here.
   *
   * @param {object} session
   * @param {number} startIndex
   * @param {object | null} exceptRun - The run being replaced, whose own claim
   *   is not somebody else's material.
   * @returns {number} The last number to work through, or `-1` for the end.
   */
  #runEndFrom(session, startIndex, exceptRun = null) {
    const key = session.outputKey ?? "";
    if (!key) {
      return -1;
    }
    const coverage = this.encodeOrchestrator.coverageOf(key);
    const segmentCount = Number(session.timeline?.segmentCount) || 0;
    if (segmentCount > 0) {
      coverage.setSegmentCount(segmentCount);
    }
    coverage.markReadyAll(this.segmentStore.provenNumbers(key));
    const free = coverage.freeRunFrom(Math.max(0, startIndex), exceptRun);
    if (!Number.isFinite(free)) {
      return -1;
    }
    const end = Math.max(0, startIndex) + Math.max(1, free) - 1;
    return segmentCount > 0 && end >= segmentCount - 1 ? -1 : end;
  }

  // Returns the encoder it built, or nothing when there was nothing to build.
  // It waits for nothing: the one thing it used to wait for was the death of
  // the run it was replacing, and that killing is gone.
  #startEncodeRun(
    session,
    startIndex,
    positionSecondsOverride,
    because = "a viewer needs it",
    ordered = null
  ) {
    // A new run starts its own reckoning: a pair spanning the restart would
    // count the gap between two runs as slow encoding.
    session.learnSample = null;
    // Where a restart's seconds go. A seek costs 5-8 s in the field and the
    // recorded reason — waiting for the previous ffmpeg to exit, measured at
    // 0.54-1.47 s — does not account for it. Before rebuilding the hottest path
    // in the proxy on a guess, make each stage state its own cost.
    const restartEnteredAt = Date.now();
    // Reads where the old run began BEFORE the new one takes its place, and
    // does not await: everything below is the restart path, which is measured
    // in milliseconds and has been worked on twice to keep it that way.
    this.#accountBackwardRestart(session, startIndex);
    // STARTING AN ENCODER STOPS NOTHING. It used to stop any live run whose own
    // start was not below this one's — a rule left over from when a session
    // held exactly one run and "the previous one" meant "the only one". Once a
    // session could hold several, that rule began killing runs the plan had
    // decided to keep: 294 stops for this reason in eight minutes of field
    // 2026-09-05, against four starts asked for by a viewer. Who is stopped is
    // decided in one place, and it is not this one.
    //
    // HOW FAR IT MAY WORK is decided by the same one place and arrives here as
    // an argument. Reading it off the coverage map a second time was the last
    // remaining second answer to that question: the plan computed `to`, passed
    // it, and the parameter list did not name it.
    const runEnd = Number.isInteger(ordered?.to)
      ? ordered.to
      : this.#runEndFrom(session, startIndex, null);
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
    // This attempt, so that a newer one can tell it has been overtaken. It used
    // to be a counter compared against a copy of itself; the attempt is a thing,
    // and comparing the thing says the same without a number to keep in step.
    const attempt = { startIndex, at: restartEnteredAt };
    session.pendingRun = attempt;
    // Stopped BEFORE the wait, and the reason it is a `stop` rather than a kill
    // is the whole of what this object changed. Every handler used to open by
    // asking whether the process was still the session's, because one set of
    // fields served however many processes had lived — and a predecessor dying
    // after its replacement had spawned passed that check and was handled as the
    // current run failing. On any host with a hardware encoder that meant a
    // downgrade to libx264 for good on every seek. A run writes its own state,
    // so there is nothing left to mistake.
    // A newer restart (or disposal) won the race while we were waiting for the
    // old process to die — it either already spawned its own replacement or
    // there is nothing left to start. Do not also spawn from this stale call.
    if (session.pendingRun !== attempt || session.state === "disposed") {
      return;
    }

    // What is still read off the session for a run. The list is the measure of
    // how far a session still is from being the three things a run is built
    // from — the material, what is produced of it, and the stretch — and it
    // shrinks in place as those are taken off. There is deliberately no method
    // wrapping it: a named adapter with one caller is a thing to remember to
    // delete, and this is a thing that disappears by being emptied.
    const { args, safeIndex, startSeconds, cutTimes } = buildRunCommand({
      file: session.file,
      inputFile: session.inputFile,
      audioFile: session.audioFile,
      inputUrl: session.inputUrl,
      audioInputUrl: session.audioInputUrl,
      timeline: session.timeline,
      output: session.output,
      segmentFormat: session.segmentFormat,
      transcodeVideo: session.transcodeVideo,
      transcodeAudio: session.transcodeAudio,
      audioOnly: session.audioOnly,
      audioSeparate: session.audioSeparate,
      audioSourceTrackIndex: session.audioSourceTrackIndex ?? session.audioTrackIndex ?? 0,
      rateCapKbps: session.rateCapKbps ?? null,
      startIndex,
      endIndex: runEnd,
      positionSecondsOverride,
      videoEncoder: this.videoEncoder,
      segmentDurationSec: this.segmentDurationSec
    });

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

    // One directory for the output, and every run writes straight into it.
    //
    // Runs used to be kept apart by a directory each, because two of them
    // writing one segment name at the same time produce a file belonging to
    // neither — which was also the only reason a restart ever had to wait for
    // its predecessor to die. Intervals remove that by construction: a run is
    // given a stretch nobody else holds and stops at the end of it, so no two
    // runs ever want the same number. What is left of the old reason — a run
    // killed mid-piece leaving a partial file — is not a correctness problem
    // either, because the store serves a segment only once its closure is
    // proven, and it is cleared up when the run ends.
    const run = new EncodeRun({
      address: session.outputKey ?? session.id,
      encoder: this.videoEncoder,
      from: safeIndex,
      to: runEnd,
      buildArgs: () => args,
      argsDescribed: describeFfmpegArgs(args),
      // Whether this run cuts at times we gave it. Decides how a segment is
      // judged finished — see getFileStream.
      usesExplicitCuts: Boolean(cutTimes && cutTimes.length > 0),
      spawn: (spawnArgs) =>
        spawn(this.ffmpegBin, spawnArgs, {
          cwd: session.dirPath,
          // A fourth channel: the encoder names every piece it has CLOSED on it,
          // which is the only proof a piece is whole.
          stdio: ["ignore", "pipe", "pipe", "pipe"]
        }),
      logger,
      // The film's last segment number, which is what tells "it reached the
      // end" from "its input dried up": ffmpeg exits zero for both and over a
      // torrent cannot tell them apart.
      lastSegmentIndex: () =>
        session.timeline?.segmentCount > 0 ? session.timeline.segmentCount - 1 : null,
      inputUnavailable: (message) => isInputUnavailable(message),
      onProgress: (report) => this.#noteRunProgress(session, run, report),
      onClosed: (name) => this.segmentStore.markClosed(session.outputKey ?? "", session.segmentFormat.segmentIndexFromName(name)),
      onEnded: (ended) => this.noteRunEnded(session, run, ended)
    });
    session.runs.add(run);
    session.pendingRestartIndex = -1;
    session.lastRestartAt = Date.now();
    session.progress.processedSeconds = startSeconds;
    session.progress.startPositionSeconds = startSeconds;
    session.progress.updatedAt = Date.now();
    // Any (re)start resets the cumulative `speed` ffmpeg reports, so reset the
    // realtime-budget slow window too — otherwise warm-up right after a user
    // seek could be mis-counted as sustained sub-realtime and trigger a
    // premature downscale.
    session.budgetSlowSince = 0;

    run.start(because);

    logger.info(
      `transcode ${session.id} encode-run #${safeIndex}..#${runEnd} from segment #${safeIndex} ` +
      `(+${Date.now() - restartEnteredAt}ms since the restart was asked for) ` +
        `(${formatSeconds(startSeconds)}) "${session.file.name}"`
    );
    // The four numbers a run is positioned by, said once, because their
    // disagreement is invisible everywhere else. The two tables are printed
    // side by side: while they differ, every cut of this run is off by the
    // difference, and nothing downstream can tell that from a bad index.
    const liveStart = this.#segmentStartTime(session, safeIndex);
    logger.info(
      `transcode ${session.id} run #${safeIndex}..#${runEnd} positioned at ${startSeconds.toFixed(3)}s ` +
        `for boundary #${safeIndex} (published ${startSeconds.toFixed(3)}s, ` +
        `live ${liveStart.toFixed(3)}s, apart ${(liveStart - startSeconds).toFixed(3)}s), ` +
        `numbering from #${safeIndex}`
    );
    return run;
  }

  /**
   * What one run reports about its own progress, put where the session
   * publishes it.
   *
   * Rebasing belongs here and not in the run: `-progress` counts from the start
   * of the run on both branches — measured on each separately — and only the
   * side that knows where this run began can put those seconds back on the
   * source's timeline.
   *
   * A report from a run that is no longer the session's is dropped. It is the
   * one place the identity question survives, because progress is published per
   * SESSION while a superseded process may still be emitting.
   *
   * @param {HlsSession} session
   * @param {import("./encode/EncodeRun.js").EncodeRun} run
   * @param {{ processedSeconds: number | null, speed: string | null, outTime?: string }} report
   * @returns {void}
   */
  #noteRunProgress(session, run, report) {
    if (!session.runs?.has(run) || session.state === "disposed") {
      return;
    }
    if (Number.isFinite(report.processedSeconds)) {
      session.progress.processedSeconds = this.#toAbsoluteProcessedSeconds(session, report.processedSeconds);
    } else if (typeof report.outTime === "string") {
      const parsed = parseFfmpegTimestamp(report.outTime);
      if (parsed != null) {
        session.progress.processedSeconds = this.#toAbsoluteProcessedSeconds(session, parsed);
      }
    }
    if (typeof report.speed === "string") {
      session.progress.speed = report.speed;
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
        `transcode ${session.id} "${session.file.name}" ${session.progress.percent.toFixed(1)}% ` +
          `(${formatSeconds(session.progress.processedSeconds)} / ${formatSeconds(session.progress.totalSeconds)})` +
          ` speed=${session.progress.speed || "n/a"}`
      );
    }
  }

  /**
   * What to do about a run that has ended.
   *
   * The run says how it ended and why; this decides what follows, which is a
   * question about the SESSION and the machine rather than about the process:
   * whether to condemn a hardware encoder, whether to wait for the input to
   * come back, whether a position has failed often enough to stop retrying it.
   *
   * An ending from a run the session has already replaced is not ignored — it
   * is simply not about this session's current run, so nothing that describes
   * the current run is written from it. That is what the identity check used to
   * be for, and it is one condition now instead of one at the head of every
   * handler.
   *
   * @param {HlsSession} session
   * @param {import("./encode/EncodeRun.js").EncodeRun} run
   * @param {import("./encode/EncodeRun.js").RunEnded} ended
   * @returns {void}
   */
  noteRunEnded(session, run, ended) {
    // First, and for every run whatever else follows: the stretch it held goes
    // back to the map. A run whose claim is never released tells the plan that
    // numbers nobody is making are being made, and nothing is ever started
    // there again.
    this.encodeOrchestrator.noteEnded(ended);
    // WAS this run still the session's when it ended? Asked before it is
    // removed, because after the removal the question always answers "no" —
    // and it was asked after, so every line below this point was unreachable.
    //
    // Measured 2026-09-05 over both of the field host's log files: zero
    // occurrences of this handler's own `encode-run #… failed:` line and zero
    // of `fast failure at segment`, across every session this proxy has ever
    // run. So the fallback from a failed hardware encoder to software, the
    // retry when the torrent data goes away, the limit on retrying a position
    // that keeps failing, and the error line naming the ffmpeg command have all
    // been dead code — which is also why nothing ever stopped the restart loop
    // recorded in the field the same day.
    const wasCurrent = session.runs?.has(run) ?? false;
    session.runs?.delete(run);
    // A stretch went back to the map, so what should be running has changed.
    // Said here rather than waited for: this is the moment it became true.
    this.planEncodersSoon();
    if (session.state === "disposed") {
      return;
    }
    if (!wasCurrent) {
      // A run the session had already replaced. It has logged its own ending;
      // nothing about the session follows from it.
      return;
    }
    if (ended.lastError) {
      session.lastError = ended.lastError;
    }
    session.progress.updatedAt = Date.now();
    if (ended.ending === ENCODE_EXIT.STOPPED || ended.ending === ENCODE_EXIT.GONE) {
      return;
    }
    if (ended.ending === ENCODE_EXIT.COMPLETE) {
      logger.info(`transcode ${session.id} encode-run complete "${session.file.name}"`);
      return;
    }
    if (ended.ending === ENCODE_EXIT.SHORT) {
      // ffmpeg exits 0 both when it reaches the end of the file and when its
      // input simply stops producing bytes — over HTTP the two look identical
      // to it. Field 2026-08-05: the torrent's download died, the read ended,
      // and a run that had made 188 segments of 624 reported itself complete;
      // the player then consumed what was on disk and froze on the first
      // segment nobody was making. So the claim is checked against the playlist
      // we published, and a run that stopped short is a FAILURE that can be
      // restarted, not a finished file.
      session.lastError = ended.because;
      logger.error(
        `transcode ${session.id} encode-run #${ended.from}..#${ended.to} ended early: ` +
        `${ended.because} "${session.file.name}"`
      );
      return;
    }
    // Runtime safety net: if a hardware encode fails, downgrade this proxy to
    // software encoding for all sessions and restart this one, so playback is
    // never permanently broken by a hardware/driver issue.
    //
    // Asked only of a genuine encoder failure. It used to be asked of every
    // non-zero exit, so a run whose TORRENT DATA went away — which says nothing
    // whatever about the encoder — condemned a working NVENC or QuickSync to
    // software for the life of the process, and started an extra run at the old
    // index while it was at it.
    if (ended.ending === ENCODE_EXIT.FAILED && session.transcodeVideo && this.videoEncoder.kind !== "software") {
      const failedEncoder = this.videoEncoder.name;
      this.videoEncoder = softwareDescriptor();
      logger.warn(
        `transcode ${session.id} hardware encoder ${failedEncoder} failed ` +
          `(${session.lastError}); falling back to software libx264 and restarting`
      );
      void this.#startEncodeRun(session, ended.from, undefined, "the hardware encoder failed");
      return;
    }
    // Losing the INPUT is not the session failing — it is the data not being
    // there YET. The torrent can be re-added and re-downloaded, so the honest
    // answer to the viewer is "still working", not an error screen. Field
    // 2026-08-06: a torrent evicted mid-seek took the film with it, the run
    // died on `File 0 not found`, the session went terminal and answered 500 to
    // every request from then on — although the swarm was there and the data
    // would have come back in seconds. The circuit breaker below stays for what
    // it was built for, a target that genuinely cannot be encoded; it must not
    // condemn a session whose data merely went away.
    if (ended.ending === ENCODE_EXIT.INPUT_LOST) {
      session.inputRetryCount = (session.inputRetryCount ?? 0) + 1;
      const delayMs = Math.min(
        INPUT_RETRY_MAX_MS,
        INPUT_RETRY_BASE_MS * 2 ** Math.min(session.inputRetryCount - 1, 6)
      );
      logger.warn(
        `transcode ${session.id} encode-run #${ended.from}..#${ended.to} lost its input ` +
          `(${session.lastError}); retrying in ${Math.round(delayMs / 1000)}s ` +
          `(attempt ${session.inputRetryCount})`
      );
      session.inputRetryTimer = setTimeout(() => {
        session.inputRetryTimer = null;
        if (run.state !== ENCODE_RUN_STATE.RETRY_WAIT) {
          return;
        }
        run.retryDue();
        const at = Number.isInteger(session.lastRequestedSegment)
          ? session.lastRequestedSegment
          : ended.from;
        this.#startEncodeRun(session, at, undefined, "its input came back");
      }, delayMs);
      session.inputRetryTimer.unref?.();
      return;
    }
    // A run that exits THIS fast never did real work: it failed at the start
    // itself — opening the input, spawning the process — rather than
    // mid-stream. Consecutive fast failures at the SAME position are counted so
    // that whoever commands a start can stop commanding one that keeps failing.
    //
    // COUNTED AT EVERY POSITION, #0 included. It used to be counted only past
    // #0, because it was written for seek restarts and a seek is never to the
    // beginning. That left the one position the plan commands FIRST with no
    // count at all, and the plan re-commanding a start that cannot succeed is
    // an unbounded loop: measured 2026-09-05, ffmpeg failing to spawn produced
    // fifty passes of the plan before a probe stopped it, as fast as the
    // failures arrived.
    if (ended.livedMs < START_FAST_FAIL_MS) {
      if (session.failedStartAt === ended.from) {
        session.failedStartCount += 1;
      } else {
        session.failedStartAt = ended.from;
        session.failedStartCount = 1;
      }
      logger.warn(
        `transcode ${session.id} fast failure at segment #${ended.from} ` +
          `(${ended.livedMs}ms) — ${session.failedStartCount}/${MAX_FAILED_STARTS} consecutive`
      );
      if (session.failedStartCount >= MAX_FAILED_STARTS) {
        logger.error(
          `transcode ${session.id} will not be started at #${ended.from} again: ` +
          `${session.failedStartCount} starts there failed within ${START_FAST_FAIL_MS}ms each ` +
          `(${session.lastError || ended.because}) "${session.file.name}"`
        );
      }
    } else {
      // Real progress was made (or this was the very first run) — not a
      // repeating seek failure. Reset the breaker.
      session.failedStartAt = -1;
      session.failedStartCount = 0;
    }
    logger.error(
      `transcode ${session.id} encode-run #${ended.from}..#${ended.to} failed: ${session.lastError}` +
        ` — ${this.#describeTrackSelection(session)}` +
        `\n  ffmpeg ${run.argsDescribed || "(command not recorded)"}`
    );
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
   * What this run asked the source for, against what the source said it has.
   *
   * Written for one failure in particular: every `-map` this proxy builds ends
   * in `?`, so ffmpeg drops a mapping for an absent stream without complaint,
   * and a run whose mappings ALL drop produces a file with nothing in it —
   * reported as `Output file does not contain any stream`, exit 255. Read from
   * the exit code alone that is indistinguishable from any other refusal. Read
   * beside the tracks the file actually holds it is unmistakable, and it names
   * which side is wrong: an audio index past the end of the list is ours, no
   * streams at all is the source's.
   *
   * @param {HlsSession} session
   * @returns {string}
   */
  #describeTrackSelection(session) {
    const wanted = [];
    // Named exactly as the command line names them, second input included: a
    // refusal whose message describes a different mapping than the one that was
    // refused is the reading that cost a wrong diagnosis before.
    const audioInput =
      typeof session.audioInputUrl === "string" && session.audioInputUrl.length > 0 ? 1 : 0;
    const audioTrack = session.audioSourceTrackIndex ?? session.audioTrackIndex ?? 0;
    if (session.audioOnly === true) {
      wanted.push(`audio 0:a:${audioTrack}`);
    } else if (this.#servesAudioSeparately(session)) {
      wanted.push("video 0:v:0");
    } else {
      wanted.push("video 0:v:0", `audio ${audioInput}:a:${audioTrack}`);
    }
    const counts = session.file.streamCounts;
    const held = counts
      ? `the source holds ${counts.video} video, ${counts.audio} audio, ` +
        `${counts.subtitle} subtitle` +
        (counts.other > 0 ? `, ${counts.other} other` : "")
      : "what the source holds was not recorded";
    return `this run asked for ${wanted.join(" + ")}, and ${held}`;
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
    if (index < (earliestRunStart(session) ?? 0)) {
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
    const head = earliestRunStart(session) ?? 0;
    // Anchor the look-ahead window on the CURRENT encode position (start index +
    // seconds already processed), not the run's start index. Otherwise a long
    // run that has encoded well past `head` would needlessly restart for a
    // request just ahead of the live edge.
    const processed = Number.isFinite(session.progress?.processedSeconds)
      ? session.progress.processedSeconds
      : this.runStartTimeFor(session, head);
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
    // Circuit breaker: this exact target has already failed MAX_FAILED_STARTS
    // times in a row (fast failures — see noteRunEnded).
    // Stop auto-retrying it; session.state stays "failed" so getFileStream
    // reports a clean, retryable error instead of looping forever. A DIFFERENT
    // target (the viewer seeking elsewhere) is unaffected — it gets its own
    // fresh attempt budget.
    if (index === session.failedStartAt && session.failedStartCount >= MAX_FAILED_STARTS) {
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
    if (!processCanBeSignalled(runStateOf(session))) {
      return;
    }
    // A seek already settling is about to move the encoder to where the VIEWER
    // said they are. That statement outranks anything inferred here.
    if (session.seekSettleTimer != null) {
      return;
    }
    // And it outranks it AFTERWARDS too, which is what was missing. The guard
    // above only holds while the settle timer is armed — a second later it is
    // gone, and a request the browser issued BEFORE the seek is then treated as
    // fresh evidence. Field 2026-08-17: a seek to 2083.4 s put both runs at
    // #373, a request for #371 from before it arrived a second afterwards, and
    // this repair moved the encoder to #370 — three segments behind the viewer,
    // who waited for it to come back. A request BEHIND what the viewer
    // themselves reported cannot be describing where they are.
    const reportedSeconds = Number(session.viewerReportedSeconds);
    if (Number.isFinite(reportedSeconds)) {
      const reportedIndex = this.#segmentIndexForTime(session, reportedSeconds);
      if (index < reportedIndex) {
        this.#explainHold(
          session,
          session.segmentFormat.segmentFileName(index),
          `it is behind #${reportedIndex}, where the viewer said they are — answered, not obeyed`
        );
        return;
      }
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
    if (target === session.failedStartAt && session.failedStartCount >= MAX_FAILED_STARTS) {
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
  requestSeek(sessionId, positionSeconds, consumerId = "") {
    const named = this.sessionsById.get(sessionId);
    if (!named || named.state === "disposed") {
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
    if (consumerId) {
      this.viewers.of(named, consumerId).moveTo(positionSeconds);
    }
    named.lastAccessedAt = Date.now();
    this.planEncodersSoon();
    return true;
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
    session.furthestViewerSeconds = positionSeconds;
    session.viewerReportedSeconds = positionSeconds;
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
    const head = earliestRunStart(session) ?? 0;
    const processed = Number.isFinite(session.progress?.processedSeconds)
      ? session.progress.processedSeconds
      : this.runStartTimeFor(session, head);
    const currentSeg = Math.max(head, this.#segmentIndexForTime(session, processed));
    // Already covered by the running encode — the data is on its way, so
    // restarting would only destroy work the viewer is waiting for. The run has
    // to be ALIVE for that to hold: after a run died, the handle still
    // pointed at the dead process and every later seek was waved through as
    // "already covered", so nothing could ever restart it. Measured 2026-08-04:
    // one ffmpeg failure turned into a session that answered 500 to every
    // segment for as long as the viewer kept trying.
    const runIsAlive = processCanBeSignalled(runStateOf(session));
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
    if (target === session.failedStartAt && session.failedStartCount >= MAX_FAILED_STARTS) {
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
    if (runStartingAt(session, target) !== null) {
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
    const runIsAlive = processCanBeSignalled(runStateOf(session));
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
      if (runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED) {
        throw new Error(session.lastError || "ffmpeg failed to start HLS session.");
      }
      return;
    }

    const playlistPath = path.join(session.dirPath, PLAYLIST_FILE_NAME);
    const deadline = Date.now() + this.startupWaitMs;

    while (Date.now() < deadline) {
      if (runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED) {
        throw new Error(session.lastError || "ffmpeg failed to start HLS session.");
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
    for (const name of this.#producedIndex(session).fileNames()) {
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
  /**
   * Where the run REALLY began, against where it was asked to begin.
   *
   * The first piece a run produces is the only statement of this that exists,
   * and until now nothing compared the two. They disagree whenever the seek
   * lands somewhere other than the time asked for — which, before the landing
   * offset, was every run on a Matroska source with B-frames, by exactly one
   * keyframe interval. Every cut of the run then inherits it, because
   * `-segment_times` is measured from the landing.
   *
   * Said once per run, and only when it matters: within what a player bridges
   * there is nothing to report.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @param {number} trueStart
   * @returns {void}
   */
  #noteRunLanding(session, index, trueStart) {
    if (runStartingAt(session, index) === null || session.landingReportedForRun === index) {
      return;
    }
    session.landingReportedForRun = index;
    // What the run was ASKED for, taken from the run itself rather than looked
    // up again in a table. The two used to be the same lookup; they stopped
    // being so when a run began positioning on the published grid while this
    // read the live one, which made a perfect landing report a drift equal to
    // the distance between the tables — and cancelled a real landing error of
    // the same size to zero. A run also has one legitimate position that is in
    // no table at all: the realignment that starts the sound where the copied
    // picture truly begins.
    const asked = Number.isFinite(session.progress?.startPositionSeconds)
      ? session.progress.startPositionSeconds
      : this.runStartTimeFor(session, index);
    const drift = trueStart - asked;
    if (!Number.isFinite(drift) || Math.abs(drift) <= PLAYER_BUFFER_HOLE_SEC) {
      return;
    }
    logger.warn(
      `transcode ${session.id} run began at ${trueStart.toFixed(3)}s but was asked for ` +
      `${asked.toFixed(3)}s — ${drift > 0 ? "+" : ""}${drift.toFixed(3)}s, and every cut of this ` +
      "run is measured from where it began, so the whole run is that far from its playlist"
    );
  }

  #noteIndexAccuracy(session, index, trueStart, declaredStart) {
    const deviation = Math.abs(trueStart - declaredStart);
    session.timeline.indexCheck ??= newIndexCheck();
    // Where each produced segment truly began, kept so that a player reporting
    // a stall can be ANSWERED rather than merely believed. Bounded: only the
    // recent past can be the subject of such a report, and an unbounded map on
    // a two-hour film is a leak.
    session.trueStartByIndex ??= new Map();
    session.trueStartByIndex.set(index, trueStart);
    if (session.trueStartByIndex.size > TRUE_START_MEMORY) {
      const oldest = session.trueStartByIndex.keys().next();
      if (!oldest.done) {
        session.trueStartByIndex.delete(oldest.value);
      }
    }
    // Did this segment begin at ANOTHER keyframe from the same list? Half an
    // audio frame is the tolerance — anything the list names is exact, so a
    // match is a match. `keyframeTimes` is the list the grid was built from, so
    // this compares the file against the table on the table's own terms.
    const knownKeyframe = Array.isArray(session.file.keyframeTimes)
      ? session.file.keyframeTimes.some((time) => Math.abs(time - trueStart) <= 0.05)
      : null;
    noteIndexDeviation(session.timeline.indexCheck, index, deviation, knownKeyframe);
    if (deviation > SEGMENT_START_DISAGREEMENT_SEC) {
      // Which boundary the true start DOES match, if any. This is what tells
      // the two possible faults apart, and they need opposite fixes: matching
      // boundary #N-1 means our numbering is shifted by one — a fault in this
      // code, where the run begins — while matching nothing means the container
      // index describes times the file does not have. Measured 2026-08-11,
      // three samples all matched N-1, which is why the line now says so
      // instead of leaving it to be inferred from the numbers.
      const at = this.#boundaryIndexAt(session, trueStart);
      // Once per segment per five seconds, like `#notePlaylistDisagreement`
      // beside it. The same segment is produced and served again and again
      // while it is refused, and — since a run keeps cutting on the list it was
      // launched with — a soundtrack whose grid has moved under it deviates on
      // EVERY segment for the life of that run. A line each time buries the
      // first one, which is the one somebody is reading the log for.
      session.deviationWarnedAt ??= new Map();
      const lastWarnedAt = session.deviationWarnedAt.get(index) ?? 0;
      if (Date.now() - lastWarnedAt >= 5_000) {
        session.deviationWarnedAt.set(index, Date.now());
        logger.warn(
        `transcode ${session.id} segment #${index} really starts at ` +
        `${trueStart.toFixed(3)}s (boundary ${at === null ? "none" : `#${at}`}), ` +
        `the grid says ${declaredStart.toFixed(3)}s — ` +
        (session.audioOnly === true
          // A soundtrack is cut exactly where it was asked to be, so a
          // disagreement here is not a reading about the file at all: it is the
          // distance between this run's own cuts and a grid the picture has
          // since corrected under it. Said plainly, because the same sentence
          // used to claim a keyframe index was wrong when no keyframe was
          // involved on this side of the stream.
          ? "sound is cut where it is asked to be; this is the picture's grid having moved, not the index"
          : session.transcodeVideo
            // A re-encode was TOLD to put a keyframe here and did not, so this
            // rung's segments no longer stand where the stream it accompanies
            // would have put them. That is a broken splice, not a wrong index.
            ? "this rung did not cut where its grid says; a switch to it will not join cleanly"
            // A copy. The two possible faults need opposite fixes and the
            // numbers already tell them apart, so the sentence follows THEM
            // rather than the branch it is printed from. Until 2026-08-21 it
            // blamed the index either way — including through a session whose
            // segments each held the boundary two, then four places before
            // their own number, which is this code's own definition of a fault
            // in this code. That sentence is what sent the reading of that
            // session after the file instead of after the arithmetic.
            : at === null
              ? "the container's keyframe index disagrees with the file; using the file"
              : `this began at another boundary of the same list, ${index - at} place(s) before ` +
                "its own number — the numbering of this run is shifted, not the index")
        );
      }
    }
    // Said as the evidence accumulates, not only when the session is disposed.
    // A proxy restart takes its sessions with it — every addon update does —
    // and a summary that only ever appears at the end is a summary that is
    // routinely never written. Twenty-five distinct boundaries is enough for
    // the proportion to mean something and rare enough not to repeat itself.
    if (session.timeline.indexCheck.checked > 0 && session.timeline.indexCheck.checked % 25 === 0) {
      this.#logIndexAccuracy(session);
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
    // Only the picture may move the grid, because the grid IS the picture's
    // cut list: it is built from the container's keyframe index, and a copied
    // stream can be cut nowhere else. A soundtrack has no keyframes — it is cut
    // exactly where `-segment_times` asks, to within one audio frame — so its
    // reading measures nothing about the grid and everything about itself.
    //
    // Writing it into the shared table is how one film ended up with two
    // answers for one boundary, each side correctly describing its own stream
    // and each overwriting the other: field 2026-08-20, segment #521 of
    // "Minions.and.Monsters.1080p.mkv" corrected 2086.084s → 2084.082s by the
    // picture at 11:14:16.939 and 2084.082s → 2086.033s by the sound 1.6s
    // later — 1.951s apart, against the 0.25s that stops a correction and the
    // 0.5s a player bridges. The next reading disagrees with the table again,
    // so it never converges and never stops.
    if (session.audioOnly === true) {
      return;
    }
    const boundaries = session.timeline.boundaries;
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
    // One write, because there is one table. Where a file is cut is a fact
    // about the FILE, so every session of it holds the same array rather than a
    // copy of it — which is what this loop used to keep in step, member by
    // member, and only for members that happened to exist at the time. A
    // session created afterwards used to inherit a copy taken at that moment;
    // now it is handed the table itself.
    boundaries[index] = trueStart;
    logger.info(
      `transcode ${session.id} boundary #${index} corrected ${wasAt.toFixed(3)}s → ` +
      `${trueStart.toFixed(3)}s from the file itself` +
      `, and the live table is now ${describeGridDrift(this.publishedGridFor(session), boundaries)}` +
      " from the one the player holds"
    );
    // And every OTHER member whose run begins at this very boundary is moved
    // to the same instant.
    //
    // Why they were not there already: the two branches are asked for the same
    // time and land in different places. The picture cannot begin anywhere but
    // a real keyframe, and it may not begin before the time asked for — that
    // content belongs to the previous segment — so it moves FORWARD to the next
    // one, by up to the keyframe spacing (0.58-2.96 s measured 2026-08-17).
    // A soundtrack has no keyframes: it begins exactly where asked, to within
    // one audio frame. So after every restart the two runs of one film began up
    // to three seconds apart, each correctly labelled with where it really was,
    // and the viewer got sound with no new picture for the difference.
    //
    // The picture's true start is a MEASURED quantity — read from the piece it
    // just produced, which is what the correction above is — so the soundtrack
    // can be put exactly there instead of at the time the container's table
    // claimed. It converges: once the boundary holds the true time, the next
    // reading agrees with it and the guard above returns before doing anything.
    for (const member of this.liveOutputs.familyOf(session)) {
      if (member === session || runStartingAt(member, index) === null) {
        continue;
      }
      logger.info(
        `transcode ${member.id} begins at #${index}, which really starts ` +
        `${(trueStart - wasAt).toFixed(3)}s later than the table said — restarting it there ` +
        `so picture and sound begin together`
      );
      // Restarted at the same INDEX, deliberately, rather than seeked to the
      // time: a seek decides by index, finds this run already begins at #index,
      // and answers "already within the running encode" — which is true about
      // the index and false about the instant, and it is why the first version
      // of this fix moved nothing at all.
      //
      // The instant is passed EXPLICITLY. It used to be smuggled through the
      // live boundary table — this function had just written `trueStart` into
      // it, and the run read its position from there — which stopped working
      // the moment a run began positioning itself on the table the player
      // holds, as it now must. Smuggled, the restart would land exactly where
      // it already was: picture and sound would stay apart and a healthy audio
      // run would be discarded for nothing, which is the shape the field
      // already showed (eleven restarts in four minutes, eight of them dying
      // with `run had produced 0.0s`).
      this.#startEncodeRun(member, index, trueStart);
    }
  }

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
    const left = this.viewers.leaves(output, consumerId);
    if (left) {
      this.encodeOrchestrator.release(`${output.id}:${consumerId}`);
    }
    return left;
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
  #boundaryIndexAt(session, seconds, table) {
    // The table is nameable because the two answer different questions. The
    // LIVE one says "is this a cut this file actually has", which is what a
    // reading taken off a produced segment is about. The PUBLISHED one says "is
    // this a cut the player believes in", which is what a report from the player
    // is about. Answering one with the other prints an index from one grid
    // beside a time from the other.
    const boundaries = Array.isArray(table) ? table : session.timeline.boundaries;
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
    const check = session.timeline?.indexCheck;
    if (!check || check.checked === 0) {
      return;
    }
    const deviations = [...(check.deviations ?? [])].sort((left, right) => left - right);
    const median = deviations.length > 0 ? deviations[Math.floor(deviations.length / 2)] : 0;
    const landed = check.landedOnAnotherKeyframe ?? 0;
    logger.info(
      // The session id, because without it this line cannot be attributed. A
      // family produces one summary per member — the picture and each
      // soundtrack — and on 2026-08-17 the picture's was read as the sound's,
      // from a neighbouring log line, and a roadmap item was written against
      // the wrong half of the stream. The id is the only thing that says whose
      // reading this is.
      // Named for what is being measured, which is not the same thing on the
      // two halves of a stream. The picture's cuts ARE keyframes of the file,
      // so its deviations measure the container's keyframe index. A soundtrack
      // is cut wherever it is asked to be and has no keyframes at all, so its
      // deviations measure how far the grid has moved since its run was
      // launched. One name for both said the index was wrong about a session
      // that never consulted it.
      `${session.audioOnly === true ? "sound-vs-grid" : "keyframe-index"} ` +
      `${session.id.slice(0, 8)} ${session.audioOnly === true ? "sound" : "picture"} ` +
      `${session.file.containerFormat || "unknown"} "${session.file.name}": ` +
      `${check.disagreed} of ${check.checked} produced segments started away from the playlist, ` +
      `median ${median.toFixed(3)}s worst ${check.maxDeviationSec.toFixed(3)}s` +
      (check.firstDisagreementIndex >= 0 ? ` (first at #${check.firstDisagreementIndex})` : "") +
      (session.audioOnly === true
        // A soundtrack has no keyframes, so there is no "began at another
        // keyframe" half to state — but the threshold the count was made
        // against belongs on both lines, or a number stands with nothing to
        // read it against.
        ? ` [tolerance ${SEGMENT_START_DISAGREEMENT_SEC}s]`
        // The discriminator, stated in the same line as the count it explains: a
        // segment that began at another time the SAME table names was not
        // mis-described by the table — the grid was built over a gap in it.
        : `; ${landed} of them began at another keyframe the table names` +
          ` [tolerance ${SEGMENT_START_DISAGREEMENT_SEC}s, ${(session.file.keyframeTimes?.length ?? 0)} keyframes read]`)
    );
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
    // construction, and a cycle between a picture and its steps would otherwise blow the stack on
    // the path that serves every playlist, init and segment.
    const owner = this.liveOutputs.pictureOf(session);
    // Settled once per session, and re-settled when this file's own decode cost
    // is measured or improves, or when the viewer moves to another rung — the
    // rung on screen is exempt from refusal, so it is an INPUT to this list and
    // belongs in what identifies a cached answer. Left out, the exemption
    // outlived the rung: a rung the host cannot hold went on being offered, and
    // went on passing every route guard, after the viewer had left it.
    // Everything else is fixed for the session's life.
    const observed = this.encodeCost.decodeCost.get(owner.file.key) ?? null;
    // Every rung a live viewer has on screen. One answer was enough while a
    // picture had one viewer; two of them can be on two rungs, and withdrawing
    // either is withdrawing a stream that is playing.
    const playingHeights = new Set(
      [...this.#variantsOnScreen(owner)]
        .map((sessionId) => this.sessionsById.get(sessionId))
        .filter((member) => member)
        .map((member) => this.liveOutputs.variantHeightOf(member))
    );
    const playing = [...playingHeights].sort((left, right) => left - right).join(",");
    // Everything the answer is derived from belongs in what identifies it. The
    // copy's price and the torrent's are inputs now, and left out of this key
    // the menu would keep the answer computed before either was measured — on
    // a copied picture, which is the case they exist for, the decode version
    // never moves at all, so the cache would never be recomputed.
    const copyVersion = this.encodeCost.copyCost.get(owner.file.key)?.version ?? 0;
    const torrentCost = this.#observedTorrentCostPerMegabyte ?? 0;
    // The soundtrack's price is an input too, and so is how many encoders of
    // this family are running: both move the answer, and an answer cached
    // across them is the stale menu this key exists to prevent.
    const audioVersion = [...this.liveOutputs.familyOf(owner)]
      .filter((member) => member.audioOnly === true)
      .map((member) => this.encodeCost.audioCost.get(this.#audioCostKey(member))?.version ?? 0)
      .reduce((total, one) => total + one, 0);
    const running = [...this.liveOutputs.familyOf(owner)]
      .filter((member) => processCanBeSignalled(runStateOf(member))).length;
    // What each running encode was last seen doing, which is BOTH an input to
    // the answer twice over — it withdraws a step measured below realtime, and
    // it prices every running picture in the committed total — and a figure
    // rewritten every five seconds. Left out of the key, the menu could be
    // pinned to what was computed before anything had been measured: on a
    // COPIED picture the decode version never moves at all, so nothing else in
    // the key would ever have recomputed it.
    // Encoded for the DECISIONS it feeds, not as a raw figure. Two of them: is
    // this encode below realtime (which withdraws its own step outright), and
    // what does it cost (which is charged against every other step). A raw
    // speed at two decimals moves on nearly every five-second reading, so the
    // menu would be recomputed — and its "not offering" line written — for the
    // whole film; while rounding alone would hide the 0.995-1.005 crossing,
    // which is exactly the band a step spends its time in when the host is
    // marginal. The flag carries the crossing, the rounded cost carries the
    // rest.
    const measured = this.liveOutputs.familyOf(owner)
      .map((member) => {
        const speed = member.lastAloneSpeed;
        if (!Number.isFinite(speed) || !(speed > 0)) {
          return "-";
        }
        return `${speed < 1 ? "slow" : "ok"}${(1 / speed).toFixed(2)}`;
      })
      .join(",");
    // The bar the answer is judged against, and the rate the torrent's price is
    // charged at. Both are inputs now — the bar rises when the reader meets
    // interruptions, the rate moves every five seconds — and neither moves any
    // other term of this key. Left out, a menu computed while nothing was known
    // about the swarm would stand for the whole film, offering steps that
    // supply cannot support and passing every route guard on the way.
    const demanded = owner.supplyFigures?.requiredSpeed
      ?? this.#requiredSpeedFor(owner.file.sourceKey, owner.file.fileIndex);
    const movingMegabytes = this.#torrentMegabytesPerSecond(
      owner.file.sourceKey,
      owner.file.fileIndex,
      this.#fileLengthByKey.get(owner.file.key) ?? null,
      owner.file.durationSeconds
    );
    const version =
      `${observed?.version ?? 0}:${playing}:${copyVersion}:${torrentCost.toFixed(6)}:` +
      `${audioVersion}:${running}:${measured}:${(demanded ?? 0).toFixed(2)}:` +
      `${(movingMegabytes ?? 0).toFixed(2)}`;
    if (Array.isArray(owner.offeredHeightsCache) && owner.offeredHeightsVersion === version) {
      return owner.offeredHeightsCache;
    }
    const heights = new Set(variantHeightsFor(Number(owner.file.height) || 0));
    const own = this.liveOutputs.variantHeightOf(owner);
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
    const answer = this.encodeCost.sustainableHeights({
      heights: ordered,
      ownHeight: own,
      playingHeights,
      // What each rung was actually seen doing in this session, which is the
      // only thing a live reading may speak for.
      measuredHeights: this.encodeCost.measuredRungSpeeds(owner),
      // The speed this file's supply demands, measured by its own reader on
      // this swarm. A well-seeded film and a thin one ask different speeds of
      // the same machine, so the bar belongs to the pair, not to the host.
      requiredSpeed: demanded,
      // What the family is already spending while a rung is considered. The
      // picture being COPIED is the common case and used to be priced at
      // nothing; measured, it is about an eighth of the machine.
      concurrentCostSec: this.encodeCost.committedCostOf(owner),
      // So a height already being produced is not charged for itself when it is
      // judged. See the subtraction in EncodeCost#sustainableHeights.
      runningCostByHeight: this.encodeCost.runningCostByHeight(owner),
      sourceWidth: Number(owner.file.width) || 0,
      sourceHeight: Math.round(Number(owner.file.height) || 0),
      fps: Number(owner.output.outputFps) || TRANSCODE_FPS,
      source: owner.file.decode ?? null,
      transcodeVideo: owner.transcodeVideo === true,
      // NOT the learned cost. What a rung is OFFERED on is the startup
      // measurement, which is taken on a quiet machine against known clips and
      // does not move; the figure learned from a live session moves with
      // whatever else the box was doing at that second, and three field
      // sessions in a row (2026-08-15) show what that costs: 0.87x, then
      // 1.34-1.57x against calibration's 2.6x, each reading refusing another
      // rung until the offer held one height and the menu disappeared with it.
      //
      // The learned figure keeps its job — but only over the rung it was
      // measured ON, and only to take that one away (below). A measurement of
      // one rung is not a prediction about the others.
      observedDecodeCostSec: null
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
    const entry = this.encodeCost.decodeCost.get(session.file.key);
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
   * the fastest instead makes the figure a ratchet: its maximum falls in the
   * burst where the encoder races to the look-ahead cap with the pieces already
   * on disk and nothing competing, and one such moment would re-admit —
   * permanently — the very rung the field measured at 0.388-0.947x. The median
   * moves in both directions and describes the machine as it usually is, which
   * is what a viewer will meet.
   *
   * The reading is the difference between two samples of one run: `speed=`
   * itself is cumulative and would carry the restart, the resume and the wait
   * for the first pieces in its denominator, but a difference cannot — and a
   * new run clears the previous sample (`#startEncodeRun`), so no pair can
   * straddle two runs. That is why nothing here waits a fixed twenty seconds
   * before believing a run: waiting was a chosen number standing in for this,
   * and it cost every reading a short run could have given.
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
  /**
   * How many encoders are running and not suspended right now.
   *
   * A cost measured while two of them share the machine belongs to neither.
   *
   * @returns {number}
   */
  #runningEncoders() {
    let running = 0;
    for (const session of this.sessionsById.values()) {
      if (session.state === "disposed") {
        continue;
      }
      for (const run of liveRunsOf(session)) {
        if (run.state !== ENCODE_RUN_STATE.SUSPENDED) {
          running += 1;
        }
      }
    }
    return running;
  }

  async #learnFromEncoder(session) {
    if (
      !session ||
      session.state === "disposed" ||
      runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED ||
      liveRunsOf(session).length === 0 ||
      runStateOf(session) === ENCODE_RUN_STATE.SUSPENDED
    ) {
      session.learnSample = null;
      return;
    }
    // Measured as a DELTA between two readings of a run that was going for the
    // whole interval, not from ffmpeg's cumulative `speed=`. The cumulative
    // figure counts every second the encoder spent SIGSTOPped by the look-ahead
    // cap in its denominator, and a copy spends most of its life there — it
    // reaches the cap in about fifteen seconds and then waits a minute. Read
    // that way a copy running at 8x reports 1.6x and falling, which would be
    // filed as the price of copying and refuse rungs on arithmetic that
    // measured a pause.
    const processedSeconds = Number(session.progress?.processedSeconds);
    const takenAt = Date.now();
    const previous = session.learnSample ?? null;
    // Stamped with the run it was taken from. A restart clears this sample, but
    // it then spends up to a second and a half making its directory and burying
    // its predecessor, and through that window the session still carries the
    // OLD process and the OLD position — so a sample taken there, paired with
    // the new run's first position, reads a twenty-minute seek as twenty
    // minutes of video produced in five seconds. Filed as this file's price it
    // admits every quality step there is. Comparing the serials is what the
    // twenty-second wait used to stand in for, and unlike the wait it costs no
    // readings on a short run.
    const run = liveRunsOf(session)[0] ?? null;
    session.learnSample = { takenAt, processedSeconds, run };
    if (previous === null || !Number.isFinite(processedSeconds) || !Number.isFinite(previous.processedSeconds)) {
      return;
    }
    if (previous.run !== run) {
      return; // the pair straddles a restart and measures the seek, not the host
    }
    const speed = speedFromReadings(previous, { takenAt, processedSeconds }, LEARN_WINDOW_MIN_SEC);
    if (speed === null) {
      return;
    }
    // Recorded HERE, before any of the conditions below can discard the
    // reading, because the budget and the learning ask different questions of
    // it. Learning refuses a reading taken beside another encoder, since it
    // would file that encoder's work as this file's price; the budget wants
    // exactly what this run is doing right now, whatever else the machine is
    // doing beside it. Sharing the figure and not the conditions is what lets
    // the budget stop reading ffmpeg's cumulative average.
    session.recentSpeed = { speed, at: takenAt, run };
    const kind = costKindForSession(session);
    // A reading taken beside another encoder contains that other encoder's
    // work, and the budget ADDS the same work again when it predicts — so filed
    // as it stands the price is counted twice and grows with every reading.
    // Measured 2026-08-15 in the field: copying, whose truth is 7.9x, was
    // learned as 2.03x, and decoding, whose clips say 2.6x, as 0.87x. Every
    // step was then refused, the offer collapsed to the one copied height, and
    // the viewer lost the quality menu altogether.
    //
    // For a picture the answer is to wait for a moment alone, which comes often
    // enough. For a SOUNDTRACK it never comes: a rendition runs for exactly as
    // long as the picture it accompanies, so "alone" is a state it is never in,
    // and the price stayed unmeasured for ever — the hole this was meant to
    // close. Its share is instead recovered by subtracting what the machine is
    // already known to be spending, which is the same arithmetic that recovers
    // this source's decoding from a running encoder, and it is only done when
    // every other running encode HAS a price. Otherwise the unpriced work would
    // land in the soundtrack's account and refuse steps on it.
    let othersCostSec = 0;
    if (this.#runningEncoders() > 1) {
      if (kind !== "audio") {
        return;
      }
      const others = this.encodeCost.pricedConcurrentCost(session);
      if (others === null) {
        return; // something running has no price; nothing can be attributed
      }
      othersCostSec = others;
    }
    if (speed < BUDGET_SPEED_OK && await this.#classifyTranscodeBound(session) === "download") {
      return; // the torrent is what is short; this says nothing about the host
    }
    // What this encode did with the machine to itself — the one figure a live
    // reading is authority on, and what withdraws a quality step that has been
    // seen failing without letting it speak for steps nobody has run.
    //
    // Recorded only AFTER the download-bound check, and that order is the whole
    // point: a run starved of torrent data reports a speed that measures the
    // swarm. Stored first, as it was, that figure became this encode's price —
    // 0.3x reads as 3.33 s of work per second of video, more than the machine
    // has — and every other quality step was refused on the download's account.
    session.lastAloneSpeed = speed;
    // What the offer predicted for this very step, against what it then did
    // with the machine to itself. The prediction is corrected for the share of
    // the machine that was free at the time, so this ratio is the error that
    // remains AFTER that correction — which is the only way to tell whether a
    // stage of roadmap item 3 moved anything. Written when it changes by more
    // than a tenth, so a steady step says it once rather than every five
    // seconds.
    if (Number.isFinite(session.predictedSpeedWhenOffered) && session.predictedSpeedWhenOffered > 0) {
      const ratio = speed / session.predictedSpeedWhenOffered;
      const lastSaid = session.lastPredictionRatio;
      if (!Number.isFinite(lastSaid) || Math.abs(ratio - lastSaid) > 0.1) {
        session.lastPredictionRatio = ratio;
        logger.info(
          `prediction ${session.id.slice(0, 8)} ${session.output.encodeHeight || "source"}p: ` +
          `predicted ${session.predictedSpeedWhenOffered.toFixed(2)}x, measured ${speed.toFixed(2)}x ` +
          `(ratio ${ratio.toFixed(2)}; 1.00 would mean the arithmetic describes this machine)`
        );
      }
    }
    if (kind === "audio") {
      // What is left after the work that was already accounted for. `null` when
      // the subtraction leaves nothing positive, which means the reading says
      // less than the noise in it.
      const ownCostSec = 1 / speed - othersCostSec;
      if (!(ownCostSec > 0) || !Number.isFinite(ownCostSec)) {
        return;
      }
      await this.#learnAudioCost(session, 1 / ownCostSec);
      return;
    }
    if (kind === "decode") {
      this.#learnDecodeCost(session, speed);
      return;
    }
    await this.#learnCopyCost(session, speed);
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
   * Median of recent readings, for the same reasons as the decode cost beside
   * it.
   *
   * @param {HlsSession} session
   * @param {number} speed
   */
  async #learnCopyCost(session, speed) {
    if (runStateOf(session) === ENCODE_RUN_STATE.SUSPENDED) {
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
    const key = session.file.key;
    const known = this.encodeCost.copyCost.get(key);
    const readings = [...(known?.readings ?? []), costSec].slice(-DECODE_LEARNING_READINGS);
    const median = medianOf(readings);
    if (!movedBeyondScatter(known?.costSec ?? null, median, readings)) {
      this.encodeCost.copyCost.set(key, { ...known, readings });
      return;
    }
    this.encodeCost.copyCost.set(key, { costSec: median, readings, version: (known?.version ?? 0) + 1 });
    logger.info(
      `transcode: ${session.file.name} copies at ${(1 / median).toFixed(2)}x on this host ` +
        `(median of ${readings.length}, latest ${speed.toFixed(2)}x)`
    );
  }

  /**
   * What this file's audio track costs to encode on this host.
   *
   * A rendition is a second encoder, running for as long as the picture does,
   * and the budget counted it at nothing — which is half of what roadmap item 6
   * was left owing. It is small beside a picture, and small is not zero: on a
   * host where a rung needs almost the whole machine, a soundtrack is the
   * difference between offering it and refusing it.
   *
   * Same rules as {@link #learnCopyCost}, for the same reasons: never
   * suspended, never while the torrent is what is short.
   *
   * @param {HlsSession} session
   * @param {number} speed
   */
  async #learnAudioCost(session, speed) {
    if (runStateOf(session) === ENCODE_RUN_STATE.SUSPENDED) {
      return;
    }
    if (await this.#classifyTranscodeBound(session) === "download") {
      return;
    }
    const costSec = 1 / speed;
    if (!(costSec > 0) || !Number.isFinite(costSec)) {
      return;
    }
    const key = this.#audioCostKey(session);
    const known = this.encodeCost.audioCost.get(key);
    const readings = [...(known?.readings ?? []), costSec].slice(-DECODE_LEARNING_READINGS);
    const median = medianOf(readings);
    if (!movedBeyondScatter(known?.costSec ?? null, median, readings)) {
      this.encodeCost.audioCost.set(key, { ...known, readings });
      return;
    }
    this.encodeCost.audioCost.set(key, { costSec: median, readings, version: (known?.version ?? 0) + 1 });
    logger.info(
      `transcode: ${session.file.name} encodes audio track ${session.audioTrackIndex ?? 0} at ` +
        `${(1 / median).toFixed(2)}x on this host (median of ${readings.length}, latest ${speed.toFixed(2)}x)`
    );
  }

  /**
   * What this file costs the machine merely by being fetched and delivered
   * while it is watched, in seconds of work per second of video.
   *
   * A viewer consumes the file at its own byte rate, and every one of those
   * bytes is downloaded, verified and pushed by this process. Priced per
   * megabyte from readings taken while nothing was encoding, so the two
   * measurements do not contain each other. Zero while either term is unmeasured
   * — a guess here would refuse rungs on arithmetic nobody performed.
   *
   * @param {HlsSession} session
   * @returns {number}
   */
  #torrentCostSecFor(session) {
    const perMegabyte = this.#observedTorrentCostPerMegabyte;
    const megabytesPerSecond = this.#torrentMegabytesPerSecond(
      session.file.sourceKey,
      session.file.fileIndex,
      this.#fileLengthByKey.get(session.file.key) ?? null,
      session.file.durationSeconds
    );
    return perMegabyte !== null && megabytesPerSecond !== null
      ? perMegabyte * megabytesPerSecond
      : 0;
  }

  /**
   * @param {HlsSession} session
   * @returns {string}
   */
  #audioCostKey(session) {
    return `${session.file.key}:${session.audioTrackIndex ?? 0}`;
  }

  #learnDecodeCost(session, speed) {
    if (!(speed > 0)) {
      return;
    }
    if (session.transcodeVideo !== true) {
      // Nothing to learn about decoding here, and nothing else either: the
      // caller routes a copy to #learnCopyCost and a rendition to
      // #learnAudioCost before this is ever reached. Routing them from here as
      // well put both calls behind a guard the caller had already made
      // (`transcodeVideo === true`), so neither could run.
      return;
    }
    if (this.videoEncoder?.kind !== "software") {
      return; // the benchmark that prices the encode half is libx264 only
    }
    const benchmark = this.softwarePresetBenchmark;
    if (!Array.isArray(benchmark) || benchmark.length === 0) {
      return;
    }
    const entry = benchmark.find((item) => item.preset === session.output.softwarePreset);
    if (!entry || !(entry.pixelsPerSec > 0)) {
      return;
    }
    const height = Number(session.output.encodeHeight) || 0;
    const width = Number(session.output.encodeWidth) || 0;
    const fps = Number(session.output.outputFps) || TRANSCODE_FPS;
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
    const key = session.file.key;
    const known = this.encodeCost.decodeCost.get(key);
    const readings = [...(known?.readings ?? []), decodeCostSec].slice(-DECODE_LEARNING_READINGS);
    const costSec = medianOf(readings);
    if (!movedBeyondScatter(known?.costSec ?? null, costSec, readings)) {
      // The same answer as before, by the readings' own scatter. Storing it
      // would bump the version and make every session recompute its offer,
      // which is asked for on the path that serves every playlist, init and
      // segment.
      this.encodeCost.decodeCost.set(key, { ...known, readings });
      return;
    }
    this.encodeCost.decodeCost.set(key, { costSec, readings, version: (known?.version ?? 0) + 1 });
    logger.info(
      `transcode: ${session.file.name} decodes at ${(1 / costSec).toFixed(2)}x on this host ` +
        `(median of ${readings.length}, latest ${(1 / decodeCostSec).toFixed(2)}x from ${height}p ` +
        `at ${speed.toFixed(2)}x, preset ${session.output.softwarePreset})`
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
      ? (this.encodeCost.decodeCost.get(`${mediaInfo.sourceKey}:${mediaInfo.fileIndex}`)?.costSec ?? null)
      : null;
    // What this file costs the machine merely by being fetched and delivered is
    // known before any session exists, so the FIRST offer — the one the viewer
    // actually sees when they open a file — is priced with it too. Without this
    // the plan and a live session answer differently about the same file.
    const movingMegabytesPerSec = mediaInfo?.sourceKey !== undefined
      ? this.#torrentMegabytesPerSecond(
        mediaInfo.sourceKey,
        mediaInfo.fileIndex,
        mediaInfo.fileLength ?? null,
        mediaInfo.durationSeconds ?? null
      )
      : null;
    const torrentCostSec = this.#observedTorrentCostPerMegabyte !== null && movingMegabytesPerSec !== null
      ? this.#observedTorrentCostPerMegabyte * movingMegabytesPerSec
      : 0;
    const forBranch = (transcodeVideo) =>
      this.encodeCost.sustainableHeights({
        heights,
        concurrentCostSec: torrentCostSec,
        // What this file's swarm demanded the last time it was read. Absent on
        // a first open, and then the bar is realtime.
        requiredSpeed: mediaInfo?.sourceKey !== undefined
          ? this.#requiredSpeedFor(mediaInfo.sourceKey, mediaInfo.fileIndex)
          : null,
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
   * The height this proxy is asking the player to move to, or 0.
   *
   * Cleared the moment the viewer is on it — the request has been answered —
   * and dropped when it runs out, which is the only sign this side ever gets
   * that a player could not or would not follow it. A browser on a manual pick
   * ignores every request by design, so an unanswered one is not an error; it
   * is said once and let go, rather than repeated for the rest of the film.
   *
   * @param {HlsSession} named - The session the browser addressed.
   * @returns {number}
   */
  #standingAskFor(named) {
    const base = this.liveOutputs.pictureOf(named);
    const ask = base.qualityAsk;
    if (!ask) {
      return 0;
    }
    if (ask.height === this.liveOutputs.variantHeightOf(this.#activeVariant(base))) {
      base.qualityAsk = null; // the viewer is there; nothing left to ask for
      return 0;
    }
    if (Date.now() - ask.at > QUALITY_ASK_TTL_MS) {
      base.qualityAsk = null;
      logger.info(
        `[budget] transcode ${base.id} asked for ${ask.height}p and the player stayed where it was ` +
          `(${ask.reason}); letting the request go`
      );
      return 0;
    }
    return ask.height;
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
   * Kept per viewer, because one picture is shared by everyone watching it and
   * a quality step is a session of its own: with one answer for the session, a
   * step taken by one viewer would move the other one's stream, and that
   * viewer's next seek would be forwarded to a rung they never chose. The
   * session's own field remains the answer for a viewer who cannot name
   * themselves, and the last one anybody moved to.
   *
   * @param {HlsSession} base
   * @param {string} [consumerId]
   * @returns {HlsSession}
   */
  #activeVariant(base, consumerId = "") {
    const named = consumerId ? base.viewers?.get(consumerId)?.activeVariantId ?? null : null;
    const activeId = named ?? base.activeVariantId;
    if (!activeId || activeId === base.id) {
      return base;
    }
    const active = this.sessionsById.get(activeId);
    if (!active || active.state === "disposed") {
      if (named) {
        this.viewers.of(base, consumerId).activeVariantId = null;
      }
      if (base.activeVariantId === activeId) {
        base.activeVariantId = base.id;
      }
      return base;
    }
    return active;
  }

  /**
   * Every session of this family that a live viewer has on screen.
   *
   * The question "may this rung's encoder be stopped" has no single answer once
   * two viewers watch one picture at two qualities: the rung one of them left is
   * the rung the other is watching. Nothing may be stopped for being left unless
   * nobody is left on it.
   *
   * @param {HlsSession} base
   * @returns {Set<string>} Session ids.
   */
  #variantsOnScreen(base) {
    const live = this.#liveConsumers(base);
    const onScreen = new Set();
    for (const [consumerId, viewer] of base.viewers ?? []) {
      if (viewer.activeVariantId === null) {
        continue;
      }
      if (consumerId && live.size > 0 && !live.has(consumerId)) {
        continue;
      }
      onScreen.add(viewer.activeVariantId);
    }
    if (onScreen.size === 0) {
      onScreen.add(this.#activeVariant(base).id);
    }
    return onScreen;
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
      return this.#segmentStartTime(base, wantedIndex);
    }
    return this.#viewerPositionOf(this.#activeVariant(base, consumerId));
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

  #audioStartSecondsFor(base) {
    const now = Date.now();
    // Read across every rung a viewer has on screen, not just one. A link
    // report is kept on the session the reporter is watching, so with two
    // viewers on two rungs each rung holds half the answer — and this needs the
    // EARLIEST picture of them all, because a soundtrack started at the leader's
    // position has nothing to give the viewer behind them.
    const watched = [...this.#variantsOnScreen(base)]
      .map((sessionId) => this.sessionsById.get(sessionId))
      .filter((member) => member && member.state !== "disposed");
    const watching = watched[0] ?? this.#activeVariant(base);
    let readHead = 0;
    let earliestStated = null;
    let deepestBuffer = null;
    for (const member of watched.length > 0 ? watched : [watching]) {
      readHead = Math.max(readHead, this.#viewerPositionOf(member));
      const reported = this.#reportedPictureOf(member, now);
      if (reported.earliestPosition !== null) {
        earliestStated = earliestStated === null
          ? reported.earliestPosition
          : Math.min(earliestStated, reported.earliestPosition);
      }
      if (reported.deepestBuffer !== null) {
        deepestBuffer = deepestBuffer === null
          ? reported.deepestBuffer
          : Math.max(deepestBuffer, reported.deepestBuffer);
      }
    }
    if (earliestStated !== null) {
      // Never ahead of the read head: a position claiming to be past what has
      // been asked for is a report that arrived out of order, and acting on it
      // would start the run where no request can ever reach it.
      return Math.max(0, Math.min(earliestStated, readHead) - this.segmentDurationSec);
    }
    // "Opened" only if it is true of EVERY rung anybody is watching: one of
    // them having served a segment means the film is running, whatever the
    // others have done.
    const everyoneJustOpened = (watched.length > 0 ? watched : [watching])
      .every((member) => this.#viewerPositionSourceOf(member) === "opened");
    if (everyoneJustOpened) {
      // The session has not started. Nobody has seeked, nobody has asked for a
      // segment, and nobody has reported anything — so the read head is not a
      // request edge at all, it is where the viewer opened, and a browser that
      // has just opened holds no buffer by construction. Subtracting one here
      // is not erring "early, the cheap direction": it is the whole of the
      // start-up cost. Field 2026-08-31: a page opened at 588s started its
      // sound at 460s, 131 seconds of film nobody would hear, and the segment
      // the viewer needed took 38.8s to appear against the picture's 8.4s
      // (`research/cold-open-audio-start-2026-08-31.md`).
      return Math.max(0, readHead - this.segmentDurationSec);
    }
    const buffered = deepestBuffer === null ? LOOKAHEAD_PAUSE_SECONDS : deepestBuffer;
    return Math.max(0, readHead - buffered - this.segmentDurationSec);
  }

  /**
   * Which reading gave a viewer's position — see {@link viewerPositionSource}.
   *
   * @param {HlsSession} session
   * @param {string} [consumerId] - Whose position. Without one the answer is
   *   the session's, which is the FURTHEST viewer of it.
   * @returns {"seeked" | "requested" | "opened" | "none"}
   */
  #viewerPositionSourceOf(session, consumerId = "") {
    const head = consumerId ? session.viewers?.get(consumerId)?.position ?? null : null;
    if (head) {
      return viewerPositionSource({
        seeked: head.seeked,
        lastRequestedStart: head.seconds,
        openedAt: session.progress?.startPositionSeconds
      });
    }
    const lastRequestedStart = Number.isInteger(session.lastRequestedSegment) && session.lastRequestedSegment > 0
      ? this.#segmentStartTime(session, session.lastRequestedSegment)
      : null;
    return viewerPositionSource({
      seeked: session.furthestViewerSeconds,
      lastRequestedStart,
      openedAt: session.progress?.startPositionSeconds
    });
  }

  /**
   * Where a viewer is on this session's timeline, in seconds.
   *
   * With a viewer named, it is THEIR head: their own seek, or the segment they
   * last asked for. Without one it is the session's own reading — the furthest
   * viewer of it — which is what an encode run is placed by, because what lies
   * behind the furthest has already been made.
   *
   * @param {HlsSession} session
   * @param {string} [consumerId]
   * @returns {number}
   */
  #viewerPositionOf(session, consumerId = "") {
    const head = consumerId ? session.viewers?.get(consumerId)?.position ?? null : null;
    if (head && Number.isFinite(head.seconds)) {
      return head.seconds;
    }
    const lastRequestedStart = Number.isInteger(session.lastRequestedSegment) && session.lastRequestedSegment > 0
      ? this.#segmentStartTime(session, session.lastRequestedSegment)
      : null;
    return resolveViewerPosition({
      seeked: session.furthestViewerSeconds,
      lastRequestedStart,
      openedAt: session.progress?.startPositionSeconds
    });
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
    const running = liveRunsOf(session);
    if (running.length === 0) {
      return;
    }
    // A newer start may be waiting on an await inside #startEncodeRun; clearing
    // the attempt makes it return instead of spawning into a stopped session.
    session.pendingRun = null;
    // Every run this session has going. The callers all mean the session's
    // encoding as a whole: a rung nobody is watching any more, a session being
    // disposed. A run that had already finished or failed is not among them,
    // which is what keeps a stop from erasing how it actually ended.
    for (const run of running) {
      const ffmpeg = run.process;
      // The stretch it was given, read now rather than when the process finally
      // exits: by then the session may have started another run with another
      // stretch, and the piece to discard belongs to this one.
      const stoppedSpan = {
        from: Number.isInteger(run.from) ? run.from : 0,
        to: Number.isInteger(run.to) ? run.to : -1
      };
      // The run resumes itself if it was suspended — a stopped process does not
      // act on SIGTERM until it is continued — records the cause, and answers
      // its own exit. Nothing here has to null a field so that the exit is read
      // correctly, because there is no shared field left to misread.
      run.stop(reason);
      // The session outlives its runs — a stopped rung keeps serving what it
      // made — so the piece this one had open must not be left looking like one
      // of them. Not awaited: the caller's own work does not depend on it, and
      // the wait is for a process that has already been told to go.
      void waitForChildExit(ffmpeg, ENCODE_RUN_TERMINATE_GRACE_MS).then(() =>
        this.#discardUnfinishedPiece(session, session.dirPath, stoppedSpan)
      );
    }
    logger.info(`transcode ${session.id} ${running.length} encoder(s) stopped: ${reason}`);
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
    // and honouring it would let a client start encoder runs at will. The
    // MASTER's list, not the live one: a rung is published for the session's
    // whole life, and refusing what we published is how a quality switch became
    // a 404 storm across every level.
    if (!this.liveOutputs.splicableHeights(base).includes(height)) {
      return null;
    }
    if (height === this.liveOutputs.variantHeightOf(base)) {
      return base;
    }
    // What this height was answered with before, if it has been asked. Kept as
    // a height and not as a session id: the answer must not move — a player
    // holding an init for one size cannot be sent another — and a number cannot
    // go stale, so nothing has to be cleaned from the other side when a session
    // ends.
    const answeredWith = base.file.stepHeights.get(height);
    if (answeredWith) {
      const serving = this.liveOutputs.stepsOf(base).find((other) => this.liveOutputs.producedHeightOf(other) === answeredWith);
      const existing = this.liveOutputs.producedHeightOf(base) === answeredWith ? base : serving;
      if (existing) {
        existing.lastAccessedAt = Date.now();
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
      transcodeAudio: base.transcodeAudio,
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
        const incumbent = await this.#adoptIfAlreadyProduced(base, height, variant);
        if (incumbent) {
          base.file.stepHeights.set(height, this.liveOutputs.producedHeightOf(incumbent));
          return incumbent;
        }
        variant.variantHeight = height;
        // How it came to be: a step of a picture, not a picture a browser
        // opened. Read where a step needs the facts of the file rather than of
        // its own encode.
        variant.isStep = true;
        base.file.stepHeights.set(height, this.liveOutputs.producedHeightOf(variant));
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
   * WHY THIS EXISTS, AND WHY IT COMPARES WHAT IS PRODUCED RATHER THAN WHAT WAS
   * ASKED FOR. The file's record is keyed on the height the browser requested,
   * while what the session encodes is decided afterwards, by the clamp in
   * `createOrGetSession`: a manual pick starts at the top of the ladder THIS
   * host can sustain (`startAtLadderTop`), which on a weak machine is well
   * below the height named. So a request for 360p and a request for 540p both
   * become a 426x240 encode, are filed under keys 360 and 540, and neither ever
   * finds the 240p session already producing that exact picture. Field
   * 2026-08-28: three ffmpeg processes on a CM4 making one identical picture,
   * every rung above 240p then measured at 0.04x of realtime, and the viewer
   * left watching a slideshow that ended in a spinner
   * (`research/session-pileup-variant-key-2026-08-28.md`).
   *
   * The comparison is made on the height PRODUCED because that is the only
   * figure that cannot be wrong. Predicting the clamp instead would mean a
   * second copy of the budget arithmetic, and the two would drift: the offer
   * deliberately prices a rung from the startup measurement
   * (`observedDecodeCostSec: null`) while the clamp prices it from what this
   * file has since been seen to cost, so they can and do answer differently.
   *
   * The price is one short-lived encoder the first time each requested height
   * is seen, which replaces one that would otherwise have run beside the others
   * for the rest of the session. Every later request for that height is
   * answered from the alias without starting anything.
   *
   * @param {HlsSession} base
   * @param {number} askedHeight
   * @param {HlsSession} candidate - The session just created for `askedHeight`.
   * @returns {Promise<HlsSession | null>} The incumbent to use instead, or null
   *   to keep the one just made.
   */
  async #adoptIfAlreadyProduced(base, askedHeight, candidate) {
    const produced = this.liveOutputs.producedHeightOf(candidate);
    if (produced <= 0) {
      return null;
    }
    const seen = new Set([candidate.id]);
    // The base belongs in this scan: it is a rung like any other, and when it
    // is itself a re-encode the clamp can land a variant right on top of it.
    for (const other of [base, ...this.liveOutputs.stepsOf(base)]) {
      if (!other || seen.has(other.id) || other.state === "disposed") {
        continue;
      }
      seen.add(other.id);
      if (this.liveOutputs.producedHeightOf(other) !== produced) {
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
    if (!this.liveOutputs.splicableHeights(base).includes(height)) {
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
    const base = this.sessionsById.get(baseSessionId);
    if (!base || base.state === "disposed" || !this.#servesAudioSeparately(base)) {
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
      const abandoned = this.sessionsById.get(stillWarming);
      const wanted = this.#liveAudioRenditionKeys(base);
      const wantedIds = new Set(
        this.liveOutputs.renditionsOf(base)
          .filter((other) => wanted.has(audioRenditionKey(other.audioTrackIndex ?? 0, other.transcodeAudio === true)))
          .map((other) => other.id)
      );
      if (abandoned && !wantedIds.has(abandoned.id)) {
        this.#stopEncodeRun(abandoned, "prepared for a track change the viewer did not make");
      }
    }
    this.viewers.of(base, consumerId).warmingAudioId = rendition.id;
    // Being prepared for them is watching it: it is made for this viewer, and
    // when they leave it must be let go with everything else of theirs.
    this.viewers.of(rendition, consumerId);
    // Pointed at the position the switch will land on: an existing track is
    // parked wherever the viewer left it.
    this.#seekSession(rendition, positionSeconds);
    const index = this.#segmentIndexForTime(rendition, positionSeconds);
    return { sessionId: rendition.id, fileName: rendition.segmentFormat.segmentFileName(index) };
  }

  async prepareVariant(baseSessionId, height, positionSeconds, consumerId = "") {
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
      const abandoned = this.sessionsById.get(stillWarming);
      if (abandoned && !this.#variantsOnScreen(base).has(abandoned.id)) {
        this.#stopEncodeRun(abandoned, "warmed for a switch the viewer did not make");
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
    variant.lastAccessedAt = Date.now();
    // Anything that is not the rung on screen has to be pointed at the switch
    // position — INCLUDING the base. Skipping it because it is the base was a
    // defect: the base is parked wherever it was when the viewer left it, and
    // its encoder was stopped then. Measured 2026-08-12, warming 400p at
    // 6506.5s found the base still at `run from #0`, so the segment the switch
    // needed was never produced and the viewer got nothing at all.
    if (variant.id !== this.#activeVariant(base, consumerId).id) {
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
   * @param {string} [consumerId] - Which viewer moved.
   * @returns {void}
   */
  #noteVariantActive(base, variant, wantedIndex = -1, consumerId = "") {
    const previous = this.#activeVariant(base, consumerId);
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
    const warmed = base.viewers?.get(consumerId)?.warmingVariantId ?? null;
    if (base.viewers?.has(consumerId)) {
      this.viewers.of(base, consumerId).warmingVariantId = null;
    }
    if (warmed && warmed !== variant.id && warmed !== previous.id) {
      const abandoned = this.sessionsById.get(warmed);
      if (abandoned && !this.#variantsOnScreen(base).has(abandoned.id)) {
        this.#stopEncodeRun(abandoned, "warmed for a switch the viewer did not make");
      }
    }
    const position = this.#variantStartSeconds(base, wantedIndex, consumerId);
    base.activeVariantId = variant.id;
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
      `transcode ${base.id} variant now ${this.liveOutputs.variantHeightOf(variant)}p ` +
      `(was ${this.liveOutputs.variantHeightOf(previous)}p) at ${position.toFixed(1)}s` +
      (consumerId ? ` for ${consumerId}` : "")
    );
    // The rung being left is stopped only if it is nobody else's rung. Two
    // viewers of one picture can be on two steps, and the one this viewer just
    // left may be the one the other is watching — stopping it there would take
    // away a stream that is playing, and answer 503 to every request held on it.
    if (!this.#variantsOnScreen(base).has(previous.id)) {
      // Every request still held on the old rung is for a segment nobody will
      // produce now — its encoder is about to be stopped — and the player has
      // already stopped waiting for them. Answering "retry" at once frees them
      // instead of holding each for the full minute.
      previous.waitEpoch = (previous.waitEpoch ?? 0) + 1;
      this.#stopEncodeRun(previous, `no viewer is watching ${this.liveOutputs.variantHeightOf(previous)}p`);
    }
    if (position > 0) {
      variant.furthestViewerSeconds = position;
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
  buildMasterPlaylist(sessionId, consumerId = "") {
    if (!isSafeSessionId(sessionId)) {
      return null;
    }
    const session = this.sessionsById.get(sessionId);
    if (!session || session.state === "disposed") {
      return null;
    }
    if (!this.liveOutputs.publishesVariants(session)) {
      return null;
    }
    const sourceHeight = Number(session.file.height) || 0;
    // What CAN be spliced, not what is worth offering this second. The live
    // judgement travels in `offeredHeights` and in every progress report, which
    // is what the viewer's menu follows; letting it decide the master's
    // existence made a live session answer 404 to its own published address.
    const rungs = this.liveOutputs.splicableHeights(session);
    const sourceWidth = Number(session.file.width) || 0;
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
      playlistVersion: session.segmentFormat.playlistVersion,
      heights: rungs,
      sourceWidth,
      sourceHeight,
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
   * @param {string} [consumerId] - Who is asking. One picture serves everyone
   *   watching it, and which soundtrack they are listening to is theirs alone.
   * @returns {Promise<{ sessionId: string | null, error?: string }>}
   */
  async resolveAudioRenditionFile(baseSessionId, trackIndex, fileName, consumerId = "") {
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
    base.activeAudioTrackIndex = trackIndex;
    const wanted = this.#liveAudioRenditionKeys(base);
    for (const other of this.liveOutputs.renditionsOf(base)) {
      if (wanted.has(audioRenditionKey(other.audioTrackIndex ?? 0, other.transcodeAudio === true))) {
        continue;
      }
      if (liveRunsOf(other).length === 0) {
        continue;
      }
      // Requests held on it are for segments nobody will produce now, and the
      // player stopped waiting for them the moment it changed track.
      other.waitEpoch = (other.waitEpoch ?? 0) + 1;
      // Nobody is listening to it any more: this viewer stops watching that
      // output, on both sides of the relation, and the claim their listening
      // placed on it is released with them.
      this.#viewerLeaves(other, consumerId);
      this.#stopEncodeRun(other, `no viewer is listening to audio track ${other.audioTrackIndex ?? "?"}`);
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
    const staleAfterMs = this.presenceStaleAfterMs();
    const now = Date.now();
    const live = new Set();
    for (const member of this.liveOutputs.familyOf(base)) {
      for (const [consumerId, viewer] of member.viewers ?? []) {
        if (viewer.isPresent(now, staleAfterMs)) {
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
    const stated = base.viewers?.get(consumerId)?.audio ?? null;
    if (stated) {
      return stated;
    }
    // A viewer this session has not heard from by name. The session's own
    // parameters are the honest fallback: they are what the request that
    // created it asked for.
    return {
      trackIndex: Number(base.activeAudioTrackIndex ?? base.audioTrackIndex) || 0,
      transcode: base.transcodeAudio === true
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
    const already = this.liveOutputs.renditionsOf(base).find(
      (other) =>
        (other.audioTrackIndex ?? 0) === trackIndex &&
        (other.transcodeAudio === true) === transcodeAudio
    );
    if (already) {
      already.lastAccessedAt = Date.now();
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
      startPositionSeconds: this.#audioStartSecondsFor(base),
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
        : null,
      // Hold the file this rendition will READ. For a soundtrack shipped beside
      // the picture that is a different file of the same torrent, and nothing
      // else claims it: the base holds the picture, and the disk sweep deletes
      // what nobody is holding — which is how a film being watched was deleted
      // on 2026-08-06.
      acquireSource: () => base.acquireSource?.(
        this.#resolveAudioSource(base.file.sourceKey, base.file.fileIndex, trackIndex).fileIndex
      )
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
    const chosen = Number.isInteger(chosenTrack) ? chosenTrack : (Number(session.audioTrackIndex) || 0);
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
    const session = isSafeSessionId(sessionId) ? this.sessionsById.get(sessionId) : null;
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
    const session = isSafeSessionId(sessionId) ? this.sessionsById.get(sessionId) : null;
    if (!session) {
      return 0;
    }
    const own = this.#consumerPositionOf(session, consumerId);
    const position = own === null ? Number(session.furthestViewerSeconds) : own;
    return Number.isFinite(position) ? position : 0;
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
    const session = isSafeSessionId(sessionId) ? this.sessionsById.get(sessionId) : null;
    if (!session) {
      return false;
    }
    const index = session.segmentFormat?.segmentIndexFromName?.(fileName) ?? -1;
    if (!(index >= 0)) {
      return true; // a playlist or an init segment belongs to no position
    }
    const own = this.#consumerPositionOf(session, consumerId);
    const position = own === null ? Number(session.furthestViewerSeconds) : own;
    if (!Number.isFinite(position)) {
      return true; // nothing said where the viewer is; refusing would be a guess
    }
    const at = this.#segmentIndexForTime(session, position);
    // The far edge on THIS session's own grid rather than a count of nominal
    // segments: a copied picture is cut at the source's keyframes, so its
    // segments are not four seconds long and dividing by that figure would put
    // the edge somewhere else entirely. The segment CONTAINING the edge is
    // wanted — it is the one the deepest allowed request lands in, and it
    // already reaches past the cushion by whatever is left of its own duration.
    const edge = this.#segmentIndexForTime(session, position + this.lookaheadSeconds);
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
    if (runStateOf(session) === ENCODE_RUN_STATE.RETRY_WAIT) {
      // The data went away and is being fetched again. Holding the request is
      // the truthful answer: nothing is broken and there is nothing for the
      // viewer to retry.
      return { kind: "warming-up" };
    }
    if (runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED) {
      return {
        kind: "failed",
        message: session.lastError || "ffmpeg failed for this transcode session."
      };
    }
    session.lastAccessedAt = Date.now();

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

    // Which run's copy answers, when several have written this name. Chosen by
    // what the copies CARRY, not by which run is newest — see #chooseProducedCopy.
    const filePath = this.#producedIndex(session).pathOf(fileName) ?? path.join(session.dirPath, fileName);
    const isPlaylist = fileName === PLAYLIST_FILE_NAME;
    if (!isPlaylist) {
      // Where the viewer actually is. Recorded for every segment request,
      // served or not, because it is what bounds how far ahead the encoder is
      // allowed to run — the plan decides that now.
      const requested = session.segmentFormat.segmentIndexFromName(fileName);
      if (requested >= 0) {
        // This requester's own head, and with it the furthest any viewer of
        // this session has reached. The encoder is steered by the furthest —
        // what lies behind it has already been made — while the individual
        // heads answer whether a particular held request is still wanted.
        const furthest = this.#noteConsumerHead(
          session,
          consumerId,
          requested,
          this.#segmentStartTime(session, requested)
        );
        session.lastRequestedSegment = furthest.segment;
        // Where the viewer is, kept current. A reported seek is the only other
        // source of it and playback never issues one, so a position recorded at
        // a seek is stale for as long as the viewer then watches — and it is
        // read when a quality change has to place the next variant's first
        // encode run. The freshest evidence wins: a seek overwrites this, and
        // the first request after the seek overwrites it back.
        // A request refines this only FORWARD of what the viewer reported.
        // Playback always moves forward from a seek, so nothing legitimate is
        // lost — while a stale request from before the seek can no longer
        // rewrite the viewer's own statement, which is what let the repair
        // below drag the encoder backwards.
        const requestedStart = furthest.seconds;
        const reported = Number(session.viewerReportedSeconds);
        if (!Number.isFinite(reported) || requestedStart >= reported) {
          session.furthestViewerSeconds = requestedStart;
        }
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
        const bytes = cutsAtGivenTimes(session) && session.segmentFormat.stripInit
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
          // A live run may genuinely still be writing this — including one
          // stopped by the look-ahead, which closes the piece when it is let
          // go. With no run at all it is a leftover, whatever its number, and
          // removing it is what lets the next run make it again.
          //
          // Field 2026-09-03, before a run was an object: an empty `#25` left
          // by a run killed four minutes earlier was called "still being
          // written" by a run that had produced nothing, so it was never
          // removed and never remade, and the viewer waited on it for ten
          // minutes. The question was asked of the segment's NUMBER — anything
          // at or above the start index while any run was alive — and it is a
          // question about the run.
          const stale = liveRunsOf(session).length === 0;
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
            // The index answers from what it read; a file removed on purpose
            // must not still be an answer in the same tick.
            this.#producedIndex(session).invalidate();
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
        const trueStart = cutsAtGivenTimes(session)
          ? session.segmentFormat.readSegmentStartSeconds?.(raw) ?? null
          : null;
        const declaredStart = this.#segmentStartTime(session, index);
        if (trueStart !== null) {
          this.#noteRunLanding(session, index, trueStart);
          this.#noteIndexAccuracy(session, index, trueStart, declaredStart);
        }
        // WHERE THE PLAYER WAS TOLD THIS SEGMENT BEGINS, which is the playlist
        // it holds and nothing else. The published text is fixed when the
        // session is created; `#segmentStartTime` reads a table that a
        // correction may since have moved, and a stamp taken from the moved
        // table describes a timeline the player has never seen.
        const publishedStart = this.#publishedStartTime(session, index);
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
          this.#notePlaylistDisagreement(session, index, trueStart, publishedStart);
        }
        const prepared = session.segmentFormat.prepareSegmentBytes(bytes, {
          startSeconds: stampStart,
          initBytes: session.initBytes ?? null
        });
        this.#noteRunProducedSegment(session, filePath);
        return {
          kind: "file",
          stream: Readable.from([prepared]),
          contentType: session.segmentFormat.segmentContentType,
          isPlaylist: false
        };
      }
      if (!isPlaylist) {
        this.#noteRunProducedSegment(session, filePath);
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
    const runStartSeconds = Number.isFinite(session.progress?.startPositionSeconds)
      ? session.progress.startPositionSeconds
      : this.runStartTimeFor(session, earliestRunStart(session) ?? 0);
    const position = Number(session.progress?.processedSeconds);
    const produced = Number.isFinite(position) ? position - runStartSeconds : null;
    const speed = session.progress?.speed ?? "n/a";
    logger.warn(
      `transcode ${session.id} holding ${fileName}: ${reason} ` +
      `(runs from #${earliestRunStart(session) ?? "?"}, viewer at #${session.lastRequestedSegment ?? "?"}, ` +
      `encoder ${liveRunsOf(session).length > 0 ? "alive" : "stopped"}, index #${index}, ` +
      `produced ${produced === null ? "nothing yet — no position reported" : `${produced.toFixed(1)}s`} ` +
      `at ${speed}${produced !== null && produced <= 0 ? " — the encoder has not moved, so it is waiting on its input" : ""})`
    );
  }

  /**
   * What moving the encoder BACKWARDS costs, said out loud when it happens.
   *
   * Nothing already written is lost — every run keeps its own directory and
   * {@link HlsSessionManager##findProducedFile} serves the union of all of them
   * — so the price of a restart is not the files. It is two other things, and
   * neither was ever counted:
   *
   *  - **work done twice.** The new run begins at the target and encodes
   *    forward through segments the old run had already finished. ffmpeg cannot
   *    know they exist, so it makes them again.
   *  - **the viewer in front.** While the run walks back up to where it already
   *    was, nothing new is being made ahead of them, and their cushion drains.
   *
   * Both are what decides whether a session should be allowed a SECOND
   * concurrent run instead — roadmap item 64. That question cannot be answered
   * from taste, and this is the reading it needs: how often it happens at all,
   * how far back, and how much of the walk is a repeat.
   *
   * Nothing here is awaited by the caller. Everything below the call site is
   * the restart path, which is measured in milliseconds and has been worked on
   * twice to keep it that way; a reading that delays the thing it is reading
   * about is not a reading. The figures that MUST be taken before the new run
   * exists are taken synchronously, and only the file counting is left to run
   * on its own — against the directories that existed at this instant, so what
   * the new run is about to write cannot be counted as already there.
   *
   * @param {HlsSession} session
   * @param {number} startIndex - Where the new run will begin.
   * @returns {void}
   */
  #accountBackwardRestart(session, startIndex) {
    const previousStart = earliestRunStart(session);
    if (!Number.isInteger(previousStart) || !Number.isInteger(startIndex) || startIndex >= previousStart) {
      // A first run, or one moving forward. Neither costs anything here: a
      // forward restart skips material it never made.
      return;
    }
    const processed = Number(session.progress?.processedSeconds);
    const head = Number.isFinite(processed)
      ? Math.max(previousStart, this.#segmentIndexForTime(session, processed))
      : previousStart;
    // Bounded: a session an hour in has thousands of segments, and the count is
    // for a comparison, not an inventory.
    const last = Math.min(head, startIndex + BACKWARD_RESTART_SCAN_SEGMENTS);
    const accounting = session.backwardRestarts ?? { count: 0, segmentsBack: 0, worstBack: 0, remade: 0 };
    accounting.count += 1;
    accounting.segmentsBack += previousStart - startIndex;
    accounting.worstBack = Math.max(accounting.worstBack, previousStart - startIndex);
    session.backwardRestarts = accounting;

    void (async () => {
      let alreadyOnDisk = 0;
      for (let index = startIndex; index <= last; index += 1) {
        const fileName = session.segmentFormat.segmentFileName(index);
        try {
          await access(path.join(session.dirPath, fileName));
          alreadyOnDisk += 1;
        } catch {
          // Nobody has made it, so this run will not be remaking it.
        }
      }
      accounting.remade += alreadyOnDisk;
      logger.info(
        `transcode ${session.id} moving the encoder BACK from #${previousStart} to #${startIndex} ` +
        `(head was #${head}): ${alreadyOnDisk} of the ${last - startIndex + 1} segment(s) it will walk through ` +
        `are already on disk and will be made again, and nothing is produced ahead of #${head} until it gets ` +
        `back there — ${accounting.count} backward restart(s) this session, worst ${accounting.worstBack} ` +
        `segment(s) back, ${accounting.remade} segment(s) remade in total (roadmap 64)`
      );
    })().catch(() => {
      // silent-ok: a reading that fails is not worth ending a restart over.
    });
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
    const held = this.#producedIndex(session).pathOf(fileName);
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
    return this.#producedIndex(session).segmentNumbers();
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
      // directory can be read back without any record kept elsewhere.
      const stated = /(?:^|:)fmt=([a-z0-9]+)(?::|$)/.exec(key)?.[1] ?? "";
      return SEGMENT_FORMAT_IDS.includes(stated) ? resolveSegmentFormat(stated) : null;
    });
  }

  /**
   * This session's one statement of what it has produced.
   *
   * Made on first use and kept on the session, so the directory times it
   * remembers survive between requests — which is the whole of what makes it
   * cheaper than the walk it replaces.
   *
   * @param {HlsSession} session
   * @returns {ProducedIndex}
   */
  #producedIndex(session) {
    if (!(session.producedIndex instanceof ProducedIndex)) {
      session.producedIndex = new ProducedIndex({
        dirPath: session.dirPath,
        segmentFormat: session.segmentFormat ?? this.segmentFormat
      });
    }
    return session.producedIndex;
  }

  /**
   * Where a produced file actually is, or null when no run has written it.
   *
   * @param {HlsSession} session
   * @param {string} fileName
   * @returns {Promise<string | null>}
   */
  async #findProducedFile(session, fileName) {
    return this.#producedIndex(session).pathOf(fileName);
  }

  /**
   * Throw away the piece a run was in the middle of when it ended.
   *
   * The `segment` muxer creates its output file when it opens it and writes
   * into it until the next cut, so at any instant exactly one file in a run's
   * directory is unfinished: the highest-numbered one. A run that reaches the
   * end of its work closes that file properly and it is a good piece; a run
   * killed for a seek does not — measured 2026-09-03, ffmpeg exited 19 ms after
   * SIGTERM and left `segment-00025.mp4` at zero bytes.
   *
   * Leaving it is what created the deadlock this method exists to prevent: an
   * empty file has a name like any other, so it closed the only hole in the
   * numbering and the look-ahead kept the encoder stopped for having "produced"
   * it. Removing it at the moment the run ends means the question never has to
   * be asked again by anyone.
   *
   * A piece is removed only when it is unusable. A run that finished its last
   * file — the ordinary end of a file, or a stop that arrived between two cuts
   * — has nothing wrong with it, and deleting good output would cost the work
   * of making it twice.
   *
   * @param {HlsSession} session
   * @param {string | null | undefined} runDirPath
   * @returns {Promise<void>}
   */
  async #discardUnfinishedPiece(session, runDirPath, within = null) {
    const canJudgeTracks =
      typeof session.segmentFormat?.hasEveryTrack === "function" &&
      session.initBytes &&
      session.initBytes.length > 0;
    const removed = await discardOpenPiece(
      runDirPath,
      session.segmentFormat,
      within,
      canJudgeTracks
        ? (raw) => {
          const bytes = cutsAtGivenTimes(session) && session.segmentFormat.stripInit
            ? session.segmentFormat.stripInit(raw)
            : raw;
          return session.segmentFormat.hasEveryTrack(bytes, session.initBytes);
        }
        : null
    );
    if (removed !== null) {
      // Removed on purpose, so the index must not go on answering with it.
      this.#producedIndex(session).invalidate();
      logger.info(
        `transcode ${session.id} discarded segment #${removed}: ` +
          "the run ended while it was open, so it holds no usable piece"
      );
    }
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
        requestedIndex < (earliestRunStart(session) ?? 0) &&
        (earliestRunStart(session) ?? 0) - requestedIndex > BEHIND_HEAD_REPAIR_MAX_SEGMENTS &&
        liveRunsOf(session).length > 0 &&
        session.seekTarget == null &&
        session.seekSettleTimer == null
      ) {
        logger.info(
          `transcode ${session.id} segment #${requestedIndex} is ${(earliestRunStart(session) ?? 0) - requestedIndex} ` +
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
    // A timeline nobody is reading any more. It is small — two arrays of a few
    // thousand numbers — but nothing removed it, and a proxy that has served a
    // hundred films would have held a hundred of them for the life of the
    // process. An unbounded map that only ever grows is the shape of half the
    // memory faults recorded in this repository.
    const timelinesInUse = new Set();
    for (const session of this.sessionsById.values()) {
      if (session.timeline) {
        timelinesInUse.add(session.timeline);
      }
    }
    this.timelines.forgetUnused(timelinesInUse);
    const outputsInUse = new Set();
    for (const session of this.sessionsById.values()) {
      if (session.output) {
        outputsInUse.add(session.output);
      }
    }
    this.outputs.forgetUnused(outputsInUse);
    const filesInUse = new Set();
    for (const session of this.sessionsById.values()) {
      if (session.file) {
        filesInUse.add(session.file);
      }
    }
    this.sourceFiles.forgetUnused(filesInUse);
    // The segments outlive every session on them, so what they cost is decided
    // here rather than by anybody's departure: how long ago each output was
    // last read, and how much room the disk has for the lot.
    this.segmentStore.enforce({
      idleMs: SEGMENT_STORE_IDLE_MS,
      maxBytes: await this.#segmentStoreAllowance()
    });
  }

  /**
   * How much disk the produced segments may hold.
   *
   * A share of what is FREE now rather than a figure fixed at startup, for the
   * same reason the piece store's memory allowance is re-derived every minute:
   * a machine that fills up after this proxy started would otherwise go on
   * spending an allowance taken when it was empty. On a Home Assistant install
   * that disk is often a 32 GB card carrying everything else the household
   * runs.
   *
   * @returns {Promise<number>}
   */
  async #segmentStoreAllowance() {
    const free = await readDiskFree(this.segmentStore.root);
    if (!Number.isFinite(free) || free <= 0) {
      return SEGMENT_STORE_FALLBACK_BYTES;
    }
    return Math.max(SEGMENT_STORE_FALLBACK_BYTES, Math.floor(free * SEGMENT_STORE_FREE_SHARE));
  }

  /**
   * Return a progress snapshot for the given session, or `null` if not found.
   * Also refreshes `lastAccessedAt` to prevent the session from expiring.
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
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return;
    }
    session.inputBytes = (session.inputBytes ?? 0) + bytes;
  }

  async getSessionProgress(sessionId, consumerId = "") {
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
    const session = this.#activeVariant(named, consumerId);
    session.lastAccessedAt = Date.now();
    const warmupTotalSeconds = this.startupWaitMs / 1000;
    const warmupElapsedSeconds = Math.max(0, (Date.now() - session.startedAt) / 1000);
    // One question, one answer. This used to read BOTH strings with `||`
    // because neither could answer alone: `session.state` said "starting" from
    // the first spawn until something else overwrote it, and `progress.state`
    // said it again on its own schedule.
    const isWarmupPhase = wireState(runStateOf(session)) === "starting";
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
      state: wireState(runStateOf(session)),
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
      processedSeconds: session.progress.processedSeconds,
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
        ? (session.output.encodeHeight ?? session.file.height ?? 0)
        : (session.file.height ?? 0),
      // The rungs still worth offering, as they stand NOW. The list the browser
      // was given when the file opened came from the startup benchmarks; this
      // one is corrected by what the encoder has since been seen to do with
      // this very source, so a rung that turns out to be beyond the host
      // disappears from the menu instead of being discovered by switching to it.
      offeredHeights: this.offeredHeights(session),
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
      requestedHeight: this.#standingAskFor(named),
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
      error: runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED ? session.lastError : ""
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
    // And everything that was true of them alone, in EVERY output of this film
    // they were watching — not only in the one the browser addresses. A viewer
    // watches a picture, a quality step and a soundtrack; the browser knows one
    // id of the three, so subtracting them here from that one left them counted
    // as watching the other two. This is the half of the relation the viewer
    // holds, and it exists for exactly this question.
    for (const outputId of this.viewers.watching(session, consumerId)) {
      const output = this.sessionsById.get(outputId);
      if (output) {
        this.#viewerLeaves(output, consumerId);
      }
    }
    this.#viewerLeaves(session, consumerId);
    session.lastAccessedAt = Date.now();
    const logReason = typeof reason === "string" && reason.length > 0 ? reason : "unspecified";
    logger.info(
      `consumer released (${logReason}) session=${session.id} consumer=${consumerId} ` +
        `remaining=${session.consumers.size}`
    );
    if (session.consumers.size > 0) {
      return true;
    }
    // Read before the picture goes, because a family is found through the file
    // the sessions share and a disposed session is no longer among them.
    const family = this.liveOutputs.familyOf(session).filter((other) => other !== session);
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
        !this.sessionsById.has(output.id) ||
        viewersOf(output).size > 0 ||
        !(output.consumers instanceof Set) ||
        !output.consumers.has(familyConsumer)
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
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return;
    }
    session.state = "disposed";
    this.sessionsById.delete(sessionId);
    this.sessionIdBySource.delete(session.sourceMapKey);
    this.#logIndexAccuracy(session);

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
    for (const other of this.liveOutputs.familyOf(session)) {
      if (other.activeVariantId === session.id) {
        other.activeVariantId = other.id;
      }
      for (const viewer of viewersOf(other).values()) {
        viewer.outputs.delete(session.id);
        if (viewer.activeVariantId === session.id) {
          viewer.activeVariantId = null;
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

    // Whether the process is still RUNNING, not whether anyone has called kill
    // on it: `.killed` means only that a signal was sent, and a run that ended
    // by itself — the file watched through, or a failure — was never killed at
    // all. Asked the old way, every idle session on disposal signalled a dead
    // pid and claimed to be stopping a run that had already ended.
    for (const run of liveRunsOf(session)) {
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
    if (!session.outputKey) {
      // A session from before the store — nothing in the tree makes one now,
      // and this is what would clean up after one if anything did.
      try {
        await rm(session.dirPath, { recursive: true, force: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`failed to cleanup HLS temp dir: ${message}`);
      }
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
