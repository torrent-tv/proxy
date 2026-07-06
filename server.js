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
import { handleApiPlaybackPlanPost } from "./routes/api/playback-plan/post.js";
import { handleApiTranscodeSessionsPost } from "./routes/api/transcode-sessions/post.js";
import { handleApiTranscodeSessionsProgressGet } from "./routes/api/transcode-sessions/progress/get.js";
import { handleApiTranscodeSessionReleasePost } from "./routes/api/transcode-sessions/release/post.js";
import { handleStreamGet } from "./routes/stream/get.js";
import { handleTranscodeSessionFileGet } from "./routes/transcode/session-file/get.js";
import { createSourceRegistry } from "./store/source-registry.js";
import { TorrentPool } from "./services/torrent-pool.js";
import { HlsSessionManager } from "./services/hls-session-manager.js";
import { createPlaybackPlanner } from "./services/playback-planner.js";
import { detectVideoEncoder, benchmarkSoftwarePresets } from "./services/hwaccel.js";
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
 */

/**
 * Create, configure, and start the proxy HTTP server.
 *
 * @param {ProxyServerOptions} options
 * @returns {Promise<{ app: import("fastify").FastifyInstance, port: number }>}
 */
export async function startProxyServer({ host, port, transcodeAudio, ffmpegBin }) {
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
  const torrentPool = new TorrentPool();
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
  const softwarePresetBenchmark = videoEncoder?.kind === "software"
    ? await benchmarkSoftwarePresets({ ffmpegBin, logger })
    : null;
  const hlsSessionManager = new HlsSessionManager({
    enabled: transcodeAudio,
    ffmpegBin,
    localBindHost: host,
    localPort: selectedPort,
    videoEncoder,
    softwarePresetBenchmark
  });
  const playbackPlanner = createPlaybackPlanner({
    ffmpegBin,
    transcodeAudioEnabled: transcodeAudio,
    localBaseUrl: hlsSessionManager.localBaseUrl,
    sourceRegistry,
    torrentPool
  });

  app.get("/health", async (req, reply) => handleHealthGet(req, reply, { version }));
  app.get("/healthz", async (req, reply) => handleHealthzGet(req, reply, { version }));
  app.post("/api/sources", async (req, reply) =>
    handleApiSourcesPost(req, reply, { sourceRegistry })
  );
  app.get("/api/sources/:sourceKey/stats", async (req, reply) =>
    handleApiSourceStatsGet(req, reply, { sourceRegistry, torrentPool })
  );
  app.post("/api/playback-plan", async (req, reply) =>
    handleApiPlaybackPlanPost(req, reply, { playbackPlanner })
  );
  app.get("/stream", async (req, reply) =>
    handleStreamGet(req, reply, { sourceRegistry, torrentPool })
  );
  app.post("/api/transcode-sessions", async (req, reply) =>
    handleApiTranscodeSessionsPost(req, reply, { hlsSessionManager })
  );
  app.post("/api/transcode-sessions/:sessionId/release", async (req, reply) =>
    handleApiTranscodeSessionReleasePost(req, reply, { hlsSessionManager })
  );
  app.get("/api/transcode-sessions/:sessionId/progress", async (req, reply) =>
    handleApiTranscodeSessionsProgressGet(req, reply, { hlsSessionManager })
  );
  app.get("/transcode/:sessionId/:fileName", async (req, reply) =>
    handleTranscodeSessionFileGet(req, reply, { hlsSessionManager })
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
