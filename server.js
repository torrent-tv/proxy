/**
 * @file Proxy HTTP server bootstrap.
 *
 * Creates and configures the Fastify application, registers all routes and
 * plugins, then starts listening on the first available port at or above the
 * requested one.
 */

import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import getPort from "get-port";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { handleHealthGet } from "./routes/health/get.js";
import { handleHealthzGet } from "./routes/healthz/get.js";
import { handleApiSourcesPost } from "./routes/api/sources/post.js";
import { handleApiSourceStatsGet } from "./routes/api/sources/stats/get.js";
import { handleApiSourceFilesGet } from "./routes/api/sources/files/get.js";
import { handleApiSourceWarmPost } from "./routes/api/sources/warm/post.js";
import { handleApiPlaybackPlanPost } from "./routes/api/playback-plan/post.js";
import { handleApiSubtitlesGet } from "./routes/api/subtitles/get.js";
import { handleApiTranscodeSessionsPost } from "./routes/api/transcode-sessions/post.js";
import { handleApiTranscodeSessionsProgressGet } from "./routes/api/transcode-sessions/progress/get.js";
import { handleApiTranscodeSessionReleasePost } from "./routes/api/transcode-sessions/release/post.js";
import { handleApiTranscodeSessionNetReportPost } from "./routes/api/transcode-sessions/net-report/post.js";
import { handleApiTranscodeSessionFragmentFarPost } from "./routes/api/transcode-sessions/fragment-far/post.js";
import { handleApiTranscodeSessionSeekPost } from "./routes/api/transcode-sessions/seek/post.js";
import { handleStreamGet } from "./routes/stream/get.js";
import { handleTranscodeSessionFileGet } from "./routes/transcode/session-file/get.js";
import { handleTranscodeVariantFileGet } from "./routes/transcode/variant-file/get.js";
import { handleTranscodeAudioFileGet } from "./routes/transcode/audio-file/get.js";
import { handleTranscodeVariantWarmGet } from "./routes/transcode/variant-warm/get.js";
import { handleTranscodeAudioWarmGet } from "./routes/transcode/audio-warm/get.js";
import { createSourceRegistry } from "./store/source-registry.js";
import { WorkerTorrentPool } from "./services/torrent-worker/pool-adapter.js";
import { HlsSessionManager } from "./services/hls-session-manager.js";
import { createPlaybackPlanner } from "./services/playback-planner.js";
import { detectVideoEncoder, benchmarkSoftwarePresets, benchmarkDecodeCost, benchmarkContention, detectTonemapSupport } from "./services/hwaccel.js";
import { logger } from "./utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const { version } = require("./package.json");
const publicRoot = path.resolve(__dirname, "./public");

/**
 * Build a list of candidate port numbers starting at `startPort`.
 *
 * @param {number} startPort
 * @param {number} [maxAttempts=51]
 * @returns {number[]}
 */
function buildPortCandidates(startPort, maxAttempts = 51) {
  const ports = [];
  for (let index = 0; index < maxAttempts; index += 1) {
    ports.push(startPort + index);
  }
  return ports;
}

/**
 * @typedef {Object} ProxyServerOptions
 * @property {string}  host           - Bind host (e.g. "127.0.0.1" or "0.0.0.0").
 * @property {number}  port           - Preferred listen port.
 * @property {boolean} transcodeAudio - Whether HLS audio transcoding is enabled.
 * @property {string}  ffmpegBin      - Path to the ffmpeg executable.
 * @property {number}  [maxDiskBytes] - Global disk cap for torrent data (undefined = pool default).
 * @property {number}  [memoryBytes]  - Per-torrent budget for pieces held in memory (undefined = store default).
 * @property {string}  [segmentFormat] - HLS output container: "fmp4" (default) or "mpegts".
 * @property {string}  [stateDir] - Where to keep what this host has measured about itself.
 */

/**
 * Create, configure, and start the proxy HTTP server.
 *
 * @param {ProxyServerOptions} options
 * @returns {Promise<{ app: import("fastify").FastifyInstance, port: number }>}
 */
export async function startProxyServer({
  host, port, transcodeAudio, ffmpegBin, maxDiskBytes, memoryBytes, segmentFormat, stateDir, onSubtitleCues
}) {
  const app = Fastify({
    // No practical body-size limit — the proxy server is localhost-only and
    // receives torrent source payloads that may be arbitrarily large.
    bodyLimit: 256 * 1024 * 1024 // 256 MB
  });

  await app.register(fastifyHelmet, {
    // Proxy serves media to a different origin (registry UI), so CORP must allow cross-origin usage.
    crossOriginResourcePolicy: {
      policy: "cross-origin"
    }
  });
  await app.register(fastifyCors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Range"]
  });

  // Allow browser requests from an HTTPS page to this private-network proxy
  // without triggering Chromium's Private Network Access permission prompt.
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Access-Control-Allow-Private-Network", "true");
  });

  const sourceRegistry = createSourceRegistry(200);
  // The torrent runs on its own thread. Profiling a live seek (2026-08-02)
  // found the main thread ~85% occupied by WebTorrent — buffer concatenation
  // ~15%, wire updates ~9%, garbage collection ~5% — while three of four cores
  // idled. Serving a segment shared that thread, so reading an already-finished
  // 10 MB file took 12-23 s against 125 ms to hand it to the channel. The
  // adapter keeps TorrentPool's interface, so nothing downstream changed.
  const torrentPool = new WorkerTorrentPool({ maxDiskBytes, memoryBytes, onSubtitleCues });
  const selectedPort = await getPort({
    port: buildPortCandidates(port)
  });
  // Auto-detect the best available H.264 encoder (hardware-accelerated or
  // software) once at startup, with a real test-encode and graceful fallback.
  // Only needed when transcoding can occur.
  const videoEncoder = transcodeAudio
    ? await detectVideoEncoder({ ffmpegBin, logger })
    : null;
  // For software libx264, benchmark preset throughput once at startup so the
  // session manager can pick the highest-quality preset that still encodes each
  // stream faster than realtime. Hardware encoders use their own fixed preset.
  // The decode model first, and the preset benchmark second — they are
  // independent now (the presets are timed on raw frames), but the order costs
  // nothing and keeps the two figures side by side in the log.
  const decodeCostModel = videoEncoder?.kind === "software"
    ? await benchmarkDecodeCost({ ffmpegBin, logger })
    : null;
  // What a second job costs on this host. Measured because the budget adds
  // independent prices and this host says two jobs that each fit alone do not
  // fit together — 2.6× on the addon box (2026-08-18).
  const contentionPenalties = videoEncoder?.kind === "software"
    ? await benchmarkContention({ ffmpegBin, logger })
    : null;
  const softwarePresetBenchmark = videoEncoder?.kind === "software"
    ? await benchmarkSoftwarePresets({ ffmpegBin, logger })
    : null;
  // Whether this ffmpeg build can tone-map HDR→SDR (zscale + tonemap filters).
  // Detected once; the session manager applies the tonemap chain only for HDR
  // sources on the software path when available.
  const tonemapSupported = transcodeAudio
    ? await detectTonemapSupport({ ffmpegBin, logger })
    : false;
  const hlsSessionManager = new HlsSessionManager({
    enabled: transcodeAudio,
    ffmpegBin,
    localBindHost: host,
    localPort: selectedPort,
    videoEncoder,
    softwarePresetBenchmark,
    decodeCostModel,
    contentionPenalties,
    tonemapSupported,
    segmentFormatId: segmentFormat,
    stateDir,
    // Live download stats accessor for the realtime budget: lets it tell a
    // CPU-bound transcode from a download-starved input before downscaling.
    // What every torrent here has moved, so the proxy can price its own
    // downloading, hashing and delivery against the machine (roadmap item 7).
    getTorrentTotals: async () => {
      if (typeof torrentPool.getTorrentTotals !== "function") {
        return null;
      }
      return torrentPool.getTorrentTotals();
    },
    getSourceStats: async (sourceKey, fileIndex) => {
      const record = sourceRegistry.get(sourceKey);
      if (!record) {
        return null;
      }
      try {
        const torrent = await torrentPool.getTorrent(record.sourceType, record.source);
        // Awaited for the same reason as the stats route: this now crosses a
        // thread boundary and returns a promise.
        return await torrentPool.getFileStats(torrent, Number.isInteger(fileIndex) ? fileIndex : null);
      } catch {
        return null;
      }
    },
    // Reuse the media info the planner already probed for this file (same
    // ffmpeg scan) so createSession skips its own probe. Late-bound: invoked
    // only at session-create time, after playbackPlanner is initialised.
    getCachedMediaInfo: (params) => playbackPlanner.getCachedMediaInfo(params),
    // The file's audio tracks, for the master playlist's rendition group. Already
    // probed for the browser's audio menu; read from there rather than probed again.
    getCachedAudioTracks: (params) => playbackPlanner.getCachedAudioTracks(params)
  });
  const playbackPlanner = createPlaybackPlanner({
    ffmpegBin,
    transcodeAudioEnabled: transcodeAudio,
    localBaseUrl: hlsSessionManager.localBaseUrl,
    sourceRegistry,
    torrentPool,
    warmKeyframeIndex: (params) => hlsSessionManager.warmKeyframeIndex(params),
    expectedFirstSegmentMs: () => hlsSessionManager.expectedFirstSegmentMs(),
    expectedSessionCreateMs: () => hlsSessionManager.expectedSessionCreateMs(),
    // The quality menu is on screen from the moment a file is opened, so the
    // heights this host can actually serve have to be answerable before any
    // encoder exists — from the probe and the startup benchmarks alone.
    predictOfferedHeights: (mediaInfo) => hlsSessionManager.predictOfferedHeights(mediaInfo)
  });

  app.get("/health", async (req, reply) => handleHealthGet(req, reply, { version }));
  app.get("/healthz", async (req, reply) => handleHealthzGet(req, reply, { version }));
  app.post("/api/sources", async (req, reply) =>
    handleApiSourcesPost(req, reply, { sourceRegistry })
  );
  app.get("/api/sources/:sourceKey/stats", async (req, reply) =>
    handleApiSourceStatsGet(req, reply, { sourceRegistry, torrentPool })
  );
  app.get("/api/sources/:sourceKey/files", async (req, reply) =>
    handleApiSourceFilesGet(req, reply, { sourceRegistry, torrentPool })
  );
  app.post("/api/sources/:sourceKey/warm", async (req, reply) =>
    handleApiSourceWarmPost(req, reply, { sourceRegistry, torrentPool })
  );
  app.post("/api/playback-plan", async (req, reply) =>
    handleApiPlaybackPlanPost(req, reply, { playbackPlanner })
  );
  app.get("/api/subtitles", async (req, reply) =>
    handleApiSubtitlesGet(req, reply, {
      sourceRegistry,
      torrentPool,
      ffmpegBin,
      localBaseUrl: hlsSessionManager.localBaseUrl
    })
  );
  app.get("/stream", async (req, reply) =>
    handleStreamGet(req, reply, { sourceRegistry, torrentPool })
  );
  app.post("/api/transcode-sessions", async (req, reply) =>
    handleApiTranscodeSessionsPost(req, reply, { hlsSessionManager, sourceRegistry, torrentPool })
  );
  app.post("/api/transcode-sessions/:sessionId/release", async (req, reply) =>
    handleApiTranscodeSessionReleasePost(req, reply, { hlsSessionManager })
  );
  app.get("/api/transcode-sessions/:sessionId/progress", async (req, reply) =>
    handleApiTranscodeSessionsProgressGet(req, reply, { hlsSessionManager })
  );
  app.post("/api/transcode-sessions/:sessionId/net-report", async (req, reply) =>
    handleApiTranscodeSessionNetReportPost(req, reply, { hlsSessionManager })
  );
  app.post("/api/transcode-sessions/:sessionId/fragment-far", async (req, reply) =>
    handleApiTranscodeSessionFragmentFarPost(req, reply, { hlsSessionManager })
  );
  app.post("/api/transcode-sessions/:sessionId/seek", async (req, reply) =>
    handleApiTranscodeSessionSeekPost(req, reply, { hlsSessionManager })
  );
  app.get("/transcode/:sessionId/:fileName", async (req, reply) =>
    handleTranscodeSessionFileGet(req, reply, { hlsSessionManager })
  );
  // A quality variant's files. Registered before the static handler for the
  // same reason as the line above, and kept a separate route rather than a
  // wildcard so the height stays a parsed parameter.
  // Registered BEFORE the variant file route: `warm` is not a file name, and
  // Fastify matches a static segment ahead of a parameter either way — stated
  // here so the order is not "tidied" into a bug.
  app.get("/transcode/:sessionId/v/:height/warm", async (req, reply) =>
    handleTranscodeVariantWarmGet(req, reply, { hlsSessionManager })
  );
  app.get("/transcode/:sessionId/a/:track/warm", async (req, reply) =>
    handleTranscodeAudioWarmGet(req, reply, { hlsSessionManager })
  );
  app.get("/transcode/:sessionId/a/:trackIndex/:fileName", async (req, reply) =>
    handleTranscodeAudioFileGet(req, reply, { hlsSessionManager })
  );
  app.get("/transcode/:sessionId/v/:height/:fileName", async (req, reply) =>
    handleTranscodeVariantFileGet(req, reply, { hlsSessionManager })
  );
  await app.register(fastifyStatic, {
    root: publicRoot,
    prefix: "/",
    serveDotFiles: true
  });

  app.addHook("onClose", async () => {
    // Order matters: stop the ffmpeg readers (HLS sessions) before destroying
    // the torrents whose files they read from, then remove the torrent data.
    await hlsSessionManager.disposeAll();
    await torrentPool.destroyAll();
  });

  await app.listen({ host, port: selectedPort });
  return {
    app,
    port: selectedPort
  };
}
