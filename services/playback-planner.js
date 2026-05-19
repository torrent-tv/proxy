/**
 * @file Playback planner service.
 *
 * Determines whether a torrent file can be served directly or requires
 * HLS audio transcoding by probing the stream codecs with ffmpeg.
 * Results are cached indefinitely (keyed by source + file index).
 */

import { spawn } from "node:child_process";

/** Audio codecs that browsers can decode natively without transcoding. */
const DIRECT_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

/**
 * Parse audio and video codec names from ffmpeg stderr output.
 *
 * @param {string} ffmpegOutput
 * @returns {{ audioCodec: string, videoCodec: string }}
 */
function parseStreamCodecs(ffmpegOutput) {
  const audioMatch = ffmpegOutput.match(/Audio:\s*([A-Za-z0-9_]+)/i);
  const videoMatch = ffmpegOutput.match(/Video:\s*([A-Za-z0-9_]+)/i);
  return {
    audioCodec: audioMatch ? String(audioMatch[1]).toLowerCase() : "",
    videoCodec: videoMatch ? String(videoMatch[1]).toLowerCase() : ""
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
 * @returns {Promise<{ audioCodec: string, videoCodec: string }>}
 */
function probeStreamCodecs({ ffmpegBin, inputUrl, userAgent = "", timeoutMs = 8_000 }) {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-loglevel", "info"];
    if (typeof userAgent === "string" && userAgent.trim().length > 0) {
      args.push("-user_agent", userAgent.trim());
    }
    args.push("-i", inputUrl, "-map", "0:a:0", "-t", "0.1", "-f", "null", "-");

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
      finish(parseStreamCodecs(stderr));
    }, timeoutMs);

    ffmpeg.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    ffmpeg.on("error", () => {
      clearTimeout(timeoutId);
      finish({ audioCodec: "", videoCodec: "" });
    });

    ffmpeg.on("exit", () => {
      clearTimeout(timeoutId);
      finish(parseStreamCodecs(stderr));
    });
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

  return {
    /**
     * Return the playback plan for the given source file.
     * Throws with `error.code === "SOURCE_NOT_FOUND"` or `"FILE_NOT_FOUND"`
     * when the source or file cannot be located.
     *
     * @param {object} params
     * @param {string} params.sourceKey
     * @param {number} params.fileIndex
     * @param {string} [params.userAgent=""]
     * @returns {Promise<PlaybackPlan>}
     */
    async getPlan({ sourceKey, fileIndex, userAgent = "" }) {
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
          videoCodec: ""
        };
        cache.set(cacheKey, plan);
        return plan;
      }

      // Pre-fetch file edges (head + tail) before probing so that WebTorrent
      // has the MOOV atom (or MKV EBML headers) ready for ffprobe.
      // Without this, ffprobe times out on fresh torrents whose MOOV sits at
      // the end of the file and hasn't been downloaded yet.
      await torrentPool.prefetchFileEdges(torrent, fileIndex);

      const { audioCodec, videoCodec } = await probeStreamCodecs({
        ffmpegBin,
        inputUrl: directUrl,
        userAgent
      });

      // Only transcode when the codec is known AND not natively supported.
      // When ffprobe cannot detect the codec (e.g. the torrent has just started
      // downloading and the MOOV atom at the end of the MP4 is not yet available),
      // fall back to "direct" so the browser can attempt native playback.  The
      // browser-side loading pipeline already has its own transcode fallback.
      const requiresTranscode = audioCodec.length > 0 && !DIRECT_AUDIO_CODECS.has(audioCodec);
      const plan = {
        mode: requiresTranscode ? "hls" : "direct",
        directUrl,
        reason: requiresTranscode ? "audio-codec-transcode-required" : "audio-codec-supported",
        audioCodec,
        videoCodec
      };
      cache.set(cacheKey, plan);
      return plan;
    }
  };
}
