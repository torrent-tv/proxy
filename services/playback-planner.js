/**
 * @file Playback planner service.
 *
 * Determines whether a torrent file can be served directly or requires
 * HLS audio transcoding by probing the stream codecs with ffmpeg.
 * Results are cached indefinitely (keyed by source + file index).
 */

import { spawn } from "node:child_process";
import {
  parseFfmpegDurationSeconds,
  parseFfmpegStartTimeSeconds,
  parseFfmpegVideoDimensions,
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
  torrentPool
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

  return {
    /**
     * Media info the planner already probed for this file, or `null`. Lets the
     * HLS session manager skip its own duplicate `probeInputMediaInfo` scan.
     *
     * @param {{ sourceKey: string, fileIndex: number }} params
     * @returns {{ durationSeconds: number | null, width: number | null, height: number | null, fps: number | null, startTime: number, isHdr: boolean } | null}
     */
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
        return cached;
      }

      const sourceRecord = sourceRegistry.get(sourceKey);
      if (!sourceRecord) {
        const error = new Error("Source key was not found.");
        error.code = "SOURCE_NOT_FOUND";
        throw error;
      }

      const torrent = await torrentPool.getTorrent(sourceRecord.sourceType, sourceRecord.source);
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
        return plan;
      }

      // Pre-fetch file edges (head + tail), then probe — retrying while the
      // file header is still downloading. In a multi-file torrent the pieces
      // for a given file arrive unevenly, so the first probe can return empty
      // codecs. A transient empty probe must NOT be cached: otherwise the wrong
      // plan (file treated as directly playable) sticks permanently for this
      // file, and an unsupported codec like xvid gets copied → black video.
      await torrentPool.prefetchFileEdges(torrent, fileIndex);
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

      // `mode` is advisory only (audio-codec based). The browser makes the
      // authoritative decision independently per stream via canPlayType /
      // mediaCapabilities, transcoding only what it cannot play.
      const requiresTranscode = audioCodec.length > 0 && !DIRECT_AUDIO_CODECS.has(audioCodec);
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
        videoWidth,
        videoHeight,
        // Full track inventory for the browser's audio/subtitle menus.
        audioTracks: audioTracks ?? [],
        subtitleTracks: subtitleTracks ?? []
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
        const dims = parseFfmpegVideoDimensions(probe.stderr);
        mediaInfoCache.set(cacheKey, {
          durationSeconds: parseFfmpegDurationSeconds(probe.stderr),
          width: dims.width,
          height: dims.height,
          fps: parseFfmpegVideoFps(probe.stderr),
          startTime: parseFfmpegStartTimeSeconds(probe.stderr),
          isHdr: parseFfmpegHdr(probe.stderr)
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
        return plan;
      }
      return { ...plan, pending: true };
    }
  };
}
