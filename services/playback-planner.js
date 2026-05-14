import { spawn } from "node:child_process";

const DIRECT_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

function parseStreamCodecs(ffmpegOutput) {
  const audioMatch = ffmpegOutput.match(/Audio:\s*([A-Za-z0-9_]+)/i);
  const videoMatch = ffmpegOutput.match(/Video:\s*([A-Za-z0-9_]+)/i);
  return {
    audioCodec: audioMatch ? String(audioMatch[1]).toLowerCase() : "",
    videoCodec: videoMatch ? String(videoMatch[1]).toLowerCase() : ""
  };
}

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

function buildDirectUrl(localBaseUrl, sourceKey, fileIndex) {
  const directUrl = new URL("/stream", `${localBaseUrl}/`);
  directUrl.searchParams.set("sourceKey", sourceKey);
  directUrl.searchParams.set("fileIndex", String(fileIndex));
  return directUrl.toString();
}

export function createPlaybackPlanner({
  ffmpegBin,
  transcodeAudioEnabled,
  localBaseUrl,
  sourceRegistry,
  torrentPool
}) {
  const cache = new Map();

  return {
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

      const { audioCodec, videoCodec } = await probeStreamCodecs({
        ffmpegBin,
        inputUrl: directUrl,
        userAgent
      });

      const requiresTranscode = !audioCodec || !DIRECT_AUDIO_CODECS.has(audioCodec);
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
