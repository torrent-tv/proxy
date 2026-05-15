import { createReadStream } from "node:fs";
import { access, mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const PLAYLIST_FILE_NAME = "index.m3u8";
const SEGMENT_FILE_NAME_PATTERN = /^segment-\d{5}\.ts$/;
const CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_SEGMENT_DURATION_SEC = 4;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_STARTUP_WAIT_MS = 5_000;
const MICROSECONDS_PER_SECOND = 1_000_000;
const PROGRESS_LOG_INTERVAL_MS = 5_000;
const VIDEO_TRANSCODE_PRESET = "superfast";
const VIDEO_TRANSCODE_CRF = "24";
const VIDEO_TRANSCODE_FPS = 24;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

function toLoopbackHost(host) {
  if (host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }
  return host;
}

function buildHttpBaseUrl(host, port) {
  const url = new URL("http://localhost");
  url.hostname = toLoopbackHost(host);
  url.port = String(port);
  return url.origin;
}

function createSessionDirPath(sessionId) {
  return path.join(os.tmpdir(), "torrent-tv-hls", sessionId);
}

function isSafeSessionId(value) {
  return /^[a-f0-9-]{36}$/i.test(value);
}

function isSafeFileName(fileName) {
  return fileName === PLAYLIST_FILE_NAME || SEGMENT_FILE_NAME_PATTERN.test(fileName);
}

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

function parseFfmpegDurationSeconds(stderrText) {
  if (typeof stderrText !== "string" || stderrText.length === 0) {
    return null;
  }
  const match = stderrText.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (![hours, minutes, seconds].every((item) => Number.isFinite(item))) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

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

function computeProgressMetrics(processedSeconds, totalSeconds) {
  const processed = Number.isFinite(processedSeconds) ? Math.max(0, processedSeconds) : 0;
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return { totalSeconds: null, percent: null, remainingSeconds: null, processedSeconds: processed };
  }
  const safeTotal = totalSeconds;
  const percent = Math.max(0, Math.min(100, (processed / safeTotal) * 100));
  const remainingSeconds = Math.max(0, safeTotal - processed);
  return {
    totalSeconds: safeTotal,
    percent,
    remainingSeconds,
    processedSeconds: processed
  };
}

async function probeInputDurationSeconds(ffmpegBin, inputUrl) {
  return new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegBin, ["-hide_banner", "-loglevel", "info", "-i", inputUrl, "-f", "null", "-"], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const timeoutId = setTimeout(() => {
      if (!ffmpeg.killed) {
        ffmpeg.kill("SIGTERM");
      }
      finish(parseFfmpegDurationSeconds(stderr));
    }, 8_000);
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    ffmpeg.on("error", () => {
      clearTimeout(timeoutId);
      finish(null);
    });
    ffmpeg.on("exit", () => {
      clearTimeout(timeoutId);
      finish(parseFfmpegDurationSeconds(stderr));
    });
  });
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

export class HlsSessionManager {
  constructor({
    enabled,
    ffmpegBin,
    localBindHost,
    localPort,
    segmentDurationSec = DEFAULT_SEGMENT_DURATION_SEC,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    startupWaitMs = DEFAULT_STARTUP_WAIT_MS
  }) {
    this.enabled = Boolean(enabled);
    this.ffmpegBin = ffmpegBin;
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
  }

  async createOrGetSession({
    sourceKey,
    fileIndex,
    transcodeVideo = false,
    transcodeAudio = false,
    consumerId = "",
    fileName = "",
    targetWidth = 0,
    targetHeight = 0
  }) {
    if (!this.enabled) {
      const error = new Error("Audio transcoding is disabled on this proxy.");
      error.code = "TRANSCODE_DISABLED";
      throw error;
    }

    const normalizedTargetWidth = Number.isInteger(targetWidth) && targetWidth > 0 ? targetWidth : 0;
    const normalizedTargetHeight = Number.isInteger(targetHeight) && targetHeight > 0 ? targetHeight : 0;
    const sourceMapKey = [
      sourceKey,
      String(fileIndex),
      transcodeVideo ? "video" : "audio",
      transcodeAudio ? "a1" : "a0",
      String(normalizedTargetWidth),
      String(normalizedTargetHeight)
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
    const sessionDir = createSessionDirPath(sessionId);
    await mkdir(sessionDir, { recursive: true });
    const inputUrl = new URL("/stream", `${this.localBaseUrl}/`);
    inputUrl.searchParams.set("sourceKey", sourceKey);
    inputUrl.searchParams.set("fileIndex", String(fileIndex));
    const durationSeconds = await probeInputDurationSeconds(this.ffmpegBin, inputUrl.toString());

    const videoCodecArgs = transcodeVideo
      ? [
          "-vf",
          this.#buildVideoFilter(normalizedTargetWidth, normalizedTargetHeight),
          "-c:v",
          "libx264",
          "-preset",
          VIDEO_TRANSCODE_PRESET,
          "-crf",
          VIDEO_TRANSCODE_CRF,
          "-pix_fmt",
          "yuv420p"
        ]
      : ["-c:v", "copy"];
    const audioCodecArgs = transcodeAudio
      ? ["-c:a", "aac", "-ac", "2", "-b:a", "128k"]
      : ["-c:a", "copy"];

    const args = [
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "error",
      "-progress",
      "pipe:1",
      "-i",
      inputUrl.toString(),
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      ...videoCodecArgs,
      ...audioCodecArgs,
      "-f",
      "hls",
      "-hls_time",
      String(this.segmentDurationSec),
      "-hls_list_size",
      "0",
      "-hls_playlist_type",
      "vod",
      "-hls_flags",
      "independent_segments+temp_file",
      "-hls_segment_filename",
      "segment-%05d.ts",
      PLAYLIST_FILE_NAME
    ];

    const ffmpeg = spawn(this.ffmpegBin, args, {
      cwd: sessionDir,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const session = {
      id: sessionId,
      sourceMapKey,
      fileName: normalizeLogFileName(fileName, fileIndex),
      dirPath: sessionDir,
      state: "starting",
      startedAt: Date.now(),
      lastAccessedAt: Date.now(),
      ffmpeg,
      lastError: "",
      consumers: new Set(consumerId ? [consumerId] : []),
      progress: {
        state: "starting",
        processedSeconds: 0,
        totalSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
        percent: null,
        remainingSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
        speed: "",
        updatedAt: Date.now(),
        lastLoggedAt: 0
      }
    };
    this.sessionsById.set(sessionId, session);
    this.sessionIdBySource.set(sourceMapKey, sessionId);

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
            session.progress.processedSeconds = numeric / MICROSECONDS_PER_SECOND;
          }
        } else if (key === "out_time") {
          const parsed = parseFfmpegTimestamp(value);
          if (parsed != null) {
            session.progress.processedSeconds = parsed;
          }
        } else if (key === "speed") {
          session.progress.speed = value;
        } else if (key === "progress") {
          session.progress.state = value === "end" ? "ready" : "running";
        }
        const metrics = computeProgressMetrics(
          session.progress.processedSeconds,
          session.progress.totalSeconds
        );
        session.progress.percent = metrics.percent;
        session.progress.remainingSeconds = metrics.remainingSeconds;
        session.progress.updatedAt = Date.now();
        const shouldLog =
          session.progress.percent != null &&
          session.progress.updatedAt - session.progress.lastLoggedAt >= PROGRESS_LOG_INTERVAL_MS;
        if (shouldLog) {
          session.progress.lastLoggedAt = session.progress.updatedAt;
          console.log(
            `[proxy-client] transcode ${session.id} "${session.fileName}" ${session.progress.percent.toFixed(1)}% ` +
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
        console.warn(`[proxy-client] ffmpeg: ${line}`);
      }
    });

    ffmpeg.on("error", (error) => {
      session.state = "failed";
      session.lastError = error instanceof Error ? error.message : String(error);
      session.progress.state = "failed";
      session.progress.updatedAt = Date.now();
      console.error(`[proxy-client] ffmpeg process error: ${session.lastError}`);
    });

    ffmpeg.on("exit", (code) => {
      if (session.state === "disposed") {
        return;
      }
      if (code === 0) {
        session.state = "ready";
        session.progress.state = "ready";
        session.progress.updatedAt = Date.now();
        return;
      }
      session.state = "failed";
      session.progress.state = "failed";
      session.progress.updatedAt = Date.now();
      if (!session.lastError) {
        session.lastError = `ffmpeg exited with code ${code ?? -1}`;
      }
    });

    try {
      await this.waitUntilReady(session);
      return session;
    } catch (error) {
      if (session.state === "failed") {
        await this.disposeSession(session.id);
        throw error;
      }
      // Do not fail session creation on warmup timeout; playlist can appear later.
      return session;
    }
  }

  #buildVideoFilter(targetWidth, targetHeight) {
    const safeWidth = Number.isInteger(targetWidth) && targetWidth > 0 ? targetWidth : 1280;
    const safeHeight = Number.isInteger(targetHeight) && targetHeight > 0 ? targetHeight : 720;
    return `scale=${safeWidth}:${safeHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${VIDEO_TRANSCODE_FPS}`;
  }

  async waitUntilReady(session) {
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

  async getFileStream(sessionId, fileName) {
    if (!isSafeSessionId(sessionId) || !isSafeFileName(fileName)) {
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
    const filePath = path.join(session.dirPath, fileName);
    try {
      await access(filePath);
    } catch (_error) {
      return { kind: "warming-up" };
    }
    return {
      kind: "file",
      stream: createReadStream(filePath),
      contentType:
        fileName === PLAYLIST_FILE_NAME
          ? "application/vnd.apple.mpegurl"
          : "video/mp2t",
      isPlaylist: fileName === PLAYLIST_FILE_NAME
    };
  }

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

  getSessionProgress(sessionId) {
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
    return {
      sessionId: session.id,
      state: session.progress.state,
      processedSeconds: session.progress.processedSeconds,
      totalSeconds: session.progress.totalSeconds,
      percent: session.progress.percent,
      remainingSeconds: session.progress.remainingSeconds,
      warmupPercent,
      warmupRemainingSeconds,
      speed: session.progress.speed,
      updatedAt: session.progress.updatedAt,
      error: session.state === "failed" ? session.lastError : ""
    };
  }

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
    console.log(
      `[proxy-client] consumer released (${logReason}) session=${session.id} consumer=${consumerId} ` +
        `remaining=${session.consumers.size}`
    );
    if (session.consumers.size > 0) {
      return true;
    }
    await this.disposeSession(sessionId);
    return true;
  }

  async disposeSession(sessionId) {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return;
    }
    session.state = "disposed";
    this.sessionsById.delete(sessionId);
    this.sessionIdBySource.delete(session.sourceMapKey);

    if (session.ffmpeg && !session.ffmpeg.killed) {
      session.ffmpeg.kill("SIGTERM");
      await waitForChildExit(session.ffmpeg);
    }
    try {
      await rm(session.dirPath, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[proxy-client] failed to cleanup HLS temp dir: ${message}`);
    }
  }

  async disposeAll() {
    clearInterval(this.cleanupTimer);
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
