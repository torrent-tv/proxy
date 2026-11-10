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
import getPort from "get-port";
import { createRequire } from "node:module";
import { SourceWaitTrace } from "./utils/wait-trace.js";
import { handleHealthGet } from "./routes/health/get.js";
import { handleMediaGet } from "./routes/media/get.js";
import { ProbeRequests } from "./services/media/ProbeRequests.js";
import { IndexMemory } from "./services/storage/IndexMemory.js";
import { LARGEST_GROWTH_BYTES } from "./services/media/container/PacketRecords.js";
import { probePackets } from "./services/media/probe-packets.js";
import { SegmentInputTable } from "./services/viewer/segment-input-table.js";
import { SourcePreparation, preparationInterval } from "./services/viewer/SourcePreparation.js";
import { publishPlaybackBeforePreparationRefresh } from "./services/server/publish-playback-before-preparation-refresh.js";
import { WorkTagsReport } from "./services/media/WorkTagsReport.js";
import { PreparationReads } from "./services/server/PreparationReads.js";
import { MediaReadParams } from "./services/server/MediaReadParams.js";
import { torrentPoolPorts } from "./services/server/torrent-pool-ports.js";
import { installForwardedResponseLog } from "./services/server/forwarded-response-log.js";
import { handleHealthzGet } from "./routes/healthz/get.js";
import { handleApiDeliverySinkGet } from "./routes/api/delivery-sink/get.js";
import { handleApiLinkProbeGet } from "./routes/api/link-probe/get.js";
import { handleApiSourcesPost } from "./routes/api/sources/post.js";
import { handleApiSourceStatsGet } from "./routes/api/sources/stats/get.js";
import { handleApiSourceFilesGet } from "./routes/api/sources/files/get.js";
import { handleApiSourceFingerprintGet } from "./routes/api/sources/fingerprint/get.js";
import { handleApiSourceContainerMetadataGet } from "./routes/api/sources/container-metadata/get.js";
import { handleApiSourceCoverGet } from "./routes/api/sources/cover/get.js";
import { handleApiSourceChaptersGet } from "./routes/api/sources/chapters/get.js";
import { ChapterOrchestrator } from "./services/media/ChapterOrchestrator.js";
import { ChapterController } from "./services/server/controllers/ChapterController.js";
import { handleApiSourceWarmPost } from "./routes/api/sources/warm/post.js";
import { handleApiSourceViewerPost } from "./routes/api/sources/viewer/post.js";
import { handleApiPlaybackPlanPost } from "./routes/api/playback-plan/post.js";
import { handleApiPlaybackPlanAudioTracksPost } from "./routes/api/playback-plan/audio-tracks/post.js";
import { handleApiClientLogsPost } from "./routes/api/client-logs/post.js";
import { createClientLogConsole, createClientLogFiles } from "./utils/client-log-file.js";
import { handleApiSubtitlesGet } from "./routes/api/subtitles/get.js";
import { handleApiSubtitlesPost } from "./routes/api/subtitles/post.js";
import { handleApiTranscodeSessionsPost } from "./routes/api/transcode-sessions/post.js";
import { handleApiTranscodeSessionsProgressGet } from "./routes/api/transcode-sessions/progress/get.js";
import { handleApiTranscodeSessionReleasePost } from "./routes/api/transcode-sessions/release/post.js";
import { handleApiTranscodeSessionNetReportPost } from "./routes/api/transcode-sessions/net-report/post.js";
import { handleApiTranscodeSessionFragmentFarPost } from "./routes/api/transcode-sessions/fragment-far/post.js";
import { handleApiTranscodeSessionSeekPost } from "./routes/api/transcode-sessions/seek/post.js";
import { handleStreamGet } from "./routes/stream/get.js";
import { handleEncodeInputGet } from "./routes/encode-input/get.js";
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
import { coalescedZones, withoutRepeatedZones } from "./services/torrent/map-zones.js";
import { SubtitleWalk } from "./services/media/SubtitleWalk.js";
import { containerOrchestrator, CONTAINER_HEAD_BYTES } from "./services/media/ContainerOrchestrator.js";
import { readPlaybackDeclarations } from "./services/media/read-playback-declarations.js";
import { DownloadMaps } from "./services/viewer/DownloadMaps.js";
import { nativeSourceMap, nativeOriginalSourceMap } from "./services/viewer/NativeSourceMap.js";
import { MediaReadRequests } from "./services/media/MediaReadRequests.js";
import { EncodeInputResolution } from "./services/encode/EncodeInputResolution.js";
import { SegmentInputs } from "./services/media/SegmentInputs.js";
import { PlaybackResolution } from "./services/torrent/PlaybackResolution.js";
import { SegmentSourceRanges } from "./services/media/SegmentSourceRanges.js";
import { readingInterval, segmentReading, selectTracks, trackFor } from "./services/media/segment-reading.js";
import { pauseCoefficient, viewerStartsOn } from "./services/viewer/PriorityMap.js";
import { measureHost } from "./services/encode/measure-host.js";
import { logger } from "./utils/logger.js";
import { completedFilesRoot } from "./services/storage/files/CompletedFiles.js";
import { startPlayback } from "./services/server/start-playback.js";
import { startupCpuProfile } from "./services/storage/cpu-profile.js";
import { startProcessorReport } from "./services/storage/processor-report.js";
import { processorBound } from "./services/storage/machine-processor.js";

const require = createRequire(import.meta.url);
const { version } = require("./package.json");

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
 * @property {string}  ffprobeBin     - Path to the ffprobe executable chosen at startup (`services/media/ffprobe-selection.js`).
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
  host, port, transcodeAudio, ffmpegBin, ffprobeBin, memoryBytes, segmentFormat, stateDir, onSubtitleCues, onChaptersChanged, diagnostics, budgetPolicy,
  deliverySink = false,
  // Whether a memory high-water earns a heap snapshot (`--heap-snapshots`).
  heapSnapshots = false,
  // Seconds of main-thread CPU profile from the first source opened; 0 is off.
  profileStartSeconds = 0,
  // The one software preset every picture is encoded at, for runs compared at
  // one quality; null leaves the choice to the machine.
  pinnedPreset = null,
  // Where the proxy writes its own log. Its DIRECTORY is what matters here:
  // the browser's half of every session is written beside it, so the two are
  // on one durable disk and join by name.
  logFile = "",
  // Told whenever what the server chooses proxies by may have changed here:
  // the films held, an encoder started or ended, a viewer came or went
  // (`transport/proxy-state.js`).
  onStateChanged = () => undefined
}) {
  const app = Fastify({
    // No practical body-size limit — the proxy server is localhost-only and
    // receives torrent source payloads that may be arbitrarily large.
    bodyLimit: 256 * 1024 * 1024 // 256 MB
  });
  const waitTrace = new SourceWaitTrace({ emit: value => logger.info(`[wait-trace] ${JSON.stringify(value)}`) });
  waitTrace.install(app);

  await app.register(fastifyHelmet, {
    // Proxy serves media to a different origin (registry UI), so CORP must allow cross-origin usage.
    crossOriginResourcePolicy: {
      policy: "cross-origin"
    }
  });
  await app.register(fastifyCors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Range", "X-Ttv-Wait-Trace", "X-Ttv-Wait-Attempt", "X-Ttv-Wait-Operation",
      "X-Ttv-Wait-Process"]
  });

  // Allow browser requests from an HTTPS page to this private-network proxy
  // without triggering Chromium's Private Network Access permission prompt.
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Access-Control-Allow-Private-Network", "true");
  });
  installForwardedResponseLog(app, { log: line => logger.info(line), warn: line => logger.warn(line) });

  const sourceRegistry = createSourceRegistry(200);
  // The torrent runs on its own thread. Profiling a live seek (2026-08-02)
  // found the main thread ~85% occupied by WebTorrent — buffer concatenation
  // ~15%, wire updates ~9%, garbage collection ~5% — while three of four cores
  // idled. Serving a segment shared that thread, so reading an already-finished
  // 10 MB file took 12-23 s against 125 ms to hand it to the channel. The
  // adapter keeps TorrentPool's interface, so nothing downstream changed.
  const torrentPool = new WorkerTorrentPool({
    isWaitTraced: sourceKey => waitTrace.has(sourceKey),
    onWaitTrace: event => waitTrace.process(event.sourceKey, event.process, event.phase, event),
    onObserved: fields => {
      waitTrace.source(fields.sourceKey, "process", { process: "P1", phase: "begin", at: fields.startedAt,
        outcome: fields.outcome });
      waitTrace.source(fields.sourceKey, "process", { process: "P1", phase: "end", at: fields.endedAt,
        startedAt: fields.startedAt, endedAt: fields.endedAt, durationMs: fields.endedAt - fields.startedAt,
        outcome: fields.outcome });
    },
    memoryBytes,
    stateDir,
    heapSnapshots,
    onHoldingsChanged: () => onStateChanged(),
    onSourceForgotten: ({ sourceKey }) => {
      sourcePreparation.forget(sourceKey);
      mediaReads.forget(sourceKey);
      chapters.forget(sourceKey);
      probeReads.forget(sourceKey);
      subtitleWalk.subtitles.forget(sourceKey);
      keyframeTables.forget(sourceKey);
      playbackPlanner.forget(sourceKey);
      indexMemory.forget(sourceKey);
      downloadMaps.retire(sourceKey);
      sourceRanges.forget(sourceKey);
      resolution.forget(sourceKey);
      segmentInputs.forget(sourceKey);
      encodeInputs?.bytesChanged();
    },
    // Pieces arriving is ANNOUNCED by the thread that owns the swarm; what is
    // done about it — walking a file's new subtitle clusters and pushing what
    // came out — happens here, because that is a reading of what the file says
    // about itself. The walk used to run in that thread, which is what put a
    // container parse there.
    // The ONE forward reference here, and it is safe by construction: this fires
    // only once the worker thread is up and a piece has verified, which is long
    // after the declarations below have run.
    onPiecesArrived: ({ sourceKey, fileIndexes, arrived }) => {
      waitTrace.source(sourceKey, "process", { process: "W9", phase: "end", fileIndexes,
        arrived: arrived?.slice?.(0, 32), arrivedCount: arrived?.length });
      for (const fileIndex of fileIndexes) {
        mediaReads.bytesChanged(sourceKey, fileIndex);
        probeReads.bytesChanged(sourceKey, fileIndex);
        void sourcePreparation.bytesChanged(sourceKey, fileIndex).catch(error =>
          logger.warn(`source input readiness failed: ${error.message}`));
        void subtitleWalk.pushFreshCues(sourceKey, fileIndex);
        // A keyframe table somebody asked for while its bytes had not arrived
        // is read again now; nothing was recorded for that wait.
        keyframeTables.readAgainIfUnanswered({ sourceKey, fileIndex, logName: String(fileIndex) });
      }
      // Which bytes arrived, when the event names them: an input waiting for
      // named bytes is tried again only when some of them have come.
      encodeInputs?.bytesChanged(Array.isArray(arrived) ? { sourceKey, ranges: arrived } : null);
    }
  });
  const selectedPort = await getPort({
    port: buildPortCandidates(port)
  });
  // The cores this process may use (a container's quota or CPU set): the
  // readings divide out a share of those, the unit every later share of the
  // machine is in (torrent-tv/meta#180, phase 3).
  const processorCores = processorBound().cores;
  const { videoEncoder, decodeCostModel, contentionPenalties, calibration, copySpeedX, audioCalibration, startStopCost,
    tonemapSupported } = await measureHost({ ffmpegBin, logger, transcode: transcodeAudio, processorCores });
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
  const chapters = new ChapterOrchestrator({
    containers: containerOrchestrator,
    subscribe: (sourceKey, fileIndex, listener) => mediaReads.subscribe(sourceKey, fileIndex, listener),
    withdraw: (sourceKey, fileIndex) => {
      mediaReads.retain(sourceKey, fileIndex, (_params, statement) => statement !== "chapters");
      void downloadMaps.withdrawMetadata(sourceKey, fileIndex, "chapters").catch(error => logger.warn(`chapter demand withdrawal failed: ${error.message}`));
    },
    failed: (error) => logger.warn(`chapter request failed: ${error.message}`),
    onChanged: (event) => onChaptersChanged?.(event),
    fileFor: async (sourceKey, fileIndex) => {
      if (!sourceRegistry.get(sourceKey)) return null;
      const torrent = torrentPool.knownTorrent(sourceKey);
      const file = torrent?.files?.[fileIndex];
      if (!file) return torrent ? { invalid: true } : null;
      return mediaParams.paramsFor({ sourceKey, fileIndex });
    }
  });
  const chapterController = new ChapterController({ sourceRegistry, chapters });
  const subtitleWalk = new SubtitleWalk({
    torrents: torrentPool,
    containers: containerOrchestrator,
    paramsFor: request => mediaParams.paramsFor(request),
    wantedSeconds: (sourceKey, fileIndex) => viewerStartsOn(outputParts.priority?.mapFor(sourceKey, fileIndex)),
    publish: entry => onSubtitleCues?.(entry),
    log: line => logger.info(line),
    warn: line => logger.warn(line)
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
  // Missing metadata bytes are demand in the same file map as playback.
  // Readers never start their own downloads or wait for source bytes.
  /** Source byte ranges of one segment interval; the cache is the resolver's, forgotten with the source. */
  const sourceRanges = new SegmentSourceRanges({ orchestrator: containerOrchestrator });
  /** Which source bytes each segment of an output reads, for the forecast (`segment-input-table.js`). */
  const segmentInputs = new SegmentInputTable();
  const mediaReads = new MediaReadRequests({
    read: (params, statement) => statement === "subtitle-file" ? subtitleWalk.subtitles.inspectFile(params)
      : statement === "subtitle-cues" ? subtitleWalk.subtitles.inspectPackets(params) : containerOrchestrator.inspect(params, statement),
    failed: (params, statement, error) => logger.warn(`media source=${params.sourceKey} file=${params.fileIndex} statement=${statement} retry failed: ${error?.message ?? error}`)
  });
  const probeReads = new ProbeRequests({
    publish: async (result) => {
      if (result.statement.startsWith("ffprobe:")) return;
      await downloadMaps.metadata(result);
      if (result.result.kind === "result") await downloadMaps.refresh(result.sourceKey, result.fileIndex);
    },
    failed: (request, error) => logger.warn(`media request=${request.key} probe failed: ${error?.message ?? error}`)
  });
  const indexMemory = new IndexMemory({
    growthBytes: LARGEST_GROWTH_BYTES,
    reviseBudget: () => { void machineBudget.revise("memory", "media metadata").catch(error => logger.warn(`packet index budget: ${error.message}`)); },
    changed: () => { mediaReads.memoryChanged(); probeReads.memoryChanged(); encodeInputs?.memoryChanged(); }
  });
  const mediaParams = new MediaReadParams({
    heldFile: (sourceKey, fileIndex) => {
      if (!sourceRegistry.get(sourceKey)) return null;
      const torrent = torrentPool.knownTorrent(sourceKey);
      const file = torrent?.files?.[fileIndex];
      if (!file || !(file.length > 0)) return null;
      return { length: file.length, name: String(file.name ?? ""), offset: file.offset,
        portionBytes: Number(torrent.pieceLength) > 0 ? Number(torrent.pieceLength) : undefined,
        readHeld: (start, end) => torrentPool.readHeldOf(torrent, fileIndex, start, end),
        noteVideo: hasVideo => contentsOf(torrent).noteVideo(fileIndex, hasVideo) };
    },
    packetMemory: (sourceKey, fileIndex) => indexMemory.forFile(sourceKey, fileIndex),
    readProbe: request => probeReads.read(request),
    probePackets: request => probePackets({ ...request, ffprobeBin }),
    baseUrl: () => localBaseUrl,
    observeWait: (sourceKey, event, fields) => waitTrace.source(sourceKey, event, fields),
    reads: { revision: (...a) => mediaReads.revision(...a), memoryRevision: () => mediaReads.memoryRevision(),
      record: (...a) => mediaReads.record(...a) },
    maps: { epoch: (...a) => downloadMaps.epoch(...a), wantsInterval: (...a) => downloadMaps.wantsInterval(...a),
      metadata: entry => downloadMaps.metadata(entry), withdrawMetadata: (...a) => downloadMaps.withdrawMetadata(...a),
      refresh: (...a) => downloadMaps.refresh(...a) },
    learnKeyframes: (params, table) => keyframeTables.learn(params, table),
    formatOf: (sourceKey, fileIndex) => containerOrchestrator.known(sourceKey, fileIndex)?.formatName ?? "unrecognised",
    warn: line => logger.warn(line)
  });
  const keyframeTables = new KeyframeTables({
    // Read by the same container that answers the track table and the media
    // info, from the same header, and now in the same thread as the session
    // that is waiting for it.
    readTable: async ({ sourceKey, fileIndex }) => {
      // Both edges: the Cues of a Matroska file are at the end.
      const params = await mediaParams.paramsFor({ sourceKey, fileIndex, tailBytes: CONTAINER_HEAD_BYTES });
      if (!params) {
        return null;
      }
      const index = await containerOrchestrator.getKeyframeIndex(params);
      return {
        times: index?.times ?? null,
        tolerance: index?.tolerance ?? 0,
        copyable: index?.copyable,
        // Which container answered, whether or not it produced a table: the
        // refusal that follows names it, and a measurement of how often an
        // index disagrees with its own file cannot be read without it.
        format: (await containerOrchestrator.getContainer(params))?.formatName ?? "unrecognised"
      };
    }
  });
  const encodeInputResolution = new EncodeInputResolution({
    paramsFor: request => mediaParams.paramsFor(request), sourceRanges,
    selectTracks, readingInterval, trackFor,
    declaredTracks: (sourceKey, fileIndex) => containerOrchestrator.tracks.get(`${sourceKey}:${fileIndex}`),
    known: (sourceKey, fileIndex) => containerOrchestrator.known(sourceKey, fileIndex),
    outputs: () => outputs.values(), // lazy: the catalog of the graph built next
    log: line => logger.info(line), warn: line => logger.warn(line)
  });
  const outputParts = wireOutputs({
    observeWait: (sourceKey, event, fields) => waitTrace.source(sourceKey, event, fields),
    pinnedPreset,
    indexMemory,
    readMetadataActivity: () => containerOrchestrator.activity(),
    onEncodersChanged: () => onStateChanged(),
    sourceInputsFor: (output, index) => segmentInputs.inputsFor(output.file.sourceKey, output.outputKey, index),
    readSourceMedia: async (params) => {
      await playbackPlanner.getPlan(params);
      const media = playbackPlanner.getCachedMediaInfo(params);
      if (media) return media;
      const error = new Error("Source media declarations require more available bytes.");
      error.code = "MEDIA_BYTES_UNAVAILABLE";
      error.canRetry = true;
      throw error;
    },
    encodeInputResolution,
    repriceEncodeDemand: demand => downloadMaps.repriceRequest(demand.requestId, demand),
    ...torrentPoolPorts({ torrentPool, sourceRegistry, wholeFilesRoot: completedFilesRoot() }),
    enabled: transcodeAudio,
    keyframeTables,
    ffmpegBin,
    localBindHost: host,
    localPort: selectedPort,
    videoEncoder,
    calibration,
    audioCalibration,
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
    diagnosticsRoot: stateDir || "",
    budgetPolicy,
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
        if (zones.length === 0) {
          mediaReads.retain(sourceKey, fileIndex, params => params.requestId?.startsWith("prepare:"));
          if (!viewers.forSource(sourceKey).length) probeReads.forget(sourceKey, fileIndex);
          await downloadMaps.forget(sourceKey, fileIndex, { keepPreparation: true });
          resolution.clear(sourceKey, fileIndex);
          void sourcePreparation.refresh();
          return;
        }
        await publishPlaybackBeforePreparationRefresh(
          () => downloadMaps.playback({ sourceKey, fileIndex, durationSeconds, zones }),
          () => { void sourcePreparation.refresh(); }
        );
        mediaReads.retain(sourceKey, fileIndex, params => !params.requestId?.startsWith("download:") ||
          zones.some(zone => zone.from === params.downloadInterval?.from && zone.to === params.downloadInterval?.to));
      } catch (error) {
        logger.warn(`download map source=${sourceKey} file=${fileIndex} publication failed: ${error?.message ?? error}`);
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
        const params = await mediaParams.paramsFor({ sourceKey, fileIndex });
        return params ? await containerOrchestrator.getMediaInfo(params) : null;
      } catch {
        return null;
      }
    }
  });
  const { viewers, viewerRequests, outputs, encodeRuns, serving, renditions, encodeInputs, quality,
    lifecycle, outputTimes, machineBudget, lookaheadSeconds, segmentDurationSec, localBaseUrl,
    encodeOrchestrator, playedOutputsOf } = outputParts;
  /**
   * The download map's pass: what the torrent is told about the file a viewer
   * plays, worked out from the viewers' map (torrent-tv/meta#273).
   */
  const resolution = new PlaybackResolution({
    paramsFor: request => mediaParams.paramsFor(request),
    sourceRanges,
    segmentReading,
    playedOutputsOf,
    pieceLengthOf: sourceKey => Number(torrentPool.knownTorrent(sourceKey)?.pieceLength),
    noteSegmentInput: (...args) => segmentInputs.set(...args),
    refresh: (sourceKey, fileIndex) => downloadMaps.refresh(sourceKey, fileIndex),
    observeWait: (sourceKey, event, fields) => waitTrace.source(sourceKey, event, fields),
    log: line => logger.info(line),
    warn: line => logger.warn(line)
  });
  const downloadMaps = new DownloadMaps({
    // The ranges a picture reads at open are named again by every segment;
    // only the zone the swarm would rank first is sent (torrent-tv/meta#166).
    // Left out of what is SENT and nowhere else: every segment's own zones are
    // also what says which bytes that segment needs, and a segment whose zones
    // all repeat another's — two of one group of pictures in an AVI read the
    // same bytes — lost them with 2.96.11, and the start forecast answered
    // "source-input-ranges-unavailable" for ever (Home Assistant 2026-10-11).
    publish: (map) => torrentPool.setPriorityMap({ ...map, zones: withoutRepeatedZones(map.zones) }),
    // And what is sent is packed: a stretch of one level and priority is one
    // window, not one zone per range of each of its segments
    // (`coalescedZones`, torrent-tv/meta#178). The playback zones come packed
    // already from the projection; this packs them with the native ones.
    pack: (zones) => coalescedZones(zones),
    log: (line) => logger.info(line),
    observeWait: (sourceKey, event, fields) => waitTrace.source(sourceKey, event, fields),
    // A file's own reads are wanted while a present viewer has the file chosen
    // or on screen.
    fileWanted: (sourceKey, fileIndex) => viewers.forSource(sourceKey)
      .some(viewer => viewer.source?.selectedFileIndex === fileIndex ||
        viewer.source?.visibleFileIndices?.includes(fileIndex)),
    resolvePlayback: map => resolution.resolve(map)
  });
  // Where the processor goes, and at a cold start what the main thread does
  // with it, when the operator asks (torrent-tv/meta#177).
  const startupProfile = startupCpuProfile({
    seconds: profileStartSeconds,
    dir: stateDir || "",
    log: (line) => logger.info(line),
    mayKeep: (bytes) => diagnostics?.mayKeep?.({ what: "a CPU profile", bytes }) ?? true,
    torrentThread: (seconds) => torrentPool.cpuProfile?.(seconds) ?? Promise.resolve(null)
  });
  startProcessorReport({
    log: (line) => logger.info(line),
    ffmpegRuns: () => [...outputs.values()]
      .flatMap((output) => encodeRuns.liveRunsOf(output).map((run) => ({
        pid: run.process?.pid,
        label: `${output.outputKey} #${run.from}..#${run.to}`,
        film: Number(run.progress?.processedSeconds) - Number(run.progress?.startPositionSeconds ?? 0)
      })))
      .filter((run) => Number.isInteger(run.pid)),
    detailed: () => startupProfile.active(),
    // What the pause rule judges from (torrent-tv/meta#180, phase 4).
    onRunSeconds: (seconds) => encodeOrchestrator?.noteRunSeconds(seconds)
  });
  // What the last life of this process left on the disk. The kernel kills this
  // one often enough for that to be an ordinary state rather than an odd one —
  // twice in a single viewing on 2026-09-02 — and when it does, no exit handler
  // runs and nothing is cleared up. So this is both the cleanup and the only
  // record that those encoders ended at all: it says what it found before it
  // decides anything, keeps the segments whose closure is proven, and removes
  // the one piece per output that was being written when the process died.
  startPlayback({ outputParts, downloadMaps, preparation: () => sourcePreparation, onStateChanged,
    warn: line => logger.warn(line) });
  const preparationReads = new PreparationReads({
    paramsFor: request => mediaParams.paramsFor(request),
    containers: containerOrchestrator,
    subtitles: subtitleWalk.subtitles,
    fileLengthOf: (sourceKey, fileIndex) => torrentPool.knownTorrent(sourceKey)?.files?.[fileIndex]?.length,
    viewersOf: sourceKey => viewers.forSource(sourceKey),
    segmentSeconds: segmentDurationSec,
    preparationInterval,
    segmentInputs: input => new SegmentInputs(input),
    nativeMaps: { packets: input => nativeSourceMap(input), original: input => nativeOriginalSourceMap(input) },
    maps: downloadMaps,
    record: (...args) => mediaReads.record(...args),
    planEncodersSoon: () => encodeRuns.planEncodersSoon()
  });
  const sourcePreparation = new SourcePreparation({
    viewers,
    candidatesFor: async sourceKey => {
      const record = sourceRegistry.get(sourceKey);
      if (!record) return [];
      const torrent = await torrentPool.getTorrent(record.sourceType, record.source);
      return contentsOf(torrent).items.map(item => item.fileIndex);
    },
    relatedFilesFor: (sourceKey, fileIndex) => {
      const torrent = torrentPool.knownTorrent(sourceKey);
      if (!torrent) return [];
      const contents = contentsOf(torrent);
      const sidecars = contents.sidecarsOf(fileIndex);
      const items = contents.items;
      const current = items.findIndex(item => item.fileIndex === fileIndex);
      const next = current >= 0 ? items[current + 1] : null;
      return [{ fileIndex, role: "source-rest" },
        ...sidecars.audio.map(file => ({ fileIndex: file.fileIndex, role: "audio" })),
        ...sidecars.subtitles.map(file => ({ fileIndex: file.fileIndex, role: "subtitle" })),
        ...(next?.episode ? [{ fileIndex: next.fileIndex, role: "next-episode" }] : [])];
    },
    priorityFor: (viewer, priority, work) => {
      if (!sourcePreparation.subtitleReadyFor(viewer)) return priority;
      const fileIndex = work.ownerFileIndex ?? work.fileIndex;
      const output = [...outputs.values()].find(output => output.file?.sourceKey === work.sourceKey &&
        output.file?.fileIndex === fileIndex && viewers.forOutput(output).has(viewer.id) &&
        !outputs.supersededBy(output, viewer.activeVariantId ?? null));
      const viewerCount = viewers.forSource(work.sourceKey)
        .filter(person => person.source.selectedFileIndex === fileIndex).length;
      if (!output) {
        const coefficient = pauseCoefficient({ playing: viewer.playing || viewer.waiting, viewerCount,
          pauseSeconds: viewer.pausedAt === null ? 0 : (Date.now() - viewer.pausedAt) / 1000,
          allowanceSeconds: segmentDurationSec,
          urgentReady: sourcePreparation.urgentReadyFor(viewer) });
        return Math.max(1, 1 + Math.floor((priority - 1) * coefficient));
      }
      return outputParts.priority.priorityFor(output, viewer, priority, viewerCount);
    },
    inputReady: async work => {
      const torrent = torrentPool.knownTorrent(work.sourceKey);
      if (!torrent || !work.inputRanges?.length) return false;
      const held = await torrentPool.heldRangesOf(torrent, work.fileIndex);
      return work.inputRanges.every(([start, end]) => held.some(([from, to]) => from <= start && to >= end));
    },
    sourceRestNeededFor: (sourceKey, fileIndex) => ![...outputs.values()].some(output =>
      output.file?.sourceKey === sourceKey && output.file?.fileIndex === fileIndex &&
      viewers.forOutput(output).size > 0),
    playbackAppliedFor: (sourceKey, fileIndex) => downloadMaps.hasAppliedPlayback(sourceKey, fileIndex),
    readyChanged: (work, ready) => logger.info(`source urgent request=${work.requestId} viewer=${work.ownerId} ` +
      `source=${work.sourceKey} file=${work.fileIndex} inputReady=${ready}`),
    inspect: work => preparationReads.inspect(work, sourcePreparation),
    withdraw: work => {
      if (work.role === "source-rest" && work.statement === "packets") {
        void downloadMaps.native({ sourceKey: work.sourceKey, fileIndex: work.fileIndex, zones: [] })
          .catch(error => logger.warn(`native source map withdrawal failed: ${error.message}`));
      }
      mediaReads.retain(work.sourceKey, work.fileIndex, params => params.requestId !== work.requestId);
      void downloadMaps.withdrawMetadata(work.sourceKey, work.fileIndex, `${work.statement}:${work.requestId}`)
        .catch(error => logger.warn(`source preparation request=${work.requestId} withdrawal failed: ${error.message}`));
      void downloadMaps.withdrawMetadata(work.sourceKey, work.fileIndex, `${work.statement}:${work.requestId}:input`)
        .catch(error => logger.warn(`source preparation request=${work.requestId} input withdrawal failed: ${error.message}`));
      if (!sourcePreparation.ownsFile(work.sourceKey, work.fileIndex)) {
        probeReads.withdraw(work.sourceKey, work.fileIndex);
        void downloadMaps.withdrawMetadata(work.sourceKey, work.fileIndex, "codec-probe")
          .catch(error => logger.warn(`source preparation request=${work.requestId} probe withdrawal failed: ${error.message}`));
      }
    },
    reprice: (work, demand) => {
      if (work.nativeInput) void preparationReads.publishNative(work, sourcePreparation)
        .catch(error => logger.warn(`native source map repricing failed: ${error.message}`));
      void downloadMaps.repriceMetadata(work.sourceKey, work.fileIndex, `${work.statement}:${work.requestId}`, demand)
        .catch(error => logger.warn(`source preparation request=${work.requestId} repricing failed: ${error.message}`));
      void downloadMaps.repriceMetadata(work.sourceKey, work.fileIndex, `${work.statement}:${work.requestId}:input`, demand)
        .catch(error => logger.warn(`source preparation request=${work.requestId} input repricing failed: ${error.message}`));
    },
    failed: error => logger.warn(`source preparation failed: ${error?.message ?? error}`)
  });
  outputParts.subtitleReadyFor = viewer => sourcePreparation.subtitleReadyFor(viewer);
  const playbackPlanner = createPlaybackPlanner({
    ffmpegBin,
    transcodeAudioEnabled: transcodeAudio,
    localBaseUrl,
    sourceRegistry,
    torrentPool,
    subscribeSource: (sourceKey, fileIndex, listener) => mediaReads.subscribe(sourceKey, fileIndex, listener),
    readDeclarations: async ({ sourceKey, fileIndex }) => {
      const params = await mediaParams.paramsFor({ sourceKey, fileIndex });
      if (!params) return { kind: "terminal", reason: "source-forgotten" };
      return readPlaybackDeclarations(containerOrchestrator, params);
    },
    sidecarsFromTorrent: (torrent, fileIndex) => contentsOf(torrent).sidecarsOf(fileIndex),
    // What a file declares about its own tracks, parsed on this thread from the
    // header the swarm delivered. The planner used to ask the torrent pool for
    // this, which meant the media layer asking the torrent layer to parse a
    // container on its behalf, in the other thread, with the answer carried
    // back over the channel.
    declaredTracksOf: async ({ sourceKey, fileIndex }) => {
      const params = await mediaParams.paramsFor({ sourceKey, fileIndex });
      return params ? await containerOrchestrator.getTracks(params) : [];
    },
    warmKeyframeIndex: (params) => keyframeTables.warm(params),
    // The quality menu is on screen from the moment a file is opened, so the
    // heights this host can actually serve have to be answerable before any
    // encoder exists — from the probe and the startup benchmarks alone.
    predictOfferedHeights: (mediaInfo) => quality.predictOfferedHeights(mediaInfo)
  });

  app.get("/health", async (req, reply) => handleHealthGet(req, reply, { version }));
  app.get("/media", async (req, reply) => handleMediaGet(req, reply, {
    torrentPool,
    onMissing: ({ sourceKey, fileIndex, start, end, requestId }) => {
      logger.info(`media request=${requestId} ${sourceKey}:${fileIndex} needs bytes ${start}-${end}`);
      probeReads.needs(requestId, start, end);
    }
  }));
  app.get("/api/sources/:sourceKey/chapters", async (req, reply) =>
    handleApiSourceChaptersGet(req, reply, { chapterController })
  );
  app.get("/healthz", async (req, reply) => handleHealthzGet(req, reply, { version }));
  // Off unless --delivery-sink was given; see the route for why it exists.
  app.get("/api/delivery-sink", async (req, reply) =>
    handleApiDeliverySinkGet(req, reply, { enabled: deliverySink === true })
  );
  // Bytes a browser can time its link with before any film has been chosen.
  app.get("/api/link-probe", async (req, reply) => handleApiLinkProbeGet(req, reply));
  app.post("/api/sources", async (req, reply) => {
    // A cold start begins with the first source opened (torrent-tv/meta#177).
    startupProfile.begin();
    return handleApiSourcesPost(req, reply, { sourceRegistry, viewers,
      associateWaitTrace: (request, sourceKey) => waitTrace.associate(request, sourceKey) });
  });
  app.get("/api/sources/:sourceKey/stats", async (req, reply) =>
    handleApiSourceStatsGet(req, reply, { sourceRegistry, torrentPool, viewerRequests })
  );
  app.get("/api/sources/:sourceKey/files", async (req, reply) =>
    handleApiSourceFilesGet(req, reply, { sourceRegistry, torrentPool, viewers,
      viewerRequests })
  );
  app.get("/api/sources/:sourceKey/files/:fileIndex/fingerprint", async (req, reply) =>
    handleApiSourceFingerprintGet(req, reply, {
      sourceRegistry,
      inspectFingerprint: async (address) => {
        const params = await mediaParams.paramsFor(address);
        return params ? containerOrchestrator.inspect(params, "fingerprint") : { kind: "pending" };
      }
    })
  );
  // What the opened file states about the work, and its cover: read only from
  // the edges of the file, which opening it fetches anyway (meta#139).
  const workTagsReport = new WorkTagsReport({ log: line => logger.info(line) });
  app.get("/api/sources/:sourceKey/files/:fileIndex/container-metadata", async (req, reply) =>
    handleApiSourceContainerMetadataGet(req, reply, {
      sourceRegistry,
      inspectWorkTags: async (address) => {
        const params = await mediaParams.paramsFor(address);
        const result = params ? await containerOrchestrator.inspect(params, "work-tags") : { kind: "pending" };
        workTagsReport.note(address, params?.label ?? "", result);
        return result;
      }
    })
  );
  app.get("/api/sources/:sourceKey/files/:fileIndex/cover", async (req, reply) =>
    handleApiSourceCoverGet(req, reply, {
      sourceRegistry,
      inspectCover: async (address) => {
        const params = await mediaParams.paramsFor(address);
        return params ? containerOrchestrator.inspect(params, "cover") : { kind: "pending" };
      }
    })
  );
  app.post("/api/sources/:sourceKey/warm", async (req, reply) =>
    handleApiSourceWarmPost(req, reply, {
      sourceRegistry,
      viewers
    })
  );
  app.post("/api/sources/:sourceKey/files/:fileIndex/viewer", async (req, reply) =>
    handleApiSourceViewerPost(req, reply, { sourceRegistry, viewers })
  );
  // The browser's own log, kept beside the proxy's: a file per session when
  // the proxy writes its log to a file, its console otherwise. See the route's
  // own file for why it is here and not only on the registry server.
  const clientLogs = logFile
    ? createClientLogFiles(logFile)
    : createClientLogConsole((message) => logger.info(message));
  app.post("/api/client-logs", async (req, reply) =>
    handleApiClientLogsPost(req, reply, { clientLogs, viewerRequests })
  );
  app.post("/api/playback-plan", async (req, reply) =>
    handleApiPlaybackPlanPost(req, reply, { playbackPlanner, viewers,
      observeWait: (sourceKey, event, fields) => waitTrace.source(sourceKey, event, fields) })
  );
  app.post("/api/playback-plan/audio-tracks", async (req, reply) =>
    handleApiPlaybackPlanAudioTracksPost(req, reply, { playbackPlanner })
  );
  app.post("/api/subtitles", async (req, reply) => handleApiSubtitlesPost(req, reply, {
    viewers, sourceRegistry,
    subtitleTracksFor: (sourceKey, fileIndex) =>
      (containerOrchestrator.tracks.get(`${sourceKey}:${fileIndex}`) ?? []).filter(track => track.type === "subtitle"),
    subtitleFilesFor: (sourceKey, fileIndex) => {
      const torrent = torrentPool.knownTorrent(sourceKey);
      return torrent && Number.isSafeInteger(fileIndex)
        ? contentsOf(torrent).sidecarsOf(fileIndex).subtitles.map(file => file.fileIndex) : [];
    }
  }));
  app.get("/api/subtitles", async (req, reply) =>
    handleApiSubtitlesGet(req, reply, {
      sourceRegistry,
      torrentPool,
      viewers,
      subtitles: subtitleWalk.subtitles
    })
  );
  app.get("/encode-input/:token/:fileIndex", (req, reply) =>
    handleEncodeInputGet(req, reply, { inputOf: token => encodeRuns.originalInputOf(token),
      noteFirstInputBytes: (token, fileIndex, bytes) => encodeRuns.noteFirstInputBytes(token, fileIndex, bytes),
      refused: ({ fileIndex, start, runTag }) => logger.warn(`encode input: run ${runTag ?? "?"} asked for byte ${start} of file ${fileIndex}, which it was not given`) })
  );
  app.get("/stream", async (req, reply) =>
    handleStreamGet(req, reply, {
      sourceRegistry,
      torrentPool,
      // So a session that has produced nothing yet can still show it is being
      // fed. The route knows only files; the session id rides on the URL the
      // session itself built.
      noteInputBytes: (sessionId, bytes) => encodeRuns.noteInputBytes(sessionId, bytes),
      noteFirstInputBytes: (token, fileIndex, bytes) => encodeRuns.noteFirstInputBytes(token, fileIndex, bytes),
      // When the encoder reading this waits for its input, so its speed is
      // measured over its own work and not over the swarm's.
      noteInputWaiting: (runToken, waiting) => encodeRuns.noteInputWaiting(runToken, waiting)
    })
  );
  app.post("/api/transcode-sessions", async (req, reply) =>
    handleApiTranscodeSessionsPost(req, reply, { viewerRequests, renditions, quality, outputs, lookaheadSeconds, sourceRegistry, torrentPool,
      subscribeSource: (sourceKey, fileIndex, listener) => mediaReads.subscribe(sourceKey, fileIndex, listener) })
  );
  app.post("/api/transcode-sessions/:sessionId/release", async (req, reply) =>
    handleApiTranscodeSessionReleasePost(req, reply, { lifecycle })
  );
  app.get("/api/transcode-sessions/:sessionId/progress", async (req, reply) =>
    handleApiTranscodeSessionsProgressGet(req, reply, { viewerRequests })
  );
  app.post("/api/transcode-sessions/:sessionId/net-report", async (req, reply) =>
    // A viewer's statement about itself goes to the VIEWER layer, not through
    // the session manager: what it needs is the live sessions and the registry
    // of viewers, and nothing about encoding.
    handleApiTranscodeSessionNetReportPost(req, reply, {
      outputs,
      viewers,
      renditions,
      quality,
      planSoon: () => encodeRuns.planEncodersSoon(),
      segmentAt: (output, seconds) => {
        // A cut table not built yet has no pieces to move between.
        try { return outputTimes.segmentIndexForTime(output, seconds); } catch { return null; }
      }
    })
  );
  app.post("/api/transcode-sessions/:sessionId/fragment-far", async (req, reply) =>
    handleApiTranscodeSessionFragmentFarPost(req, reply, { serving })
  );
  app.post("/api/transcode-sessions/:sessionId/seek", async (req, reply) =>
    handleApiTranscodeSessionSeekPost(req, reply, { viewerRequests })
  );
  app.get("/transcode/:sessionId/:fileName", async (req, reply) =>
    handleTranscodeSessionFileGet(req, reply, { serving, viewerRequests })
  );
  // A quality variant's files. Registered before the static handler for the
  // same reason as the line above, and kept a separate route rather than a
  // wildcard so the height stays a parsed parameter.
  // Registered BEFORE the variant file route: `warm` is not a file name, and
  // Fastify matches a static segment ahead of a parameter either way — stated
  // here so the order is not "tidied" into a bug.
  app.get("/transcode/:sessionId/v/:height/warm", async (req, reply) =>
    handleTranscodeVariantWarmGet(req, reply, { renditions, serving, viewerRequests })
  );
  app.get("/transcode/:sessionId/a/:track/warm", async (req, reply) =>
    handleTranscodeAudioWarmGet(req, reply, { renditions, serving, viewerRequests })
  );
  app.get("/transcode/:sessionId/a/:trackIndex/:fileName", async (req, reply) =>
    handleTranscodeAudioFileGet(req, reply, { renditions, serving, viewerRequests })
  );
  app.get("/transcode/:sessionId/v/:height/:fileName", async (req, reply) =>
    handleTranscodeVariantFileGet(req, reply, { renditions, serving, viewerRequests })
  );

  app.addHook("onClose", async () => {
    // Order matters: stop the ffmpeg readers (HLS sessions) before destroying
    // the torrents whose files they read from, then remove the torrent data.
    await lifecycle.disposeAll();
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
    mediaMemory: { packetIndexBytes: () => indexMemory.packetBytes() },
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
