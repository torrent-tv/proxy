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
import { availableShareFrom, correctForAvailability } from "./available-share.js";
import { contentionPenalty } from "./contention.js";
import { minimumBufferFrom } from "./supply-margin.js";
import { baseDrawFrom, costPerMegabyteFrom } from "./torrent-cost.js";
import { medianOf, movedBeyondScatter, scatterOf } from "./learned-median.js";
import {
  ENCODE_RUN_EVENT,
  ENCODE_RUN_STATE,
  INITIAL_RUN_STATE,
  nextState,
  processCanBeSignalled,
  wireState
} from "./encode-run-state.js";
import { ENCODE_EXIT, classifyEncodeExit } from "./encode-exit.js";

/** Own package version, stamped onto session-start log lines. */
const PROXY_VERSION = createRequire(import.meta.url)("../package.json").version;
import {
  softwareDescriptor,
  chooseSoftwareEncodeSettings,
  pickSoftwarePreset,
  canSustainOutput,
  speedBar,
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
import { ProducedIndex } from "./produced-index.js";
import { SegmentStore } from "./encode/SegmentStore.js";
import { viewerOf, viewersOf } from "./viewer/Viewer.js";
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
 * Remove the piece a run had open when it ended, if that piece is unusable.
 *
 * The `segment` muxer creates its output file when it OPENS it and writes into
 * it until the next cut, so at any instant exactly one file in a run's
 * directory is unfinished: the highest-numbered one. A run that reaches the end
 * of its work closes that file and it is a good piece; a run killed for a seek
 * does not — measured 2026-09-03, ffmpeg exited 19 ms after SIGTERM and left
 * `segment-00025.mp4` at zero bytes, which then closed the only hole in the
 * numbering and convinced the look-ahead to keep the encoder stopped for having
 * "produced" it.
 *
 * Only an unusable piece goes. A run stopped between two cuts leaves a finished
 * file behind, and deleting good output would mean making it a second time.
 *
 * @param {string | null | undefined} runDirPath
 * @param {{ isSegmentFileName: (name: string) => boolean, segmentIndexFromName: (name: string) => number }} segmentFormat
 * @param {((raw: Buffer) => boolean) | null} judgeUsable - Whether a non-empty
 *   piece carries what it should. Null where nothing can say, and then only an
 *   empty file is removed.
 * @returns {Promise<number | null>} The segment number removed, or null.
 */
export async function discardOpenPiece(runDirPath, segmentFormat, within, judgeUsable) {
  if (!runDirPath || typeof segmentFormat?.isSegmentFileName !== "function") {
    return null;
  }
  // Only inside the stretch the ended run was given. Every run of an output
  // writes into one directory now — they are kept apart by their intervals
  // rather than by a directory each — so the highest-numbered file in there may
  // belong to a run that is still going, and removing it would take away a
  // piece somebody is producing.
  const from = Number.isInteger(within?.from) ? within.from : 0;
  const to = Number.isInteger(within?.to) && within.to >= from ? within.to : Number.MAX_SAFE_INTEGER;
  let highest = null;
  try {
    for (const name of await readdir(runDirPath)) {
      if (!segmentFormat.isSegmentFileName(name)) {
        continue;
      }
      const index = segmentFormat.segmentIndexFromName(name);
      if (index < from || index > to) {
        continue;
      }
      if (index >= 0 && (highest === null || index > highest.index)) {
        highest = { index, name };
      }
    }
  } catch {
    return null; // The run wrote nothing, or its directory is already gone.
  }
  if (highest === null) {
    return null;
  }
  const filePath = path.join(runDirPath, highest.name);
  let unusable = false;
  try {
    const info = await stat(filePath);
    if (info.size === 0) {
      unusable = true;
    } else if (typeof judgeUsable === "function") {
      unusable = !judgeUsable(await readFile(filePath));
    }
  } catch {
    return null; // Gone between the listing and the question.
  }
  if (!unusable) {
    return null;
  }
  try {
    await unlink(filePath);
    return highest.index;
  } catch {
    return null; // Already removed.
  }
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
 * The codec and bit depth travel with the rates because they decide WHICH
 * measurement of this host applies: the model is fitted per codec family, and a
 * video that has to be re-encoded is by definition one the browser could not
 * play — HEVC, 10-bit — which is exactly where H.264 constants are wrong.
 *
 * @param {{ width: number | null, height: number | null, fps: number | null, bitrateKbps: number | null, codec?: string | null, bitDepth?: number | null }} mediaInfo
 * @returns {{ megapixelsPerSecond: number, megabitsPerSecond: number, codec: string, bitDepth: number | null } | null}
 */
export function sourceDecodeCharacteristics(mediaInfo) {
  const width = Number(mediaInfo?.width);
  const height = Number(mediaInfo?.height);
  const fps = Number(mediaInfo?.fps);
  const kbps = Number(mediaInfo?.bitrateKbps);
  if (!(width > 0) || !(height > 0) || !(fps > 0) || !(kbps > 0)) {
    return null;
  }
  const depth = Number(mediaInfo?.bitDepth);
  return {
    megapixelsPerSecond: (width * height * fps) / 1e6,
    megabitsPerSecond: kbps / 1000,
    codec: typeof mediaInfo?.codec === "string" ? mediaInfo.codec : "",
    bitDepth: Number.isFinite(depth) && depth > 0 ? depth : null
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
    // Every deviation, so the summary can report a distribution instead of one
    // extreme. Bounded by the number of distinct boundaries a session produces.
    deviations: [],
    // Of the segments that started away from the playlist, how many began at
    // ANOTHER time in the very list the grid was built from. This is the
    // measurement that separates the two explanations: a table that describes
    // times the file does not have, against a table that lists only SOME
    // keyframes and a grid built over its gaps. Asked 2026-08-17 by the user,
    // who was right that the second is far more likely — every deviation
    // measured that day was positive, 0.58-2.96 s, which is what a cut pushed
    // forward to the next real keyframe looks like.
    landedOnAnotherKeyframe: 0,
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
// How often each session says what its cushion is. Half a minute: the link
// reports that feed it arrive every ten seconds, and a line per session per
// ten seconds would drown the log on a host serving several.
const CUSHION_REPORT_MS = 30_000;
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
 * What ffmpeg's own CLI subtracts from an input seek, and therefore what has to
 * be added back to land where we asked.
 *
 * `fftools/ffmpeg_demux.c`, in `ifile_open`: when the container does not
 * declare `AVFMT_SEEK_TO_PTS` — Matroska does not — and any stream carries
 * B-frames, the seek target is moved back by `3*AV_TIME_BASE / 23` before
 * `avformat_seek_file` is called. Its purpose is sound: such containers seek in
 * decode order while the caller asks in presentation order, and with B-frames
 * the two differ, so it backs off far enough to be sure of reaching the frame
 * asked for.
 *
 * The consequence for a COPY is that asking for a keyframe lands on the one
 * BEFORE it — deterministically, every time. Measured 2026-08-21 on a Matroska
 * file with keyframes every 2 s: `-ss 10` produced a first segment starting at
 * 8.000; `-ss 10.130435` produced one starting at 10.000. On MP4, where the
 * heuristic does not fire, all of 10, 10.130435 and 10.2 produced 10.000 — so
 * adding this is right in one case and harmless in the other.
 *
 * That landing is what `-segment_times` is measured from, while this code
 * computes those offsets from the time it ASKED for. One keyframe interval
 * apart, inherited by every cut of the run: 119 of 125 segments arriving a
 * uniform 2.002 s early in the field, four times what a player bridges.
 *
 * Not applied when the picture is re-encoded: a re-encode decodes from the
 * keyframe and discards frames up to the requested time, so its output already
 * begins exactly where asked (measured the same day: `-ss 11` copied starts at
 * 10.000, re-encoded at 11.000).
 */
const SEEK_LANDING_OFFSET_SEC = 3 / 23;

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
/**
 * Which timeline a session's own ffmpeg works on.
 *
 * True — the COPY branch: the source's timestamps are kept (`-copyts`) and the
 * output is re-labelled 0-based. Everything handed to the muxer is therefore
 * stated in the source's terms, and everything read back out of a produced
 * piece is 0-based.
 *
 * False — the re-encode branch: the output is labelled from the run's start on
 * the 0-based timeline, and the muxer is addressed in those same terms.
 *
 * One predicate for both callers, because the two used to answer it separately
 * and a disagreement between them is exactly what desynced picture from sound.
 *
 * @param {{ audioOnly?: boolean, cutGrid?: string, transcodeVideo?: boolean }} session
 * @returns {boolean}
 */
export function onKeyframeGridFor(session) {
  return session?.audioOnly === true
    ? session?.cutGrid === "keyframe"
    : session?.transcodeVideo !== true;
}

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
 * How much later than a keyframe to ASK, so that ffmpeg lands on that keyframe.
 *
 * Bounded by half the distance to the next keyframe, which matters only where
 * keyframes stand closer together than twice the offset. There no single value
 * can satisfy both worlds — asking too little lands a keyframe early when the
 * heuristic fires, asking too much lands a keyframe late when it does not — and
 * the bound picks the smaller error, which is then under one keyframe interval
 * and therefore under what a player bridges.
 *
 * @param {HlsSession} session
 * @param {number} keyframe - A real keyframe time the run is to begin at.
 * @returns {number} Seconds to add to the request.
 */
export function seekLandingOffsetFor(session, keyframe) {
  // A re-encode trims to the requested time itself, so it needs no help and
  // must not be pushed past what it was asked for.
  if (session?.transcodeVideo === true) {
    return 0;
  }
  // A grid whose times are approximate needs that error added on top, or a name
  // sitting just below its real keyframe seeks to before it and lands on the
  // one before that. Only AVI declares one.
  const tolerance = Number.isFinite(session?.keyframeTolerance) ? Math.max(0, session.keyframeTolerance) : 0;
  const wanted = SEEK_LANDING_OFFSET_SEC + tolerance;
  const times = Array.isArray(session?.keyframeTimes) ? session.keyframeTimes : [];
  const next = times.find((time) => time > keyframe + 0.001);
  if (next === undefined) {
    return wanted;
  }
  return Math.min(wanted, (next - keyframe) / 2);
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

  /**
   * What encoding one audio TRACK of one file costs this host, in seconds of
   * work per second of video. Keyed by source, file and track, because two
   * tracks of one film are not the same encode: a 5.1 AC-3 dub and a stereo
   * AAC original decode and mix differently.
   *
   * Measured exactly as the copy's price is — from an audio-only session's own
   * reported speed, past its start, alone on the machine, and never while the
   * torrent is what is short.
   *
   * @type {Map<string, { costSec: number, readings: number[], version: number }>}
   */
  #observedAudioCost = new Map();

  /**
   * The last "not offering" line written, so the same one is not written again.
   * See the end of {@link HlsSessionManager##sustainableHeights}.
   *
   * @type {string}
   */
  #lastOfferLine = "";
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
    videoEncoder = null,
    softwarePresetBenchmark = null,
    decodeCostModel = null,
    getSourceStats = null,
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
    const sourceMapKey = `${spec.toKey()}:start=${normalizedStartPosition}`;
    const existingId = this.sessionIdBySource.get(sourceMapKey);
    if (existingId) {
      const existing = this.sessionsById.get(existingId);
      if (existing && existing.state !== "failed") {
        existing.fileName = normalizeLogFileName(fileName, fileIndex);
        const joined = Boolean(consumerId) && !existing.consumers.has(consumerId);
        if (consumerId) {
          existing.consumers.add(consumerId);
          // What THIS viewer wants of the sound, which the session they are
          // joining knows nothing about: they may have chosen another language,
          // and their browser may need a track re-encoded that the first
          // viewer's could decode as it stands.
          viewerOf(existing, consumerId).audio = {
            trackIndex: normalizedAudioTrack,
            transcode: transcodeAudio === true
          };
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
    const inputUrl = new URL("/stream", `${this.localBaseUrl}/`);
    inputUrl.searchParams.set("sourceKey", sourceKey);
    // Whose read this is. The stream route counts the bytes it delivers against
    // this session, and that count is what tells a waiting browser the proxy is
    // alive while nothing has been encoded yet — the encoder's own progress
    // cannot move before its first frame is decoded.
    inputUrl.searchParams.set("session", sessionId);
    // A soundtrack shipped as its own file is encoded FROM that file, and an
    // audio rendition carries nothing else — so it reads the sidecar directly and
    // needs no second input at all. The muxed case, where a browser takes its
    // audio inside the picture's own stream, is the one that reads two files; its
    // second input is `audioInputUrl` below.
    const readsSidecarAlone = audioOnly === true && audioSource.isSidecar;
    inputUrl.searchParams.set(
      "fileIndex",
      String(readsSidecarAlone ? audioSource.fileIndex : fileIndex)
    );
    // The second input, for a muxed session whose sound comes from another file.
    // A picture whose sound is published separately reads ONE file: it maps no
    // audio (`-an`), so a second input would open a read on a file this output
    // does not carry a frame of, and hold that file against the disk sweep for
    // the whole session.
    let audioInputUrl = null;
    if (carriesAudio && !readsSidecarAlone && audioSource.isSidecar) {
      audioInputUrl = new URL("/stream", `${this.localBaseUrl}/`);
      audioInputUrl.searchParams.set("sourceKey", sourceKey);
      audioInputUrl.searchParams.set("session", sessionId);
      audioInputUrl.searchParams.set("fileIndex", String(audioSource.fileIndex));
    }

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
    const pictureUrl = readsSidecarAlone
      ? (() => {
          const url = new URL("/stream", `${this.localBaseUrl}/`);
          url.searchParams.set("sourceKey", sourceKey);
          url.searchParams.set("fileIndex", String(fileIndex));
          return url;
        })()
      : inputUrl;
    const mediaInfo = cachedUsable
      ? cachedMediaInfo
      : await probeInputMediaInfo(this.ffmpegBin, pictureUrl.toString());
    const mediaInfoMs = Date.now() - mediaInfoStartMs;
    const mediaInfoSource = cachedUsable ? "cached" : "probed";
    const durationSeconds = mediaInfo.durationSeconds;
    const sourceWidth = mediaInfo.width;
    const sourceHeight = mediaInfo.height;
    const sourceStartTime = Number.isFinite(mediaInfo.startTime) ? mediaInfo.startTime : 0;
    // Where the timeline of the file this session actually READS begins.
    //
    // For every session until now that was the picture's own file, so one figure
    // served both purposes. A soundtrack shipped separately has a start time of
    // its own, and it is the one that must be subtracted when the output is
    // relabelled onto a zero-based timeline: subtract the picture's instead and
    // the sound sits at a fixed offset from it for the whole film. Measured from
    // the file rather than assumed to be zero, because assuming it is exactly
    // the fault being avoided.
    //
    // NOT awaited. Creating a session used to stop here until the answer came
    // back, and on a cold start the answer needs the sidecar's header off the
    // swarm — 8121 ms of every session created, measured three times out of
    // three on 2026-09-03. What is known now is used now; the reading runs
    // behind, and `#startEncodeRun` takes the freshest value at spawn time, the
    // same way it already re-reads `session.keyframeTimes`.
    //
    // Unknown means "no difference between the two timelines", not "the
    // soundtrack starts at zero". The shift exists to correct a difference
    // between two containers; asserting one that has not been read is inventing
    // a number, while assuming none leaves the sound exactly where a release
    // remuxed from a single source puts it.
    const audioFileStartTime = audioSource.isSidecar
      ? (this.#sidecarStartTimeNow(sourceKey, audioSource.fileIndex) ?? sourceStartTime)
      : sourceStartTime;
    if (audioSource.isSidecar) {
      this.#warmSidecarStartTime(sourceKey, audioSource.fileIndex);
    }
    const inputStartTime = readsSidecarAlone ? audioFileStartTime : sourceStartTime;
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
    //
    // Sized for the file being READ, which for a soundtrack shipped separately
    // is that file: it is a twentieth of the picture's size over the same
    // duration, so the picture's byte rate would buy a window twenty times
    // wider than the seconds it is meant to represent, and the piece store
    // would hold it.
    const readWindowBytes = await this.#readWindowBytesFor(
      sourceKey,
      readsSidecarAlone ? audioSource.fileIndex : fileIndex,
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
    // the other's would have. The grid arrives with the request rather than
    // being worked out again: it is the same file, so a second reading could
    // only agree — or, if the index were read differently, disagree silently.
    if (inheritedGrid) {
      keyframeTimes = inheritedGrid.keyframeTimes;
      containerFormat = inheritedGrid.containerFormat ?? "";
      keyframeTolerance = Number.isFinite(inheritedGrid.keyframeTolerance)
        ? inheritedGrid.keyframeTolerance
        : 0;
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
      keyframeTolerance = Number.isFinite(index.tolerance) ? index.tolerance : 0;
      keyframeMs = Date.now() - keyframeStartMs;
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
        logger.warn(
          `transcode ${sessionId}: no keyframe index in the ${containerFormat} container for ` +
            `"${logName}" — a copied picture has no honest grid without one, so the video is ` +
            "re-encoded instead and its keyframes are placed on our own cuts"
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
    // What this session will PUBLISH. A member of a family takes its base's
    // published table verbatim; a session with no base publishes what it cuts
    // at. The two differ exactly by the corrections made since the family's
    // first playlist was written, and that difference is what must never reach
    // the player as two different timelines.
    const publishedGrid = Array.isArray(inheritedGrid?.published) && inheritedGrid.published.length > 1
      ? inheritedGrid.published
      : (hasDuration ? [...segmentBoundaries] : null);
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
    // filter) with the default preset.
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
          observedDecodeCostSec: this.#observedDecodeCost.get(`${sourceKey}:${fileIndex}`)?.costSec ?? null,
          requiredSpeed: this.#requiredSpeedFor(sourceKey, fileIndex)
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
      fileName: logName,
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
      encodeRunGeneration: 0,
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
      sourceKey,
      fileIndex,
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
      audioFileIndex: audioSource.fileIndex,
      audioSourceTrackIndex: audioSource.sourceTrackIndex,
      // The second input, present only for a muxed session whose sound is in
      // another file. An audio rendition reads its sidecar as its only input, so
      // it has none.
      audioInputUrl: audioInputUrl ? audioInputUrl.toString() : "",
      // Where the timeline of the file being READ begins, against the picture's
      // own `sourceStartTime` below. The two differ only when the sound comes
      // from a separate file.
      inputStartTime,
      audioFileStartTime,
      // Whether this session's ONE input is the sidecar itself, which is what an
      // audio rendition of a separately shipped soundtrack is. Stored rather
      // than re-derived, because the derivation needs `audioOnly` and the
      // sidecar test together and was already written two different ways.
      readsSidecarAlone,
      // What this session's output carries. `audioOnly` is a rendition — one
      // audio track, no picture; `videoOnly` is a stream whose audio the viewer
      // takes from such a rendition. Neither is set on the ordinary muxed
      // session, which is what every browser gets until it says otherwise.
      audioOnly: audioOnly === true,
      audioRenditions: audioRenditions === true,
      outputFps,
      // What the source declared it holds, kept for a failed run to quote. Null
      // when the media info came from a cache that predates this field or from
      // a probe whose banner carried no stream lines.
      sourceStreamCounts: mediaInfo.streamCounts ?? null,
      // Client-requested target box (the orientation-independent ceiling). Kept
      // for the session key and reference; the actual encode uses encodeWidth/
      // encodeHeight, which the realtime budget may have downscaled below this.
      targetWidth: normalizedTargetWidth,
      targetHeight: normalizedTargetHeight,
      // Effective encode resolution handed to ffmpeg (budget-selected on weak
      // software hosts, else the client target). 0 = keep source.
      encodeWidth,
      encodeHeight,
      // What the offer predicted this height would do on this machine, so the
      // field can say what the prediction was worth once the step runs. Null
      // when the step was never judged — a copied stream needs no encoder and
      // is never predicted.
      predictedSpeedWhenOffered: this.lastPredictedByHeight?.get(encodeHeight) ?? null,
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
      // Whether to insert the HDR→SDR tone-map chain (software path only).
      applyTonemap,
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
      // How far those times may sit from the instants they name — nonzero only
      // for AVI, which computes them from frame numbers.
      keyframeTolerance,
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
      playlistText: hasDuration ? this.#buildVodPlaylist(publishedGrid, segmentFormat) : "",
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
      publishedBoundaries: publishedGrid,
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
      // See #enforceLookAhead. With several viewers on one session it is the
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
      // Circuit breaker: consecutive FAST failures (see SEEK_FAST_FAIL_MS) at
      // seekFailureTarget. Reset whenever a run starts at a DIFFERENT target or
      // survives past the fast-fail window. See the exit handler in
      // #wireEncodeProcess and MAX_SEEK_FAILURES.
      seekFailureTarget: -1,
      seekFailureCount: 0,
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
    // to be known.
    if (consumerId) {
      viewerOf(session, consumerId).audio = {
        trackIndex: normalizedAudioTrack,
        transcode: transcodeAudio === true
      };
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
      if (session.runState === ENCODE_RUN_STATE.ENDED_FAILED) {
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
    // The soundtrack of this session may not be in the file that was probed. A
    // release that ships its dub as a separate file often ships the picture with
    // no sound of its own at all, and then the picture's probe says there is no
    // audio while the output plainly carries some — which would leave the header
    // check expecting one track where two arrive, and tell the browser its sound
    // was lost.
    const audioFromAnotherFile =
      Number.isInteger(session.audioFileIndex) && session.audioFileIndex !== session.fileIndex;
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
    const cacheKey = `${sourceKey}:${fileIndex}`;
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
    const work = this.#readContainerKeyframesOnce({ sourceKey, fileIndex, inputUrl, logName })
      .then((result) => {
        this.keyframeIndexCache.set(cacheKey, result);
        return result;
      })
      .finally(() => {
        this.keyframeIndexPending.delete(cacheKey);
      });
    this.keyframeIndexPending.set(cacheKey, work);
    return work;
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
    return Array.isArray(session.publishedBoundaries) && session.publishedBoundaries.length > 0
      ? session.publishedBoundaries
      : (session.segmentBoundaries ?? []);
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
    const boundaries = Array.isArray(session.publishedBoundaries) && session.publishedBoundaries.length > 0
      ? session.publishedBoundaries
      : null;
    if (!boundaries) {
      // No playlist was published from a table (no duration, so no synthetic
      // playlist): the live table is all there is, and it has not been
      // contradicted by anything the player holds.
      return this.#segmentStartTime(session, index);
    }
    const clamped = Math.max(0, Math.min(index, boundaries.length - 1));
    return boundaries[clamped];
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
    const boundaries = this.publishedGridFor(session);
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
  recordNetReport(sessionId, { linkMbps, bufferedAheadSec, consumerId, positionSeconds }) {
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
    viewerOf(session, typeof consumerId === "string" && consumerId.length > 0 ? consumerId : "").netReport = {
      linkMbps,
      bufferedAheadSec,
      // Where the picture is, said by the viewer rather than worked out from
      // their buffer. Null from a browser that does not send it.
      positionSeconds:
        Number.isFinite(positionSeconds) && positionSeconds >= 0 ? positionSeconds : null,
      at: now
    };
    // A viewer who left stops reporting, and their last reading must not go on
    // deciding for the ones still here. Nothing else removes it: a closed data
    // channel does not release consumers today (roadmap item 55).
    for (const [key, viewer] of viewersOf(session)) {
      const report = viewer.netReport;
      if (report === null) {
        continue;
      }
      if (now - report.at > LINK_REPORT_FRESH_MS) {
        viewer.netReport = null;
        // A viewer with nothing left to say about themselves is a viewer this
        // session has not met: one object goes, where six maps each had to be
        // emptied and none of them was.
        if (viewer.head === null && viewer.activeVariantId === null) {
          viewersOf(session).delete(key);
        }
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
    const viewer = viewerOf(session, consumerId);
    const seeked = viewer.head?.seeked ?? null;
    viewer.head = { segment, seconds, at: now, seeked };
    const staleAfterMs = (this.lookaheadSeconds + this.segmentDurationSec) * 1000;
    let furthest = { segment, seconds };
    for (const [key, other] of heads) {
      if (other.head === null) {
        continue;
      }
      if (!other.isLive(now, staleAfterMs)) {
        // A viewer nobody has heard from for longer than the cushion has gone.
        // One object goes, where six parallel maps each had to be remembered.
        heads.delete(key);
        continue;
      }
      if (other.head.segment > furthest.segment) {
        furthest = { segment: other.head.segment, seconds: other.head.seconds };
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
    const head = session.viewers?.get(consumerId)?.head;
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
      ? ([...this.#familyOf(onScreen)].find((member) => member.audioOnly === true) ?? onScreen)
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
    this.#fileLengthByKey.set(`${sourceKey}:${fileIndex}`, fileLength);
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
      this.#stopIfItWalkedIntoAnotherRun(session);
      this.#enforceLookAheadFor(session);
    }
  }

  /**
   * Stop a run that has produced its way into a stretch another run was given.
   *
   * A run's end is an ARGUMENT, fixed when it was spawned: ffmpeg has no
   * channel by which a running encode can be told to stop somewhere new, so a
   * run told to go to the end of the file will do exactly that. When a second
   * viewer opens the same film further on and is given the stretch in front,
   * the first run is walking towards material somebody else is making.
   *
   * Three ways to deal with that, and this is the cheap one. Restarting the
   * first run with a new end would make it stop by itself, at the price of a
   * restart its own viewer pays for — a spawn is 0.12 s on the addon host but
   * the decode up to its position is not. Leaving it be costs a second copy of
   * every segment the two of them overlap on. Stopping it where it arrives
   * costs one segment, made twice, and no restart at all.
   *
   * Asked here rather than only when a segment is served, because a run that
   * nobody is asking for anything from is exactly the one that walks furthest.
   *
   * @param {HlsSession} session
   * @returns {void}
   */
  #stopIfItWalkedIntoAnotherRun(session) {
    if (!session || session.state === "disposed" || !processCanBeSignalled(session.runState)) {
      return;
    }
    const produced = this.#latestProducedSegment(session);
    if (!Number.isInteger(produced)) {
      return;
    }
    const owner = this.runMakingSegment(session, produced);
    if (owner !== null) {
      this.#stopEncodeRun(
        session,
        `it produced #${produced}, which ${owner.slice(0, 8)} was given`
      );
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
      if (session.runState === ENCODE_RUN_STATE.SUSPENDED && this.#resumeEncoder(session, "the viewer needs a segment nobody has made")) {
        this.#transitionRun(session, ENCODE_RUN_EVENT.RESUME_ORDERED);
      }
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

    if (session.runState !== ENCODE_RUN_STATE.SUSPENDED && aheadSeconds > LOOKAHEAD_PAUSE_SECONDS) {
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
    } else if (session.runState === ENCODE_RUN_STATE.SUSPENDED && aheadSeconds <= LOOKAHEAD_RESUME_SECONDS) {
      if (this.#resumeEncoder(session, `${Math.round(aheadSeconds)}s ahead of the viewer`)) {
        this.#transitionRun(session, ENCODE_RUN_EVENT.RESUME_ORDERED);
      }
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
    const fileLength = this.#fileLengthByKey.get(`${session.sourceKey}:${session.fileIndex}`);
    const duration = Number(session.totalDurationSeconds) || Number(session.durationSeconds) || 0;
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
      sourceKey: session.sourceKey,
      fileIndex: session.fileIndex
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
      const key = `${session.sourceKey}:${fileIndex}`;
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
      Promise.resolve(this.fetchWholeFile({ sourceKey: session.sourceKey, fileIndex })).catch(
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
      if (session.runState === ENCODE_RUN_STATE.STARTING || session.runState === ENCODE_RUN_STATE.PRODUCING) {
        running += 1;
      }
    }
    return running;
  }

  #transitionRun(session, event) {
    const from = session.runState ?? INITIAL_RUN_STATE;
    const to = nextState(from, event);
    if (to === null) {
      logger.warn(`run-state ${session.id} ${from} + ${event} — no such edge; ignored`);
      return from;
    }
    session.runState = to;
    logger.info(`run-state ${session.id} ${from} --${event}--> ${to}`);
    return to;
  }

  /**
   * Does this process's exit still say anything about the session?
   *
   * Two conditions, and the second is why this is a method rather than a
   * comparison. A process is not the session's own run once a NEWER one has
   * been installed — and also once it has been marked for replacement, which
   * happens BEFORE the replacement exists. Between those two moments the field
   * still names the doomed process, so comparing against it alone answers
   * "yes, this is the current run" about a process we have just killed.
   *
   * @param {HlsSession} session
   * @param {import("node:child_process").ChildProcess} ffmpeg
   * @returns {boolean}
   */
  #isCurrentRun(session, ffmpeg) {
    if (session.ffmpeg !== ffmpeg) {
      return false;
    }
    return session.supersededRuns?.has(ffmpeg) !== true;
  }

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
    if (session.runState !== ENCODE_RUN_STATE.STARTING) {
      return;
    }
    const runDir = session.runDirPath;
    if (typeof runDir !== "string" || runDir.length === 0 || typeof filePath !== "string") {
      return;
    }
    if (path.dirname(filePath) !== runDir) {
      return;
    }
    this.#transitionRun(session, ENCODE_RUN_EVENT.FIRST_SEGMENT);
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
    if (session.runState === ENCODE_RUN_STATE.SUSPENDED || session.encoderPauseUnsupported || !session.ffmpeg?.pid) {
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
    this.#transitionRun(session, ENCODE_RUN_EVENT.SUSPEND_ORDERED);
    logger.info(
      `transcode ${session.id} encoder suspended — ${reason} ` +
        `"${session.fileName}"`
    );
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
    if (session.runState !== ENCODE_RUN_STATE.SUSPENDED || !session.ffmpeg?.pid) {
      return false;
    }
    let continued = true;
    try {
      process.kill(session.ffmpeg.pid, "SIGCONT");
    } catch {
      // The process is gone; the exit handler will deal with it. The flag is
      // cleared either way — but nothing was resumed, and saying so is what
      // stops a dead run being reported as producing again.
      continued = false;
    }
    // Two records of one moment must not contradict each other: a line saying
    // the encoder resumed, beside a return value saying nothing was resumed, is
    // the sort of pair that costs an hour of reading a field log.
    logger.info(
      continued
        ? `transcode ${session.id} encoder resumed — ${reason} "${session.fileName}"`
        : `transcode ${session.id} could not resume the encoder (the process is gone) — ${reason} "${session.fileName}"`
    );
    return continued;
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
      wanted.set(`${session.sourceKey}:${session.fileIndex}`, {
        sourceKey: session.sourceKey,
        fileIndex: session.fileIndex
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
            if (session?.sourceKey === source.sourceKey && session.fileIndex === source.fileIndex) {
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
      if (session && session.state !== "disposed" && session.sourceKey === sourceKey) {
        files.add(session.fileIndex);
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
    return this.#requiredSpeedByKey.get(`${sourceKey}:${fileIndex}`) ?? null;
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
      (session) => processCanBeSignalled(session?.runState) && session.state !== "disposed"
    );
    const runningNow = encoding.filter((session) => session.runState !== ENCODE_RUN_STATE.SUSPENDED);
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
    const suspended = encoding.filter((session) => session.runState === ENCODE_RUN_STATE.SUSPENDED).length;
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
        session.runState === ENCODE_RUN_STATE.ENDED_FAILED ||
        // Nothing is encoding, so there is no speed to judge. A variant the
        // viewer has switched away from is left in exactly this state, and its
        // last recorded speed would otherwise buy it a step — which restarts
        // the encoder it was just stopped for.
        !session.ffmpeg ||
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
      if (now - this.#baseOf(session).budgetLastActionAt < BUDGET_ACTION_COOLDOWN_MS) {
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
    if (!reading || reading.runSerial !== (session.runSerial ?? 0)) {
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
          `"${session.fileName}"; not stepping down (torrent is the bottleneck)`
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
    const base = this.#baseOf(session);
    const current = this.variantHeightOf(session);
    const offered = this.offeredHeights(base);
    // The highest rung strictly below the one on screen that this host is still
    // willing to serve. `offeredHeights` has already refused everything the
    // machine cannot hold, so a rung that survives it is one worth moving to.
    const next = this.#splicableHeights(base)
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
          `for "${session.fileName}"; leaving the picture alone`
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
    return Math.round(Number(base.sourceHeight) || 0);
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
    if (!this.#publishesVariants(base)) {
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
    const playing = this.variantHeightOf(this.#activeVariant(base));
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
        `"${base.fileName}" (a change of size is a change of variant — its own init describes it)`
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
    const base = this.#baseOf(session);
    const current = this.variantHeightOf(session);
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
      if (!this.#linkCouldCarry(session, this.#peakMbpsForHeight(this.#baseOf(session), current), now)) {
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
    const base = this.#baseOf(session);
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
    const ceiling = Math.round(Number(base.sourceHeight) || 0);
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
    const sourceHeight = Math.round(Number(base.sourceHeight) || 0);
    if (height === sourceHeight && base.transcodeVideo !== true) {
      const sourceMbps = Number(base.sourceDecode?.megabitsPerSecond);
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
    const base = this.#baseOf(session);
    const offered = this.offeredHeights(base);
    const smallest = offered.length > 0 ? Math.min(...offered) : this.variantHeightOf(session);
    const floor = nominalKbpsForHeight(smallest);
    if (wanted < floor) {
      if (this.#askLowerHeight(session, `viewer-link-bound ${reasonText}`)) {
        return true;
      }
      logger.info(
        `[budget] transcode ${session.id} the link carries ${maxrateKbpsFor(wanted)}kbps and the ` +
          `smallest picture on offer (${smallest}p) is sized for ${maxrateKbpsFor(floor)}kbps; ` +
          `capping at the floor rather than below it "${session.fileName}"`
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
        `${maxrateKbpsFor(nominal)}kbps peak, size unchanged at ${session.encodeWidth}x${session.encodeHeight} ` +
        `"${session.fileName}"`
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
    this.#baseOf(session).budgetLastActionAt = Date.now();
    logger.info(
      `[budget] transcode ${session.id} the link has carried this picture with room to spare; ` +
        `lifting the ${maxrateKbpsFor(lifted)}kbps cap "${session.fileName}"`
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
    const head = session.encodeStartIndex;
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
    if (!(session.encodeWidth > 0) || !(session.encodeHeight > 0)) {
      return; // the run keeps the encoder's own default box; nothing was told
    }
    const producing = computeOutputDimensions(
      session.encodeWidth,
      session.encodeHeight,
      session.sourceWidth,
      session.sourceHeight
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
        `the player holds describes ${described.width}x${described.height} "${session.fileName}" — ` +
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
      stats = await this.getSourceStats(session.sourceKey, session.fileIndex);
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
   * The stretch a run should be given, from the gaps in what this output holds.
   *
   * Three things decide it, and none of them is who asked. What the store
   * already has; what another live run of the same output has been given; and
   * where the request wants to begin. A run starts at the first number nobody
   * has and nobody is making, and stops before the next number somebody does —
   * so two runs on one output cannot reach each other's files, which is what
   * makes one flat directory correct and per-run directories unnecessary.
   *
   * @param {HlsSession} session
   * @param {number} startIndex - Where the caller wants to begin.
   * @returns {{ from: number, to: number } | null} Null when everything from
   *   here on is already made or already being made, and a run would only
   *   repeat somebody else's work.
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
  runMakingSegment(session, index) {
    const key = session.outputKey ?? "";
    if (!key) {
      return null;
    }
    for (const other of this.sessionsById.values()) {
      if (other === session || other.outputKey !== key || other.state === "disposed") {
        continue;
      }
      if (!processCanBeSignalled(other.runState)) {
        continue;
      }
      const from = Number(other.encodeStartIndex);
      // A run with an explicit stretch owns the whole of it. One WITHOUT an end
      // owns only as far as it has actually got: claiming the rest of the film
      // would make it the owner of every number in front of it, including the
      // ones another run was expressly given.
      const to = Number.isInteger(other.runEndIndex) && other.runEndIndex >= from
        ? other.runEndIndex
        : (this.#latestProducedSegment(other) ?? from);
      if (Number.isInteger(from) && index >= from && index <= to) {
        return other.id;
      }
    }
    return null;
  }

  planRunInterval(session, startIndex) {
    const key = session.outputKey ?? "";
    const lastIndex = (Number(session.segmentCount) || 0) - 1;
    if (!key || lastIndex < 0) {
      // Nothing to plan against: no address, or no playlist yet. The run keeps
      // the shape it has always had — start here, no end.
      return { from: Math.max(0, startIndex), to: -1 };
    }
    const ready = new Set(this.segmentStore.provenNumbers(key));
    /** @type {{from: number, to: number}[]} */
    const claims = [];
    for (const other of this.sessionsById.values()) {
      if (other === session || other.outputKey !== key || other.state === "disposed") {
        continue;
      }
      if (!processCanBeSignalled(other.runState)) {
        continue;
      }
      const from = Number(other.encodeStartIndex);
      if (!Number.isInteger(from)) {
        continue;
      }
      // How far this run will ACTUALLY get, which is not the same as how far it
      // was allowed to go. A run without an end used to claim the whole film,
      // and a second viewer opening the same film at another place then found
      // every number taken and got no encoder at all — they would have waited
      // for the first run to encode its way there, which on a long film is an
      // hour. What bounds a run in practice is the look-ahead: it is suspended
      // once it is that far in front of the segment its viewer last asked for,
      // and past that point it produces nothing until somebody asks. So that is
      // the honest extent of its claim, and it is a measured figure rather than
      // a chosen one — the same allowance the browser sizes its cushion from.
      const lookaheadSegments = Math.ceil(this.lookaheadSeconds / this.segmentDurationSec);
      const head = Number.isInteger(other.encodeStartIndex) ? other.encodeStartIndex : from;
      const willReach = Math.max(head, this.#latestProducedSegment(other) ?? head) + lookaheadSegments;
      const allowed = Number.isInteger(other.runEndIndex) && other.runEndIndex >= from
        ? other.runEndIndex
        : lastIndex;
      claims.push({ from, to: Math.min(allowed, willReach) });
    }
    const takenAt = (index) =>
      ready.has(index) || claims.some((span) => index >= span.from && index <= span.to);

    let from = Math.max(0, startIndex);
    while (from <= lastIndex && takenAt(from)) {
      from += 1;
    }
    if (from > lastIndex) {
      return null;
    }
    let to = from;
    while (to + 1 <= lastIndex && !takenAt(to + 1)) {
      to += 1;
    }
    return { from, to: to >= lastIndex ? -1 : to };
  }

  async #startEncodeRun(session, startIndex, positionSecondsOverride) {
    // A new run starts its own reckoning: a pair spanning the restart would
    // count the gap between two runs as slow encoding.
    session.learnSample = null;
    // Where a restart's seconds go. A seek costs 5-8 s in the field and the
    // recorded reason — waiting for the previous ffmpeg to exit, measured at
    // 0.54-1.47 s — does not account for it. Before rebuilding the hottest path
    // in the proxy on a guess, make each stage state its own cost.
    const restartEnteredAt = Date.now();
    // Reads where the old run began BEFORE the new one overwrites it, and does
    // not await: everything below is the restart path, which is measured in
    // milliseconds and has been worked on twice to keep it that way.
    this.#accountBackwardRestart(session, startIndex);
    // One directory per run. Two runs writing the same segment name at once
    // produce a file that is neither, which is the only reason a restart ever
    // had to wait for its predecessor to die.
    // Read before it is overwritten: the run about to be superseded is the one
    // whose open piece has to be discarded once it has actually exited.
    const previousRunDirPath = session.runDirPath ?? null;
    // The stretch the run being replaced was given, read before the new one
    // overwrites it: with every run of an output writing into one directory,
    // the piece to discard has to be looked for inside that run own numbers.
    const previousRunSpan = {
      from: Number.isInteger(session.encodeStartIndex) ? session.encodeStartIndex : 0,
      to: Number.isInteger(session.runEndIndex) ? session.runEndIndex : -1
    };
    session.runSerial = (session.runSerial ?? 0) + 1;
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
    session.runDirPath = session.dirPath;
    const interval = this.planRunInterval(session, startIndex);
    if (interval === null) {
      logger.info(
        `transcode ${session.id} no run started at #${startIndex}: everything from there on is ` +
        `already made or already being made "${session.fileName}"`
      );
      return;
    }
    if (interval.from !== startIndex) {
      logger.info(
        `transcode ${session.id} run moved forward from #${startIndex} to #${interval.from}: ` +
        `what lies between is already made "${session.fileName}"`
      );
    }
    startIndex = interval.from;
    session.runEndIndex = interval.to;
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
    // Marked BEFORE it is killed, and this is not a formality.
    //
    // The exit handler decides whether an exit belongs to the current run by
    // comparing against `session.ffmpeg` — and that field still names the
    // PREVIOUS process here, because the new one is not spawned for another
    // few hundred lines. So a predecessor killed for a seek passed the identity
    // check and was handled as though the session's own run had died: exit code
    // null with a signal, i.e. the "ffmpeg failed" branch. Consequences, in
    // rising order of cost — a spurious `state = "failed"` for the moment
    // between the kill and the spawn, which a segment request landing in that
    // window is answered 500 for; a fast-failure tally against a target that
    // never failed; and on any host with a hardware encoder, the runtime safety
    // net firing on every seek: the proxy downgraded itself to libx264 for good
    // and started an extra run at the OLD index, which then took the generation
    // and made the real restart abort. The comment further down claiming this
    // could not happen ("the old process's exit handler no-ops") described an
    // earlier arrangement where the field was already reassigned.
    session.supersededRuns ??= new WeakSet();
    if (previousFfmpeg) {
      session.supersededRuns.add(previousFfmpeg);
    }
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
      void waitForChildExit(previousFfmpeg, ENCODE_RUN_TERMINATE_GRACE_MS).then(async () => {
        logger.info(
          `transcode ${session.id} restart: previous run took ${Date.now() - termSentAt}ms to exit after SIGTERM`
        );
        // Only now: while the process lives it may still close the file, and a
        // piece removed from under it would be written on into nothing.
        await this.#discardUnfinishedPiece(session, previousRunDirPath, previousRunSpan);
      });
      if (!hasChildExited(previousFfmpeg)) {
        try {
          previousFfmpeg.kill("SIGKILL");
        } catch {
          // Best effort.
        }
        await waitForChildExit(previousFfmpeg, ENCODE_RUN_TERMINATE_GRACE_MS);
        await this.#discardUnfinishedPiece(session, previousRunDirPath, previousRunSpan);
      }
    }
    // A newer restart (or disposal) won the race while we were waiting for the
    // old process to die — it either already spawned its own replacement or
    // there is nothing left to start. Do not also spawn from this stale call.
    if (session.encodeRunGeneration !== generation || session.state === "disposed") {
      return;
    }

    const safeIndex = Number.isInteger(startIndex) && startIndex > 0 ? startIndex : 0;
    // 0-based output time of this segment, from the table the PLAYER holds —
    // the same one the cut list below is taken from.
    //
    // These two were read from different tables until 2026-08-21, and that is
    // one fault, not two: `-segment_times` are measured from wherever the run
    // really began, so any distance between the position and the cut list moves
    // EVERY cut of that run by it. The live table keeps being corrected as
    // produced segments reveal where the file's cuts truly are, and those
    // corrections run backwards, so each restart began a little earlier than
    // the grid the cuts were stated on — and since the corrections accumulate,
    // so did the distance. Measured on `JUFD665.mp4`: after one seek restart a
    // produced segment held the boundary two places before its own number
    // (16.684 s, exactly 2.0000 segments), after the next it held the one four
    // places before (33.5 s). The player's buffer then stops extending at all,
    // because the content of every fragment lands before the time its playlist
    // entry names: `bufferEnd` stood still at 4571.1 s through four `frag-far`
    // warnings until hls.js gave up and jumped the viewer 16.8 s forward.
    //
    // 2.45.0 moved the CUT LIST onto the published table for this same reason
    // and left the position on the live one. Both belong on the published
    // table: a run must begin where the player was told the segment begins.
    const startSeconds = Number.isFinite(positionSecondsOverride)
      ? positionSecondsOverride
      : this.runStartTimeFor(session, safeIndex);
    // Where a sidecar soundtrack's own timeline begins, taken FRESH: the
    // session may have been created before that file's header could be read,
    // and this run is the first moment the answer matters. Same shape as
    // `session.keyframeTimes`, which is likewise read again on every call so a
    // background reading that has since finished is picked up.
    const hasSidecarSound =
      Number.isInteger(session.audioFileIndex) && session.audioFileIndex !== session.fileIndex;
    const sidecarStartNow = hasSidecarSound
      ? this.#sidecarStartTimeNow(session.sourceKey, session.audioFileIndex)
      : null;
    const audioFileStartTime = sidecarStartNow !== null
      ? sidecarStartNow
      : (Number.isFinite(session.audioFileStartTime) ? session.audioFileStartTime : 0);
    // The start time of the file this run READS, which is the picture's own for
    // every session except one whose soundtrack is a separate file.
    const sourceStartTime = session.readsSidecarAlone === true && sidecarStartNow !== null
      ? sidecarStartNow
      : (Number.isFinite(session.inputStartTime)
        ? session.inputStartTime
        : (Number.isFinite(session.sourceStartTime) ? session.sourceStartTime : 0));
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
    //
    // Cut on the grid the PLAYER WAS GIVEN, not on the corrected one. A player
    // places a fragment by the playlist it holds, and that text was written
    // once and never changes; the live table keeps moving as produced segments
    // reveal where the file's cuts really are. Cutting on the moved table makes
    // every run faithful to a timeline nobody sent the player — measured
    // 2026-08-20, the picture's segments arriving a uniform 2.002 s before the
    // times the playlist named for them, which is four times what hls.js will
    // bridge, so the fragment does not land and is asked for again.
    //
    // The corrections keep their purpose: they describe the file, and a variant
    // created later inherits the corrected table and PUBLISHES it, so its own
    // playlist and its own cuts agree from the start. What they may not do is
    // move the cuts of a session whose playlist is already being read.
    const gridCutTimes = explicitTimes && (!session.transcodeVideo || session.cutGrid === "keyframe")
      ? segmentCutTimesFrom(this.publishedGridFor(session), safeIndex)
      : null;
    // Cut times are stated on the grid, for both branches.
    //
    // 2.28.0 added `sourceStartTime` to them on the copy branch, reasoning that
    // the muxer decides its cuts before the output is relabelled. The field
    // measured it the next session and the reasoning was wrong: of 75 pieces
    // the picture produced, only NINE began at a time the container's own
    // keyframe table names (the soundtrack, untouched by the change, scored 70
    // of 75). Before it, every piece began exactly on a named keyframe and it
    // was the PLAYLIST that disagreed with them. So the shift moved the cuts
    // OFF the keyframes rather than onto them, and it is gone.
    //
    // What remains true, and is what that measurement is really about: the
    // picture cuts where the source's keyframes are, and the playlist must be
    // built from those same times. That is the correction path's job, not the
    // cut list's.
    const cutTimes = gridCutTimes;

    // A second chance for a predecessor that survived the escalation above —
    // the first block is the one that does the work. Its exit is ignored
    // because it was marked superseded there, not because the field it is
    // compared against has changed: the spawn is still below this line.
    this.#resumeEncoder(session, "terminating");
    if (session.ffmpeg && !session.ffmpeg.killed) {
      session.supersededRuns.add(session.ffmpeg);
      try {
        session.ffmpeg.kill("SIGTERM");
      } catch (_error) {
        // Best effort.
      }
    }

    this.#warnIfRunLeavesTheInitBehind(session);
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
          forcedKeyframeTimes: cutTimes,
          // A ceiling the VIEWER's measured link put on this picture, when one
          // has been measured. Null means the rung's own nominal rate stands.
          nominalKbps: session.rateCapKbps ?? null
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
    // A second input, and it exists for exactly one case: a browser that takes
    // its audio muxed into the picture, watching a release whose soundtrack is a
    // file of its own. An audio RENDITION reads that file as its only input and
    // has none of this — which is why the ordinary path, and every browser that
    // understands rendition groups, still runs on a single input.
    const audioInputUrl =
      typeof session.audioInputUrl === "string" && session.audioInputUrl.length > 0
        ? session.audioInputUrl
        : "";
    // Where the picture's own start sits on the soundtrack file's timeline. Both
    // files begin at their own container start time, and those need not be the
    // same number; the difference is what keeps the two aligned.
    const audioTimelineShift = audioInputUrl
      ? audioFileStartTime - sourceStartTime
      : 0;
    /**
     * Add the second input, if there is one, with its own seek.
     *
     * Called between the first `-i` and any OUTPUT option, because ffmpeg reads
     * these positionally: an option written after the last `-i` applies to the
     * output, and the residual seek below is exactly such an option. Getting the
     * order wrong would silently turn the audio file's seek into a trim of the
     * finished stream.
     *
     * @param {number} inputSeekSeconds - Where to start, on the PICTURE's
     *   timeline. Translated to the soundtrack file's own here.
     */
    const pushAudioInput = (inputSeekSeconds) => {
      if (!audioInputUrl) {
        return;
      }
      // `-itsoffset` states the soundtrack's timestamps on the picture's
      // timeline, so everything after this point — `-copyts`, the output offset,
      // the cut list — goes on treating the two as one timeline, unchanged.
      //
      // ONLY on the branch that keeps the source's own timestamps. Without
      // `-copyts` ffmpeg rebases each input from its own seek point, and both
      // inputs are seeked to the same instant just below — so the two are
      // already aligned and adding the offset would pull them apart by exactly
      // the amount it exists to remove.
      if (audioTimelineShift !== 0 && onKeyframeGridFor(session)) {
        args.push("-itsoffset", ffmpegSeconds(-audioTimelineShift));
      }
      const audioSeek = Math.max(0, inputSeekSeconds + audioTimelineShift);
      if (audioSeek > 0) {
        // No keyframe to snap to and none needed: every audio frame is a sync
        // point, so the seek can be accurate outright.
        args.push("-accurate_seek", "-ss", ffmpegSeconds(audioSeek));
      }
      args.push("-i", audioInputUrl);
    };

    if (snappedKeyframe !== null) {
      const residualSeconds = Math.max(0, seekSeconds - snappedKeyframe);
      if (snappedKeyframe > 0) {
        args.push("-ss", ffmpegSeconds(snappedKeyframe + seekLandingOffsetFor(session, snappedKeyframe)));
      }
      args.push("-i", session.inputUrl);
      // The coarse landing, not the exact target: the residual below is discarded
      // from the OUTPUT and so takes the same slice off every stream. Seeking the
      // soundtrack to the exact target as well would take that slice twice and
      // leave the sound running ahead of the picture by it.
      pushAudioInput(snappedKeyframe);
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
      pushAudioInput(seekSeconds);
    }
    // Which timeline the output is labelled on. An audio rendition has no
    // picture of its own to follow, so it follows the grid it was given — the
    // same one the video it plays with is on. Deciding by `transcodeVideo`, as
    // everything else here does, would put the audio of a re-encoded stream on
    // the copy branch: `-copyts` and a shift by the container's start time,
    // against a picture labelled from zero. The two would be offset by
    // `sourceStartTime` for the whole file.
    const onKeyframeGrid = onKeyframeGridFor(session);
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
    // Where this run STOPS. Until now a run had a start and no end — neither
    // `-to` nor `-t` appeared anywhere in the arguments this proxy builds — so
    // every stop was a kill from outside, and two runs on one output could only
    // be kept apart by giving each its own directory. With an end they cannot
    // reach each other's numbers at all, and a run that finishes its stretch
    // exits by itself instead of having to be noticed and killed.
    //
    // WHICH argument states it is a property of the branch, and it is measured
    // rather than reasoned (2026-09-04, `research/encoder-layer-2026-09-04.md`
    // §11): `-t` is a duration on the output's own clock, and `-to` a point on
    // the input's. The copy branch runs with `-copyts`, where the input's clock
    // IS the source's, so `-to` takes the absolute time; the re-encode branch
    // has no `-copyts` and takes the duration. Swapping them is not a near
    // miss — on the copy branch `-t` produced one segment where five were
    // wanted, because the time it names is already past when the run starts.
    const endIndex = Number.isInteger(session.runEndIndex) ? session.runEndIndex : -1;
    const publishedGrid = this.publishedGridFor(session);
    if (endIndex >= safeIndex && Array.isArray(publishedGrid) && publishedGrid[endIndex + 1] > 0) {
      const endsAt = publishedGrid[endIndex + 1];
      if (session.transcodeVideo) {
        args.push("-t", ffmpegSeconds(Math.max(0.1, endsAt - publishedGrid[safeIndex])));
      } else {
        args.push("-to", ffmpegSeconds(endsAt));
      }
    }
    if (session.audioOnly === true) {
      // An audio RENDITION: one track, no picture. Published as its own
      // `#EXT-X-MEDIA` and shared by every video variant, so the track is
      // encoded once for the file instead of once per rung, and changing it is
      // the player switching rendition rather than this proxy rebuilding the
      // session. Cut on the same grid as the video it accompanies, which is
      // what lets the two be played together.
      // `0:` because a rendition's only input IS the file its track lives in —
      // the picture's own file, or the one beside it that carries this dub.
      args.push("-vn", "-map", `0:a:${session.audioSourceTrackIndex ?? session.audioTrackIndex ?? 0}?`, ...audioCodecArgs);
    } else if (this.#servesAudioSeparately(session)) {
      // The other half of the same arrangement: the picture alone, because its
      // audio is published as a rendition and would otherwise play twice.
      args.push("-an", "-map", "0:v:0?", ...videoCodecArgs);
    } else {
      args.push(
        "-map",
        "0:v:0?",
        "-map",
        // The audio track the viewer chose: input 1 when their choice is a
        // soundtrack shipped as its own file, input 0 when it is one of the
        // picture's own. Type-relative within that input, which is what
        // `audioSourceTrackIndex` holds — the number the browser sent is flat
        // across both files and was resolved when the session was made.
        `${audioInputUrl ? 1 : 0}:a:${session.audioSourceTrackIndex ?? session.audioTrackIndex ?? 0}?`,
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
    const describedArgs = describeFfmpegArgs(args);
    // Kept so a failure can quote the command that produced it instead of
    // leaving whoever reads the log to find it among the lines of the runs that
    // succeeded around it.
    session.lastRunArgsDescribed = describedArgs;
    logger.info(`transcode ${session.id} ${runLabel} ffmpeg ${describedArgs}`);

    const ffmpeg = spawn(this.ffmpegBin, args, {
      cwd: session.runDirPath ?? session.dirPath,
      stdio: ["ignore", "pipe", "pipe"]
    });
    session.ffmpeg = ffmpeg;
    this.#transitionRun(session, ENCODE_RUN_EVENT.SPAWNED);
    // Whether this run cuts at times we gave it. Decides how a segment is
    // judged finished — see getFileStream.
    session.usesExplicitCuts = Boolean(cutTimes && cutTimes.length > 0);
    session.encodeStartIndex = safeIndex;
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

    logger.info(
      `transcode ${session.id} ${session.runLabel} encode-run from segment #${safeIndex} ` +
      `(+${Date.now() - restartEnteredAt}ms since the restart was asked for) ` +
        `(${formatSeconds(startSeconds)}) "${session.fileName}"`
    );
    // The four numbers a run is positioned by, said once, because their
    // disagreement is invisible everywhere else. The two tables are printed
    // side by side: while they differ, every cut of this run is off by the
    // difference, and nothing downstream can tell that from a bad index.
    const liveStart = this.#segmentStartTime(session, safeIndex);
    logger.info(
      `transcode ${session.id} ${session.runLabel} positioned at ${startSeconds.toFixed(3)}s ` +
        `for boundary #${safeIndex} (published ${startSeconds.toFixed(3)}s, ` +
        `live ${liveStart.toFixed(3)}s, apart ${(liveStart - startSeconds).toFixed(3)}s), ` +
        `numbering from #${safeIndex}`
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
      if (!this.#isCurrentRun(session, ffmpeg)) {
        return;
      }
      session.lastError = error instanceof Error ? error.message : String(error);
      session.progress.updatedAt = Date.now();
      this.#transitionRun(session, ENCODE_RUN_EVENT.EXITED_FAILED);
      logger.error(`ffmpeg ${session.id} process error: ${session.lastError}`);
    });

    ffmpeg.on("exit", (code, signal) => {
      // Asked FIRST, before anything is written or read. An exit that belongs
      // to a replaced run must not touch the session's error, which the viewer
      // is shown and the next real exit is classified by, and must not send the
      // handler reading directories on its behalf.
      if (!this.#isCurrentRun(session, ffmpeg) || session.state === "disposed") {
        return;
      }
      const producedThrough = code === 0 ? this.#latestProducedSegment(session) : null;
      const expectedLast = session.segmentCount > 0 ? session.segmentCount - 1 : null;
      if (!session.lastError && code !== 0) {
        session.lastError = `ffmpeg exited with code ${code ?? -1}${signal ? ` (signal ${signal})` : ""}`;
      }
      // What this exit means is decided in one place, from facts, and the
      // reasoning behind each answer lives with it in `encode-exit.js`.
      const outcome = classifyEncodeExit({
        code,
        producedThrough,
        lastSegmentIndex: expectedLast,
        inputUnavailable: isInputUnavailable(session.lastError)
      });
      if (outcome === ENCODE_EXIT.IGNORED) {
        return;
      }
      if (outcome === ENCODE_EXIT.SHORT) {
        // ffmpeg exits 0 both when it reaches the end of the file and when its
        // input simply stops producing bytes — over HTTP the two look identical
        // to it. Field 2026-08-05: the torrent's download died, the read ended,
        // and a run that had made 188 segments of 624 reported itself complete;
        // the player then consumed what was on disk and froze on the first
        // segment nobody was making. So the claim is checked against the
        // playlist we published, and a run that stopped short is a FAILURE that
        // can be restarted, not a finished file.
            session.progress.updatedAt = Date.now();
        session.lastError =
          `input ended after segment #${producedThrough} of ${expectedLast} — ` +
          "the source stopped delivering data";
        this.#transitionRun(session, ENCODE_RUN_EVENT.EXITED_SHORT);
        logger.error(
          `transcode ${session.id} ${session.runLabel ?? "run#?"} encode-run ended early: ` +
          `${session.lastError} "${session.fileName}"`
        );
        return;
      }
      if (outcome === ENCODE_EXIT.COMPLETE) {
        session.progress.updatedAt = Date.now();
        this.#transitionRun(session, ENCODE_RUN_EVENT.EXITED_COMPLETE);
        logger.info(`transcode ${session.id} encode-run complete "${session.fileName}"`);
        return;
      }
      // Runtime safety net: if a hardware encode fails, downgrade this proxy to
      // software encoding for all sessions and restart this one, so playback is
      // never permanently broken by a hardware/driver issue.
      //
      // Asked only of a genuine encoder failure. It used to be asked of every
      // non-zero exit, so a run whose TORRENT DATA went away — which says
      // nothing whatever about the encoder — condemned a working NVENC or
      // QuickSync to software for the life of the process, and started an extra
      // run at the old index while it was at it.
      if (outcome === ENCODE_EXIT.FAILED && session.transcodeVideo && this.videoEncoder.kind !== "software") {
        const failedEncoder = this.videoEncoder.name;
        // The run died before the software one takes its place: the failure is
        // an event of its own, and the restart below is a separate spawn.
        this.#transitionRun(session, ENCODE_RUN_EVENT.EXITED_FAILED);
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
      if (outcome === ENCODE_EXIT.INPUT_LOST) {
        // On the wire it is simply "not ready yet" — a state the browser has
        // always known how to wait through. Only the proxy needs the
        // distinction between waiting for data and having given up.
        session.progress.updatedAt = Date.now();
        this.#transitionRun(session, ENCODE_RUN_EVENT.EXITED_INPUT_LOST);
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
          if (session.runState !== ENCODE_RUN_STATE.RETRY_WAIT) {
            return;
          }
          this.#transitionRun(session, ENCODE_RUN_EVENT.RETRY_DUE);
          const at = Number.isInteger(session.lastRequestedSegment)
            ? session.lastRequestedSegment
            : (session.encodeStartIndex ?? 0);
          this.#startEncodeRun(session, at).catch(() => {});
        }, delayMs);
        session.inputRetryTimer.unref?.();
        return;
      }
      session.progress.updatedAt = Date.now();
      this.#transitionRun(session, ENCODE_RUN_EVENT.EXITED_FAILED);
      logger.error(
        `transcode ${session.id} ${session.runLabel ?? "run#?"} encode-run failed: ${session.lastError}` +
          ` — ${this.#describeTrackSelection(session)}` +
          `\n  ffmpeg ${session.lastRunArgsDescribed ?? "(command not recorded)"}`
      );
    });
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
    const counts = session.sourceStreamCounts;
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
    if (!processCanBeSignalled(session.runState)) {
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
  requestSeek(sessionId, positionSeconds, consumerId = "") {
    const named = this.sessionsById.get(sessionId);
    if (!named || named.state === "disposed") {
      return false;
    }
    // The seeking viewer's OWN head moves with them. Without this their head
    // would still hold the segment they asked for before the jump, and the very
    // next thing they ask for — the segment at the seek target — would be
    // judged stale against it and refused. That refusal, from the shared field,
    // is the freeze of 2026-08-18; keeping per-viewer heads without moving them
    // on a seek would bring it back one viewer at a time.
    if (consumerId) {
      viewerOf(named, consumerId).head = {
        segment: this.#segmentIndexForTime(named, positionSeconds),
        seconds: positionSeconds,
        at: Date.now(),
        // Stated, not inferred. It is what makes this viewer's position a
        // "seeked" one for as long as they stay there.
        seeked: positionSeconds
      };
    }
    // The browser holds one session id for the whole file and knows nothing of
    // variants, so a seek it reports means the stream on screen.
    //
    // The session's own figure, which is what an encode run is placed by. It is
    // NOT this viewer's position — that is their head above — and the two used
    // to be one field called `viewerPositionSeconds`: with two viewers the name
    // was a falsehood, since a session has one of these and as many positions
    // as it has viewers.
    named.furthestViewerSeconds = positionSeconds;
    // What the viewer SAID, kept apart from what requests imply. A request is
    // evidence about where the player is reading; a reported seek is the viewer
    // stating where they are, and after one, requests already in flight
    // describe a place that no longer exists. Field 2026-08-17: a seek to
    // 2083.4 s restarted both runs at #373, a request for #371 issued before it
    // arrived a second later, and the encoder was dragged back to #370 — three
    // segments behind the viewer, who then waited for it to return.
    named.viewerReportedSeconds = positionSeconds;
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
    // The seeking viewer's OWN soundtrack, not every soundtrack the session
    // has: with two viewers, moving the other one's audio to a position they
    // are not at would take their sound away and produce for nobody.
    const listening = this.#audioChoiceOf(named, consumerId);
    const renditionId = named.audioRenditionSessions?.get(
      audioRenditionKey(listening.trackIndex, listening.transcode)
    );
    const rendition = renditionId ? this.sessionsById.get(renditionId) : null;
    if (rendition && rendition.state !== "disposed") {
      rendition.lastAccessedAt = Date.now();
      this.#seekSession(rendition, positionSeconds);
    }
    const onScreen = this.#activeVariant(named, consumerId);
    // A seek backwards while somebody else is watching ahead must not drag
    // their picture back with it. A session holds ONE run, so repositioning it
    // is repositioning theirs: field shape of 2026-09-04, two viewers who
    // opened a film together, one jumps back an hour, and the other's segments
    // stop being made.
    //
    // The answer is not to refuse the seek but to give it a run of its own. A
    // run at another position is another SESSION of the same output — which
    // costs nothing extra now that segments are addressed by the output rather
    // than by the session, so both runs write into one directory and each
    // viewer is served whatever either of them has made.
    if (this.#wouldDragAnotherViewerBack(onScreen, consumerId, positionSeconds)) {
      const own = this.#sessionAtPosition(onScreen, positionSeconds);
      if (own && own !== onScreen) {
        logger.info(
          `transcode ${onScreen.id} seek to ${positionSeconds.toFixed(1)}s served by its own run ` +
          `(${own.id.slice(0, 8)}) for ${consumerId}: another viewer is watching ahead ` +
          `"${onScreen.fileName}"`
        );
        return this.#seekSession(own, positionSeconds);
      }
      logger.info(
        `transcode ${onScreen.id} seek to ${positionSeconds.toFixed(1)}s starting a run of its ` +
        `own for ${consumerId}: another viewer is watching ahead, and one run cannot be in two ` +
        `places "${onScreen.fileName}"`
      );
      // Not awaited: this call answers the browser, and what the viewer waits
      // for afterwards is the segment, which the ordinary loading flow already
      // knows how to wait for. The other viewer's picture is left alone, which
      // is the whole point.
      void this.#startSessionAtPosition(onScreen, positionSeconds).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`transcode ${onScreen.id} could not start a run at that position: ${message}`);
      });
      return true;
    }
    return this.#seekSession(onScreen, positionSeconds);
  }

  /**
   * Whether repositioning this session would take the picture away from
   * somebody else.
   *
   * Two things have to hold. The seek has to be one that actually restarts the
   * run — a position the run already covers going forward costs nobody
   * anything. And another viewer has to be live and AHEAD of it, since a run
   * only ever moves forward: what lies behind the furthest viewer has already
   * been made, and dragging the run back is what stops it being made for them.
   *
   * @param {HlsSession} session
   * @param {string} consumerId - The one seeking, who does not count.
   * @param {number} positionSeconds
   * @returns {boolean}
   */
  #wouldDragAnotherViewerBack(session, consumerId, positionSeconds) {
    if (!session || !consumerId || !processCanBeSignalled(session.runState)) {
      return false;
    }
    const target = this.#segmentIndexForTime(session, positionSeconds);
    const head = Number(session.encodeStartIndex);
    if (!Number.isInteger(head) || target >= head) {
      return false;
    }
    const staleAfterMs = (this.lookaheadSeconds + this.segmentDurationSec) * 1000;
    const now = Date.now();
    for (const [otherId, viewer] of viewersOf(session)) {
      if (otherId === consumerId || !viewer.isLive(now, staleAfterMs)) {
        continue;
      }
      if (viewer.head.segment > target) {
        return true;
      }
    }
    return false;
  }

  /**
   * A session of the same output, positioned where this viewer is going.
   *
   * The same material by every parameter that decides what is produced — only
   * the place it begins differs, which is what the session key still carries
   * and what decides how many runs there are.
   *
   * @param {HlsSession} base
   * @param {number} positionSeconds
   * @returns {Promise<HlsSession | null> | HlsSession | null}
   */
  #sessionAtPosition(base, positionSeconds) {
    const key = `${base.outputKey}:start=${Math.round(positionSeconds / 10) * 10}`;
    const existingId = this.sessionIdBySource.get(key);
    const existing = existingId ? this.sessionsById.get(existingId) : null;
    return existing && existing.state !== "disposed" ? existing : null;
  }

  /**
   * Make one, with every parameter of the material the same and only the place
   * it begins different.
   *
   * It is held by the family rather than by the browser, which knows one
   * session id and must go on knowing one: its segment requests keep going to
   * the session it holds, and that session serves them out of the directory
   * both runs write into.
   *
   * @param {HlsSession} base
   * @param {number} positionSeconds
   * @returns {Promise<HlsSession | null>}
   */
  async #startSessionAtPosition(base, positionSeconds) {
    if (typeof base.acquireSource !== "function" && base.acquireSource !== null) {
      return null;
    }
    return this.createOrGetSession({
      sourceKey: base.sourceKey,
      fileIndex: base.fileIndex,
      transcodeVideo: base.transcodeVideo === true,
      transcodeAudio: base.transcodeAudio === true,
      fileName: base.fileName,
      // The family's own claim, exactly as a quality step is held: nobody
      // outside this class learns its id, so nothing else could ever release
      // it, and it is let go when the session that asked for it ends.
      consumerId: variantConsumerId(base.id),
      targetWidth: 0,
      targetHeight: base.transcodeVideo === true ? this.variantHeightOf(base) : 0,
      startPositionSeconds: positionSeconds,
      audioTrackIndex: base.audioTrackIndex,
      manualQuality: base.manualQuality === true,
      audioRenditions: base.audioRenditions === true,
      inheritedAudioSeparate: base.audioSeparate === true,
      audioOnly: base.audioOnly === true,
      segmentFormatId: base.segmentFormat?.id ?? "",
      inheritedGrid: base.cutGrid === "keyframe"
        ? {
            boundaries: base.segmentBoundaries,
            published: base.publishedBoundaries,
            keyframeTimes: base.keyframeTimes,
            keyframeTolerance: base.keyframeTolerance,
            containerFormat: base.containerFormat
          }
        : null,
      acquireSource: base.acquireSource
    });
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
    const head = session.encodeStartIndex;
    const processed = Number.isFinite(session.progress?.processedSeconds)
      ? session.progress.processedSeconds
      : this.runStartTimeFor(session, head);
    const currentSeg = Math.max(head, this.#segmentIndexForTime(session, processed));
    // Already covered by the running encode — the data is on its way, so
    // restarting would only destroy work the viewer is waiting for. The run has
    // to be ALIVE for that to hold: after a run died, `session.ffmpeg` still
    // pointed at the dead process and every later seek was waved through as
    // "already covered", so nothing could ever restart it. Measured 2026-08-04:
    // one ffmpeg failure turned into a session that answered 500 to every
    // segment for as long as the viewer kept trying.
    const runIsAlive = processCanBeSignalled(session.runState);
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
    if (target === session.encodeStartIndex && processCanBeSignalled(session.runState)) {
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
    const runIsAlive = processCanBeSignalled(session.runState);
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
      if (session.runState === ENCODE_RUN_STATE.ENDED_FAILED) {
        throw new Error(session.lastError || "ffmpeg failed to start HLS session.");
      }
      return;
    }

    const playlistPath = path.join(session.dirPath, PLAYLIST_FILE_NAME);
    const deadline = Date.now() + this.startupWaitMs;

    while (Date.now() < deadline) {
      if (session.runState === ENCODE_RUN_STATE.ENDED_FAILED) {
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
    if (session.encodeStartIndex !== index || session.landingReportedForRun === index) {
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
    session.indexCheck ??= newIndexCheck();
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
    const knownKeyframe = Array.isArray(session.keyframeTimes)
      ? session.keyframeTimes.some((time) => Math.abs(time - trueStart) <= 0.05)
      : null;
    noteIndexDeviation(session.indexCheck, index, deviation, knownKeyframe);
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
    if (session.indexCheck.checked > 0 && session.indexCheck.checked % 25 === 0) {
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
    for (const member of this.#familyOf(session)) {
      if (member === session || member.encodeStartIndex !== index) {
        continue;
      }
      if (!processCanBeSignalled(member.runState)) {
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
      void this.#startEncodeRun(member, index, trueStart).catch(() => {});
    }
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
      // The soundtracks published separately. They are encoders of this family
      // exactly as the quality steps are — one runs for as long as the picture
      // does — and they were reachable only through `audioRenditionSessions`,
      // which nothing here walked. So a family never contained one, and every
      // sum taken over the family priced the soundtrack at nothing.
      if (root.audioRenditionSessions instanceof Map) {
        for (const renditionId of root.audioRenditionSessions.values()) {
          const rendition = this.sessionsById.get(renditionId);
          if (rendition) {
            family.add(rendition);
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
  #boundaryIndexAt(session, seconds, table) {
    // The table is nameable because the two answer different questions. The
    // LIVE one says "is this a cut this file actually has", which is what a
    // reading taken off a produced segment is about. The PUBLISHED one says "is
    // this a cut the player believes in", which is what a report from the player
    // is about. Answering one with the other prints an index from one grid
    // beside a time from the other.
    const boundaries = Array.isArray(table) ? table : session.segmentBoundaries;
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
      `${session.containerFormat || "unknown"} "${session.fileName}": ` +
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
          ` [tolerance ${SEGMENT_START_DISAGREEMENT_SEC}s, ${(session.keyframeTimes?.length ?? 0)} keyframes read]`)
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
   * The heights this file's variants CAN be spliced at — a fact about the
   * source and the cut grid, settled once and never moved.
   *
   * Separate from {@link #variantHeights}, which answers a different question:
   * which of them are worth OFFERING to the viewer right now, on a machine
   * whose load moves every five seconds. Both were the same list until
   * 2026-08-18, and that is what broke playback outright: the browser is told
   * at session creation that a master playlist exists, and 192 ms later — after
   * the session's own encoder had started and the first supply reading had
   * arrived — the live list had fallen from five rungs to one, `buildMaster
   * Playlist` returned null for having fewer than two, and the master answered
   * 404 to the very session that had just published it. hls.js treats that as
   * fatal and unrecoverable, so nothing played at all (session `4ef731d8`,
   * "Moana (2016).mkv", 17:43:01).
   *
   * A live figure may decide what to offer. It may not decide whether a
   * published document exists.
   *
   * @param {HlsSession} session
   * @returns {number[]} Largest first.
   */
  /**
   * Whether this stream publishes a master playlist at all — that is, whether
   * there is anything for a player to move BETWEEN.
   *
   * Asked in one place because two callers depend on the same answer and used
   * to compute it differently: the builder refused a copied stream whose cut
   * grid is a fiction, while the budget looked only at how many heights could
   * in principle be spliced. A copy with no readable keyframe index therefore
   * had requests recorded against it — asking a player with no variants to
   * change variant, once every window, for the whole film.
   *
   * @param {HlsSession} session
   * @returns {boolean}
   */
  #publishesVariants(session) {
    const owner = this.#baseOf(session);
    // A copy can only be cut where the source already has a keyframe, so a rung
    // meant to splice into it has to be cut at exactly those times. A copy that
    // fell back to an even grid ffmpeg does not cut on has nothing to align to.
    if (!owner.transcodeVideo && owner.cutGrid !== "keyframe") {
      return false;
    }
    return this.#splicableHeights(owner).length >= 2;
  }

  #splicableHeights(session) {
    const owner = this.#baseOf(session);
    if (Array.isArray(owner.splicableHeights)) {
      return owner.splicableHeights;
    }
    const heights = new Set(variantHeightsFor(Number(owner.sourceHeight) || 0));
    const own = this.variantHeightOf(owner);
    if (own > 0) {
      heights.add(own);
    }
    owner.splicableHeights = [...heights].sort((left, right) => right - left);
    return owner.splicableHeights;
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
    // Every rung a live viewer has on screen. One answer was enough while a
    // picture had one viewer; two of them can be on two rungs, and withdrawing
    // either is withdrawing a stream that is playing.
    const playingHeights = new Set(
      [...this.#variantsOnScreen(owner)]
        .map((sessionId) => this.sessionsById.get(sessionId))
        .filter((member) => member)
        .map((member) => this.variantHeightOf(member))
    );
    const playing = [...playingHeights].sort((left, right) => left - right).join(",");
    // Everything the answer is derived from belongs in what identifies it. The
    // copy's price and the torrent's are inputs now, and left out of this key
    // the menu would keep the answer computed before either was measured — on
    // a copied picture, which is the case they exist for, the decode version
    // never moves at all, so the cache would never be recomputed.
    const copyVersion = this.#observedCopyCost.get(`${owner.sourceKey}:${owner.fileIndex}`)?.version ?? 0;
    const torrentCost = this.#observedTorrentCostPerMegabyte ?? 0;
    // The soundtrack's price is an input too, and so is how many encoders of
    // this family are running: both move the answer, and an answer cached
    // across them is the stale menu this key exists to prevent.
    const audioVersion = [...this.#familyOf(owner)]
      .filter((member) => member.audioOnly === true)
      .map((member) => this.#observedAudioCost.get(this.#audioCostKey(member))?.version ?? 0)
      .reduce((total, one) => total + one, 0);
    const running = [...this.#familyOf(owner)]
      .filter((member) => processCanBeSignalled(member.runState)).length;
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
    const measured = this.#familyOf(owner)
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
      ?? this.#requiredSpeedFor(owner.sourceKey, owner.fileIndex);
    const movingMegabytes = this.#torrentMegabytesPerSecond(
      owner.sourceKey,
      owner.fileIndex,
      this.#fileLengthByKey.get(`${owner.sourceKey}:${owner.fileIndex}`) ?? null,
      owner.durationSeconds
    );
    const version =
      `${observed?.version ?? 0}:${playing}:${copyVersion}:${torrentCost.toFixed(6)}:` +
      `${audioVersion}:${running}:${measured}:${(demanded ?? 0).toFixed(2)}:` +
      `${(movingMegabytes ?? 0).toFixed(2)}`;
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
      playingHeights,
      // What each rung was actually seen doing in this session, which is the
      // only thing a live reading may speak for.
      measuredHeights: this.#measuredRungSpeeds(owner),
      // The speed this file's supply demands, measured by its own reader on
      // this swarm. A well-seeded film and a thin one ask different speeds of
      // the same machine, so the bar belongs to the pair, not to the host.
      requiredSpeed: demanded,
      // What the family is already spending while a rung is considered. The
      // picture being COPIED is the common case and used to be priced at
      // nothing; measured, it is about an eighth of the machine.
      concurrentCostSec: this.#committedCostOf(owner),
      // So a height already being produced is not charged for itself when it is
      // judged. See the subtraction in #sustainableHeights.
      runningCostByHeight: this.#runningCostByHeight(owner),
      sourceWidth: Number(owner.sourceWidth) || 0,
      sourceHeight: Math.round(Number(owner.sourceHeight) || 0),
      fps: Number(owner.outputFps) || TRANSCODE_FPS,
      source: owner.sourceDecode ?? null,
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
      if (session?.ffmpeg != null &&
          !hasChildExited(session.ffmpeg) &&
          session.runState !== ENCODE_RUN_STATE.SUSPENDED &&
          session.state !== "disposed") {
        running += 1;
      }
    }
    return running;
  }

  async #learnFromEncoder(session) {
    if (
      !session ||
      session.state === "disposed" ||
      session.runState === ENCODE_RUN_STATE.ENDED_FAILED ||
      !session.ffmpeg ||
      session.runState === ENCODE_RUN_STATE.SUSPENDED
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
    const runSerial = session.runSerial ?? 0;
    session.learnSample = { takenAt, processedSeconds, runSerial };
    if (previous === null || !Number.isFinite(processedSeconds) || !Number.isFinite(previous.processedSeconds)) {
      return;
    }
    if (previous.runSerial !== runSerial) {
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
    session.recentSpeed = { speed, at: takenAt, runSerial };
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
      const others = this.#pricedConcurrentCost(session);
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
          `prediction ${session.id.slice(0, 8)} ${session.encodeHeight || "source"}p: ` +
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
    if (session.runState === ENCODE_RUN_STATE.SUSPENDED) {
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
    const median = medianOf(readings);
    if (!movedBeyondScatter(known?.costSec ?? null, median, readings)) {
      this.#observedCopyCost.set(key, { ...known, readings });
      return;
    }
    this.#observedCopyCost.set(key, { costSec: median, readings, version: (known?.version ?? 0) + 1 });
    logger.info(
      `transcode: ${session.fileName} copies at ${(1 / median).toFixed(2)}x on this host ` +
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
    if (session.runState === ENCODE_RUN_STATE.SUSPENDED) {
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
    const known = this.#observedAudioCost.get(key);
    const readings = [...(known?.readings ?? []), costSec].slice(-DECODE_LEARNING_READINGS);
    const median = medianOf(readings);
    if (!movedBeyondScatter(known?.costSec ?? null, median, readings)) {
      this.#observedAudioCost.set(key, { ...known, readings });
      return;
    }
    this.#observedAudioCost.set(key, { costSec: median, readings, version: (known?.version ?? 0) + 1 });
    logger.info(
      `transcode: ${session.fileName} encodes audio track ${session.audioTrackIndex ?? 0} at ` +
        `${(1 / median).toFixed(2)}x on this host (median of ${readings.length}, latest ${speed.toFixed(2)}x)`
    );
  }

  /**
   * @param {HlsSession} session
   * @returns {string}
   */
  #audioCostKey(session) {
    return `${session.sourceKey}:${session.fileIndex}:${session.audioTrackIndex ?? 0}`;
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
    const costSec = medianOf(readings);
    if (!movedBeyondScatter(known?.costSec ?? null, costSec, readings)) {
      // The same answer as before, by the readings' own scatter. Storing it
      // would bump the version and make every session recompute its offer,
      // which is asked for on the path that serves every playlist, init and
      // segment.
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
      this.#sustainableHeights({
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
   * What a running re-encode of the picture costs, in seconds of work per
   * second of video.
   *
   * Measured first: `lastAloneSpeed` is what this very rung did with the
   * machine to itself. Failing that, the encode model that decides every rung —
   * the same benchmark, the same decode term — applied to this rung's own pixel
   * rate. There is no third answer: a rung whose cost cannot be derived at all
   * contributes nothing rather than a number somebody invented.
   *
   * @param {HlsSession} session
   * @returns {number}
   */
  #pictureCostOf(session) {
    if (Number.isFinite(session.lastAloneSpeed) && session.lastAloneSpeed > 0) {
      return 1 / session.lastAloneSpeed;
    }
    const benchmark = this.softwarePresetBenchmark;
    const width = Number(session.encodeWidth) || 0;
    const height = Number(session.encodeHeight) || 0;
    const fps = Number(session.outputFps) || TRANSCODE_FPS;
    if (!Array.isArray(benchmark) || benchmark.length === 0 || width <= 0 || height <= 0) {
      return 0;
    }
    const { speed } = canSustainOutput({
      benchmark,
      decodeModel: this.decodeCostModel,
      source: session.sourceDecode ?? null,
      outputPixelsPerSec: width * height * fps,
      observedDecodeCostSec: null,
      concurrentCostSec: 0
    });
    return Number.isFinite(speed) && speed > 0 ? 1 / speed : 0;
  }

  /**
   * What everything OTHER than this session is costing right now, or null when
   * any of it is unpriced.
   *
   * Used to recover a soundtrack's own share from a reading taken beside the
   * picture — the only kind of reading a rendition ever gives, since it runs
   * exactly as long as the picture does. Refusing to answer when something
   * running has no price is the point: unpriced work would otherwise be
   * attributed to the soundtrack, and an overpriced soundtrack refuses quality
   * steps the host could actually hold.
   *
   * @param {HlsSession} session
   * @returns {number | null}
   */
  #pricedConcurrentCost(session) {
    let cost = 0;
    for (const member of this.#familyOf(session)) {
      if (member === session || !processCanBeSignalled(member.runState)) {
        continue;
      }
      if (member.audioOnly === true) {
        const audio = this.#observedAudioCost.get(this.#audioCostKey(member));
        if (!audio || !(audio.costSec > 0)) {
          return null;
        }
        cost += audio.costSec;
        continue;
      }
      if (member.transcodeVideo !== true) {
        const copy = this.#observedCopyCost.get(`${member.sourceKey}:${member.fileIndex}`);
        if (!copy || !(copy.costSec > 0)) {
          return null;
        }
        cost += copy.costSec;
        continue;
      }
      const picture = this.#pictureCostOf(member);
      if (!(picture > 0)) {
        return null;
      }
      cost += picture;
    }
    // Encoders outside this family are counted by number only — there is no
    // price to look up for another film's session — so a reading taken while
    // one is running cannot be attributed either.
    return this.#runningEncoders() > this.#familyOf(session).filter(
      (member) => processCanBeSignalled(member.runState)
    ).length
      ? null
      : cost;
  }

  /**
   * What each height of this family is costing RIGHT NOW, for the heights an
   * encoder is actually running at.
   *
   * Exists so a height can be judged against what the machine spends on
   * everything else — a step being warmed is running while it is judged, and
   * charged its own cost it refuses itself.
   *
   * @param {HlsSession} session
   * @returns {Map<number, number>}
   */
  #runningCostByHeight(session) {
    /** @type {Map<number, number>} */
    const byHeight = new Map();
    for (const member of this.#familyOf(session)) {
      if (member.audioOnly === true || member.transcodeVideo !== true) {
        continue;
      }
      if (!processCanBeSignalled(member.runState)) {
        continue;
      }
      const height = this.variantHeightOf(member);
      if (height > 0) {
        byHeight.set(height, (byHeight.get(height) ?? 0) + this.#pictureCostOf(member));
      }
    }
    return byHeight;
  }

  /**
   * Seconds of work per second of video this family is ALREADY committed to,
   * beside any rung being considered.
   *
   * Every encoder of the family that is actually running: the picture, whether
   * it is copied or re-encoded, and each audio rendition. The rung the viewer
   * is watching and the source's own copied height are never withdrawn by the
   * caller, so charging for the encoder that serves them cannot strand anyone —
   * what it does is stop the NEXT rung being offered as though the machine were
   * idle, which is what the field disproved on 2026-08-15.
   *
   * Anything whose cost is neither measured nor derivable contributes nothing.
   * A guess here would refuse rungs on arithmetic nobody performed.
   *
   * @param {HlsSession} session
   * @returns {number}
   */
  #committedCostOf(session) {
    let cost = 0;
    for (const member of this.#familyOf(session)) {
      // Only what still HAS an encoder. A quality step the viewer left keeps
      // its session and its segments but not a process, and it produces nothing
      // for anybody — charging the machine for it would refuse steps on work
      // nobody is doing.
      //
      // A SUSPENDED encoder is charged, deliberately, and this is not the same
      // question. The unit here is seconds of work per second of VIDEO, not per
      // second of wall clock: a copy running at 8x costs 0.125 s/s whether it
      // is producing right now or parked by the look-ahead cap, because over an
      // hour of watching it still produces an hour of video. Suspension is how
      // that cost is spread, not a discount on it — and pricing a parked
      // encoder at zero would offer a step on the strength of a pause that ends
      // the moment the viewer catches up.
      if (!processCanBeSignalled(member.runState)) {
        continue;
      }
      if (member.audioOnly === true) {
        // A soundtrack encoder, priced from its own measured speed. Nothing is
        // charged for a track nobody has measured: a guess here refuses rungs
        // on arithmetic no one performed.
        const audio = this.#observedAudioCost.get(this.#audioCostKey(member));
        cost += audio && audio.costSec > 0 ? audio.costSec : 0;
        continue;
      }
      if (member.transcodeVideo !== true) {
        const observed = this.#observedCopyCost.get(`${member.sourceKey}:${member.fileIndex}`);
        cost += observed && observed.costSec > 0 ? observed.costSec : 0;
        continue;
      }
      // A picture being RE-ENCODED beside the rung being judged — the warm-up
      // that makes a quality switch seamless is two encoders by design, and
      // that overlap is exactly where the field measured 0.504x on a rung
      // predicted at 1.58x (2026-08-15). Priced by what it has been SEEN doing
      // when it had the machine to itself, and otherwise by the same model that
      // judges every rung — which is a prediction, not a guess.
      cost += this.#pictureCostOf(member);
    }
    // And what the FILE costs simply by being fetched and delivered while it is
    // watched: a viewer consumes it at its own byte rate, and every one of
    // those bytes is downloaded, verified and pushed by this process. Priced
    // per megabyte from readings taken while nothing was encoding, so the two
    // measurements do not contain each other.
    const perMegabyte = this.#observedTorrentCostPerMegabyte;
    const megabytesPerSecond = this.#torrentMegabytesPerSecond(
      session.sourceKey,
      session.fileIndex,
      this.#fileLengthByKey.get(`${session.sourceKey}:${session.fileIndex}`) ?? null,
      session.durationSeconds
    );
    if (perMegabyte !== null && megabytesPerSecond !== null) {
      cost += perMegabyte * megabytesPerSecond;
    }
    return cost;
  }

  /**
   * The speed each rung of this family was last seen running at, when it was
   * running alone.
   *
   * A rung that has been watched failing is refused on that evidence; a rung
   * nobody has run says nothing about itself and is judged by the startup
   * measurement like any other.
   *
   * @param {HlsSession} base
   * @returns {Map<number, number>}
   */
  #measuredRungSpeeds(base) {
    /** @type {Map<number, number>} */
    const speeds = new Map();
    for (const session of this.#familyOf(base)) {
      if (session.transcodeVideo !== true || !Number.isFinite(session.lastAloneSpeed)) {
        continue;
      }
      const height = this.variantHeightOf(session);
      if (height > 0) {
        speeds.set(height, session.lastAloneSpeed);
      }
    }
    return speeds;
  }

  #sustainableHeights({
    heights,
    ownHeight,
    // Every height a viewer has on screen, not one: two viewers of one picture
    // can be on two rungs, and a rung is never withdrawn while somebody is
    // watching it — their next segment would 404 on a stream that is playing.
    playingHeights = new Set(),
    sourceWidth,
    sourceHeight,
    fps,
    source,
    transcodeVideo,
    observedDecodeCostSec = null,
    concurrentCostSec = 0,
    runningCostByHeight = null,
    measuredHeights = null,
    requiredSpeed = null
  }) {
    // What this file's own supply demands, measured by its reader — and
    // realtime while it has not been measured. Read once here so the line that
    // reports a refusal names the figure it refused against.
    const bar = speedBar(requiredSpeed);
    const benchmark = this.softwarePresetBenchmark;
    if (!Array.isArray(benchmark) || benchmark.length === 0 || sourceHeight <= 0 || sourceWidth <= 0) {
      return heights;
    }
    /** @type {number[]} */
    const kept = [];
    /** @type {string[]} */
    const dropped = [];
    // What each height was predicted to do on THIS machine, kept so a session
    // started at that height can be compared against it once it runs. The
    // manager holds the last answer, because the offer is computed on the path
    // that serves every request while a session is created elsewhere.
    /** @type {Map<number, number | null>} */
    const predictedByHeight = new Map();
    for (const height of heights) {
      // A rung this session has actually been seen running below realtime is
      // withdrawn on that evidence, whatever the prediction says. This is the
      // one thing a live reading is authority on: itself. It is asked before
      // any exemption so a rung measured failing while on screen does not stay
      // offered because it was on screen when measured — otherwise a step
      // would ask for the one rung this machine has been measured failing at,
      // then fail again, then step down, for ever. A copied source height
      // cannot reach this: `#measuredRungSpeeds` records only sessions that
      // re-encode, so a copy has no reading to be withdrawn on, which is right
      // — it costs no encoder.
      const measured = measuredHeights?.get(height) ?? null;
      if (measured !== null && measured < 1) {
        // Even the rung on screen is withdrawn on measured failure: keeping it
        // would 404 the next segment, but keeping a rung measured at 0.007x
        // (field 2026-08-31, 4K HEVC on CM4) stalls the viewer for minutes with
        // 0.04s buffered and no way to downgrade because every other rung is
        // also dropped. Withdrawing it lets the offer become empty, which the
        // caller turns into an error the viewer can act on (try another proxy
        // or a lower source) instead of an endless spinner.
        dropped.push(`${height}p=${measured.toFixed(2)}x measured`);
        continue;
      }
      // The rung ON SCREEN is kept only when it has not been measured failing
      // above. Keeping a rung measured at 0.007x would stall the viewer with
      // no path to a faster rung, which is what the field showed.
      if (playingHeights.has(height)) {
        kept.push(height);
        continue;
      }
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
      // any other: on a session whose budget stepped down to 480p, the source's
      // 1080p is neither copied nor being produced, and keeping it unpriced
      // would offer exactly the kind of rung this refuses. Likewise, a rung
      // this session is already producing at 0.007x (field 2026-08-31, 4K HEVC
      // on CM4, 0.1x at 23:45 and 0.007x at 06:57) is not sustainable just
      // because it is running — keeping it offered no path to a faster rung
      // and left the viewer at 0.04s buffered with no downgrade.
      if (
        (height === ownHeight && !transcodeVideo) ||
        (height === sourceHeight && !transcodeVideo)
      ) {
        kept.push(height);
        continue;
      }
      const width = Math.round(((sourceWidth / sourceHeight) * height) / 2) * 2;
      // What the machine is spending on everything EXCEPT this height. A step
      // being warmed for a switch is already running while it is judged, so its
      // own cost is inside the committed total — and charged against itself it
      // is counted twice. Measured against the field figures of 2026-08-15
      // that is 1.83x against 1.03x: below the margin, so the step the viewer
      // had just asked for was dropped from the offer by the act of warming it,
      // and its next segment answered 404 on a stream that was playing.
      const concurrentBesideThis = Math.max(
        0,
        concurrentCostSec - (runningCostByHeight?.get(height) ?? 0)
      );
      const { speed } = canSustainOutput({
        benchmark,
        decodeModel: this.decodeCostModel,
        source,
        outputPixelsPerSec: width * height * fps,
        observedDecodeCostSec,
        concurrentCostSec: concurrentBesideThis
      });
      // The benchmark behind that figure was taken on a QUIET host — one
      // ffmpeg and nothing else. The machine a step will actually run on is
      // also running the kernel, the container and whatever else its owner
      // does, and on the addon host that was measured at 99 % busy with a
      // quarter of it unattributed. Only the unattributed part is charged
      // here: our own encoders are already in `concurrentBesideThis` and the
      // proxy's own work is already priced per megabyte moved.
      // Two corrections, and they are different facts about the machine. The
      // availability share removes work nobody has been charged for; the
      // contention penalty says what OUR OWN second job costs, because the
      // budget adds independent prices and this host does not behave that way
      // — the same work measured 2.6× dearer beside one encoder and 3.7×
      // beside two (2026-08-18). `concurrentBesideThis` already counts what is
      // committed; this multiplies by how badly running at all together goes.
      const othersRunning = concurrentBesideThis > 0 ? this.#encodersRunningNow() : 0;
      const { penalty } = contentionPenalty(othersRunning, this.contentionPenalties);
      const onThisMachine = correctForAvailability(
        speed === null ? null : speed / penalty,
        this.hostAvailability
      );
      // Kept against the step's own session, so that when it runs the field
      // says what the prediction was worth. Without this the only comparison
      // available is between two figures written minutes apart in different
      // lines of the log.
      predictedByHeight.set(height, onThisMachine);
      if (onThisMachine !== null && onThisMachine >= bar) {
        kept.push(height);
        continue;
      }
      dropped.push(`${height}p=${onThisMachine === null ? "n/a" : `${onThisMachine.toFixed(2)}x`}`);
    }
    // Written when the ANSWER changes, not when the answer is recomputed. This
    // is asked on the path that serves every playlist, init and segment, and
    // the figures behind it move every five seconds — so an unconditional line
    // here is roughly seven hundred identical lines an hour into a forwarder
    // that holds five hundred, which buries whatever is worth reading.
    if (dropped.length > 0) {
      const line =
        `transcode: not offering ${dropped.join(" ")} — below ${bar.toFixed(2)}x ` +
        (Number.isFinite(requiredSpeed) && requiredSpeed > 1
          ? "(the speed this file's own interruptions demand) "
          : "(realtime, this file's supply not measured yet) ") +
        // Said with the figures, because a step refused on a busy machine and
        // one refused on an idle machine are different facts about the host.
        (this.hostAvailability?.known
          ? `on a machine with ${Math.round(this.hostAvailability.share * 100)}% to spare `
          : "") +
        `(offering ${kept.map((height) => `${height}p`).join(" ")})`;
      if (line !== this.#lastOfferLine) {
        this.#lastOfferLine = line;
        logger.info(line);
      }
      this.lastPredictedByHeight = predictedByHeight;
    } else {
      this.lastPredictedByHeight = predictedByHeight;
      this.#lastOfferLine = "";
    }
    return kept;
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
    const base = this.#baseOf(named);
    const ask = base.qualityAsk;
    if (!ask) {
      return 0;
    }
    if (ask.height === this.variantHeightOf(this.#activeVariant(base))) {
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
        viewerOf(base, consumerId).activeVariantId = null;
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
    const head = consumerId ? session.viewers?.get(consumerId)?.head ?? null : null;
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
    const head = consumerId ? session.viewers?.get(consumerId)?.head ?? null : null;
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
    // Only a run that was still going is being STOPPED. The handle outlives the
    // process — nothing nulls it when a run ends — so a rung that had already
    // finished or failed reaches here too, and calling that a stop would erase
    // how it actually ended.
    const stoppedRunDirPath = session.runDirPath ?? null;
    if (!hasChildExited(ffmpeg)) {
      this.#transitionRun(session, ENCODE_RUN_EVENT.STOP_ORDERED);
      try {
        ffmpeg.kill("SIGTERM");
      } catch {
        // Best effort — the process may have exited between the two lines.
      }
    }
    // The session outlives the run — a stopped rung keeps serving what it made
    // — so the piece this run had open must not be left looking like one of
    // them. Not awaited: the caller's own work does not depend on it, and the
    // wait is for a process that has already been told to go.
    // The stretch this run was given, read now rather than when the process
    // finally exits: by then the session may have started another run with
    // another stretch, and the piece to discard belongs to this one.
    const stoppedSpan = {
      from: Number.isInteger(session.encodeStartIndex) ? session.encodeStartIndex : 0,
      to: Number.isInteger(session.runEndIndex) ? session.runEndIndex : -1
    };
    void waitForChildExit(ffmpeg, ENCODE_RUN_TERMINATE_GRACE_MS).then(() =>
      this.#discardUnfinishedPiece(session, stoppedRunDirPath, stoppedSpan)
    );
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
    if (!this.#splicableHeights(base).includes(height)) {
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
      inheritedGrid: base.cutGrid === "keyframe"
        ? {
            // The table as it stands NOW, corrections included — not the index
            // it was first built from. This is what the new session CUTS at.
            boundaries: base.segmentBoundaries,
            // And this is what it must SAY, which is not the same thing: every
            // member of a family has to publish one timeline, or two sessions
            // stamp the same moment differently and the picture and the sound
            // drift apart by exactly the corrections made between their two
            // creations (field 2026-08-17, corrections of 0.6-2.9 s).
            published: base.publishedBoundaries,
            keyframeTimes: base.keyframeTimes,
            keyframeTolerance: base.keyframeTolerance,
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
        const incumbent = await this.#adoptIfAlreadyProduced(base, height, variant);
        if (incumbent) {
          base.variants.set(height, incumbent.id);
          return incumbent;
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
   * The height a session's encoder is actually producing, or 0 when it produces
   * no encoded picture of its own (a copy, or a soundtrack).
   *
   * A COPY must never be adopted: it costs no encoder at all, so handing it to a
   * request for a re-encoded rung would give away the one thing this host can
   * always serve.
   *
   * @param {HlsSession} session
   * @returns {number}
   */
  #producedHeightOf(session) {
    if (!session || session.transcodeVideo !== true || session.audioOnly === true) {
      return 0;
    }
    return Math.round(Number(session.encodeHeight) || 0);
  }

  /**
   * A session of this family already making exactly this picture, if there is
   * one — so that a second request for it does not start a second encoder.
   *
   * WHY THIS EXISTS, AND WHY IT COMPARES WHAT IS PRODUCED RATHER THAN WHAT WAS
   * ASKED FOR. `base.variants` is keyed on the height the browser requested,
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
    const produced = this.#producedHeightOf(candidate);
    if (produced <= 0) {
      return null;
    }
    const seen = new Set([candidate.id]);
    // The base belongs in this scan: it is a rung like any other, and when it
    // is itself a re-encode the clamp can land a variant right on top of it.
    for (const other of [base, ...[...base.variants.values()]
      .map((id) => this.sessionsById.get(id))]) {
      if (!other || seen.has(other.id) || other.state === "disposed") {
        continue;
      }
      seen.add(other.id);
      if (this.#producedHeightOf(other) !== produced) {
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
          `instead of starting a second encoder "${base.fileName}"`
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
    if (!this.#splicableHeights(base).includes(height)) {
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
    const stillWarming = viewerOf(base, consumerId).warmingAudioId;
    if (stillWarming && stillWarming !== rendition.id) {
      const abandoned = this.sessionsById.get(stillWarming);
      const wanted = this.#liveAudioRenditionKeys(base);
      const wantedIds = new Set();
      for (const [renditionKey, sessionId] of base.audioRenditionSessions ?? []) {
        if (wanted.has(renditionKey)) {
          wantedIds.add(sessionId);
        }
      }
      if (abandoned && !wantedIds.has(abandoned.id)) {
        this.#stopEncodeRun(abandoned, "prepared for a track change the viewer did not make");
      }
    }
    viewerOf(base, consumerId).warmingAudioId = rendition.id;
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
    const stillWarming = viewerOf(base, consumerId).warmingVariantId;
    if (stillWarming && stillWarming !== variant.id) {
      const abandoned = this.sessionsById.get(stillWarming);
      if (abandoned && !this.#variantsOnScreen(base).has(abandoned.id)) {
        this.#stopEncodeRun(abandoned, "warmed for a switch the viewer did not make");
      }
    }
    // The base is not a rung being prepared for anybody — it is what the family
    // is named by — so warming its own height leaves nothing outstanding.
    if (variant.id === base.id) {
      viewerOf(base, consumerId).warmingVariantId = null;
    } else {
      viewerOf(base, consumerId).warmingVariantId = variant.id;
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
      viewerOf(base, consumerId).warmingVariantId = null;
    }
    if (warmed && warmed !== variant.id && warmed !== previous.id) {
      const abandoned = this.sessionsById.get(warmed);
      if (abandoned && !this.#variantsOnScreen(base).has(abandoned.id)) {
        this.#stopEncodeRun(abandoned, "warmed for a switch the viewer did not make");
      }
    }
    const position = this.#variantStartSeconds(base, wantedIndex, consumerId);
    base.activeVariantId = variant.id;
    viewerOf(base, consumerId).activeVariantId = variant.id;
    logger.info(
      `transcode ${base.id} variant now ${this.variantHeightOf(variant)}p ` +
      `(was ${this.variantHeightOf(previous)}p) at ${position.toFixed(1)}s` +
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
      this.#stopEncodeRun(previous, `no viewer is watching ${this.variantHeightOf(previous)}p`);
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
    if (!this.#publishesVariants(session)) {
      return null;
    }
    const sourceHeight = Number(session.sourceHeight) || 0;
    // What CAN be spliced, not what is worth offering this second. The live
    // judgement travels in `offeredHeights` and in every progress report, which
    // is what the viewer's menu follows; letting it decide the master's
    // existence made a live session answer 404 to its own published address.
    const rungs = this.#splicableHeights(session);
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
    const renditions = this.#servesAudioSeparately(session)
      // Which track is marked DEFAULT is the ASKING viewer's business: one
      // picture is shared by everyone watching it, and each of them may have
      // chosen a different language. A default written from the session's own
      // field would start the second viewer in the first viewer's language.
      ? this.#audioRenditionsOf(session, this.#audioChoiceOf(session, consumerId).trackIndex)
      : [];
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
    viewerOf(base, consumerId).audio = { ...previous, trackIndex };
    // Kept for the viewer who cannot name themselves, and for the master's
    // default rendition when nobody has said anything else.
    base.activeAudioTrackIndex = trackIndex;
    const wanted = this.#liveAudioRenditionKeys(base);
    for (const [renditionKey, sessionId] of base.audioRenditionSessions ?? []) {
      if (wanted.has(renditionKey)) {
        continue;
      }
      const other = this.sessionsById.get(sessionId);
      if (!other || other.state === "disposed" || other.ffmpeg == null) {
        continue;
      }
      // Requests held on it are for segments nobody will produce now, and the
      // player stopped waiting for them the moment it changed track.
      other.waitEpoch = (other.waitEpoch ?? 0) + 1;
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
    const staleAfterMs = (this.lookaheadSeconds + this.segmentDurationSec) * 1000;
    const now = Date.now();
    const live = new Set();
    for (const member of this.#familyOf(base)) {
      for (const [consumerId, viewer] of member.viewers ?? []) {
        if (viewer.isLive(now, staleAfterMs)) {
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
    const renditionKey = audioRenditionKey(trackIndex, transcodeAudio);
    const existingId = base.audioRenditionSessions?.get(renditionKey);
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
      transcodeAudio,
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
            published: base.publishedBoundaries,
            keyframeTimes: base.keyframeTimes,
            containerFormat: base.containerFormat
          }
        : null,
      // Hold the file this rendition will READ. For a soundtrack shipped beside
      // the picture that is a different file of the same torrent, and nothing
      // else claims it: the base holds the picture, and the disk sweep deletes
      // what nobody is holding — which is how a film being watched was deleted
      // on 2026-08-06.
      acquireSource: () => base.acquireSource?.(
        this.#resolveAudioSource(base.sourceKey, base.fileIndex, trackIndex).fileIndex
      )
    });
    if (!rendition) {
      return null;
    }
    if (!(base.audioRenditionSessions instanceof Map)) {
      base.audioRenditionSessions = new Map();
    }
    base.audioRenditionSessions.set(renditionKey, rendition.id);
    return rendition;
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
   * Where a sidecar soundtrack's own timeline begins, in seconds.
   *
   * What has already been read, without reading anything. The answer to
   * "is it known yet", which is what a caller who must not wait needs.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex - The SIDECAR's file.
   * @returns {number | null} Null when nobody has read it yet.
   */
  #sidecarStartTimeNow(sourceKey, fileIndex) {
    if (!(this.sidecarStartTimes instanceof Map)) {
      this.sidecarStartTimes = new Map();
    }
    const held = this.sidecarStartTimes.get(`${sourceKey}:${fileIndex}`);
    return Number.isFinite(held) ? held : null;
  }

  /**
   * Start reading where a sidecar soundtrack's timeline begins, if nobody has.
   *
   * Read by the container layer from the file's own header — the same 64 KB,
   * the same reader and the same per-file cache the audio menu's track list
   * comes from. A container states this, so it is read from the container and
   * not measured from the media.
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
   * @param {string} sourceKey
   * @param {number} fileIndex - The SIDECAR's file.
   * @returns {void}
   */
  #warmSidecarStartTime(sourceKey, fileIndex) {
    if (typeof this.getContainerMediaInfo !== "function") {
      return;
    }
    if (!(this.sidecarStartTimes instanceof Map)) {
      this.sidecarStartTimes = new Map();
    }
    if (!(this.sidecarStartTimeReads instanceof Set)) {
      this.sidecarStartTimeReads = new Set();
    }
    const key = `${sourceKey}:${fileIndex}`;
    if (this.sidecarStartTimes.has(key) || this.sidecarStartTimeReads.has(key)) {
      return;
    }
    this.sidecarStartTimeReads.add(key);
    void Promise.resolve(this.getContainerMediaInfo({ sourceKey, fileIndex }))
      .then((info) => {
        if (info && Number.isFinite(info.startTimeSeconds)) {
          this.sidecarStartTimes.set(key, info.startTimeSeconds);
          logger.info(
            `transcode: soundtrack file ${fileIndex}'s own timeline starts at ` +
            `${info.startTimeSeconds.toFixed(6)}s, read from its header`
          );
        }
      })
      .catch((error) => {
        logger.info(
          `transcode: the start of soundtrack file ${fileIndex}'s timeline could not be read ` +
          `(${error instanceof Error ? error.message : String(error)}) — the two timelines are ` +
          "taken to agree until it can be"
        );
      })
      .finally(() => {
        this.sidecarStartTimeReads.delete(key);
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
      sourceKey: session.sourceKey,
      // The PICTURE's file, which is what `fileIndex` is on every session of a
      // family — a rendition is created with its base's, and only its
      // `audioFileIndex` points at the file its sound comes from. The inventory
      // is keyed on the picture and spans the soundtracks beside it.
      fileIndex: session.fileIndex
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
    if (session.runState === ENCODE_RUN_STATE.RETRY_WAIT) {
      // The data went away and is being fetched again. Holding the request is
      // the truthful answer: nothing is broken and there is nothing for the
      // viewer to retry.
      return { kind: "warming-up" };
    }
    if (session.runState === ENCODE_RUN_STATE.ENDED_FAILED) {
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

    // Which run's copy answers, when several have written this name. Chosen by
    // what the copies CARRY, not by which run is newest — see #chooseProducedCopy.
    const chosen = await this.#chooseProducedCopy(session, fileName);
    const filePath = chosen?.path ?? path.join(session.dirPath, fileName);
    // Which run wrote what is being served. Every question below that used to
    // be asked of a segment's NUMBER — is it finished, is it a leftover — is a
    // question about its run, and the run is known here.
    const currentRunDir = session.runDirPath ?? session.dirPath;
    const fromCurrentRun = (chosen?.dir ?? currentRunDir) === currentRunDir;
    const isPlaylist = fileName === PLAYLIST_FILE_NAME;
    if (!isPlaylist) {
      // Where the viewer actually is. Recorded for every segment request,
      // served or not, because it is what bounds how far ahead the encoder is
      // allowed to run — see #enforceLookAhead.
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
        // Only the CURRENT run can have a file open, and only its own next
        // piece is evidence that it has moved on. A run that has ended closed
        // everything it wrote, so its files need no such proof — and taking the
        // proof from whichever run happened to hold the next number is how a
        // file being written came to be read as finished.
        if (!isLast && session.ffmpeg && fromCurrentRun) {
          const nextName = session.segmentFormat.segmentFileName(index + 1);
          const nextPath = path.join(chosen?.dir ?? session.dirPath, nextName);
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
      // A run that has walked into a stretch another run was given stops here.
      //
      // A run's own end is set when it starts, from the gaps of that moment,
      // and a viewer who opened the same film somewhere else afterwards is not
      // in that picture: their run took the stretch in front, and this one is
      // now producing numbers they are producing too. Nothing may write a name
      // another run wants — that is the whole reason runs used to be kept in
      // separate directories, and this is what replaces it now that they share
      // one.
      if (!isPlaylist) {
        const served = session.segmentFormat.segmentIndexFromName(fileName);
        const madeByAnother = Number.isInteger(served) && served >= 0
          ? this.runMakingSegment(session, served)
          : null;
        if (madeByAnother !== null) {
          this.#stopEncodeRun(
            session,
            `it reached #${served}, which ${madeByAnother.slice(0, 8)} was given`
          );
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
        // Already in hand when the choice between copies had to read it.
        const raw = chosen?.raw ?? await readFile(filePath);
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
          // Whose file is this? The question is about the RUN that wrote it,
          // and it was asked of the index instead: anything at or above
          // `encodeStartIndex` while any run was alive counted as being
          // written. Field 2026-09-03: an empty `#25` left by a run that had
          // been killed four minutes earlier was called "still being written"
          // by a run that had produced nothing, so it was never removed and
          // never remade, and the viewer waited on it for ten minutes. Every
          // run has a directory of its own, and the copy that was read carries
          // the one it came from, so the run can simply be named.
          //
          // A file in the current run's directory while that run exists may
          // genuinely be unfinished — including a run stopped by the look-ahead,
          // which will close the piece when it is released. Everything else is a
          // leftover, whatever its number, and removing it is what lets the
          // current run make it again. Deletion is now provably safe as well:
          // no process writes into a run directory but that run's own ffmpeg,
          // which is what the first version of this check got wrong when it
          // deleted the file an encoder was writing into (2026-08-06, #225).
          const stale = session.ffmpeg === null || !fromCurrentRun;
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
        const trueStart = session.usesExplicitCuts
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
      : this.runStartTimeFor(session, session.encodeStartIndex ?? 0);
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
    const previousStart = session.encodeStartIndex;
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
    const dirsBefore = this.#runDirs(session);
    const accounting = session.backwardRestarts ?? { count: 0, segmentsBack: 0, worstBack: 0, remade: 0 };
    accounting.count += 1;
    accounting.segmentsBack += previousStart - startIndex;
    accounting.worstBack = Math.max(accounting.worstBack, previousStart - startIndex);
    session.backwardRestarts = accounting;

    void (async () => {
      let alreadyOnDisk = 0;
      for (let index = startIndex; index <= last; index += 1) {
        const fileName = session.segmentFormat.segmentFileName(index);
        for (const dir of dirsBefore) {
          try {
            await access(path.join(dir, fileName));
            alreadyOnDisk += 1;
            break;
          } catch {
            // Not this run's; try an older one.
          }
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
    return this.#producedIndex(session).runDirs();
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
          const bytes = session.usesExplicitCuts && session.segmentFormat.stripInit
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

  /**
   * Every copy of one produced file, newest run first.
   *
   * Several runs of a session write the same segment numbers — a restart begins
   * at the viewer's position and walks forward through material an earlier run
   * had already made — so a name can exist two or three times over with
   * different contents. {@link HlsSessionManager##findProducedFile} answers with
   * the first of them, which is the right answer to "has anything opened this
   * number yet" and the wrong one to "what should the viewer be sent".
   *
   * The directory each copy came from is carried out with it, because whose run
   * wrote a file is the only sound way to tell a piece being written now from a
   * leftover of a run that has ended.
   *
   * @param {HlsSession} session
   * @param {string} fileName
   * @returns {Promise<{ path: string, dir: string, bytes: number }[]>}
   */
  async #producedCopies(session, fileName) {
    const dirs = this.#runDirs(session);
    // No run directories at all is the flat layout: one session, one place.
    const searched = dirs.length > 0 ? dirs : [session.dirPath];
    const copies = [];
    for (const dir of searched) {
      const candidate = path.join(dir, fileName);
      try {
        const info = await stat(candidate);
        copies.push({ path: candidate, dir, bytes: info.size });
      } catch {
        // Not this run's.
      }
    }
    return copies;
  }

  /**
   * The newest copy of a file that has anything in it.
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
    for (const copy of await this.#producedCopies(session, fileName)) {
      if (copy.bytes > 0) {
        return copy.path;
      }
    }
    return null;
  }

  /**
   * Which copy of a segment to serve, when more than one run has written it.
   *
   * The newest copy is preferred — it is the one the current run is making — but
   * preference is not entitlement: a copy that carries fewer tracks than the
   * session's header declares cannot be played, and an older run's complete copy
   * of the same number can. Field 2026-09-03: `#25` existed twice, empty in the
   * run that had just been stopped and whole in the run before it, and the whole
   * one was never reached because the search returned the first name it found
   * and stopped. The viewer sat on a frozen frame for ten minutes with the bytes
   * they needed already on the disk.
   *
   * The chosen copy's contents come back with it. The caller reads the file
   * anyway to stamp it, and reading it twice to answer one question about it
   * would double the cost of every segment served.
   *
   * @param {HlsSession} session
   * @param {string} fileName
   * @returns {Promise<{ path: string, dir: string, bytes: number, raw: Buffer | null } | null>}
   */
  async #chooseProducedCopy(session, fileName) {
    const copies = await this.#producedCopies(session, fileName);
    if (copies.length === 0) {
      return null;
    }
    // A file with nothing in it is never the better copy, and saying so costs
    // no read. This holds even where the tracks cannot be counted — before the
    // session has a header, `hasEveryTrack` has nothing to compare against and
    // waves every piece through, empty ones included.
    const withBytes = copies.filter((copy) => copy.bytes > 0);
    const ranked = withBytes.length > 0 ? withBytes : copies;
    const canJudge =
      typeof session.segmentFormat?.hasEveryTrack === "function" &&
      session.segmentFormat.needsSegmentRewrite &&
      session.segmentFormat.isSegmentFileName(fileName) &&
      session.initBytes &&
      session.initBytes.length > 0;
    if (!canJudge) {
      // Nothing further can be said about which copy is better, so the newest
      // that has bytes in it stands.
      return { ...ranked[0], raw: null };
    }
    for (const copy of ranked) {
      if (copy.bytes === 0) {
        continue;
      }
      let raw;
      try {
        raw = await readFile(copy.path);
      } catch {
        continue; // Removed while we were choosing; the next copy answers.
      }
      const bytes = session.usesExplicitCuts && session.segmentFormat.stripInit
        ? session.segmentFormat.stripInit(raw)
        : raw;
      if (session.segmentFormat.hasEveryTrack(bytes, session.initBytes)) {
        return { ...copy, raw };
      }
    }
    // None of them is servable. The newest is handed back regardless, so the
    // readiness path can say WHY and, when it belongs to a run that has ended,
    // remove it — answering "not produced" here would lose both.
    return { ...ranked[0], raw: null };
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
    const isWarmupPhase = wireState(session.runState) === "starting";
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
      state: wireState(session.runState),
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
        ? (session.encodeHeight ?? session.sourceHeight ?? 0)
        : (session.sourceHeight ?? 0),
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
      error: session.runState === ENCODE_RUN_STATE.ENDED_FAILED ? session.lastError : ""
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
    // And everything that was true of them alone. This is what six parallel
    // maps made easy to forget, and it WAS forgotten: a viewer who had left
    // went on counting as wanting their soundtrack until their head expired,
    // and their entries stayed for the life of the session. One object, one
    // deletion.
    viewersOf(session).delete(consumerId);
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
        // EVERY key naming it, not just the height it was created under. One
        // session can be filed under several heights: the clamp lands different
        // requests on one picture, and each of those requests keeps its own key
        // pointing at the single session that serves it.
        if (base.variants instanceof Map) {
          for (const [height, id] of [...base.variants]) {
            if (id === session.id) {
              base.variants.delete(height);
            }
          }
        }
        if (base.activeVariantId === session.id) {
          base.activeVariantId = base.id;
        }
        // And every viewer who was watching it goes back to the picture the
        // family is named by, or their next request would resolve a session
        // that no longer exists.
        for (const [, viewer] of base.viewers ?? []) {
          if (viewer.activeVariantId === session.id) {
            viewer.activeVariantId = null;
          }
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
    // Whether the process is still RUNNING, not whether anyone has called kill
    // on it: `.killed` means only that a signal was sent, and a run that ended
    // by itself — the file watched through, or a failure — was never killed at
    // all. Asked the old way, every idle session on disposal signalled a dead
    // pid and claimed to be stopping a run that had already ended.
    if (session.ffmpeg && !hasChildExited(session.ffmpeg)) {
      // The run ends with the session, and the state must say so: left where it
      // was, it would go on claiming a process that can be signalled and an
      // input that is being read, about a session that no longer exists.
      this.#transitionRun(session, ENCODE_RUN_EVENT.STOP_ORDERED);
      session.ffmpeg.kill("SIGTERM");
      await waitForChildExit(session.ffmpeg);
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
