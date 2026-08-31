/**
 * Create or return an existing HLS transcode session for a torrent file.
 *
 * POST /api/transcode-sessions
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ hlsSessionManager: import("../../../services/hls-session-manager.js").HlsSessionManager, sourceRegistry: object, torrentPool: object }} deps
 * @returns {Promise<void>}
 */

import { logger } from "../../../utils/logger.js";

/**
 * Extract a plain object from the request body, guarding against
 * non-object payloads (arrays, primitives, null).
 *
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function getPayload(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body;
  }
  return {};
}

/**
 * Claim the source's file so the pool cannot clean it up under a live session.
 *
 * Asynchronous underneath — the torrent lives on another thread — but the
 * caller needs a release function immediately, so the claim is chased and the
 * release waits for it.
 *
 * @param {{ sourceRegistry: object, torrentPool: object, sourceKey: string, fileIndex: number }} params
 * @returns {() => void}
 */
function holdSource({ sourceRegistry, torrentPool, sourceKey, fileIndex }) {
  let release = null;
  let releasedEarly = false;
  const record = sourceRegistry?.get?.(sourceKey);
  if (!record) {
    return () => {};
  }
  void Promise.resolve(torrentPool.getTorrent(record.sourceType, record.source))
    .then((torrent) => {
      release = torrentPool.acquireFile(torrent, fileIndex);
      if (releasedEarly) {
        release();
      }
    })
    .catch(() => {});
  return () => {
    releasedEarly = true;
    if (typeof release === "function") {
      release();
      release = null;
    }
  };
}

export async function handleApiTranscodeSessionsPost(req, reply, { hlsSessionManager, sourceRegistry, torrentPool }) {
  const payload = getPayload(req.body);
  const sourceKey = typeof payload.sourceKey === "string" ? payload.sourceKey.trim() : "";
  const fileIndex = Number(payload.fileIndex);
  const transcodeVideo = payload.transcodeVideo === true;
  const transcodeAudio = payload.transcodeAudio === true;
  const consumerId = typeof payload.consumerId === "string" ? payload.consumerId.trim() : "";
  const fileName = typeof payload.fileName === "string" ? payload.fileName.trim() : "";
  const targetWidth = Number(payload.targetWidth);
  const targetHeight = Number(payload.targetHeight);
  // Manual quality: the target box is a user-forced resolution, encoded exactly
  // (capped to source), with the realtime budget's auto-downscale + runtime
  // downswitch disabled for the session.
  const manualQuality = payload.manualQuality === true;
  // Whether this browser will take its audio from a separate rendition group in
  // the master playlist rather than muxed into the picture. It has to say so:
  // publishing renditions AND muxing the same audio would play it twice, while
  // a browser that does not know about them would get no sound at all.
  const audioRenditions = payload.audioRenditions === true;
  const startPositionSeconds = Number(payload.startPositionSeconds);
  const audioTrackIndex = Number(payload.audioTrackIndex);
  // Which container to produce. The browser knows what its media stack will
  // accept for the tracks it asked to be copied; an absent or unknown value
  // leaves the proxy's own `--segment-format` in charge.
  const segmentFormatId =
    typeof payload.segmentFormat === "string" ? payload.segmentFormat.trim() : "";

  if (!sourceKey || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return reply.code(400).send({ error: "sourceKey and valid fileIndex are required." });
  }

  try {
    const session = await hlsSessionManager.createOrGetSession({
      sourceKey,
      fileIndex,
      transcodeVideo,
      transcodeAudio,
      consumerId,
      fileName,
      targetWidth: Number.isInteger(targetWidth) && targetWidth > 0 ? targetWidth : 0,
      targetHeight: Number.isInteger(targetHeight) && targetHeight > 0 ? targetHeight : 0,
      manualQuality,
      audioRenditions,
      startPositionSeconds:
        Number.isFinite(startPositionSeconds) && startPositionSeconds > 0
          ? startPositionSeconds
          : 0,
      audioTrackIndex:
        Number.isInteger(audioTrackIndex) && audioTrackIndex > 0 ? audioTrackIndex : 0,
      segmentFormatId,
      // Hold the torrent for as long as this session lives. Reads take a claim
      // only while they run, and a seek leaves a gap with no read at all — the
      // disk sweep caught that gap on 2026-08-06 and deleted the film being
      // watched.
      // Takes the file to hold, because a session does not always read the file
      // it was created for: a release whose dub ships as its own file gives that
      // soundtrack a session of its own, reading a different index of the same
      // torrent. Defaults to the picture, which is every other case.
      acquireSource: (heldFileIndex = fileIndex) =>
        holdSource({
          sourceRegistry,
          torrentPool,
          sourceKey,
          fileIndex: Number.isInteger(heldFileIndex) ? heldFileIndex : fileIndex
        })
    });
    // The index of quality variants, when this session has more than one to
    // offer. Its presence is what tells the browser it can change quality
    // without a new session: the player switches variants itself, appending the
    // new one after what is already buffered. Absent for a copied video, whose
    // segments are cut at the source's own keyframes and so cannot be spliced
    // with a re-encoded rung.
    const hasVariants = hlsSessionManager.buildMasterPlaylist(session.id) !== null;
    return reply.send({
      sessionId: session.id,
      playlistPath: `/transcode/${session.id}/index.m3u8`,
      ...(hasVariants
        ? {
            masterPath: `/transcode/${session.id}/master.m3u8`,
            // Which of the master's variants this session IS. The browser pins
            // the player to it, so loading the master costs nothing: an encoder
            // is already producing that height, and any other rung would be a
            // second cold start before the first frame.
            variantHeight: hlsSessionManager.variantHeightOf(session)
          }
        : {}),
      // The heights this host will actually serve this file at, largest first
      // — the ladder minus every rung it cannot produce faster than it is
      // watched. The browser needs it whether or not a master exists: without
      // it, it fell back to a ladder of its own invention and offered rungs the
      // proxy had just refused, and picking one re-opened the session at a
      // height measured at a third of realtime.
      offeredHeights: hlsSessionManager.offeredHeights(session),
      // What this session's output will carry, stated rather than left to be
      // discovered. The browser checks what it actually got against this: a
      // track that never arrives is otherwise noticed only by its absence,
      // minutes later, as a black picture with working sound.
      tracks: hlsSessionManager.declaredTracks(session),
      // How far ahead of the viewer this proxy lets the encoder run, in seconds
      // of playback. The browser sizes its own forward buffer from it, so the
      // two sides agree by construction instead of each carrying a constant of
      // its own — which is how the browser came to hold thirty seconds while
      // two minutes stood produced on disk (roadmap item 4).
      lookaheadSeconds: hlsSessionManager.lookaheadSeconds
    });
  } catch (error) {
    if (error instanceof Error && error.code === "TRANSCODE_DISABLED") {
      return reply.code(409).send({ error: error.message });
    }
    const message = error instanceof Error ? error.message : String(error);
    // Say why on the proxy's own log, not only in the answer. This route
    // answered 500 for every viewer of proxy 2.9.101-2.9.102 (an undeclared
    // constant) and the addon log carried nothing but the data-channel layer's
    // bare "→ 500": the cause had to be recovered by replaying the request
    // against the live proxy. The stack is worth the two lines it costs — a
    // programming error here is invisible to the viewer, who only sees that
    // nothing plays.
    logger.error(
      `transcode-sessions: ${sourceKey}:${fileIndex} failed to prepare: ${message}\n` +
        `${error instanceof Error ? (error.stack ?? "") : ""}`
    );
    return reply.code(500).send({ error: `Failed to prepare transcode session: ${message}` });
  }
}
