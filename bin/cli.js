#!/usr/bin/env node
/**
 * @file CLI entry point for the torrent-tv proxy.
 *
 * Parses command-line arguments, starts the local HTTP server, opens a
 * persistent WebSocket tunnel to the registry server, and registers this
 * proxy. Liveness is tracked via the tunnel connection — the proxy re-registers
 * automatically on reconnect so the server's in-memory store stays consistent.
 */

import { Command } from "commander";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import ffmpegStatic from "ffmpeg-static";
import { startProxyServer } from "../server.js";
import { registerClient } from "../services/registry-api.js";
import { createTunnelClient } from "../services/tunnel-client.js";
import { createWebRtcManager } from "../services/webrtc-manager.js";
import { createDataChannelHandler } from "../services/data-channel-handler.js";
import { collectHealthMetrics } from "../services/health-collector.js";
import { createPortMapper } from "../services/port-mapper.js";
import { classifyNat } from "../services/nat-classifier.js";
import { logger } from "../utils/logger.js";

const require = createRequire(import.meta.url);
const { version: PROXY_VERSION } = require("../package.json");

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
  .option("--no-port-mapping", "Disable automatic UPnP/NAT-PMP port mapping")
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
const portMappingEnabled = options.portMapping !== false;
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

/** @type {import("fastify").FastifyInstance | null} */
let app = null;

/** @type {number} */
let actualPort = localPort;

/** @type {boolean} */
let shutdownInProgress = false;

/** @type {ReturnType<typeof createTunnelClient> | null} */
let tunnelClient = null;

/** @type {ReturnType<typeof createPortMapper> | null} */
let portMapper = null;

/** @type {ReturnType<typeof createPortMapper> | null} UDP mapping for the WebRTC port. */
let udpPortMapper = null;


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
    logger.success(`Registered as "${result.client?.name}" (${result.client?.id?.slice(0, 8)})`);
  } finally {
    registrationInProgress = false;
  }
}

/**
 * Register this proxy with the registry server, retrying indefinitely
 * with exponential backoff until it succeeds. This allows the proxy to
 * survive temporary server outages (restarts, deployments) without crashing.
 *
 * @returns {Promise<void>}
 */
async function registerWithRetry() {
  const MAX_DELAY_MS = 60_000;
  let delayMs = 2_000;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await registerClientSafe();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Registration attempt ${attempt} failed: ${message}. Retrying in ${delayMs / 1000}s…`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
    }
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
  if (tunnelClient) {
    tunnelClient.disconnect();
    tunnelClient = null;
  }
  logger.warn(`Received ${signal}, shutting down...`);
  try {
    // Remove the router port mappings before exiting (lease expiry is the
    // backstop if this is skipped on a hard kill).
    if (portMapper) {
      await portMapper.stop();
      portMapper = null;
    }
    if (udpPortMapper) {
      await udpPortMapper.stop();
      udpPortMapper = null;
    }
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

  logger.info(`Starting @torrent-tv/proxy v${PROXY_VERSION}`);
  logger.info(`Local stream endpoint: http://${bindHost}:${actualPort}/stream`);
  logger.info(`Advertised direct URL: ${directBaseUrl}`);
  if (transcodeAudio) {
    logger.info(`Optional HLS audio transcode is enabled (ffmpeg: ${ffmpegBin}).`);
  }

  // Try to open the local port on the home router (UPnP/NAT-PMP) so the proxy
  // is reachable from the internet without manual port forwarding. Best-effort
  // and fire-and-forget: failure is normal (router without UPnP) and must not
  // delay tunnel connect / registration, so we do not await it.
  if (portMappingEnabled) {
    portMapper = createPortMapper({ port: actualPort, protocol: "TCP" });
    void portMapper
      .start()
      .then(() => {
        // Mapping may finish after the tunnel is already connected; report the
        // endpoint now. If the tunnel is not open yet, onConnect re-sends it.
        const endpoint = portMapper?.getMappedEndpoint();
        if (endpoint) {
          tunnelClient?.sendEndpoint(endpoint);
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Port mapping failed to start: ${message}`);
      });

    // Also map the WebRTC UDP port (same number, different protocol). All
    // WebRTC sessions are multiplexed onto this single UDP port (ICE UDP mux),
    // so a static mapping makes the proxy's WebRTC path reachable even behind
    // symmetric NAT. This endpoint is NOT reported to the server: the browser
    // discovers it via ICE (srflx) candidates, not the TCP dial-back probe.
    udpPortMapper = createPortMapper({
      port: actualPort,
      protocol: "UDP",
      description: "torrent-tv proxy (WebRTC)"
    });
    void udpPortMapper.start().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`UDP port mapping failed to start: ${message}`);
    });
  } else {
    logger.info("Automatic port mapping is disabled (--no-port-mapping).");
  }

  // Classify the home NAT (diagnostic + decides whether WebRTC will need port
  // prediction for remote viewers). Best-effort, fire-and-forget — STUN probes
  // never block startup.
  void classifyNat()
    .then((nat) => {
      if (nat.klass === "endpoint-independent") {
        logger.info(
          `nat: endpoint-independent (cone) — external UDP port stable across STUN servers (${nat.externalIp}); fixed-port WebRTC mapping is sufficient, no port prediction needed`
        );
      } else if (nat.klass === "symmetric") {
        logger.warn(
          `nat: SYMMETRIC — external UDP port varies per destination (delta ${nat.portDelta}); WebRTC will need port prediction to reach remote viewers`
        );
      } else {
        logger.info("nat: classification inconclusive (STUN probes failed); continuing");
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`nat classification failed: ${message}`);
    });

  // Create tunnel + WebRTC manager.
  // The tunnel forwards WebRTC signals between browser (via server) and this proxy.
  // The WebRTC manager handles the actual peer connection and data channel.
  //
  // We use a late-binding ref so both objects can reference each other without
  // running into the TDZ (tunnelClient is declared above; webRtcManager uses let
  // so the closure in createTunnelClient can call it after both are initialised).
  /** @type {ReturnType<typeof createWebRtcManager> | null} */
  let webRtcManager = null;

  tunnelClient = createTunnelClient({
    serverUrl,
    proxyId: clientId,
    token,
    proxyPort: actualPort,
    onSignal(sessionId, signal) {
      webRtcManager?.handleSignal(sessionId, signal);
    },
    onHealthRequest() {
      return collectHealthMetrics();
    },
    onConnect() {
      // Re-register on every tunnel connect/reconnect so the server's
      // in-memory store stays consistent after server restarts.
      void registerClientSafe().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Re-registration after tunnel connect failed: ${message}`);
      });
      // Re-report the mapped endpoint on every (re)connect — the server's
      // in-memory reachability state resets on restart, and the mapping may
      // have completed before this connection existed.
      const endpoint = portMapper?.getMappedEndpoint();
      if (endpoint) {
        tunnelClient?.sendEndpoint(endpoint);
      }
    },
    onLog: (message) => logger.info(message)
  });

  const dataChannelHandler = createDataChannelHandler({
    proxyPort: actualPort,
    onLog: (message) => logger.info(message)
  });

  webRtcManager = createWebRtcManager({
    // Pin all WebRTC sessions to this single UDP port (multiplexed via ICE UDP
    // mux) so the UPnP UDP mapping above makes the WebRTC path reachable.
    udpPort: actualPort,
    sendSignal(sessionId, signal) {
      tunnelClient?.sendSignal(sessionId, signal);
    },
    onDataChannel(sessionId, channel) {
      dataChannelHandler.handleChannel(sessionId, channel);
    },
    onLog: (message) => logger.info(message)
  });

  tunnelClient.connect();

  await registerWithRetry();
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
