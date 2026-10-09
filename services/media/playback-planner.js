/**
 * @file Playback planner service.
 *
 * Determines whether a torrent file can be served directly or requires
 * HLS audio transcoding from the file's shared container declarations.
 * Results are cached indefinitely (keyed by source + file index).
 */

import { logger } from "../../utils/logger.js";
import { Container } from "./container/Container.js";
import { buildAudioInventory, enrichAudioInventoryFromSidecar } from "./audio-inventory.js";
import { waitForPlan } from "./await-plan.js";
import { playbackDeclarations } from "./playback-declarations.js";

/** Audio codecs that browsers can decode natively without transcoding. */
const DIRECT_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

/** Subtitle codecs that can be converted to WebVTT (text-based). */
const TEXT_SUBTITLE_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "vtt", "mov_text", "text"]);

/**
 * Parse every stream from the ffmpeg `-i` banner: type, codec, language tag,
 * default disposition and (when present) the stream's `title` metadata line.
 *
 * @param {string} ffmpegOutput
 * @returns {Array<{ streamIndex: number, type: string, codec: string, language: string, title: string, isDefault: boolean }>}
 */
/**
 * The bitrate a stream line states for that stream, in kbit/s, or null.
 *
 * @param {string} line
 * @returns {number | null}
 */
function kbpsFromStreamLine(line) {
  const match = line.match(/,\s*(\d+)\s*kb\/s/);
  const kbps = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(kbps) && kbps > 0 ? kbps : null;
}

function parseStreams(ffmpegOutput) {
  // Only the Input section: ffmpeg prints Stream lines for the null OUTPUT
  // too (wrapped_avframe / pcm_s16le), which would duplicate every track.
  const inputSection = ffmpegOutput.split(/^(?:Output #|Stream mapping:)/m)[0] ?? ffmpegOutput;
  const lines = inputSection.split(/\r?\n/);
  const streams = [];
  let current = null;
  for (const line of lines) {
    const streamMatch = line.match(
      /^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([A-Za-z0-9]{2,3})\))?: (Audio|Video|Subtitle): ([A-Za-z0-9_]+)/
    );
    if (streamMatch) {
      current = {
        streamIndex: Number(streamMatch[1]),
        type: streamMatch[3].toLowerCase(),
        codec: String(streamMatch[4]).toLowerCase(),
        language: (streamMatch[2] ?? "").toLowerCase(),
        title: "",
        isDefault: /\(default\)/.test(line),
        // What the stream line states for THIS stream, e.g. "…, 128 kb/s". A
        // Matroska stream usually states none here and carries its rate as a
        // statistics tag instead (`BPS`, read below). Never the file's total.
        bitrateKbps: kbpsFromStreamLine(line)
      };
      streams.push(current);
      continue;
    }
    if (current) {
      const bpsMatch = line.match(/^\s+BPS(?:-[A-Za-z]+)?\s*:\s*(\d+)\s*$/);
      if (bpsMatch && current.bitrateKbps === null) {
        current.bitrateKbps = Math.round(Number(bpsMatch[1]) / 1000);
        continue;
      }
      const titleMatch = line.match(/^\s+title\s*:\s*(.+)$/);
      if (titleMatch && current.title.length === 0) {
        current.title = titleMatch[1].trim();
        continue;
      }
      // A new top-level section (non-indented line) ends the stream's block.
      if (!/^\s/.test(line)) {
        current = null;
      }
    }
  }
  return streams;
}

/**
 * Parse audio and video codec names from ffmpeg stderr output.
 *
 * @param {string} ffmpegOutput
 * @returns {{ audioCodec: string, videoCodec: string }}
 */
export function parseStreamCodecs(ffmpegOutput) {
  const audioMatch = ffmpegOutput.match(/Audio:\s*([A-Za-z0-9_]+)/i);
  const videoMatch = ffmpegOutput.match(/Video:\s*([A-Za-z0-9_]+)/i);
  // Coded resolution from the video Stream line ("Video: h264 …, 1280x720, …").
  // The first WxH is the coded size (any trailing "[SAR …]" is ignored).
  const videoLineMatch = ffmpegOutput.match(/Video:[^\n]*/i);
  let videoWidth = 0;
  let videoHeight = 0;
  if (videoLineMatch) {
    const dim = videoLineMatch[0].match(/\b(\d{2,5})x(\d{2,5})\b/);
    if (dim) {
      videoWidth = Number(dim[1]);
      videoHeight = Number(dim[2]);
    }
  }
  const containerMatch = ffmpegOutput.match(/Input #0,\s*([^,]+(?:,[^,]+)*?),\s*from/i);
  const durationMatch = ffmpegOutput.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  let durationSeconds = 0;
  if (durationMatch) {
    const value =
      Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
    durationSeconds = Number.isFinite(value) ? value : 0;
  }
  const streams = parseStreams(ffmpegOutput);
  const audioTracks = streams
    .filter((s) => s.type === "audio")
    .map((s, i) => ({
      // Type-relative index — what ffmpeg's `-map 0:a:N` selects.
      index: i,
      streamIndex: s.streamIndex,
      codec: s.codec,
      language: s.language,
      title: s.title,
      isDefault: s.isDefault,
      bitrateKbps: s.bitrateKbps
    }));
  const subtitleTracks = streams
    .filter((s) => s.type === "subtitle")
    .map((s, i) => ({
      // Type-relative index — what ffmpeg's `-map 0:s:N` selects.
      index: i,
      streamIndex: s.streamIndex,
      codec: s.codec,
      language: s.language,
      title: s.title,
      isDefault: s.isDefault,
      // Image-based subtitles (PGS/VobSub) cannot become WebVTT.
      textBased: TEXT_SUBTITLE_CODECS.has(s.codec)
    }));
  return {
    audioCodec: audioMatch ? String(audioMatch[1]).toLowerCase() : "",
    videoCodec: videoMatch ? String(videoMatch[1]).toLowerCase() : "",
    container: containerMatch ? String(containerMatch[1]).trim().toLowerCase() : "",
    durationSeconds,
    videoWidth,
    videoHeight,
    audioTracks,
    subtitleTracks
  };
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
 * @property {number} videoWidth        - Source coded width (0 if unknown).
 * @property {number} videoHeight       - Source coded height (0 if unknown).
 * @property {boolean} audioTracksPending - At least one sidecar declaration still needs source bytes.
 */

/**
 * @typedef {Object} PlaybackPlannerOptions
 * @property {boolean} transcodeAudioEnabled
 * @property {string}  localBaseUrl
 * @property {ReturnType<import("../../store/source-registry.js").createSourceRegistry>} sourceRegistry
 * @property {import("../torrent/torrent-pool.js").TorrentPool} torrentPool
 */

/**
 * Create a playback planner that decides the optimal streaming mode for
 * a torrent file. Plans are cached per (sourceKey, fileIndex) pair.
 *
 * @param {PlaybackPlannerOptions} options
 * @returns {{ getPlan: (params: { sourceKey: string, fileIndex: number, userAgent?: string }) => Promise<PlaybackPlan>, refreshAudioTracks: (params: { sourceKey: string, fileIndex: number }) => Promise<{ audioTracks: object[], pending: boolean }> }}
 */
export function createPlaybackPlanner({
  transcodeAudioEnabled,
  localBaseUrl,
  sourceRegistry,
  torrentPool,
  // What the torrent holds beside this picture — its dubs, its subtitle files,
  // its contact sheets — grouped by whoever knows what a torrent contains. This
  // layer answers about ONE file and must not read a torrent's file list.
  sidecarsFromTorrent = null,
  // What a file DECLARES about its own tracks, read from its header. Handed in
  // rather than asked of the torrent pool: this layer used to call
  // `torrentPool.getDeclaredAudioTracks` and friends, which is the media layer
  // asking the torrent layer to parse a container on its behalf — the parse
  // happened in the torrent thread and came back over the channel. It happens
  // on this thread now, and what is passed here is the ordinary container read.
  declaredTracksOf = null,
  readDeclarations = null,
  subscribeSource = null,
  // Optional. Called once the file's edges are downloaded, so the keyframe
  // index — which reads the same tail of the file — is fetched alongside the
  // codec probe instead of after it. It goes straight to `KeyframeTables`,
  // which owns that table: it used to be routed through the session manager,
  // which held a second copy of it and a second reader for it.
  warmKeyframeIndex,
  // Optional. The heights this host could actually serve this source at, for
  // both playback branches, so the quality menu is right from the moment the
  // file is opened rather than from the moment an encoder exists.
  predictOfferedHeights
}) {
  /** @type {Map<string, PlaybackPlan>} */
  const cache = new Map();
  const lifetimes = new Map();
  const pendingSidecarHeaders = new Map();
  const declaredAudioReads = new Map();
  /**
   * Full media info parsed from the SAME probe that produced the plan, cached
   * under the same key so a transcode session can reuse it instead of running
   * a second ffmpeg scan. Only set when the plan is cached (codecs detected).
   * @type {Map<string, { durationSeconds: number | null, width: number | null, height: number | null, fps: number | null, startTime: number, isHdr: boolean }>}
   */
  const mediaInfoCache = new Map();

  /**
   * Attach what this host currently measures itself taking to create a session
   * and to produce a first segment.
   *
   * Read at RESPONSE time, deliberately. Both are medians of sessions that have
   * already finished on this host, so at the moment a plan is BUILT the very
   * first file opened after a restart has none and gets `null` — and the plan
   * is then cached, so that file kept answering `null` for the life of the
   * process however many sessions ran afterwards. Measured 2026-08-05: a fresh
   * 2.9.103 answered `null` for both, then produced the session in 6 ms and the
   * first segment in 21 479 ms. The figures existed; the plan could not carry
   * them, and the browser's estimate fell back to its own guess in exactly the
   * cold-start case the feature was built for.
   *
   * @param {PlaybackPlan} plan
   * @returns {PlaybackPlan}
   */
  /**
   * The probe's subtitle tracks, with `FlagDefault` read from the container
   * instead of inferred from ffmpeg's banner.
   *
   * Best-effort by construction: a container that cannot be read this way, or a
   * reading that does not line up with the probe, leaves the tracks as they
   * were with `declaresDefault: false` — which the browser reads as "the file
   * has no opinion", and then nothing is shown unasked.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {object[]} subtitleTracks
   * @returns {Promise<object[]>}
   */
  /**
   * The files beside this picture that belong to it, in three groups.
   *
   * HANDED IN, because what a torrent contains is the torrent layer's to say
   * and this is the media layer. It works the grouping out once and keeps it;
   * it used to be worked out here on every call, and again on the warm-up's own
   * path over the same list, so one opened film paired the same files several
   * times and neither side could be sure of the other's answer.
   *
   * Absent, a file has no companions — which is what a proxy with no torrent
   * behind it should answer, rather than failing.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @returns {{ audio: object[], subtitles: object[], images: object[] }}
   */
  function sidecarsOf(torrent, fileIndex) {
    return sidecarsFromTorrent?.(torrent ?? {}, fileIndex) ?? { audio: [], subtitles: [], images: [] };
  }

  async function withContainerDefaults(sourceKey, torrent, fileIndex, subtitleTracks) {
    if (subtitleTracks.length === 0 || typeof declaredTracksOf !== "function") {
      return subtitleTracks.map((track) => ({ ...track, declaresDefault: false }));
    }
    let declared = [];
    try {
      declared = (await declaredTracksOf({ sourceKey, fileIndex })).filter((track) => track?.type === "subtitle");
    } catch (error) {
      logger.info(`subtitle defaults: the container could not be read (${error?.message ?? error})`);
    }
    const merged = Container.mergeSubtitleFlags(subtitleTracks, declared);
    logger.info(
      merged.aligned
        ? "subtitle defaults: the container wrote FlagDefault on " +
          `${merged.tracks.filter((track) => track.declaresDefault).length} of ${merged.tracks.length} ` +
          `subtitle tracks, marking ${merged.tracks.filter((track) => track.declaresDefault && track.isDefault).length}`
        : `subtitle defaults: using the probe's own flags — ${merged.reason}`
    );
    return merged.tracks;
  }

  /**
   * Every soundtrack this file can be watched with, as one numbered list: its
   * own tracks and the ones shipped as separate files beside it.
   *
   * Built here, in the plan, because the plan is what the viewer's menu is drawn
   * from — so every playable track gets a stable number before the file opens.
   * Sidecar header fields may arrive later; they enrich an existing numbered
   * entry without changing the inventory length. It is also what
   * the master playlist's rendition group is built from, so the number in the
   * menu and the number in the `a/<n>/` address are the same number by
   * construction rather than by agreement.
   *
   * @param {string} sourceKey
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {object[]} bannerAudioTracks - The probe's own audio streams.
   * @returns {Promise<{ audioTracks: import("./audio-inventory.js").AudioInventoryEntry[], pendingFileIndexes: number[] }>}
   */
  async function declaredAudioOf(sourceKey, wantedFileIndex, label) {
    if (typeof declaredTracksOf !== "function") {
      return { tracks: [], complete: false, timedOut: false };
    }
    const readKey = `${sourceKey}:${wantedFileIndex}`;
    let readPromise = declaredAudioReads.get(readKey);
    if (!readPromise) {
      readPromise = Promise.resolve()
        .then(() => declaredTracksOf({ sourceKey, fileIndex: wantedFileIndex }))
        .then((tracks) => ({
          tracks: tracks
            .filter((track) => track?.type === "audio")
            .sort((left, right) => (left.declaredIndex ?? 0) - (right.declaredIndex ?? 0)),
          // ContainerOrchestrator leaves empty reads uncached because the file
          // header may not have arrived yet. Only a non-empty table proves the
          // read reached the container's track list.
          complete: Array.isArray(tracks) && tracks.length > 0
        }))
        .catch((error) => {
          logger.info(`audio tracks: "${label}" could not be read (${error?.message ?? error})`);
          return { tracks: [], complete: false };
        });
      declaredAudioReads.set(readKey, readPromise);
      readPromise.then(
        () => { if (declaredAudioReads.get(readKey) === readPromise) declaredAudioReads.delete(readKey); },
        () => { if (declaredAudioReads.get(readKey) === readPromise) declaredAudioReads.delete(readKey); }
      );
    }
    try {
      return await readPromise.then((tracks) => {
        return {
          tracks: Array.isArray(tracks?.tracks) ? tracks.tracks : [],
          complete: tracks?.complete === true,
          timedOut: false
        };
      });
    } catch (error) {
      logger.info(`audio tracks: "${label}" could not be read (${error?.message ?? error})`);
      return { tracks: [], complete: false, timedOut: false };
    }
  }

  async function buildInventory(sourceKey, torrent, fileIndex, bannerAudioTracks) {
    const banner = Array.isArray(bannerAudioTracks) ? bannerAudioTracks : [];
    // The picture's own tracks: ffmpeg numbers them, the container declares what
    // they are. Both readings, lined up and checked — see `audio-inventory.js`.
    let embedded = banner.map((track) => ({ ...track, declaresDefault: false }));
    if (banner.length > 0) {
      // The picture's head is already downloaded — the codec probe just read it
      // — so this is a parse and not a wait, but it is bounded like the rest.
      const { tracks: declared } = await declaredAudioOf(sourceKey, fileIndex, "the picture");
      const merged = Container.mergeAudioFlags(banner, declared);
      embedded = merged.tracks;
      logger.info(
        merged.aligned
          ? `audio tracks: the container describes all ${merged.tracks.length}` +
            `${merged.tracks.some((track) => track.isCommentary) ? ", one of them commentary" : ""}` +
            `${merged.tracks.some((track) => track.isVisualImpaired) ? ", one of them described" : ""}`
          : `audio tracks: using the probe's own fields — ${merged.reason}`
      );
    }

    const sidecarFiles = sidecarsOf(torrent, fileIndex);
    // All of them at once. They are separate files with separate headers, and
    // read one after another the waits add up on the path to the first frame.
    const sidecars = await Promise.all(
      sidecarFiles.audio.map(async (file) => ({
        file,
        // A bare elementary stream — `.ac3`, `.dts`, `.mp3` — has no table to
        // read, so nothing is asked of the swarm for it at all.
        ...(file.declaresTracks
          ? await declaredAudioOf(sourceKey, file.fileIndex, file.name)
          : { tracks: [], timedOut: false })
      }))
    );
    const inventory = buildAudioInventory({ embedded, videoFileIndex: fileIndex, sidecars });
    if (sidecars.length > 0) {
      logger.info(
        `audio tracks: ${sidecars.length} file(s) beside the picture carry sound — ` +
        inventory
          .filter((entry) => entry.kind === "sidecar")
          .map((entry) =>
            `a:${entry.index}=${entry.folders.join("/") || "."}/${entry.fileName}` +
            `#${entry.sourceTrackIndex}${entry.codec ? `(${entry.codec})` : ""}`
          )
          .join(" ")
      );
    }
    return {
      audioTracks: inventory,
      pendingFileIndexes: sidecars.filter((sidecar) => sidecar.timedOut).map((sidecar) => sidecar.file.fileIndex)
    };
  }

  async function refreshAudioTracks({ sourceKey, fileIndex }) {
    const cacheKey = `${sourceKey}:${fileIndex}`;
    const plan = cache.get(cacheKey);
    if (!plan) {
      return { audioTracks: Array.isArray(plan?.audioTracks) ? plan.audioTracks : [], pending: false };
    }
    const pendingIndexes = new Set(pendingSidecarHeaders.get(cacheKey) ?? []);
    if (pendingIndexes.size === 0 || typeof declaredTracksOf !== "function") {
      return { audioTracks: plan.audioTracks, pending: false };
    }
    const sourceRecord = sourceRegistry.get(sourceKey);
    if (!sourceRecord) {
      const error = new Error("Source key was not found.");
      error.code = "SOURCE_NOT_FOUND";
      throw error;
    }
    const torrent = await torrentPool.getTorrent(sourceRecord.sourceType, sourceRecord.source);
    const sidecarFiles = sidecarsOf(torrent, fileIndex).audio;
    for (const sidecar of sidecarFiles) {
      if (!pendingIndexes.has(sidecar.fileIndex)) continue;
      const read = await declaredAudioOf(sourceKey, sidecar.fileIndex, sidecar.name);
      if (cache.get(cacheKey) !== plan) return { audioTracks: [], pending: false };
      if (read.timedOut) continue;
      if (read.tracks.length === 0) {
        if (read.complete) pendingIndexes.delete(sidecar.fileIndex);
        continue;
      }
      const audio = read.tracks
        .filter((track) => track?.type === "audio")
        .sort((left, right) => (left.declaredIndex ?? 0) - (right.declaredIndex ?? 0));
      if (audio.length === 0) continue;
      if (!enrichAudioInventoryFromSidecar(plan.audioTracks, sidecar, audio[0])) {
        pendingIndexes.delete(sidecar.fileIndex);
        continue;
      }
      // Keep the published inventory length and every address stable for this
      // session. A late header enriches the offered first track; adding tracks
      // would require replacing the HLS master playlist already loaded by the
      // browser.
      pendingIndexes.delete(sidecar.fileIndex);
      if (audio.length > 1) {
        logger.info(
          `audio tracks: late header for "${sidecar.name}" describes ${audio.length} tracks; ` +
          "the active inventory keeps its published track count"
        );
      }
    }
    if (cache.get(cacheKey) !== plan) return { audioTracks: [], pending: false };
    pendingSidecarHeaders.set(cacheKey, [...pendingIndexes]);
    plan.audioTracksPending = pendingIndexes.size > 0;
    return { audioTracks: plan.audioTracks, pending: pendingIndexes.size > 0 };
  }

  function withLiveFigures(plan) {
    const withOffer = {
      ...plan,
      // Answered here, not when the plan is built: a plan is cached for the
      // life of the process, and what this host will serve a file at is not.
      // It starts as a prediction from the startup benchmarks and is replaced by
      // what an encoder running on this very source turns out to cost — frozen
      // into the cache, every later open of the file would hand the browser the
      // first guess again and undo that. This is the 2.9.106 defect exactly.
      offeredHeights: plan.mediaInfoForOffer
        ? (predictOfferedHeights?.(plan.mediaInfoForOffer) ?? null)
        : null,
      // The description the rest of the pool answers by arithmetic. Carried
      // on every plan, not only on a refusal here: the output opened next can
      // still be refused for want of a place on this machine (roadmap item 97,
      // step 14), and the page then asks the pool the same question before
      // anything plays — which it can only do with this in hand.
      mediaInfoForOffer: plan.mediaInfoForOffer
    };
    // Refused rather than served badly. Both lists empty means this machine
    // cannot sustain this file at ANY height — not even by copying the picture,
    // which costs no encoder at all — so a session made here would produce a
    // slideshow and take the swarm and the processor from whoever is already
    // watching. Field 2026-08-28: five sessions on one file put every rung at
    // 0.04x of realtime and the viewer watched one before the process was
    // killed. The viewer is told why, which is a different thing from a spinner
    // that never ends.
    const offer = withOffer.offeredHeights;
    if (offer && offer.copy.length === 0 && offer.transcode.length === 0) {
      withOffer.cannotServe =
        "This proxy cannot keep up with this file at any quality right now.";
      // The description travels with the plan (above). It is what lets the
      // browser ask the rest of the pool the same question without anybody
      // else adding the torrent, fetching a byte or running ffmpeg — the
      // expensive half of finding out what this file IS has been paid here,
      // once. Everyone else answers by arithmetic against their own startup
      // benchmarks.
    }
    return withOffer;
  }

  return {
    forget(sourceKey) {
      for (const records of [cache, lifetimes, pendingSidecarHeaders, declaredAudioReads, mediaInfoCache]) {
        for (const key of records.keys()) if (key.startsWith(`${sourceKey}:`)) records.delete(key);
      }
    },
    getReadyPlan(params, { signal } = {}) {
      if (!subscribeSource) throw new Error("Event-driven source preparation is unavailable.");
      return waitForPlan({ read: () => this.getPlan(params), signal,
        subscribe: listener => subscribeSource(params.sourceKey, params.fileIndex, listener) });
    },
    /**
     * Media info the planner already probed for this file, or `null`. Lets the
     * HLS session manager skip its own duplicate `probeInputMediaInfo` scan.
     *
     * @param {{ sourceKey: string, fileIndex: number }} params
     * @returns {{ durationSeconds: number | null, width: number | null, height: number | null, fps: number | null, startTime: number, isHdr: boolean } | null}
     */
    /**
     * The audio tracks this file was probed to have, or an empty list. The
     * master playlist publishes one rendition per track, and the inventory is
     * already here — probing again for it would be a second scan of a file the
     * proxy is in the middle of serving.
     *
     * @param {{ sourceKey: string, fileIndex: number }} params
     * @returns {object[]}
     */
    getCachedAudioTracks({ sourceKey, fileIndex }) {
      const plan = cache.get(`${sourceKey}:${fileIndex}`);
      return Array.isArray(plan?.audioTracks) ? plan.audioTracks : [];
    },

    refreshAudioTracks,

    getCachedMediaInfo({ sourceKey, fileIndex }) {
      return mediaInfoCache.get(`${sourceKey}:${fileIndex}`) ?? null;
    },

    /**
     * Return the playback plan for the given source file.
     * Throws with `error.code === "SOURCE_NOT_FOUND"` or `"FILE_NOT_FOUND"`
     * when the source or file cannot be located.
     *
     * A probe reads only bytes already stored. Missing input becomes demand in
     * the shared map and returns `pending: true`, which is never cached as a
     * playback plan. Storage changes repeat unfinished probes; another request
     * reads their latest result without creating a separate download request.
     *
     * @param {object} params
     * @param {string} params.sourceKey
     * @param {number} params.fileIndex
     * @param {string} [params.userAgent=""]
     * @returns {Promise<PlaybackPlan & { pending?: boolean }>}
     */
    async getPlan({ sourceKey, fileIndex, background = false }) {
      const cacheKey = `${sourceKey}:${fileIndex}`;
      let lifetime = lifetimes.get(cacheKey);
      if (!lifetime) lifetimes.set(cacheKey, lifetime = {});
      const ensureCurrent = () => {
        if (lifetimes.get(cacheKey) === lifetime) return;
        const error = new Error("Source preparation was withdrawn.");
        error.code = "SOURCE_FORGOTTEN";
        error.canRetry = false;
        throw error;
      };
      const cached = cache.get(cacheKey);
      if (cached) {
        return withLiveFigures(cached);
      }
      // Where the time before playback goes. `cold-start` already breaks down
      // everything from the transcode-session request onwards, but the plan
      // runs BEFORE that and was a single opaque wait: a field session spent
      // 5.7 s here on a torrent already in the store, with the codec probe
      // cached, and nothing said which part of it was slow.
      const planEntryMs = Date.now();
      let torrentReadyMs = 0;

      const sourceRecord = sourceRegistry.get(sourceKey);
      if (!sourceRecord) {
        const error = new Error("Source key was not found.");
        error.code = "SOURCE_NOT_FOUND";
        throw error;
      }

      const torrent = await torrentPool.getTorrent(sourceRecord.sourceType, sourceRecord.source);
      ensureCurrent();
      torrentReadyMs = Date.now() - planEntryMs;
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
          durationSeconds: 0,
          videoWidth: 0,
          videoHeight: 0,
          audioTracks: [],
          audioTracksPending: false,
          subtitleTracks: []
        };
        cache.set(cacheKey, plan);
        return withLiveFigures(plan);
      }

      // Structural reads state their exact missing bytes through
      // the shared download map. No separate edge or body demand is created.
      if (typeof declaredTracksOf === "function") await declaredTracksOf({ sourceKey, fileIndex });
      if (!background) {
        warmKeyframeIndex?.({ sourceKey, fileIndex, logName: file.name });
      }
      if (typeof readDeclarations !== "function") throw new Error("Source container declarations are unavailable.");
      const probeResult = await readDeclarations({ sourceKey, fileIndex });
      ensureCurrent();
      if (probeResult.kind === "terminal") {
        const error = new Error(probeResult.message || probeResult.reason);
        error.code = probeResult.reason;
        error.canRetry = false;
        throw error;
      }
      if (probeResult.kind === "cancelled") {
        throw new DOMException("Playback preparation was cancelled.", "AbortError");
      }
      const probe = probeResult.kind === "result" ? playbackDeclarations({ ...probeResult.value, fileBytes: file.length })
        : { audioCodec: "", videoCodec: "", container: "", durationSeconds: null,
          videoWidth: 0, videoHeight: 0, audioTracks: [], subtitleTracks: [] };
      const { audioCodec, videoCodec, container, durationSeconds, videoWidth, videoHeight, audioTracks, subtitleTracks } = probe;
      const codecsDetected = audioCodec.length > 0 || videoCodec.length > 0;
      if (!codecsDetected && probeResult?.kind === "result") {
        const error = new Error("The available source bytes declare no playable audio or video track.");
        error.code = "media-probe-no-tracks";
        error.canRetry = false;
        throw error;
      }
      logger.info(
        `plan ${sourceKey.slice(0, 8)}:${fileIndex} torrent-ready=${torrentReadyMs}ms ` +
          `probe=${Date.now() - planEntryMs - torrentReadyMs}ms total=${Date.now() - planEntryMs}ms ` +
          `${codecsDetected ? `${videoCodec || "-"}/${audioCodec || "-"}` : "codec declaration awaits source bytes"}`
      );

      const requiresTranscode = audioCodec.length > 0 && !DIRECT_AUDIO_CODECS.has(audioCodec);
      const videoFacts = Container.mergeVideoFacts({ width: videoWidth, height: videoHeight,
        fps: probe.fps, isHdr: probe.isHdr, bitDepth: probe.bitDepth }, probe.video ?? null);
      const sidecars = sidecarsOf(torrent, fileIndex);
      const inventory = await buildInventory(sourceKey, torrent, fileIndex, audioTracks ?? []);
      ensureCurrent();
      const plan = {
        mode: requiresTranscode ? "hls" : "direct",
        directUrl,
        reason: requiresTranscode ? "audio-codec-transcode-required" : "audio-codec-supported",
        audioCodec,
        videoCodec,
        container,
        durationSeconds,
        // Source coded resolution — drives the browser's manual quality menu
        // (list of forced resolutions <= source). 0 when unknown.
        videoWidth: videoFacts.width ?? 0,
        videoHeight: videoFacts.height ?? 0,
        // Full track inventory for the browser's audio/subtitle menus. The audio
        // half spans the picture's own tracks AND the soundtracks shipped as
        // files beside it, under one numbering — see `buildInventory`.
        audioTracks: inventory.audioTracks,
        audioTracksPending: inventory.pendingFileIndexes.length > 0,
        subtitleTracks: await withContainerDefaults(sourceKey, torrent, fileIndex, subtitleTracks ?? []),
        // The files BESIDE this picture that belong to it, and what each one's
        // own path says about the track in it. Both answers are made here, by
        // one grammar, because the browser used to make them again: it paired
        // with a looser rule and read the names with a stricter one, and nothing
        // compared the two. Measured 2026-09-04 over 115 real torrents — 1249
        // video files, ten pairings differing — and the difference reached the
        // viewer as a subtitle track offered but never warmed.
        //
        // The soundtracks are NOT repeated here: they are already in
        // `audioTracks`, under the one flat numbering the browser addresses them
        // by. What this adds is the two groups that had no place in the plan at
        // all.
        sidecarSubtitles: sidecars.subtitles,
        sidecarImages: sidecars.images,
        // Filled in by `withLiveFigures` on the way out, never here: read at
        // build time it would be frozen into the cached plan, which is the bug
        // fixed in 2.9.106.
        offeredHeights: null,
        // What the offer is computed FROM, kept on the cached plan so the offer
        // itself can be recomputed on every response. The figures are the
        // probe's own and never change for a file; the answer derived from them
        // does, as the host learns what this source costs. Stripped on the way
        // out — it is not part of the plan the browser is given.
        mediaInfoForOffer: {
          width: videoFacts.width,
          height: videoFacts.height,
          fps: videoFacts.fps,
          bitrateKbps: probe.bitrateKbps,
          audioTracks: probe.audioTracks,
          // Which family of the decode measurement prices this source. A video
          // that has to be re-encoded is one the browser could not play, so it
          // is usually NOT H.264, and H.264 constants are wrong for it.
          codec: videoCodec,
          bitDepth: videoFacts.bitDepth,
          // Which file this is, so the offer can be answered from what an
          // encoder has already learned about THIS source rather than from the
          // startup clips — the same correction a live session applies.
          sourceKey,
          fileIndex
        }
      };
      ensureCurrent();
      // Only cache a plan whose codecs were actually detected. An empty probe is
      // a "header not downloaded yet" signal, not a valid result — caching it
      // would permanently mis-plan the file. In that case flag the plan
      // `pending`; the media request's missing ranges remain in the shared map.
      if (codecsDetected && durationSeconds > 0) {
        cache.set(cacheKey, plan);
        pendingSidecarHeaders.set(cacheKey, inventory.pendingFileIndexes);
        // Cache the full media info from THIS probe's banner (same helpers the
        // session manager uses) so createSession can skip its own probe.
        mediaInfoCache.set(cacheKey, {
          // The codecs, because the session manager asks this cache which
          // tracks the output will carry — and they were never stored here. It
          // read `videoCodec`/`audioCodec` off an object that has only ever had
          // dimensions and duration, got `undefined` for both, and declared
          // `{video: false, audio: false}` for EVERY session since the check was
          // written. Measured 2026-08-11: `declared tracks video=false
          // audio=false`, which left the browser unable to tell "this file has
          // no video" from "the video was lost on the way", and left the init
          // guard expecting zero tracks and therefore accepting any header.
          videoCodec: plan.videoCodec,
          audioCodec: plan.audioCodec,
          durationSeconds: durationSeconds,
          width: videoFacts.width,
          height: videoFacts.height,
          bitrateKbps: probe.bitrateKbps,
          audioTracks: probe.audioTracks,
          fps: videoFacts.fps,
          startTime: probe.startTimeSeconds,
          isHdr: videoFacts.isHdr,
          bitDepth: videoFacts.bitDepth,
          // Retain every declared stream count for failed-run diagnostics.
          streamCounts: probe.streamCounts
        });
        return withLiveFigures(plan);
      }
      return withLiveFigures({ ...plan, pending: true });
    }
  };
}
