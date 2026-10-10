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
import { handleHealthGet } from "./routes/health/get.js";
import { handleMediaGet } from "./routes/media/get.js";
import { ProbeRequests } from "./services/media/ProbeRequests.js";
import { IndexMemory } from "./services/storage/IndexMemory.js";
import { probePackets } from "./services/media/probe-packets.js";
import { segmentDemands, sourceDeadline } from "./services/viewer/segment-demands.js";
import { SourcePreparation } from "./services/viewer/SourcePreparation.js";
import { handleHealthzGet } from "./routes/healthz/get.js";
import { handleApiDeliverySinkGet } from "./routes/api/delivery-sink/get.js";
import { handleApiLinkProbeGet } from "./routes/api/link-probe/get.js";
import { handleApiSourcesPost } from "./routes/api/sources/post.js";
import { handleApiSourceStatsGet } from "./routes/api/sources/stats/get.js";
import { handleApiSourceFilesGet } from "./routes/api/sources/files/get.js";
import { handleApiSourceFingerprintGet } from "./routes/api/sources/fingerprint/get.js";
import { handleApiSourceContainerMetadataGet } from "./routes/api/sources/container-metadata/get.js";
import { handleApiSourceCoverGet } from "./routes/api/sources/cover/get.js";
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
import { joinedWithinPieces } from "./services/torrent/demand/pieces.js";
import { SubtitleOrchestrator } from "./services/media/SubtitleOrchestrator.js";
import { containerOrchestrator, CONTAINER_HEAD_BYTES, describeWorkTags } from "./services/media/ContainerOrchestrator.js";
import { readPlaybackDeclarations } from "./services/media/read-playback-declarations.js";
import { DownloadMaps } from "./services/viewer/DownloadMaps.js";
import { nativeSourceMap, nativeOriginalSourceMap } from "./services/viewer/NativeSourceMap.js";
import { MediaReadRequests } from "./services/media/MediaReadRequests.js";
import { SegmentInputs } from "./services/media/SegmentInputs.js";
import { ContainerTrack } from "./services/media/tracks/ContainerTrack.js";
import { pauseCoefficient, viewerStartsOn } from "./services/viewer/PriorityMap.js";
import { coalescing } from "./utils/coalesce.js";
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
import { benchmarkAudio } from "./services/encode/audio-calibration.js";
import { logger } from "./utils/logger.js";
import { completedFilesRoot } from "./services/storage/files/CompletedFiles.js";

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
  // What viewers' connections carry beyond the film, per byte of film; the
  // transport counts it and is built after this server, so it is late-bound.
  serviceShare = () => null,
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
    onHoldingsChanged: () => onStateChanged(),
    onSourceForgotten: ({ sourceKey }) => {
      sourcePreparation?.forget(sourceKey);
      mediaReads.forget(sourceKey);
      probeReads.forget(sourceKey);
      subtitles.forget(sourceKey);
      keyframeTables.forget(sourceKey);
      playbackPlanner.forget(sourceKey);
      indexMemory.forget(sourceKey);
      downloadMaps.retire(sourceKey);
      for (const key of segmentSourceRanges.keys()) if (key.startsWith(`${sourceKey}:`)) segmentSourceRanges.delete(key);
      outputParts.encodeInputs?.bytesChanged();
    },
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
        mediaReads.bytesChanged(sourceKey, fileIndex);
        probeReads.bytesChanged(sourceKey, fileIndex);
        void sourcePreparation?.bytesChanged(sourceKey, fileIndex).catch(error =>
          logger.warn(`source input readiness failed: ${error.message}`));
        void pushFreshCues(`${sourceKey}:${fileIndex}`, sourceKey, fileIndex);
        // A keyframe table somebody asked for while its bytes had not arrived
        // is read again now; nothing was recorded for that wait.
        keyframeTables.readAgainIfUnanswered({ sourceKey, fileIndex, logName: String(fileIndex) });
      }
      outputParts.encodeInputs?.bytesChanged();
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
  const audioCalibration = transcodeAudio
    ? await benchmarkAudio({ ffmpegBin, logger })
    : [];
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
   * name, a length, its one container, which ranges are downloaded whole, how
   * to read one of those without asking the swarm, the portion one read may
   * span, and where the viewers stand. File offsets and the bitfield stay in
   * the torrent's thread; the piece length crosses as a plain number.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @param {object} [known] - The torrent handle when the caller already has it.
   * @returns {Promise<import("./services/media/SubtitleCues.js").HeldFile | null>}
   */
  const heldFileFor = async (sourceKey, fileIndex, known = null) => {
    let torrent = known;
    if (!torrent) {
      torrent = torrentPool.knownTorrent(sourceKey);
      if (!torrent) return null;
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
      portionBytes: Number(torrent.pieceLength) > 0 ? Number(torrent.pieceLength) : undefined,
      // The file's ONE container — the one the track table, the media info and
      // the keyframe table are read from. Built here only when nobody has built
      // it yet, so a pass of the walk does not fetch the file's edges again.
      container: async () => {
        const known = containerOrchestrator.known(sourceKey, fileIndex);
        if (known !== undefined) {
          return known;
        }
        const params = await containerOver({ sourceKey, fileIndex, tailBytes: CONTAINER_HEAD_BYTES });
        return params ? containerOrchestrator.containerFor(params) : null;
      },
      heldRanges: () => torrentPool.heldRangesOf(torrent, fileIndex),
      readHeld: (start, end) => torrentPool.readHeldOf(torrent, fileIndex, start, end),
      // Where the viewers of this file stand: the start of every urgent stretch
      // of its priority map, which is where each viewer's own need begins.
      wantedSeconds: () => viewerStartsOn(outputParts.priority?.mapFor(sourceKey, fileIndex)),
      // A pass left readable clusters for the next one: run it.
      askAgain: () => {
        void pushFreshCues(`${sourceKey}:${fileIndex}`, sourceKey, fileIndex);
      }
    };
  };
  /**
   * Walk whatever new cues a file now holds and push them to the viewers.
   *
   * One walk of a file at a time, and one more after it whenever pieces
   * arrived meanwhile (`coalescing`): `verified` fires per piece, so a queue of
   * identical passes would only postpone the one with something new to find,
   * and dropping them — as this used to — lost the pass that would have found
   * the last pieces of a file.
   */
  const pushFreshCues = coalescing(async (sourceKey, fileIndex) => {
    try {
      const file = await heldFileFor(sourceKey, fileIndex);
      if (!file) {
        return;
      }
      for (const entry of await warmSubtitleCues(file)) {
        if (subtitles.hasPacketCues(sourceKey, fileIndex, entry.trackIndex)) continue;
        const span = entry.spanStartSeconds === null
          ? "empty"
          : `${entry.spanStartSeconds.toFixed(1)}-${entry.spanEndSeconds.toFixed(1)}s`;
        logger.info(
          `subtitle push ${sourceKey.slice(0, 8)}:${fileIndex} track ${entry.trackIndex}: ` +
          `${entry.cues.length} new cue(s) covering ${span}` +
          (entry.withdrawn.length > 0 ? `, ${entry.withdrawn.length} taken back` : "") +
          `, clusters walked ${entry.walkedClusters}/${entry.indexedClusters}, cursor ${entry.cursor}`
        );
        onSubtitleCues?.({ sourceKey, fileIndex, ...entry });
      }
    } catch (error) {
      logger.warn(`subtitle push ${sourceKey.slice(0, 8)}:${fileIndex} failed: ${error?.message ?? error}`);
    }
  });
  const subtitles = new SubtitleOrchestrator(containerOrchestrator, {
    publish: entry => onSubtitleCues?.(entry),
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
  // Missing metadata bytes are demand in the same file map as playback.
  // Readers never start their own downloads or wait for source bytes.
  /** Source byte ranges of one segment interval, by file and interval; forgotten with the source. */
  const segmentSourceRanges = new Map();
  const downloadMaps = new DownloadMaps({
    publish: (map) => torrentPool.setPriorityMap(map),
    log: (line) => logger.info(line),
    resolvePlayback: async (map) => {
      if (map.zones.length === 0) return [];
      const params = await containerOver(map);
      if (!params || !map.isCurrent()) return [];
      const tracks = await containerOrchestrator.inspect(params, "tracks");
      if (tracks.kind !== "result" || !map.isCurrent()) return [];
      const container = containerOrchestrator.known(map.sourceKey, map.fileIndex);
      if (typeof container?.readSourceRanges !== "function" && typeof container?.readPacketIndex !== "function") return [];
      const media = await containerOrchestrator.inspect(params, "media-info");
      if (media.kind !== "result" || !map.isCurrent()) return [];
      const shift = Number(media.value?.startTimeSeconds) || 0;
      // A zone's ranges are stated to the torrent at the precision it fetches:
      // ranges closer than a piece hold the same pieces as one.
      const pieceLength = Number(torrentPool.knownTorrent(map.sourceKey)?.pieceLength);
      const converted = [];
      const demands = [];
      for (const output of outputParts.outputs.values()) {
        if (output.file.sourceKey !== map.sourceKey) continue;
        const consumers = [...outputParts.viewers.forOutput(output).values()].filter(viewer =>
          viewer.isPresent() && !outputParts.outputs.supersededBy(output, viewer.activeVariantId ?? null));
        if (consumers.length === 0) continue;
        const inventory = outputParts.segmentStore.sizesOf(output.outputKey);
        let bytes = 0, seconds = 0;
        for (const [index, size] of inventory) {
          const span = output.timeline.publishedStartOf(index + 1) - output.timeline.publishedStartOf(index);
          if (span > 0) { bytes += size; seconds += span; }
        }
        const links = consumers.map(viewer => viewer.linkReading()?.linkMbps)
          .filter(value => Number.isFinite(value) && value > 0);
        const encodeSpeed = outputParts.encodeCost.latestSpeedReadingOf(output)?.speed;
        for (const demand of segmentDemands(output, map.fileIndex, map.zones)) {
          if (inventory.has(demand.index)) continue;
          const deadlineAt = sourceDeadline(demand, { encodeSpeed,
            outputBytes: seconds > 0 ? bytes / seconds * (demand.to - demand.from) : null,
            linkMbps: links.length ? Math.min(...links) : null });
          const leadSeconds = Number.isFinite(demand.deadlineAt) ? Math.max(0, (demand.deadlineAt - deadlineAt) / 1000) : 0;
          demands.push({ ...demand, deadlineAt, leadSeconds, outputKey: output.outputKey,
            sourceInterval: output.timeline.sourceInterval(demand.index, demand.index, shift) });
        }
      }
      demands.sort((left, right) => left.deadlineAt - right.deadlineAt || right.priority - left.priority || left.index - right.index);
      // A container that names the bytes of an interval from an index it holds
      // answers every segment by arithmetic: once that index is read
      // ("source-navigation"), the ranges are computed here directly instead of
      // through the file's queue of reads, three steps per segment. On Home
      // Assistant those steps made a pass over a two-hour AVI take minutes while
      // the arithmetic takes milliseconds (torrent-tv/meta#151).
      const navigated = await containerOrchestrator.inspect(params, "source-navigation");
      if (!map.isCurrent()) return [];
      const direct = navigated.kind === "result" && navigated.value === true &&
        typeof container?.readSourceRanges === "function" ? container : null;
      for (const zone of demands) {
        if (!map.isCurrent()) return [];
        const selected = zone.tracks.map(choice => ({ choice, track: choice.type === "video"
          ? ContainerTrack.firstUsable(tracks.value, "video")
          : tracks.value.filter(track => track.type === choice.type)[choice.index] }));
        if (selected.some(({ track }) => !track)) continue;
        const wanted = selected.map(({ track }) => track);
        const modes = new Map(selected.map(({ choice, track }) => [track, choice.mode]));
        const interval = { ...zone.sourceInterval, trackIds: wanted.map(track => track.trackNumber),
          modes: Object.fromEntries(wanted.map(track => [track.trackNumber, modes.get(track)])) };
        const { tracks: _choices, owner: _owner, sourceInterval: _sourceInterval, ...demand } = zone;
        const convert = ranges => {
          for (const [byteStart, byteEnd] of joinedWithinPieces(ranges, pieceLength)) converted.push({ ...demand,
            downloadInterval: { from: zone.owner.from, to: zone.owner.to }, byteStart, byteEnd });
        };
        // The bytes one segment needs are a fact of the file and the output, so
        // they are worked out once. A whole film is thousands of segments and
        // the map changes every few seconds; worked out afresh on every change,
        // a pass over a two-hour AVI never finished and the next segment's bytes
        // were never asked for (Home Assistant 2026-10-08, torrent-tv/meta#151).
        const rangesKey = `${map.sourceKey}:${map.fileIndex}:${JSON.stringify(interval)}`;
        const known = segmentSourceRanges.get(rangesKey);
        if (known) { convert(known); continue; }
        if (direct) {
          // Asked per zone too: a soundtrack of an AVI is read from its own
          // packets, which the same index states (torrent-tv/meta#166).
          let value = null;
          try {
            if (await direct.supportsOriginalSourceRanges(interval) === true) value = await direct.readSourceRanges(interval);
            else {
              const index = await direct.readPacketIndex(interval);
              await index.prepareAudioDependencies?.(interval, direct.readRange);
              value = new SegmentInputs({ index, tracks: wanted }).forInterval({ ...interval, mode: track => modes.get(track) });
            }
          } catch { value = null; }
          if (!map.isCurrent()) return [];
          if (value?.kind === "result") {
            segmentSourceRanges.set(rangesKey, value.ranges);
            convert(value.ranges);
            continue;
          }
        }
        const intervalParams = await containerOver({ ...map, packetInterval: interval,
          requestId: `download:${map.sourceKey}:${map.fileIndex}:${zone.outputKey}:${zone.index}`,
          demand: { ...zone.owner, leadSeconds: zone.leadSeconds } });
        if (!map.isCurrent()) return [];
        if (!intervalParams) continue;
        const navigation = await containerOrchestrator.inspect(intervalParams, "source-navigation");
        if (navigation.kind !== "result") continue;
        const originalRanges = navigation.value;
        const packets = await containerOrchestrator.inspect(intervalParams, originalRanges ? "source-ranges" : "packets");
        if (!map.isCurrent()) return [];
        if (packets.kind !== "result") continue;
        const input = originalRanges ? packets.value : new SegmentInputs({ index: packets.value, tracks: wanted }).forInterval({ ...interval, mode: track => modes.get(track) });
        if (input.kind !== "result") continue;
        segmentSourceRanges.set(rangesKey, input.ranges);
        convert(input.ranges);
      }
      return converted;
    }
  });
  const mediaReads = new MediaReadRequests({
    read: (params, statement) => statement === "subtitle-file" ? subtitles.inspectFile(params)
      : statement === "subtitle-cues" ? subtitles.inspectPackets(params) : containerOrchestrator.inspect(params, statement),
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
    reviseBudget: () => { void outputParts.machineBudget.revise().catch(error => logger.warn(`packet index budget: ${error.message}`)); },
    changed: () => { mediaReads.memoryChanged(); probeReads.memoryChanged(); outputParts.encodeInputs?.memoryChanged(); }
  });
  const containerOver = async ({ sourceKey, fileIndex, requestId, packetInterval, demand }) => {
    const record = sourceRegistry.get(sourceKey);
    if (!record) {
      return null;
    }
    const torrent = torrentPool.knownTorrent(sourceKey);
    const file = torrent?.files?.[fileIndex];
    if (!file || !(file.length > 0)) {
      return null;
    }
    const params = {
      sourceKey,
      fileIndex,
      requestId,
      packetInterval,
      packetMemory: indexMemory.forFile(sourceKey, fileIndex),
      downloadInterval: demand ? { from: demand.from, to: demand.to } : null,
      readRange: (start, end) =>
        torrentPool.readHeldOf(torrent, fileIndex, start, Math.min(end, file.length - 1)),
      fileSize: file.length,
      probe: (statement, onRecord) => probeReads.read({ sourceKey, fileIndex, statement: `ffprobe:${statement}`,
        probe: ({ requestId, signal }) => {
          const url = new URL("/media", outputParts.localBaseUrl);
          url.searchParams.set("sourceKey", sourceKey);
          url.searchParams.set("fileIndex", String(fileIndex));
          url.searchParams.set("readId", requestId);
          return probePackets({ url: url.toString(), statement, signal, onRecord });
        } }),
      label: String(file.name ?? ""),
      fileOffset: file.offset,
      onTracks: (tracks) => contentsOf(torrent).noteVideo(fileIndex, tracks.some((track) => track.type === "video")),
      onReadStart: () => ({ storage: mediaReads.revision(sourceKey, fileIndex), memory: mediaReads.memoryRevision(), demand: downloadMaps.epoch(sourceKey, fileIndex) }),
      onReadResult: async (statement, result, revision) => {
        if (revision.demand !== downloadMaps.epoch(sourceKey, fileIndex)) return;
        if (demand && !downloadMaps.wantsInterval(sourceKey, fileIndex, demand)) return;
        if (statement === "keyframes" && result.kind === "result") {
          keyframeTables.learn(params, { times: result.value?.times ?? null, tolerance: result.value?.tolerance ?? 0,
            format: containerOrchestrator.known(sourceKey, fileIndex)?.formatName ?? "unrecognised" });
        }
        const finished = mediaReads.record(params, statement, result, revision.storage, revision.memory);
        await downloadMaps.metadata({ sourceKey, fileIndex, statement: requestId ? `${statement}:${requestId}` : statement, result,
          ...(demand ? { priority: demand.priority, urgent: demand.urgent, deadlineAt: demand.deadlineAt, interval: demand, leadSeconds: demand.leadSeconds ?? 0 } : {}) });
        if (finished && result.kind === "result") {
          void downloadMaps.refresh(sourceKey, fileIndex).catch(error =>
            logger.warn(`download map source=${sourceKey} file=${fileIndex} metadata refresh failed: ${error?.message ?? error}`));
        }
      },
      portionBytes: Number(torrent.pieceLength) > 0 ? Number(torrent.pieceLength) : undefined
    };
    return params;
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
        copyable: index?.copyable,
        // Which container answered, whether or not it produced a table: the
        // refusal that follows names it, and a measurement of how often an
        // index disagrees with its own file cannot be read without it.
        format: (await containerOrchestrator.getContainer(params))?.formatName ?? "unrecognised"
      };
    }
  });
  let sourcePreparation;
  const outputParts = wireOutputs({
    indexMemory,
    serviceShare,
    readMetadataActivity: () => containerOrchestrator.activity(),
    onViewerChanged: () => { void sourcePreparation?.refresh(); onStateChanged(); },
    onEncodersChanged: () => onStateChanged(),
    sourceInputsFor: (output, index) => downloadMaps.inputsForOutput(output.file.sourceKey, output.outputKey, index),
    readSourceMedia: async (params) => {
      await playbackPlanner.getPlan(params);
      const media = playbackPlanner.getCachedMediaInfo(params);
      if (media) return media;
      const error = new Error("Source media declarations require more available bytes.");
      error.code = "MEDIA_BYTES_UNAVAILABLE";
      error.canRetry = true;
      throw error;
    },
    // `timing`, when given, is told how long each read of a file waited behind
    // the reads asked before it and how long it took (torrent-tv/meta#166).
    resolveEncodeInput: async (output, fromIndex, toIndex, timing = null) => {
      const grid = output.timeline?.published ?? output.timeline?.boundaries;
      const from = grid?.[fromIndex], to = grid?.[toIndex + 1];
      if (!Number.isFinite(from) || !(to > from)) return { kind: "terminal", reason: "output-interval-not-declared" };
      const selected = new Map();
      for (const type of ["video", "audio"]) {
        const spec = output.spec[type];
        if (!spec) continue;
        const list = selected.get(spec.fileIndex) ?? [];
        list.push({ type, index: type === "video" ? null : spec.trackIndex,
          mode: type === "video" ? spec.encode ? "transcode" : "copy" : spec.transcode ? "transcode" : "copy" });
        selected.set(spec.fileIndex, list);
      }
      // Every selected file is read the same way in one run: from the original
      // file when each container can name the bytes the interval needs, from
      // reassembled packets otherwise.
      const files = [];
      for (const [fileIndex, choices] of selected) {
        const params = await containerOver({ sourceKey: output.file.sourceKey, fileIndex });
        if (!params) return { kind: "needs-source" };
        if (timing) {
          params.onTimed = (_statement, waitedMs, readMs) => {
            timing.reads += 1;
            timing.queuedMs += waitedMs;
            timing.readMs += readMs;
          };
        }
        const tracks = await containerOrchestrator.inspect(params, "tracks");
        if (tracks.kind !== "result") return tracks;
        const container = containerOrchestrator.known(params.sourceKey, fileIndex);
        if (typeof container?.readPacketIndex !== "function" && typeof container?.readSourceRanges !== "function") {
          return { kind: "needs-index", reason: "packet-index-not-yet-available" };
        }
        const modes = new Map(), wanted = [];
        for (const choice of choices) {
          // The picture is the first usable video track (torrent-tv/meta#49);
          // a soundtrack keeps the number every list of them uses.
          const track = choice.type === "video" ? ContainerTrack.firstUsable(tracks.value, "video")
            : tracks.value.filter(track => track.type === choice.type)[choice.index];
          if (!track) return { kind: "terminal", reason: "selected-track-is-absent" };
          wanted.push(track); modes.set(track, choice.mode);
        }
        const media = await containerOrchestrator.inspect(params, "media-info");
        if (media.kind !== "result") return media;
        const timeShiftSeconds = Number(media.value?.startTimeSeconds) || 0;
        const sourceInterval = output.timeline.sourceInterval(fromIndex, toIndex, timeShiftSeconds);
        params.packetInterval = { ...sourceInterval,
          trackIds: wanted.map(track => track.trackNumber),
          modes: Object.fromEntries(wanted.map(track => [track.trackNumber, modes.get(track)])) };
        const navigation = await containerOrchestrator.inspect(params, "source-navigation");
        if (navigation.kind !== "result") return navigation;
        files.push({ fileIndex, choices, params, wanted, modes, timeShiftSeconds, sourceInterval, navigable: navigation.value === true });
      }
      const original = output.segmentFormat.supportsOriginalInput === true && files.every(file => file.navigable);
      const sources = [];
      for (const { fileIndex, choices, params, wanted, modes, timeShiftSeconds, sourceInterval } of files) {
        if (original) {
          const ranges = await containerOrchestrator.inspect(params, "source-ranges");
          if (ranges.kind !== "result") return ranges;
          sources.push({ sourceKey: params.sourceKey, fileIndex, timeShiftSeconds,
            input: { ...ranges.value, original: true, selections: wanted.map(track => ({ track,
              index: track.declaredIndex ?? choices.find(choice => choice.type === track.type)?.index ?? 0 })) } });
          continue;
        }
        const packets = await containerOrchestrator.inspect(params, "packets");
        if (packets.kind !== "result") return packets;
        const input = new SegmentInputs({ index: packets.value, tracks: wanted }).forInterval({
          ...sourceInterval, mode: track => modes.get(track) });
        if (input.kind !== "result") return input;
        sources.push({ sourceKey: params.sourceKey, fileIndex, input, timeShiftSeconds });
      }
      return { kind: "result", sources };
    },
    readEncodeRanges: async (source, ranges, maxBytes) => {
      const torrent = torrentPool.knownTorrent(source.sourceKey);
      return torrent ? torrentPool.readHeldRangesOf(torrent, source.fileIndex, ranges, maxBytes) : null;
    },
    // Which bytes of a file are downloaded whole now — what an original
    // input's stretch may extend over. A snapshot: the copy that follows
    // holds the pieces it reads, and refuses where one has gone since.
    readEncodeHeldRanges: async (source) => {
      const torrent = torrentPool.knownTorrent(source.sourceKey);
      return torrent ? torrentPool.heldRangesOf(torrent, source.fileIndex) : [];
    },
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
      void sourcePreparation?.refresh();
      const record = sourceRegistry.get(sourceKey);
      if (!record) {
        return;
      }
      try {
        if (zones.length === 0) {
          mediaReads.retain(sourceKey, fileIndex, params => params.requestId?.startsWith("prepare:"));
          if (!outputParts.viewers.forSource(sourceKey).length) probeReads.forget(sourceKey, fileIndex);
          await downloadMaps.forget(sourceKey, fileIndex, { keepPreparation: true });
          return;
        }
        await downloadMaps.playback({ sourceKey, fileIndex, durationSeconds, zones });
        mediaReads.retain(sourceKey, fileIndex, params => !params.requestId?.startsWith("download:") ||
          zones.some(zone => zone.from === params.downloadInterval?.from && zone.to === params.downloadInterval?.to));
      } catch (error) {
        logger.warn(`download map source=${sourceKey} file=${fileIndex} publication failed: ${error?.message ?? error}`);
      }
    },
    getSourceStats: async (sourceKey, fileIndex, options) => {
      const record = sourceRegistry.get(sourceKey);
      if (!record) {
        return null;
      }
      try {
        const torrent = torrentPool.knownTorrent(sourceKey);
        if (!torrent) return null;
        // Awaited for the same reason as the stats route: this now crosses a
        // thread boundary and returns a promise.
        return await torrentPool.getFileStats(torrent, Number.isInteger(fileIndex) ? fileIndex : null, options);
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
  const publishNative = async work => {
    if (!work.nativeInput || !sourcePreparation.accepts(work)) return Promise.resolve();
    const viewers = outputParts.viewers.forSource(work.sourceKey)
      .filter(viewer => viewer.source.selectedFileIndex === work.fileIndex && viewer.outputs.size === 0);
    const convert = work.nativeInput.container ? nativeOriginalSourceMap : nativeSourceMap;
    const zones = await convert({ ...work.nativeInput, viewers,
      allowanceSeconds: outputParts.segmentDurationSec,
      urgentReadyFor: viewer => sourcePreparation.urgentReadyFor(viewer) });
    if (!sourcePreparation.accepts(work)) return;
    return downloadMaps.native({ sourceKey: work.sourceKey, fileIndex: work.fileIndex, zones });
  };
  sourcePreparation = new SourcePreparation({
    viewers: outputParts.viewers,
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
      const output = [...outputParts.outputs.values()].find(output => output.file?.sourceKey === work.sourceKey &&
        output.file?.fileIndex === fileIndex && outputParts.viewers.forOutput(output).has(viewer.id) &&
        !outputParts.outputs.supersededBy(output, viewer.activeVariantId ?? null));
      const viewerCount = outputParts.viewers.forSource(work.sourceKey)
        .filter(person => person.source.selectedFileIndex === fileIndex).length;
      if (!output) {
        const coefficient = pauseCoefficient({ playing: viewer.playing || viewer.waiting, viewerCount,
          pauseSeconds: viewer.pausedAt === null ? 0 : (Date.now() - viewer.pausedAt) / 1000,
          allowanceSeconds: outputParts.segmentDurationSec,
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
    readyChanged: (work, ready) => logger.info(`source urgent request=${work.requestId} viewer=${work.ownerId} ` +
      `source=${work.sourceKey} file=${work.fileIndex} inputReady=${ready}`),
    inspect: async work => {
      const params = await containerOver(work);
      if (!params) return { kind: "needs-source" };
      params.isCurrent = () => sourcePreparation.accepts(work);
      const originalContainer = work.statement === "packets" ? await containerOrchestrator.containerFor(params) : null;
      const navigation = work.statement === "packets" && work.role !== "subtitle-embedded"
        ? await containerOrchestrator.inspect(params, "source-navigation") : { kind: "result", value: false };
      if (navigation.kind !== "result") return navigation;
      const originalRanges = navigation.value;
      if (!originalRanges && work.statement === "packets" && work.role === "source-rest" && sourcePreparation.accepts(work)) {
        const file = torrentPool.knownTorrent(work.sourceKey)?.files?.[work.fileIndex];
        if (file?.length > 0) {
          const statement = `${work.statement}:${work.requestId}:input`;
          await downloadMaps.metadata({ sourceKey: work.sourceKey, fileIndex: work.fileIndex, statement,
            result: { kind: "needs-ranges", ranges: [[0, file.length - 1]], requestId: statement },
            scope: "preparation", ...sourcePreparation.demandFor(work) });
        }
      }
      if ((work.statement === "packets" && (work.role !== "source-rest" || originalRanges)) || work.role === "subtitle-embedded" && work.statement === "subtitle-cues") {
        const info = await containerOrchestrator.inspect({ ...params, onReadResult: undefined }, "media-info");
        if (info.kind !== "result") return info;
        const positions = outputParts.viewers.forSource(work.sourceKey)
          .filter(viewer => viewer.source.selectedFileIndex === work.fileIndex &&
            (work.ownerId === undefined || viewer.id === work.ownerId))
          .map(viewer => viewer.positionSeconds() ?? 0);
        const from = (positions.length ? Math.min(...positions) : 0) + (Number(info.value?.startTimeSeconds) || 0);
        params.packetInterval = { from, to: from + outputParts.segmentDurationSec };
        if (work.role === "subtitle-embedded") {
          const tracks = await containerOrchestrator.containerFor(params).then(container => container.readTracks());
          const track = tracks.find(track => track.type === "subtitle" && track.declaredIndex === work.trackIndex);
          if (!track || track.isTextBased?.() !== true) return { kind: "terminal", reason: "subtitle-track-not-supported" };
          params.packetInterval.trackIds = [track.trackNumber];
          params.subtitleTrackIndex = work.trackIndex;
        }
      }
      params.onReadResult = async (statement, result, revision) => {
        if (!sourcePreparation.accepts(work)) return;
        mediaReads.record(params, statement, result, revision.storage, revision.memory);
        const inputStatement = `${work.statement}:${work.requestId}:input`;
        if (statement === "source-ranges" && result.kind === "result") {
          if (work.selected) work.inputRanges = result.value.ranges;
          if (work.role === "source-rest") {
            const info = await containerOrchestrator.inspect({ ...params, onReadResult: undefined }, "media-info");
            if (!sourcePreparation.accepts(work)) return;
            if (info.kind === "result") {
              work.nativeInput = { container: originalContainer, durationSeconds: info.value.durationSeconds,
                startTimeSeconds: info.value.startTimeSeconds ?? 0 };
              await publishNative(work);
            }
          } else {
            await downloadMaps.metadata({ sourceKey: work.sourceKey, fileIndex: work.fileIndex,
              statement: inputStatement, result: { kind: "needs-ranges", ranges: result.value.ranges, requestId: inputStatement },
              scope: "preparation", ...sourcePreparation.demandFor(work) });
            if (work.selected) await sourcePreparation.bytesChanged(work.sourceKey, work.fileIndex);
          }
        }
        if (statement === "packets" && work.role === "source-rest" && result.kind === "result") {
          const tracks = await containerOrchestrator.containerFor(params).then(container => container.readTracks());
          const info = await containerOrchestrator.inspect({ ...params, onReadResult: undefined }, "media-info");
          if (!sourcePreparation.accepts(work)) return;
          if (info.kind === "result") {
            work.nativeInput = { index: result.value, tracks, durationSeconds: info.value.durationSeconds,
              startTimeSeconds: info.value.startTimeSeconds ?? 0 };
            await publishNative(work);
          }
        }
        if (statement === "packets" && work.role !== "source-rest" && result.kind === "result" && (work.selected || work.ownerFileIndex !== undefined)) {
          const tracks = await containerOrchestrator.containerFor(params).then(container => container.readTracks());
          if (!sourcePreparation.accepts(work)) return;
          const bounds = tracks.filter(track => ["video", "audio"].includes(track.type))
            .map(track => result.value.boundsOf(track.trackNumber)).filter(Boolean);
          const interval = params.packetInterval ?? (bounds.length ? {
            from: Math.max(0, Math.min(...bounds.map(bound => bound.start))), to: Math.max(...bounds.map(bound => bound.end))
          } : null);
          if (interval && interval.to > interval.from) {
            const input = work.role === "subtitle-embedded"
              ? result.value.inputFor({ trackId: params.packetInterval.trackIds[0], ...interval })
              : new SegmentInputs({ index: result.value, tracks }).forInterval(interval);
            if (work.selected) work.inputRanges = input.kind === "result" ? input.ranges : null;
            await downloadMaps.metadata({ sourceKey: work.sourceKey, fileIndex: work.fileIndex,
              statement: inputStatement, result: input.kind === "result" ? { kind: "needs-ranges", ranges: input.ranges, requestId: inputStatement } : input,
              scope: "preparation", ...sourcePreparation.demandFor(work) });
            if (work.selected) await sourcePreparation.bytesChanged(work.sourceKey, work.fileIndex);
          }
        }
        if (!sourcePreparation.accepts(work)) return;
        await downloadMaps.metadata({ sourceKey: work.sourceKey, fileIndex: work.fileIndex,
          statement: `${work.statement}:${work.requestId}`, result, scope: "preparation", ...sourcePreparation.demandFor(work) });
        sourcePreparation.result(work, result);
        if (["subtitle-file", "subtitle-cues"].includes(statement)) outputParts.encodeRuns.planEncodersSoon();
      };
      return work.statement === "subtitle-file"
        ? subtitles.inspectFile(params) : work.statement === "subtitle-cues"
          ? subtitles.inspectPackets(params) : containerOrchestrator.inspect(params, originalRanges ? "source-ranges" : work.statement);
    },
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
      if (work.nativeInput) void publishNative(work)
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
    localBaseUrl: outputParts.localBaseUrl,
    sourceRegistry,
    torrentPool,
    subscribeSource: (sourceKey, fileIndex, listener) => mediaReads.subscribe(sourceKey, fileIndex, listener),
    readDeclarations: async ({ sourceKey, fileIndex }) => {
      const params = await containerOver({ sourceKey, fileIndex });
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
      const params = await containerOver({ sourceKey, fileIndex });
      return params ? await containerOrchestrator.getTracks(params) : [];
    },
    warmKeyframeIndex: (params) => keyframeTables.warm(params),
    // The quality menu is on screen from the moment a file is opened, so the
    // heights this host can actually serve have to be answerable before any
    // encoder exists — from the probe and the startup benchmarks alone.
    predictOfferedHeights: (mediaInfo) => outputParts.quality.predictOfferedHeights(mediaInfo)
  });

  app.get("/health", async (req, reply) => handleHealthGet(req, reply, { version }));
  app.get("/media", async (req, reply) => handleMediaGet(req, reply, {
    torrentPool,
    onMissing: ({ sourceKey, fileIndex, start, end, requestId }) => {
      logger.info(`media request=${requestId} ${sourceKey}:${fileIndex} needs bytes ${start}-${end}`);
      probeReads.needs(requestId, start, end);
    }
  }));
  app.get("/healthz", async (req, reply) => handleHealthzGet(req, reply, { version }));
  // Off unless --delivery-sink was given; see the route for why it exists.
  app.get("/api/delivery-sink", async (req, reply) =>
    handleApiDeliverySinkGet(req, reply, { enabled: deliverySink === true })
  );
  // Bytes a browser can time its link with before any film has been chosen.
  app.get("/api/link-probe", async (req, reply) => handleApiLinkProbeGet(req, reply));
  app.post("/api/sources", async (req, reply) =>
    handleApiSourcesPost(req, reply, { sourceRegistry, viewers: outputParts.viewers })
  );
  app.get("/api/sources/:sourceKey/stats", async (req, reply) =>
    handleApiSourceStatsGet(req, reply, { sourceRegistry, torrentPool })
  );
  app.get("/api/sources/:sourceKey/files", async (req, reply) =>
    handleApiSourceFilesGet(req, reply, { sourceRegistry, torrentPool, viewers: outputParts.viewers })
  );
  app.get("/api/sources/:sourceKey/files/:fileIndex/fingerprint", async (req, reply) =>
    handleApiSourceFingerprintGet(req, reply, {
      sourceRegistry,
      inspectFingerprint: async (address) => {
        const params = await containerOver(address);
        return params ? containerOrchestrator.inspect(params, "fingerprint") : { kind: "pending" };
      }
    })
  );
  // What the opened file states about the work, and its cover: read only from
  // the edges of the file, which opening it fetches anyway (meta#139).
  const workTagsLogged = new Set();
  app.get("/api/sources/:sourceKey/files/:fileIndex/container-metadata", async (req, reply) =>
    handleApiSourceContainerMetadataGet(req, reply, {
      sourceRegistry,
      inspectWorkTags: async (address) => {
        const params = await containerOver(address);
        const result = params ? await containerOrchestrator.inspect(params, "work-tags") : { kind: "pending" };
        const key = `${address.sourceKey}:${address.fileIndex}`;
        if (result.kind !== "pending" && result.kind !== "needs-ranges" && !workTagsLogged.has(key)) {
          workTagsLogged.add(key);
          logger.info(`container metadata "${params?.label ?? ""}": ${describeWorkTags(result)}`);
        }
        return result;
      }
    })
  );
  app.get("/api/sources/:sourceKey/files/:fileIndex/cover", async (req, reply) =>
    handleApiSourceCoverGet(req, reply, {
      sourceRegistry,
      inspectCover: async (address) => {
        const params = await containerOver(address);
        return params ? containerOrchestrator.inspect(params, "cover") : { kind: "pending" };
      }
    })
  );
  app.post("/api/sources/:sourceKey/warm", async (req, reply) =>
    handleApiSourceWarmPost(req, reply, {
      sourceRegistry,
      viewers: outputParts.viewers
    })
  );
  app.post("/api/sources/:sourceKey/files/:fileIndex/viewer", async (req, reply) =>
    handleApiSourceViewerPost(req, reply, { sourceRegistry, viewers: outputParts.viewers })
  );
  // The browser's own log, kept beside the proxy's: a file per session when
  // the proxy writes its log to a file, its console otherwise. See the route's
  // own file for why it is here and not only on the registry server.
  const clientLogs = logFile
    ? createClientLogFiles(logFile)
    : createClientLogConsole((message) => logger.info(message));
  app.post("/api/client-logs", async (req, reply) =>
    handleApiClientLogsPost(req, reply, { clientLogs })
  );
  app.post("/api/playback-plan", async (req, reply) =>
    handleApiPlaybackPlanPost(req, reply, { playbackPlanner, viewers: outputParts.viewers })
  );
  app.post("/api/playback-plan/audio-tracks", async (req, reply) =>
    handleApiPlaybackPlanAudioTracksPost(req, reply, { playbackPlanner })
  );
  app.post("/api/subtitles", async (req, reply) => handleApiSubtitlesPost(req, reply, {
    viewers: outputParts.viewers, sourceRegistry,
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
      viewers: outputParts.viewers,
      subtitles
    })
  );
  app.get("/encode-input/:token/:fileIndex", (req, reply) =>
    handleEncodeInputGet(req, reply, { inputOf: token => outputParts.encodeRuns.originalInputOf(token),
      refused: ({ fileIndex, start, runTag }) => logger.warn(`encode input: run ${runTag ?? "?"} asked for byte ${start} of file ${fileIndex}, which it was not given`) })
  );
  app.get("/stream", async (req, reply) =>
    handleStreamGet(req, reply, {
      sourceRegistry,
      torrentPool,
      // So a session that has produced nothing yet can still show it is being
      // fed. The route knows only files; the session id rides on the URL the
      // session itself built.
      noteInputBytes: (sessionId, bytes) => outputParts.encodeRuns.noteInputBytes(sessionId, bytes),
      // When the encoder reading this waits for its input, so its speed is
      // measured over its own work and not over the swarm's.
      noteInputWaiting: (runToken, waiting) => outputParts.encodeRuns.noteInputWaiting(runToken, waiting)
    })
  );
  app.post("/api/transcode-sessions", async (req, reply) =>
    handleApiTranscodeSessionsPost(req, reply, { viewerRequests: outputParts.viewerRequests, renditions: outputParts.renditions, quality: outputParts.quality, outputs: outputParts.outputs, lookaheadSeconds: outputParts.lookaheadSeconds, sourceRegistry, torrentPool,
      subscribeSource: (sourceKey, fileIndex, listener) => mediaReads.subscribe(sourceKey, fileIndex, listener) })
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
