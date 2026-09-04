/**
 * @file Playback planner service.
 *
 * Determines whether a torrent file can be served directly or requires
 * HLS audio transcoding by probing the stream codecs with ffmpeg.
 * Results are cached indefinitely (keyed by source + file index).
 */

import { spawn } from "node:child_process";
import { logger } from "../utils/logger.js";
import { Container } from "./container/Container.js";
import { buildAudioInventory } from "./audio-inventory.js";
import { countVideoFiles, matchSidecarFiles } from "./torrent/files.js";
import {
  parseFfmpegDurationSeconds,
  parseFfmpegStartTimeSeconds,
  parseFfmpegBitDepth,
  parseFfmpegBitrateKbps,
  parseFfmpegVideoFps,
  parseFfmpegHdr
} from "./ffmpeg-banner.js";

/** Audio codecs that browsers can decode natively without transcoding. */
const DIRECT_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

// Once the plan probe succeeds, warm the START of the file body so the
// transcode session's ffmpeg reads hit downloaded data instead of paying
// piece latency at encode time (the edge prefetch only covers head+tail for
// the codec probe). ~16 MB ≈ the first segments of typical media.
const BODY_PREFETCH_BYTES = 16 * 1024 * 1024;

/**
 * How long the plan waits for a file's own header before offering its
 * soundtrack without what that header would have said.
 *
 * Not a measurement, and nothing is derived from it: it is the point past which
 * holding the viewer costs more than the language and flags being waited for —
 * which the folder name supplies anyway, from the torrent's file list, at no
 * cost. The reading itself carries on in the worker and is kept there.
 */
const SIDECAR_HEADER_WAIT_MS = 3_000;

/** Subtitle codecs that can be converted to WebVTT (text-based). */
const TEXT_SUBTITLE_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "vtt", "mov_text", "text"]);

/**
 * Parse every stream from the ffmpeg `-i` banner: type, codec, language tag,
 * default disposition and (when present) the stream's `title` metadata line.
 *
 * @param {string} ffmpegOutput
 * @returns {Array<{ streamIndex: number, type: string, codec: string, language: string, title: string, isDefault: boolean }>}
 */
function parseStreams(ffmpegOutput) {
  // Only the Input section: ffmpeg prints Stream lines for the null OUTPUT
  // too (wrapped_avframe / pcm_s16le), which would duplicate every track.
  const inputSection = ffmpegOutput.split(/^(?:Output #|Stream mapping:)/m)[0] ?? ffmpegOutput;
  const lines = inputSection.split(/\r?\n/);
  const streams = [];
  let current = null;
  for (const line of lines) {
    const streamMatch = line.match(
      /^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([A-Za-z0-9]{2,3})\))?: (Audio|Video|Subtitle): ([A-Za-z0-9_]+)/
    );
    if (streamMatch) {
      current = {
        streamIndex: Number(streamMatch[1]),
        type: streamMatch[3].toLowerCase(),
        codec: String(streamMatch[4]).toLowerCase(),
        language: (streamMatch[2] ?? "").toLowerCase(),
        title: "",
        isDefault: /\(default\)/.test(line)
      };
      streams.push(current);
      continue;
    }
    if (current) {
      const titleMatch = line.match(/^\s+title\s*:\s*(.+)$/);
      if (titleMatch && current.title.length === 0) {
        current.title = titleMatch[1].trim();
        continue;
      }
      // A new top-level section (non-indented line) ends the stream's block.
      if (!/^\s/.test(line)) {
        current = null;
      }
    }
  }
  return streams;
}

/**
 * Parse audio and video codec names from ffmpeg stderr output.
 *
 * @param {string} ffmpegOutput
 * @returns {{ audioCodec: string, videoCodec: string }}
 */
function parseStreamCodecs(ffmpegOutput) {
  const audioMatch = ffmpegOutput.match(/Audio:\s*([A-Za-z0-9_]+)/i);
  const videoMatch = ffmpegOutput.match(/Video:\s*([A-Za-z0-9_]+)/i);
  // Coded resolution from the video Stream line ("Video: h264 …, 1280x720, …").
  // The first WxH is the coded size (any trailing "[SAR …]" is ignored).
  const videoLineMatch = ffmpegOutput.match(/Video:[^\n]*/i);
  let videoWidth = 0;
  let videoHeight = 0;
  if (videoLineMatch) {
    const dim = videoLineMatch[0].match(/\b(\d{2,5})x(\d{2,5})\b/);
    if (dim) {
      videoWidth = Number(dim[1]);
      videoHeight = Number(dim[2]);
    }
  }
  const containerMatch = ffmpegOutput.match(/Input #0,\s*([^,]+(?:,[^,]+)*?),\s*from/i);
  const durationMatch = ffmpegOutput.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  let durationSeconds = 0;
  if (durationMatch) {
    const value =
      Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
    durationSeconds = Number.isFinite(value) ? value : 0;
  }
  const streams = parseStreams(ffmpegOutput);
  const audioTracks = streams
    .filter((s) => s.type === "audio")
    .map((s, i) => ({
      // Type-relative index — what ffmpeg's `-map 0:a:N` selects.
      index: i,
      streamIndex: s.streamIndex,
      codec: s.codec,
      language: s.language,
      title: s.title,
      isDefault: s.isDefault
    }));
  const subtitleTracks = streams
    .filter((s) => s.type === "subtitle")
    .map((s, i) => ({
      // Type-relative index — what ffmpeg's `-map 0:s:N` selects.
      index: i,
      streamIndex: s.streamIndex,
      codec: s.codec,
      language: s.language,
      title: s.title,
      isDefault: s.isDefault,
      // Image-based subtitles (PGS/VobSub) cannot become WebVTT.
      textBased: TEXT_SUBTITLE_CODECS.has(s.codec)
    }));
  return {
    audioCodec: audioMatch ? String(audioMatch[1]).toLowerCase() : "",
    videoCodec: videoMatch ? String(videoMatch[1]).toLowerCase() : "",
    container: containerMatch ? String(containerMatch[1]).trim().toLowerCase() : "",
    durationSeconds,
    videoWidth,
    videoHeight,
    audioTracks,
    subtitleTracks
  };
}

/**
 * Run a brief ffmpeg probe to identify the audio and video codecs of a stream.
 * Times out after `timeoutMs` and returns empty strings on failure.
 *
 * @param {object} options
 * @param {string} options.ffmpegBin
 * @param {string} options.inputUrl
 * @param {string} [options.userAgent=""]
 * @param {number} [options.timeoutMs=8000]
 * @returns {Promise<{ audioCodec: string, videoCodec: string, container: string, durationSeconds: number, videoWidth: number, videoHeight: number, audioTracks: object[], subtitleTracks: object[], stderr: string }>}
 *   Parsed banner fields plus the raw `stderr`, so the caller can derive the
 *   full media info (fps/startTime/HDR) without a second ffmpeg scan.
 */
function probeStreamCodecs({ ffmpegBin, inputUrl, userAgent = "", timeoutMs = 8_000 }) {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-loglevel", "info"];
    if (typeof userAgent === "string" && userAgent.trim().length > 0) {
      args.push("-user_agent", userAgent.trim());
    }
    // Decode a tiny slice of all streams (no per-stream -map, so video-only
    // files probe correctly too).  The ffmpeg banner that precedes decoding
    // gives us audio/video codecs, the container format and the duration in a
    // single pass.
    args.push("-i", inputUrl, "-t", "0.1", "-f", "null", "-");

    const ffmpeg = spawn(ffmpegBin, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    let settled = false;

    const finish = (codecs) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(codecs);
    };

    const timeoutId = setTimeout(() => {
      if (!ffmpeg.killed) {
        ffmpeg.kill("SIGTERM");
      }
      finish({ ...parseStreamCodecs(stderr), stderr });
    }, timeoutMs);

    ffmpeg.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    ffmpeg.on("error", () => {
      clearTimeout(timeoutId);
      finish({ audioCodec: "", videoCodec: "", stderr: "" });
    });

    ffmpeg.on("exit", () => {
      clearTimeout(timeoutId);
      finish({ ...parseStreamCodecs(stderr), stderr });
    });
  });
}

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
 * Build the direct stream URL for a source file served by the local proxy.
 *
 * @param {string} localBaseUrl - e.g. "http://127.0.0.1:9090"
 * @param {string} sourceKey
 * @param {number} fileIndex
 * @returns {string}
 */
function buildDirectUrl(localBaseUrl, sourceKey, fileIndex) {
  const directUrl = new URL("/stream", `${localBaseUrl}/`);
  directUrl.searchParams.set("sourceKey", sourceKey);
  directUrl.searchParams.set("fileIndex", String(fileIndex));
  return directUrl.toString();
}

/**
 * @typedef {Object} PlaybackPlan
 * @property {"direct" | "hls"} mode
 * @property {string} directUrl
 * @property {string} reason   - Human-readable explanation of the chosen mode.
 * @property {string} audioCodec
 * @property {string} videoCodec
 * @property {string} container         - Demuxer/container name(s) reported by ffmpeg.
 * @property {number} durationSeconds   - Total media duration in seconds (0 if unknown).
 * @property {number} videoWidth        - Source coded width (0 if unknown).
 * @property {number} videoHeight       - Source coded height (0 if unknown).
 */

/**
 * @typedef {Object} PlaybackPlannerOptions
 * @property {string}  ffmpegBin
 * @property {boolean} transcodeAudioEnabled
 * @property {string}  localBaseUrl
 * @property {ReturnType<import("../store/source-registry.js").createSourceRegistry>} sourceRegistry
 * @property {import("./torrent-pool.js").TorrentPool} torrentPool
 */

/**
 * Create a playback planner that decides the optimal streaming mode for
 * a torrent file. Plans are cached per (sourceKey, fileIndex) pair.
 *
 * @param {PlaybackPlannerOptions} options
 * @returns {{ getPlan: (params: { sourceKey: string, fileIndex: number, userAgent?: string }) => Promise<PlaybackPlan> }}
 */
export function createPlaybackPlanner({
  ffmpegBin,
  transcodeAudioEnabled,
  localBaseUrl,
  sourceRegistry,
  torrentPool,
  // Optional. Reports what this host typically takes to produce a session's
  // first segment. The browser needs it for the gap between "the file is
  // downloaded" and "a segment exists": until now it assumed the pipeline
  // merely keeps up with realtime, and showed 15 s where 3.8 s were left.
  expectedFirstSegmentMs,
  expectedSessionCreateMs,
  // Optional. Called once the file's edges are downloaded, so the keyframe
  // index — which reads the same tail of the file — is fetched alongside the
  // codec probe instead of after it. Late-bound to the HLS session manager,
  // which owns the cache both of them share.
  warmKeyframeIndex,
  // Optional. The heights this host could actually serve this source at, for
  // both playback branches, so the quality menu is right from the moment the
  // file is opened rather than from the moment an encoder exists.
  predictOfferedHeights
}) {
  /** @type {Map<string, PlaybackPlan>} */
  const cache = new Map();
  /**
   * Full media info parsed from the SAME probe that produced the plan, cached
   * under the same key so a transcode session can reuse it instead of running
   * a second ffmpeg scan. Only set when the plan is cached (codecs detected).
   * @type {Map<string, { durationSeconds: number | null, width: number | null, height: number | null, fps: number | null, startTime: number, isHdr: boolean }>}
   */
  const mediaInfoCache = new Map();

  /**
   * Attach what this host currently measures itself taking to create a session
   * and to produce a first segment.
   *
   * Read at RESPONSE time, deliberately. Both are medians of sessions that have
   * already finished on this host, so at the moment a plan is BUILT the very
   * first file opened after a restart has none and gets `null` — and the plan
   * is then cached, so that file kept answering `null` for the life of the
   * process however many sessions ran afterwards. Measured 2026-08-05: a fresh
   * 2.9.103 answered `null` for both, then produced the session in 6 ms and the
   * first segment in 21 479 ms. The figures existed; the plan could not carry
   * them, and the browser's estimate fell back to its own guess in exactly the
   * cold-start case the feature was built for.
   *
   * @param {PlaybackPlan} plan
   * @returns {PlaybackPlan}
   */
  /**
   * The probe's subtitle tracks, with `FlagDefault` read from the container
   * instead of inferred from ffmpeg's banner.
   *
   * Best-effort by construction: a container that cannot be read this way, or a
   * reading that does not line up with the probe, leaves the tracks as they
   * were with `declaresDefault: false` — which the browser reads as "the file
   * has no opinion", and then nothing is shown unasked.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {object[]} subtitleTracks
   * @returns {Promise<object[]>}
   */
  /**
   * The files beside this picture that belong to it, in three groups.
   *
   * One call site's worth of arguments, spelled once: the file list, the
   * torrent's own name (which WebTorrent prefixes to every path) and how many
   * pictures the torrent holds, which is what decides whether a sidecar with a
   * name in common with nothing can still belong to the only video there is.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @returns {{ audio: object[], subtitles: object[], images: object[] }}
   */
  function sidecarsOf(torrent, fileIndex) {
    return matchSidecarFiles({
      files: torrent?.files ?? [],
      videoIndex: fileIndex,
      torrentName: typeof torrent?.name === "string" ? torrent.name : "",
      videoCount: countVideoFiles(torrent?.files ?? [])
    });
  }

  async function withContainerDefaults(torrent, fileIndex, subtitleTracks) {
    if (subtitleTracks.length === 0 || typeof torrentPool?.getDeclaredSubtitleTracks !== "function") {
      return subtitleTracks.map((track) => ({ ...track, declaresDefault: false }));
    }
    let declared = [];
    try {
      declared = await torrentPool.getDeclaredSubtitleTracks(torrent, fileIndex);
    } catch (error) {
      logger.info(`subtitle defaults: the container could not be read (${error?.message ?? error})`);
    }
    const merged = Container.mergeSubtitleFlags(subtitleTracks, declared);
    logger.info(
      merged.aligned
        ? "subtitle defaults: the container wrote FlagDefault on " +
          `${merged.tracks.filter((track) => track.declaresDefault).length} of ${merged.tracks.length} ` +
          `subtitle tracks, marking ${merged.tracks.filter((track) => track.declaresDefault && track.isDefault).length}`
        : `subtitle defaults: using the probe's own flags — ${merged.reason}`
    );
    return merged.tracks;
  }

  /**
   * Every soundtrack this file can be watched with, as one numbered list: its
   * own tracks and the ones shipped as separate files beside it.
   *
   * Built here, in the plan, because the plan is what the viewer's menu is drawn
   * from — so the offer is complete the moment a file is opened, with nothing
   * arriving late and nothing measured while the viewer waits. It is also what
   * the master playlist's rendition group is built from, so the number in the
   * menu and the number in the `a/<n>/` address are the same number by
   * construction rather than by agreement.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {object[]} bannerAudioTracks - The probe's own audio streams.
   * @returns {Promise<import("./audio-inventory.js").AudioInventoryEntry[]>}
   */
  async function buildInventory(torrent, fileIndex, bannerAudioTracks) {
    const banner = Array.isArray(bannerAudioTracks) ? bannerAudioTracks : [];
    /**
     * Read a file's declared audio tracks, or give up quickly.
     *
     * The plan is on the path to the first frame, and reading a sidecar's header
     * waits on the swarm: that file has usually had nothing downloaded when this
     * runs, and a header that never arrives would hold the plan — and the
     * viewer — for the whole of the read's own patience. What a timeout costs is
     * small and deliberate: the track is still offered, still numbered and still
     * playable, only without the language and flags its own header would have
     * given. The language the viewer actually sees is read from the FOLDER the
     * release put it in, which is in the torrent's file list and needs no bytes
     * at all.
     *
     * @param {number} wantedFileIndex
     * @param {string} label
     * @returns {Promise<object[]>}
     */
    const declaredAudioOf = async (wantedFileIndex, label) => {
      if (typeof torrentPool?.getDeclaredAudioTracks !== "function") {
        return [];
      }
      let timer = null;
      try {
        return await Promise.race([
          torrentPool.getDeclaredAudioTracks(torrent, wantedFileIndex),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), SIDECAR_HEADER_WAIT_MS);
            timer.unref?.();
          })
        ]).then((tracks) => {
          if (tracks === null) {
            logger.info(
              `audio tracks: "${label}" did not answer within ` +
              `${SIDECAR_HEADER_WAIT_MS / 1000}s — offered without what its header would say`
            );
            return [];
          }
          return Array.isArray(tracks) ? tracks : [];
        });
      } catch (error) {
        logger.info(`audio tracks: "${label}" could not be read (${error?.message ?? error})`);
        return [];
      } finally {
        if (timer !== null) {
          clearTimeout(timer);
        }
      }
    };
    // The picture's own tracks: ffmpeg numbers them, the container declares what
    // they are. Both readings, lined up and checked — see `audio-inventory.js`.
    let embedded = banner.map((track) => ({ ...track, declaresDefault: false }));
    if (banner.length > 0) {
      // The picture's head is already downloaded — the codec probe just read it
      // — so this is a parse and not a wait, but it is bounded like the rest.
      const declared = await declaredAudioOf(fileIndex, "the picture");
      const merged = Container.mergeAudioFlags(banner, declared);
      embedded = merged.tracks;
      logger.info(
        merged.aligned
          ? `audio tracks: the container describes all ${merged.tracks.length}` +
            `${merged.tracks.some((track) => track.isCommentary) ? ", one of them commentary" : ""}` +
            `${merged.tracks.some((track) => track.isVisualImpaired) ? ", one of them described" : ""}`
          : `audio tracks: using the probe's own fields — ${merged.reason}`
      );
    }

    const sidecarFiles = sidecarsOf(torrent, fileIndex);
    // All of them at once. They are separate files with separate headers, and
    // read one after another the waits add up on the path to the first frame.
    const sidecars = await Promise.all(
      sidecarFiles.audio.map(async (file) => ({
        file,
        // A bare elementary stream — `.ac3`, `.dts`, `.mp3` — has no table to
        // read, so nothing is asked of the swarm for it at all.
        tracks: file.declaresTracks ? await declaredAudioOf(file.fileIndex, file.name) : []
      }))
    );
    const inventory = buildAudioInventory({ embedded, videoFileIndex: fileIndex, sidecars });
    if (sidecars.length > 0) {
      logger.info(
        `audio tracks: ${sidecars.length} file(s) beside the picture carry sound — ` +
        inventory
          .filter((entry) => entry.kind === "sidecar")
          .map((entry) =>
            `a:${entry.index}=${entry.folders.join("/") || "."}/${entry.fileName}` +
            `#${entry.sourceTrackIndex}${entry.codec ? `(${entry.codec})` : ""}`
          )
          .join(" ")
      );
    }
    return inventory;
  }

  function withHostTimings(plan) {
    const withOffer = {
      ...plan,
      expectedFirstSegmentMs: expectedFirstSegmentMs?.() ?? null,
      expectedSessionCreateMs: expectedSessionCreateMs?.() ?? null,
      // Answered here for the same reason as the two above: a plan is cached for
      // the life of the process, and what this host will serve a file at is not.
      // It starts as a prediction from the startup benchmarks and is replaced by
      // what an encoder running on this very source turns out to cost — frozen
      // into the cache, every later open of the file would hand the browser the
      // first guess again and undo that. This is the 2.9.106 defect exactly.
      offeredHeights: plan.mediaInfoForOffer
        ? (predictOfferedHeights?.(plan.mediaInfoForOffer) ?? null)
        : null,
      mediaInfoForOffer: undefined
    };
    // Refused rather than served badly. Both lists empty means this machine
    // cannot sustain this file at ANY height — not even by copying the picture,
    // which costs no encoder at all — so a session made here would produce a
    // slideshow and take the swarm and the processor from whoever is already
    // watching. Field 2026-08-28: five sessions on one file put every rung at
    // 0.04x of realtime and the viewer watched one before the process was
    // killed. The viewer is told why, which is a different thing from a spinner
    // that never ends.
    const offer = withOffer.offeredHeights;
    if (offer && offer.copy.length === 0 && offer.transcode.length === 0) {
      withOffer.cannotServe =
        "This proxy cannot keep up with this file at any quality right now.";
      // The description travels with the refusal, and only with it. It is what
      // lets the browser ask the rest of the pool the same question without
      // anybody else adding the torrent, fetching a byte or running ffmpeg —
      // the expensive half of finding out what this file IS has been paid here,
      // once. Everyone else answers by arithmetic against their own startup
      // benchmarks.
      withOffer.mediaInfoForOffer = plan.mediaInfoForOffer;
    }
    return withOffer;
  }

  return {
    /**
     * Media info the planner already probed for this file, or `null`. Lets the
     * HLS session manager skip its own duplicate `probeInputMediaInfo` scan.
     *
     * @param {{ sourceKey: string, fileIndex: number }} params
     * @returns {{ durationSeconds: number | null, width: number | null, height: number | null, fps: number | null, startTime: number, isHdr: boolean } | null}
     */
    /**
     * The audio tracks this file was probed to have, or an empty list. The
     * master playlist publishes one rendition per track, and the inventory is
     * already here — probing again for it would be a second scan of a file the
     * proxy is in the middle of serving.
     *
     * @param {{ sourceKey: string, fileIndex: number }} params
     * @returns {object[]}
     */
    getCachedAudioTracks({ sourceKey, fileIndex }) {
      const plan = cache.get(`${sourceKey}:${fileIndex}`);
      return Array.isArray(plan?.audioTracks) ? plan.audioTracks : [];
    },

    getCachedMediaInfo({ sourceKey, fileIndex }) {
      return mediaInfoCache.get(`${sourceKey}:${fileIndex}`) ?? null;
    },

    /**
     * Return the playback plan for the given source file.
     * Throws with `error.code === "SOURCE_NOT_FOUND"` or `"FILE_NOT_FOUND"`
     * when the source or file cannot be located.
     *
     * When the file header has not downloaded yet (cold torrent, peers still
     * connecting) the codec probe cannot succeed. Rather than block the HTTP
     * response until it can, the planner prioritises the header, probes for at
     * most `maxWaitMs`, and if still undetectable returns a plan flagged
     * `pending: true` (NOT cached). The caller polls again — each call keeps the
     * header prioritised and downloading — until a real plan comes back. This
     * avoids a single long request racing the transport's request timeout.
     *
     * @param {object} params
     * @param {string} params.sourceKey
     * @param {number} params.fileIndex
     * @param {string} [params.userAgent=""]
     * @param {number} [params.maxWaitMs=60000] - Max time to wait for the header within ONE call.
     * @returns {Promise<PlaybackPlan & { pending?: boolean }>}
     */
    async getPlan({ sourceKey, fileIndex, userAgent = "", maxWaitMs = 60_000 }) {
      const cacheKey = `${sourceKey}:${fileIndex}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        return withHostTimings(cached);
      }
      // Where the time before playback goes. `cold-start` already breaks down
      // everything from the transcode-session request onwards, but the plan
      // runs BEFORE that and was a single opaque wait: a field session spent
      // 5.7 s here on a torrent already in the store, with the codec probe
      // cached, and nothing said which part of it was slow.
      const planEntryMs = Date.now();
      let torrentReadyMs = 0;
      let edgesReadyMs = 0;

      const sourceRecord = sourceRegistry.get(sourceKey);
      if (!sourceRecord) {
        const error = new Error("Source key was not found.");
        error.code = "SOURCE_NOT_FOUND";
        throw error;
      }

      const torrent = await torrentPool.getTorrent(sourceRecord.sourceType, sourceRecord.source);
      torrentReadyMs = Date.now() - planEntryMs;
      const file = torrent.files[fileIndex];
      if (!file) {
        const error = new Error("File index was not found in torrent.");
        error.code = "FILE_NOT_FOUND";
        throw error;
      }

      const directUrl = buildDirectUrl(localBaseUrl, sourceKey, fileIndex);
      if (!transcodeAudioEnabled) {
        const plan = {
          mode: "direct",
          directUrl,
          reason: "transcode-disabled",
          audioCodec: "",
          videoCodec: "",
          container: "",
          durationSeconds: 0,
          videoWidth: 0,
          videoHeight: 0,
          audioTracks: [],
          subtitleTracks: []
        };
        cache.set(cacheKey, plan);
        return withHostTimings(plan);
      }

      // Pre-fetch file edges (head + tail), then probe — retrying while the
      // file header is still downloading. In a multi-file torrent the pieces
      // for a given file arrive unevenly, so the first probe can return empty
      // codecs. A transient empty probe must NOT be cached: otherwise the wrong
      // plan (file treated as directly playable) sticks permanently for this
      // file, and an unsupported codec like xvid gets copied → black video.
      await torrentPool.prefetchFileEdges(torrent, fileIndex);
      edgesReadyMs = Date.now() - planEntryMs;
      // The keyframe index reads the tail of the file, which the probe has just
      // waited for as well. Started here it overlaps the probe instead of
      // following the whole plan — worth 311-430 ms of the time before the
      // first segment. Fire and forget: the session reads it itself if this has
      // not finished, and both share one cache entry.
      warmKeyframeIndex?.({
        sourceKey,
        fileIndex,
        inputUrl: new URL(directUrl),
        logName: file.name
      });
      let probe = await probeStreamCodecs({ ffmpegBin, inputUrl: directUrl, userAgent });
      const probeDeadline = Date.now() + Math.max(0, maxWaitMs);
      let attempt = 0;
      while (
        probe.audioCodec.length === 0 &&
        probe.videoCodec.length === 0 &&
        Date.now() < probeDeadline
      ) {
        attempt += 1;
        await delay(Math.min(3_000, 500 + attempt * 250));
        await torrentPool.prefetchFileEdges(torrent, fileIndex);
        probe = await probeStreamCodecs({ ffmpegBin, inputUrl: directUrl, userAgent });
      }
      const { audioCodec, videoCodec, container, durationSeconds, videoWidth, videoHeight, audioTracks, subtitleTracks } = probe;
      const codecsDetected = audioCodec.length > 0 || videoCodec.length > 0;
      logger.info(
        `plan ${sourceKey.slice(0, 8)}:${fileIndex} torrent-ready=${torrentReadyMs}ms ` +
          `file-edges=${edgesReadyMs - torrentReadyMs}ms probe=${Date.now() - planEntryMs - edgesReadyMs}ms ` +
          `total=${Date.now() - planEntryMs}ms attempts=${attempt + 1} ` +
          `${codecsDetected ? `${videoCodec || "-"}/${audioCodec || "-"}` : "codecs NOT detected (will be polled again)"}`
      );

      // The picture's own facts come from two readings and only one was ever
      // used: every figure the encode is planned from came from ffmpeg's
      // banner, while the `VideoTrack` the container declares was read and used
      // for nothing but a line in the log.
      let declaredVideo = null;
      if (typeof torrentPool?.getDeclaredVideoTrack === "function") {
        try {
          declaredVideo = await torrentPool.getDeclaredVideoTrack(torrent, fileIndex);
        } catch (error) {
          logger.info(`video track: could not be read (${error?.message ?? error})`);
        }
      }
      // `mode` is advisory only (audio-codec based). The browser makes the
      // authoritative decision independently per stream via canPlayType /
      // mediaCapabilities, transcoding only what it cannot play.
      const requiresTranscode = audioCodec.length > 0 && !DIRECT_AUDIO_CODECS.has(audioCodec);
      // The two readings of the picture, lined up. Which one answers is decided
      // per field by what each IS — see `Container.mergeVideoFacts`.
      const videoFacts = Container.mergeVideoFacts(
        {
          width: videoWidth,
          height: videoHeight,
          fps: parseFfmpegVideoFps(probe.stderr),
          isHdr: parseFfmpegHdr(probe.stderr),
          bitDepth: parseFfmpegBitDepth(probe.stderr)
        },
        declaredVideo
      );
      if (videoFacts.disagreements.length > 0) {
        logger.info(
          `video track: the file and the probe disagree — ${videoFacts.disagreements.join("; ")}; ` +
          "the size and frame rate are the probe's, the bit depth and HDR the file's"
        );
      }
      const sidecars = sidecarsOf(torrent, fileIndex);
      const plan = {
        mode: requiresTranscode ? "hls" : "direct",
        directUrl,
        reason: requiresTranscode ? "audio-codec-transcode-required" : "audio-codec-supported",
        audioCodec,
        videoCodec,
        container,
        durationSeconds,
        // Source coded resolution — drives the browser's manual quality menu
        // (list of forced resolutions <= source). 0 when unknown.
        videoWidth: videoFacts.width ?? 0,
        videoHeight: videoFacts.height ?? 0,
        // Full track inventory for the browser's audio/subtitle menus. The audio
        // half spans the picture's own tracks AND the soundtracks shipped as
        // files beside it, under one numbering — see `buildInventory`.
        audioTracks: await buildInventory(torrent, fileIndex, audioTracks ?? []),
        subtitleTracks: await withContainerDefaults(torrent, fileIndex, subtitleTracks ?? []),
        // The files BESIDE this picture that belong to it, and what each one's
        // own path says about the track in it. Both answers are made here, by
        // one grammar, because the browser used to make them again: it paired
        // with a looser rule and read the names with a stricter one, and nothing
        // compared the two. Measured 2026-09-04 over 115 real torrents — 1249
        // video files, ten pairings differing — and the difference reached the
        // viewer as a subtitle track offered but never warmed.
        //
        // The soundtracks are NOT repeated here: they are already in
        // `audioTracks`, under the one flat numbering the browser addresses them
        // by. What this adds is the two groups that had no place in the plan at
        // all.
        sidecarSubtitles: sidecars.subtitles,
        sidecarImages: sidecars.images,
        // Both host timings are filled in by `withHostTimings` on the way out,
        // never here: read at build time they would be frozen into the cached
        // plan, which is the bug fixed in 2.9.106.
        expectedFirstSegmentMs: null,
        expectedSessionCreateMs: null,
        offeredHeights: null,
        // What the offer is computed FROM, kept on the cached plan so the offer
        // itself can be recomputed on every response. The figures are the
        // probe's own and never change for a file; the answer derived from them
        // does, as the host learns what this source costs. Stripped on the way
        // out — it is not part of the plan the browser is given.
        mediaInfoForOffer: {
          width: videoFacts.width,
          height: videoFacts.height,
          fps: videoFacts.fps,
          bitrateKbps: parseFfmpegBitrateKbps(probe.stderr),
          // Which family of the decode measurement prices this source. A video
          // that has to be re-encoded is one the browser could not play, so it
          // is usually NOT H.264, and H.264 constants are wrong for it.
          codec: videoCodec,
          bitDepth: videoFacts.bitDepth,
          // Which file this is, so the offer can be answered from what an
          // encoder has already learned about THIS source rather than from the
          // startup clips — the same correction a live session applies.
          sourceKey,
          fileIndex
        }
      };
      // Only cache a plan whose codecs were actually detected. An empty probe is
      // a "header not downloaded yet" signal, not a valid result — caching it
      // would permanently mis-plan the file. In that case flag the plan
      // `pending` so the caller polls again (the header keeps downloading,
      // prioritised by the prefetch above).
      if (codecsDetected) {
        cache.set(cacheKey, plan);
        // Cache the full media info from THIS probe's banner (same helpers the
        // session manager uses) so createSession can skip its own probe.
        mediaInfoCache.set(cacheKey, {
          // The codecs, because the session manager asks this cache which
          // tracks the output will carry — and they were never stored here. It
          // read `videoCodec`/`audioCodec` off an object that has only ever had
          // dimensions and duration, got `undefined` for both, and declared
          // `{video: false, audio: false}` for EVERY session since the check was
          // written. Measured 2026-08-11: `declared tracks video=false
          // audio=false`, which left the browser unable to tell "this file has
          // no video" from "the video was lost on the way", and left the init
          // guard expecting zero tracks and therefore accepting any header.
          videoCodec: plan.videoCodec,
          audioCodec: plan.audioCodec,
          durationSeconds: parseFfmpegDurationSeconds(probe.stderr),
          width: videoFacts.width,
          height: videoFacts.height,
          bitrateKbps: parseFfmpegBitrateKbps(probe.stderr),
          fps: videoFacts.fps,
          startTime: parseFfmpegStartTimeSeconds(probe.stderr),
          isHdr: videoFacts.isHdr,
          bitDepth: videoFacts.bitDepth
        });
        // Warm the file-body start for the transcode session that follows.
        // Fire-and-forget: never delays the plan response.
        void torrentPool
          .prefetchFileEdges(torrent, fileIndex, {
            headBytes: BODY_PREFETCH_BYTES,
            tailBytes: 0,
            timeoutMs: 60_000
          })
          .catch(() => {});
        return withHostTimings(plan);
      }
      return withHostTimings({ ...plan, pending: true });
    }
  };
}
