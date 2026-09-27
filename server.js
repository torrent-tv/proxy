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
import { handleApiDeliverySinkGet } from "./routes/api/delivery-sink/get.js";
import { handleApiLinkProbeGet } from "./routes/api/link-probe/get.js";
import { handleApiSourcesPost } from "./routes/api/sources/post.js";
import { handleApiSourceStatsGet } from "./routes/api/sources/stats/get.js";
import { handleApiSourceFilesGet } from "./routes/api/sources/files/get.js";
import { handleApiSourceWarmPost } from "./routes/api/sources/warm/post.js";
import { handleApiPlaybackPlanPost } from "./routes/api/playback-plan/post.js";
import { handleApiClientLogsPost } from "./routes/api/client-logs/post.js";
import { createClientLogFiles } from "./utils/client-log-file.js";
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
import { WorkerTorrentPool } from "./services/torrent/worker/pool-adapter.js";
import { wireOutputs } from "./services/server/wire-outputs.js";
import { createPlaybackPlanner } from "./services/media/playback-planner.js";
import { KeyframeTables } from "./services/media/KeyframeTables.js";
import { contentsOf } from "./services/torrent/Contents.js";
import { SubtitleOrchestrator } from "./services/media/SubtitleOrchestrator.js";
import { containerOrchestrator, CONTAINER_HEAD_BYTES } from "./services/media/ContainerOrchestrator.js";
import {
  warmSubtitleCues,
  cuesHeldFor,
  subtitleTracksOf,
  declaredSubtitleTracksOf,
  forgetSubtitles
} from "./services/media/SubtitleCues.js";
import { detectVideoEncoder, benchmarkDecodeCost, benchmarkContention, benchmarkCopySpeed, detectTonemapSupport, softwareDescriptor } from "./services/encode/hwaccel.js";
import { calibrateEncoder, HostCalibration } from "./services/encode/calibration.js";
import { readHostFingerprint } from "./services/encode/fingerprint.js";
import { measureStartAndStop } from "./services/encode/start-stop-cost.js";
import { logger } from "./utils/logger.js";
import { completedFilesRoot } from "./services/storage/files/CompletedFiles.js";

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
  host, port, transcodeAudio, ffmpegBin, memoryBytes, segmentFormat, stateDir, onSubtitleCues, diagnostics, budgetPolicy,
  deliverySink = false,
  // Where the proxy writes its own log. Its DIRECTORY is what matters here:
  // the browser's half of every session is written beside it, so the two are
  // on one durable disk and join by name.
  logFile = ""
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
  const torrentPool = new WorkerTorrentPool({
    memoryBytes,
    stateDir,
    // Pieces arriving is ANNOUNCED by the thread that owns the swarm; what is
    // done about it — walking a file's new subtitle clusters and pushing what
    // came out — happens here, because that is a reading of what the file says
    // about itself. The walk used to run in that thread, which is what put a
    // container parse there.
    // The ONE forward reference here, and it is safe by construction: this fires
    // only once the worker thread is up and a piece has verified, which is long
    // after the declarations below have run.
    onPiecesArrived: ({ sourceKey, fileIndexes }) => {
      for (const fileIndex of fileIndexes) {
        void pushFreshCues(sourceKey, fileIndex);
      }
    }
  });
  const selectedPort = await getPort({
    port: buildPortCandidates(port)
  });
  // Auto-detect the best available H.264 encoder (hardware-accelerated or
  // software) once at startup, with a real test-encode and graceful fallback.
  // Only needed when transcoding can occur.
  let videoEncoder = transcodeAudio
    ? await detectVideoEncoder({ ffmpegBin, logger })
    : null;
  // WHAT THIS HOST DOES, measured before any viewer exists. Every one of these
  // was gated on the chosen encoder being SOFTWARE, and two of the three are
  // not about the encoder at all: a host with a GPU decodes in software just
  // the same — no hardware decoder is asked for anywhere — and what a second
  // job costs is a property of the machine. So a GPU host had no decode cost,
  // no contention penalty and no encoder throughput, and the quality offer,
  // which is arithmetic over those three, had nothing to compute from.
  //
  // The decode model first and the throughput second — they are independent
  // (the rungs are timed on raw frames), but the order keeps the two figures
  // side by side in the log.
  const decodeCostModel = transcodeAudio
    ? await benchmarkDecodeCost({ ffmpegBin, logger })
    : null;
  // What a second job costs on this host. Measured because the budget adds
  // independent prices and this host says two jobs that each fit alone do not
  // fit together — 2.6× on the addon box (2026-08-18).
  const contentionPenalties = transcodeAudio
    ? await benchmarkContention({ ffmpegBin, logger })
    : null;
  // WHICH MODES THIS HOST MAY ENCODE WITH, AND WHAT EACH COSTS AT EVERY SIZE
  // (roadmap item 97, step 14). Every setting an output can actually be
  // encoded at is put through the product's own arguments and its segments
  // decoded, then timed at the sizes of the ladder; a mode that fails either is
  // not used, and a size nothing was timed at is not offered. Software is
  // calibrated too when detection chose a device: it is what a failing device
  // falls back to for the rest of the process, and it must not be priced by
  // the device's figures.
  //
  // And WHICH CONFIGURATION all of it describes — the ffmpeg and x264 builds,
  // the processor and the threads, the device and its driver — which is what
  // decides whether anything kept from an earlier run still applies.
  const fingerprint = videoEncoder
    ? await readHostFingerprint({ ffmpegBin, encoder: videoEncoder })
    : null;
  /** @type {Record<string, object[]>} */
  const calibratedModes = {};
  if (videoEncoder) {
    calibratedModes[videoEncoder.kind] =
      (await calibrateEncoder({ ffmpegBin, encoder: videoEncoder, logger })).modes;
    if (videoEncoder.kind !== "software") {
      calibratedModes.software =
        (await calibrateEncoder({ ffmpegBin, encoder: softwareDescriptor(), logger })).modes;
      // A device that passed detection's own test and then none of whose modes
      // passed the product's is not used: detection encodes a synthetic pattern
      // with arguments of its own, and it is the product's arguments a viewer
      // is served with.
      if (calibratedModes[videoEncoder.kind].length === 0) {
        logger.warn(
          `calibration: ${videoEncoder.name} passed detection but none of its modes produced correct segments ` +
          "through the product's own arguments; encoding in software instead"
        );
        videoEncoder = softwareDescriptor();
      }
    }
  }
  const calibration = videoEncoder ? new HostCalibration({ byKind: calibratedModes, fingerprint }) : null;
  // What this host does with a picture it does NOT re-encode. Every other
  // startup measurement prices encoding or decoding, and a copied picture does
  // neither — it reads packets and writes them out again — so that whole branch
  // had no speed until its own run had been running long enough to report one.
  // The encoding layer decides where encoders go from arrivals, and an arrival
  // cannot be computed without a speed, so the moment it mattered most was the
  // moment nothing was known. Measured whatever the encoder is: copying does not
  // touch it.
  const copySpeedX = transcodeAudio
    ? await benchmarkCopySpeed({ ffmpegBin, logger })
    : null;
  // WHAT A START AND A STOP COST HERE, before any viewer exists. Both decide one
  // thing — leave an encoder where it stands, or kill it and start another —
  // and both used to be learned only from runs that had ENDED, so at a cold
  // open they were zero. Zero does not read as "not measured": it reads as
  // "free", and a free move is always taken. Field 2026-09-08: an encoder moved
  // between two adjacent numbers every half second and produced nothing.
  const startStopCost = transcodeAudio
    ? await measureStartAndStop({ ffmpegBin, encoder: videoEncoder, logger })
    : null;
  // Whether this ffmpeg build can tone-map HDR→SDR (zscale + tonemap filters).
  // Detected once; the session manager applies the tonemap chain only for HDR
  // sources on the software path when available.
  const tonemapSupported = transcodeAudio
    ? await detectTonemapSupport({ ffmpegBin, logger })
    : false;
  // Where every file's keyframe table lives, and the only thing that reads one.
  // Built here rather than inside the session manager because it is not a fact
  // about a session: the playback planner warms it while a file is being opened
  // and no session exists yet, and a session created later is handed the very
  // object that warm read filled in.
  // Subtitles are two layers put together, and this is the one place that knows
  // about both: what a file STATES about its subtitle tracks and how a cue is
  // written out is the media layer's, while which clusters may be read, where
  // the cursor stands and what one walk at a time means are the TORRENT's own
  // rules. The media layer used to import the second directly.
  /**
   * One file of one torrent, reduced to what the subtitle walk may know: a
   * name, a length, which ranges are downloaded whole, and how to read one of
   * those without asking the swarm. Piece length, file offsets and the bitfield
   * stay in the torrent's thread.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @param {object} [known] - The torrent handle when the caller already has it.
   * @returns {Promise<import("./services/media/SubtitleCues.js").HeldFile | null>}
   */
  const heldFileFor = async (sourceKey, fileIndex, known = null) => {
    let torrent = known;
    if (!torrent) {
      const record = sourceRegistry.get(sourceKey);
      if (!record) {
        return null;
      }
      torrent = await torrentPool.getTorrent(record.sourceType, record.source);
    }
    const file = torrent?.files?.[fileIndex];
    if (!file || !(file.length > 0)) {
      return null;
    }
    return {
      sourceKey,
      fileIndex,
      name: String(file.name ?? ""),
      length: file.length,
      heldRanges: () => torrentPool.heldRangesOf(torrent, fileIndex),
      readHeld: (start, end) => torrentPool.readHeldOf(torrent, fileIndex, start, end)
    };
  };
  /** @type {Set<string>} */
  const walksInFlight = new Set();
  /**
   * Walk whatever new cues a file now holds and push them to the viewers.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {Promise<void>}
   */
  const pushFreshCues = async (sourceKey, fileIndex) => {
    // A pass that arrives while the previous one is still walking is dropped
    // rather than queued: `verified` fires per piece, so on a fast download
    // these arrive many times a second, and a queue of identical passes would
    // only postpone the one that has something new to find. The walk is
    // serialized per file inside `SubtitleCues` anyway.
    const key = `${sourceKey}:${fileIndex}`;
    if (walksInFlight.has(key)) {
      return;
    }
    walksInFlight.add(key);
    try {
      const file = await heldFileFor(sourceKey, fileIndex);
      if (!file) {
        return;
      }
      for (const entry of await warmSubtitleCues(file)) {
        const span = entry.spanStartSeconds === null
          ? "empty"
          : `${entry.spanStartSeconds.toFixed(1)}-${entry.spanEndSeconds.toFixed(1)}s`;
        logger.info(
          `subtitle push ${sourceKey.slice(0, 8)}:${fileIndex} track ${entry.trackIndex}: ` +
          `${entry.cues.length} new cue(s) covering ${span}, ` +
          `clusters walked ${entry.walkedClusters}/${entry.indexedClusters}, cursor ${entry.cursor}`
        );
        onSubtitleCues?.({ sourceKey, fileIndex, ...entry });
      }
    } catch (error) {
      logger.warn(`subtitle push ${sourceKey.slice(0, 8)}:${fileIndex} failed: ${error?.message ?? error}`);
    } finally {
      walksInFlight.delete(key);
    }
  };
  const subtitles = new SubtitleOrchestrator(containerOrchestrator, {
    warm: async (torrent, fileIndex, sourceKey) => {
      const file = await heldFileFor(sourceKey, fileIndex, torrent);
      return file ? warmSubtitleCues(file) : [];
    },
    held: async (torrent, fileIndex, sourceKey, trackNumber) => {
      const file = await heldFileFor(sourceKey, fileIndex, torrent);
      return file ? cuesHeldFor(file, trackNumber) : null;
    },
    tracksOf: async (torrent, fileIndex, sourceKey) => {
      const file = await heldFileFor(sourceKey, fileIndex, torrent);
      return file ? subtitleTracksOf(file) : [];
    },
    declaredTracksOf: async (torrent, fileIndex, sourceKey) => {
      const file = await heldFileFor(sourceKey, fileIndex, torrent);
      return file ? declaredSubtitleTracksOf(file) : [];
    },
    forget: forgetSubtitles
  });
  // WHAT A FILE STATES ABOUT ITSELF IS READ HERE, ON THIS THREAD.
  //
  // The container layer is built from one function — `readRange(start, end)` —
  // and the bytes behind it live in shared memory, so the parse has no reason
  // to happen anywhere else. It used to happen in the torrent thread for one
  // stated reason, that "the main thread cannot open a read stream on one of
  // its files": true of WebTorrent's own API, and not of the bytes. The price
  // was three commands, a second `ContainerOrchestrator` in that thread, and
  // every answer carried back across the channel — which is what made "where is
  // this fact kept" a question at all.
  //
  // The edges are fetched first because the file this is asked about is usually
  // one nobody has played: a sidecar soundtrack is asked about before anyone
  // has chosen it, and a Matroska file's Cues sit at the END behind a SeekHead
  // in the head, so a read that has neither waits for the swarm twice over.
  const containerOver = async ({ sourceKey, fileIndex, tailBytes = 0 }) => {
    const record = sourceRegistry.get(sourceKey);
    if (!record) {
      return null;
    }
    const torrent = await torrentPool.getTorrent(record.sourceType, record.source);
    const file = torrent?.files?.[fileIndex];
    if (!file || !(file.length > 0)) {
      return null;
    }
    try {
      await torrentPool.prefetchFileEdges(torrent, fileIndex, {
        headBytes: CONTAINER_HEAD_BYTES,
        tailBytes,
        timeoutMs: 60_000
      });
    } catch {
      // A prefetch that failed is not a reason to skip the read: the read
      // fetches what it needs itself, only more slowly.
    }
    return {
      sourceKey,
      fileIndex,
      readRange: (start, end) =>
        torrentPool.readRangeOf(torrent, fileIndex, start, Math.min(end, file.length - 1)),
      fileSize: file.length,
      label: String(file.name ?? "")
    };
  };
  const keyframeTables = new KeyframeTables({
    // Read by the same container that answers the track table and the media
    // info, from the same header, and now in the same thread as the session
    // that is waiting for it.
    readTable: async ({ sourceKey, fileIndex }) => {
      // Both edges: the Cues of a Matroska file are at the end.
      const params = await containerOver({ sourceKey, fileIndex, tailBytes: CONTAINER_HEAD_BYTES });
      if (!params) {
        return null;
      }
      const index = await containerOrchestrator.getKeyframeIndex(params);
      return {
        times: index?.times ?? null,
        tolerance: index?.tolerance ?? 0,
        // Which container answered, whether or not it produced a table: the
        // refusal that follows names it, and a measurement of how often an
        // index disagrees with its own file cannot be read without it.
        format: (await containerOrchestrator.getContainer(params))?.formatName ?? "unrecognised"
      };
    }
  });
  const outputParts = wireOutputs({
    enabled: transcodeAudio,
    keyframeTables,
    ffmpegBin,
    localBindHost: host,
    localPort: selectedPort,
    videoEncoder,
    calibration,
    decodeCostModel,
    contentionPenalties,
    copySpeedX,
    startStopCost,
    tonemapSupported,
    segmentFormatId: segmentFormat,
    stateDir,
    diagnostics,
    // Live download stats accessor for the realtime budget: lets it tell a
    // CPU-bound transcode from a download-starved input before downscaling.
    // What every torrent here has moved, so the proxy can price its own
    // downloading, hashing and delivery against the machine (roadmap item 7).
    // What the spilled pieces weigh on the torrent thread, and how to tell them
    // their share of the disk. The owner of the disk is on this side, where the
    // segments are; the pieces are on the other.
    spillDisk: typeof torrentPool.allowSpillBytes === "function"
      ? {
          held: () => torrentPool.spilledBytes ?? 0,
          allow: (bytes) => torrentPool.allowSpillBytes(bytes)
        }
      : null,
    // Files downloaded whole, kept as files. They live on the torrent thread
    // too, and until 2026-09-14 they had no bound of any kind — a 2.8 GB film
    // on a host whose disk is often a 32 GB card.
    wholeFiles: typeof torrentPool.allowWholeFileBytes === "function"
      ? {
          held: () => torrentPool.wholeFileBytes ?? 0,
          allow: (bytes) => torrentPool.allowWholeFileBytes(bytes),
          root: completedFilesRoot()
        }
      : null,
    // The pieces held IN memory, on the torrent thread. Told their share by the
    // same owner that divides the disk: what does not fit here is spilled
    // there, so the two cannot be divided apart.
    memoryClaimant: typeof torrentPool.allowMemoryBytes === "function"
      ? {
          held: () => torrentPool.memoryClaim?.held ?? 0,
          wanted: () => torrentPool.memoryClaim?.wanted ?? 0,
          allow: (bytes) => torrentPool.allowMemoryBytes(bytes)
        }
      : null,
    diagnosticsRoot: stateDir || "",
    budgetPolicy,
    getTorrentTotals: async () => {
      if (typeof torrentPool.getTorrentTotals !== "function") {
        return null;
      }
      return torrentPool.getTorrentTotals();
    },
    // The priority map, on its way to the downloading. It lives in another
    // thread, so the map crosses the worker channel; what it does with it —
    // seconds into bytes, what to ask the swarm for, what to keep in memory —
    // is its own business.
    setPriorityMap: async ({ sourceKey, fileIndex, durationSeconds, zones }) => {
      const record = sourceRegistry.get(sourceKey);
      if (!record) {
        return;
      }
      try {
        await torrentPool.setPriorityMap({ sourceKey, fileIndex, durationSeconds, zones });
      } catch {
        // Best effort: the map is republished on the next change, and the
        // downloading goes on serving reads meanwhile.
      }
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
    getCachedAudioTracks: (params) => playbackPlanner.getCachedAudioTracks(params),
    // What a file declares about itself, read by the container layer from the
    // same header its track table comes from. This is how the session learns
    // where a soundtrack shipped as its own file begins — it used to spawn an
    // ffmpeg over this proxy's own HTTP to ask the same question of the same
    // bytes, and that read cost 8.1 s of every cold start (field 2026-09-03).
    getContainerMediaInfo: async ({ sourceKey, fileIndex }) => {
      try {
        const params = await containerOver({ sourceKey, fileIndex });
        return params ? await containerOrchestrator.getMediaInfo(params) : null;
      } catch {
        return null;
      }
    },
    // Pull one whole file onto the disk. Used for a soundtrack that ships beside
    // the picture, once the encoder is as far ahead of the viewer as it is
    // allowed to get — the one moment the swarm's capacity is demonstrably
    // spare. A bounded read of the file's whole length, NOT `file.select()`:
    // selecting a file alongside the readers' own windows is what made a seek
    // wait 93 s while the swarm fetched 2.47 GB in file order (see
    // `#syncSelections` in `torrent/torrent-pool.js`).
    fetchWholeFile: async ({ sourceKey, fileIndex }) => {
      const record = sourceRegistry.get(sourceKey);
      if (!record) {
        return;
      }
      const torrent = await torrentPool.getTorrent(record.sourceType, record.source);
      // The same background fill the warm-up starts when a file is chosen, not a
      // second way of doing it. It is guarded against running twice on one file,
      // so the two triggers converge instead of putting two readers on the same
      // soundtrack — and only one of them would have stood aside for the
      // picture. This trigger remains for the session that never had a warm-up
      // before it.
      await torrentPool.fillFileInBackground?.(torrent, fileIndex);
    }
  });
  // What the last life of this process left on the disk. The kernel kills this
  // one often enough for that to be an ordinary state rather than an odd one —
  // twice in a single viewing on 2026-09-02 — and when it does, no exit handler
  // runs and nothing is cleared up. So this is both the cleanup and the only
  // record that those encoders ended at all: it says what it found before it
  // decides anything, keeps the segments whose closure is proven, and removes
  // the one piece per output that was being written when the process died.
  outputParts.lifecycle.adoptSegmentsLeftBehind();
  const playbackPlanner = createPlaybackPlanner({
    ffmpegBin,
    transcodeAudioEnabled: transcodeAudio,
    localBaseUrl: outputParts.localBaseUrl,
    sourceRegistry,
    torrentPool,
    sidecarsFromTorrent: (torrent, fileIndex) => contentsOf(torrent).sidecarsOf(fileIndex),
    // What a file declares about its own tracks, parsed on this thread from the
    // header the swarm delivered. The planner used to ask the torrent pool for
    // this, which meant the media layer asking the torrent layer to parse a
    // container on its behalf, in the other thread, with the answer carried
    // back over the channel.
    declaredTracksOf: async ({ sourceKey, fileIndex }) => {
      const params = await containerOver({ sourceKey, fileIndex });
      return params ? await containerOrchestrator.getTracks(params) : [];
    },
    warmKeyframeIndex: (params) => keyframeTables.warm(params),
    expectedFirstSegmentMs: () => outputParts.hostTimings.expectedFirstSegmentMs(),
    expectedSessionCreateMs: () => outputParts.hostTimings.expectedSessionCreateMs(),
    // The quality menu is on screen from the moment a file is opened, so the
    // heights this host can actually serve have to be answerable before any
    // encoder exists — from the probe and the startup benchmarks alone.
    predictOfferedHeights: (mediaInfo) => outputParts.quality.predictOfferedHeights(mediaInfo)
  });

  app.get("/health", async (req, reply) => handleHealthGet(req, reply, { version }));
  app.get("/healthz", async (req, reply) => handleHealthzGet(req, reply, { version }));
  // Off unless --delivery-sink was given; see the route for why it exists.
  app.get("/api/delivery-sink", async (req, reply) =>
    handleApiDeliverySinkGet(req, reply, { enabled: deliverySink === true })
  );
  // Bytes a browser can time its link with before any film has been chosen.
  app.get("/api/link-probe", async (req, reply) => handleApiLinkProbeGet(req, reply));
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
    handleApiSourceWarmPost(req, reply, {
      sourceRegistry,
      torrentPool,
      // How long the file runs, read on this thread from the header. The warm
      // turns a position in seconds into a byte offset and needs it; it used to
      // read the container itself, in the torrent thread, to find out.
      durationOf: async (params) => {
        const over = await containerOver(params);
        return over ? (await containerOrchestrator.getMediaInfo(over))?.durationSeconds ?? null : null;
      }
    })
  );
  // The browser's own log, kept beside the proxy's. See the route's own file
  // for why it is here and not only on the registry server.
  const clientLogs = logFile ? createClientLogFiles(logFile) : null;
  app.post("/api/client-logs", async (req, reply) =>
    handleApiClientLogsPost(req, reply, { clientLogs })
  );
  app.post("/api/playback-plan", async (req, reply) =>
    handleApiPlaybackPlanPost(req, reply, { playbackPlanner })
  );
  app.get("/api/subtitles", async (req, reply) =>
    handleApiSubtitlesGet(req, reply, {
      sourceRegistry,
      torrentPool,
      ffmpegBin,
      localBaseUrl: outputParts.localBaseUrl,
      viewers: outputParts.viewers,
      subtitles
    })
  );
  app.get("/stream", async (req, reply) =>
    handleStreamGet(req, reply, {
      sourceRegistry,
      torrentPool,
      // So a session that has produced nothing yet can still show it is being
      // fed. The route knows only files; the session id rides on the URL the
      // session itself built.
      noteInputBytes: (sessionId, bytes) => outputParts.encodeRuns.noteInputBytes(sessionId, bytes)
    })
  );
  app.post("/api/transcode-sessions", async (req, reply) =>
    handleApiTranscodeSessionsPost(req, reply, { viewerRequests: outputParts.viewerRequests, renditions: outputParts.renditions, quality: outputParts.quality, outputs: outputParts.outputs, lookaheadSeconds: outputParts.lookaheadSeconds, sourceRegistry, torrentPool })
  );
  app.post("/api/transcode-sessions/:sessionId/release", async (req, reply) =>
    handleApiTranscodeSessionReleasePost(req, reply, { lifecycle: outputParts.lifecycle })
  );
  app.get("/api/transcode-sessions/:sessionId/progress", async (req, reply) =>
    handleApiTranscodeSessionsProgressGet(req, reply, { viewerRequests: outputParts.viewerRequests })
  );
  app.post("/api/transcode-sessions/:sessionId/net-report", async (req, reply) =>
    // A viewer's statement about itself goes to the VIEWER layer, not through
    // the session manager: what it needs is the live sessions and the registry
    // of viewers, and nothing about encoding.
    handleApiTranscodeSessionNetReportPost(req, reply, {
      outputs: outputParts.outputs,
      viewers: outputParts.viewers,
      renditions: outputParts.renditions,
      quality: outputParts.quality
    })
  );
  app.post("/api/transcode-sessions/:sessionId/fragment-far", async (req, reply) =>
    handleApiTranscodeSessionFragmentFarPost(req, reply, { serving: outputParts.serving })
  );
  app.post("/api/transcode-sessions/:sessionId/seek", async (req, reply) =>
    handleApiTranscodeSessionSeekPost(req, reply, { viewerRequests: outputParts.viewerRequests })
  );
  app.get("/transcode/:sessionId/:fileName", async (req, reply) =>
    handleTranscodeSessionFileGet(req, reply, { serving: outputParts.serving, viewerRequests: outputParts.viewerRequests })
  );
  // A quality variant's files. Registered before the static handler for the
  // same reason as the line above, and kept a separate route rather than a
  // wildcard so the height stays a parsed parameter.
  // Registered BEFORE the variant file route: `warm` is not a file name, and
  // Fastify matches a static segment ahead of a parameter either way — stated
  // here so the order is not "tidied" into a bug.
  app.get("/transcode/:sessionId/v/:height/warm", async (req, reply) =>
    handleTranscodeVariantWarmGet(req, reply, { renditions: outputParts.renditions, serving: outputParts.serving, viewerRequests: outputParts.viewerRequests })
  );
  app.get("/transcode/:sessionId/a/:track/warm", async (req, reply) =>
    handleTranscodeAudioWarmGet(req, reply, { renditions: outputParts.renditions, serving: outputParts.serving, viewerRequests: outputParts.viewerRequests })
  );
  app.get("/transcode/:sessionId/a/:trackIndex/:fileName", async (req, reply) =>
    handleTranscodeAudioFileGet(req, reply, { renditions: outputParts.renditions, serving: outputParts.serving, viewerRequests: outputParts.viewerRequests })
  );
  app.get("/transcode/:sessionId/v/:height/:fileName", async (req, reply) =>
    handleTranscodeVariantFileGet(req, reply, { renditions: outputParts.renditions, serving: outputParts.serving, viewerRequests: outputParts.viewerRequests })
  );
  await app.register(fastifyStatic, {
    root: publicRoot,
    prefix: "/",
    serveDotFiles: true
  });

  app.addHook("onClose", async () => {
    // Order matters: stop the ffmpeg readers (HLS sessions) before destroying
    // the torrents whose files they read from, then remove the torrent data.
    await outputParts.lifecycle.disposeAll();
    await torrentPool.destroyAll();
  });

  await app.listen({ host, port: selectedPort });
  return {
    app,
    port: selectedPort,
    // Asked over the tunnel when the proxy a viewer landed on has refused their
    // file: could THIS host sustain it? Answered from the startup benchmarks
    // and a description, so it needs no torrent and costs milliseconds.
    outputParts,
    // The browser only ever knows a source by its REGISTRY key (a hash of the
    // raw request bytes, scoped to one API session) — never the torrent
    // pool's own key (the content's infohash, shared across a magnet and a
    // `.torrent` naming the same film). The subtitle push subscription is
    // recorded from a browser request and published from the pool's side, so
    // resolving one into the other is what lets the two ends agree on what
    // they are both calling "sourceKey".
    sourceRegistry,
    // Which films this host holds, for the health poll the browser makes before
    // it picks a proxy. The pool is on the worker thread and this is the way to
    // it from the process that answers that poll.
    torrentPool
  };
}
