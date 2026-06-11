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
  const containerMatch = ffmpegOutput.match(/Input #0,\s*([^,]+(?:,[^,]+)*?),\s*from/i);
  const durationMatch = ffmpegOutput.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  let durationSeconds = 0;
  if (durationMatch) {
    const value =
      Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
    durationSeconds = Number.isFinite(value) ? value : 0;
  }
  return {
    audioCodec: audioMatch ? String(audioMatch[1]).toLowerCase() : "",
    videoCodec: videoMatch ? String(videoMatch[1]).toLowerCase() : "",
    container: containerMatch ? String(containerMatch[1]).trim().toLowerCase() : "",
    durationSeconds
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
          durationSeconds: 0
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
      const { audioCodec, videoCodec, container, durationSeconds } = probe;
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
        durationSeconds
      };
      // Only cache a plan whose codecs were actually detected. An empty probe is
      // a "header not downloaded yet" signal, not a valid result — caching it
      // would permanently mis-plan the file. In that case flag the plan
      // `pending` so the caller polls again (the header keeps downloading,
      // prioritised by the prefetch above).
      if (codecsDetected) {
        cache.set(cacheKey, plan);
        return plan;
      }
      return { ...plan, pending: true };
    }
  };
}
