#!/usr/bin/env node
/**
 * @file CLI entry point for the torrent-tv proxy.
 *
 * Parses command-line arguments, starts the local HTTP server, registers
 * this proxy with the registry server, establishes the WebSocket tunnel,
 * and maintains a periodic heartbeat.
 */

import { Command } from "commander";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import { startProxyServer } from "../server.js";
import { registerClient, sendHeartbeat } from "../services/registry-api.js";
import { createTunnelClient } from "../services/tunnel-client.js";
import { logger } from "../utils/logger.js";

const program = new Command();

const HELP_EXAMPLES = `
Examples:
  torrent-tv-proxy --server-url http://localhost:8080
  torrent-tv-proxy --server-url http://localhost:8080 --host 0.0.0.0 --port 9090
  torrent-tv-proxy --server-url http://localhost:8080 --public-base-url https://proxy.example.com
  torrent-tv-proxy --server-url http://localhost:8080 --ffmpeg-bin /usr/local/bin/ffmpeg
  torrent-tv-proxy --server-url http://localhost:8080 --no-transcode-audio

Notes:
  - --help prints this message and exits with code 0.
  - Video transcode is available automatically for per-session fallback when requested by client API.
`;

if (process.argv.includes("help")) {
  process.argv = [process.argv[0], process.argv[1], "--help"];
}

program
  .name("torrent-proxy-client")
  .description("Expose torrent files over HTTP stream endpoints for browser playback.")
  .requiredOption("--server-url <url>", "Registry server base URL")
  .option("--public-base-url <url>", "Direct URL advertised to browser clients")
  .option("--host <host>", "Local bind host", "127.0.0.1")
  .option("--port <port>", "Local HTTP port", "9090")
  .option("--id <id>", "Stable client id")
  .option("--name <name>", "Display name")
  .option("--no-transcode-audio", "Disable optional HLS AAC audio transcoding")
  .option("--ffmpeg-bin <path>", "Path to ffmpeg binary")
  .option("--token <token>", "Registration token", "")
  .addHelpText("after", HELP_EXAMPLES);

program.parse(process.argv);
const options = program.opts();

const localPort = Number(options.port);
if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) {
  logger.error("Invalid --port value.");
  process.exit(1);
}

const serverUrl = String(options.serverUrl).replace(/\/+$/, "");
const bindHost = String(options.host);
const explicitBaseUrl = options.publicBaseUrl
  ? String(options.publicBaseUrl).replace(/\/+$/, "")
  : "";
const clientId = options.id ? String(options.id) : crypto.randomUUID();
const clientName = options.name ? String(options.name) : `proxy-${clientId.slice(0, 8)}`;
const token = String(options.token ?? "");
const transcodeAudio = options.transcodeAudio !== false;
const bundledFfmpegBin = typeof ffmpegStatic === "string" ? ffmpegStatic : "";
const ffmpegBin = options.ffmpegBin ? String(options.ffmpegBin) : bundledFfmpegBin || "ffmpeg";

/**
 * Verify that the ffmpeg binary is reachable and exits cleanly.
 * Throws with a descriptive message when the check fails.
 *
 * @returns {void}
 */
function assertFfmpegAvailability() {
  const probe = spawnSync(ffmpegBin, ["-version"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 5000
  });
  if (probe.error) {
    const message = probe.error instanceof Error ? probe.error.message : String(probe.error);
    throw new Error(`Audio transcode is enabled, but ffmpeg is unavailable (${ffmpegBin}): ${message}`);
  }
  if (typeof probe.status === "number" && probe.status !== 0) {
    throw new Error(
      `Audio transcode is enabled, but ffmpeg check failed (${ffmpegBin}, exit code ${probe.status}).`
    );
  }
}

/** @type {boolean} */
let registrationInProgress = false;

/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatTimer = null;

/** @type {import("fastify").FastifyInstance | null} */
let app = null;

/** @type {number} */
let actualPort = localPort;

/** @type {boolean} */
let shutdownInProgress = false;

/** @type {ReturnType<typeof import("../services/tunnel-client.js").createTunnelClient> | null} */
let tunnelClient = null;

/**
 * Register this proxy with the registry server.
 * Silently skips if a registration is already in flight.
 *
 * @returns {Promise<void>}
 */
async function registerClientSafe() {
  if (registrationInProgress) {
    return;
  }
  registrationInProgress = true;
  try {
    const result = await registerClient({
      serverUrl,
      id: clientId,
      name: clientName,
      baseUrl: explicitBaseUrl || `http://${bindHost}:${actualPort}`,
      token
    });
    logger.success(`Registered: ${JSON.stringify(result.client)}`);
  } finally {
    registrationInProgress = false;
  }
}

/**
 * Gracefully shut down the tunnel, heartbeat timer, and HTTP server.
 *
 * @param {string} signal - Signal name (e.g. "SIGINT").
 * @returns {Promise<void>}
 */
async function shutdown(signal) {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (tunnelClient) {
    tunnelClient.disconnect();
    tunnelClient = null;
  }
  logger.warn(`Received ${signal}, shutting down...`);
  try {
    if (app) {
      await app.close();
    }
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Shutdown failed: ${message}`);
    process.exit(1);
  }
}

try {
  if (transcodeAudio) {
    assertFfmpegAvailability();
  }
  const started = await startProxyServer({
    host: bindHost,
    port: localPort,
    transcodeAudio,
    ffmpegBin
  });
  app = started.app;
  actualPort = started.port;
  const directBaseUrl = explicitBaseUrl || `http://${bindHost}:${actualPort}`;

  logger.info(`Local stream endpoint: http://${bindHost}:${actualPort}/stream`);
  logger.info(`Advertised direct URL: ${directBaseUrl}`);
  if (transcodeAudio) {
    logger.info(`Optional HLS audio transcode is enabled (ffmpeg: ${ffmpegBin}).`);
  }

  await registerClientSafe();

  tunnelClient = createTunnelClient({
    serverUrl,
    proxyId: clientId,
    token,
    proxyPort: actualPort,
    onLog: (msg) => logger.info(msg)
  });
  tunnelClient.connect();

  heartbeatTimer = setInterval(async () => {
    const status = await sendHeartbeat({
      serverUrl,
      id: clientId,
      token
    });
    if (status === 404) {
      logger.warn("Heartbeat returned 404, re-registering...");
      try {
        await registerClientSafe();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Re-register failed: ${message}`);
      }
    }
  }, 20_000);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(message);
  process.exit(1);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
