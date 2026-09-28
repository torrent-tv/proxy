import { logger } from "../../../../utils/logger.js";
import { TEXT_SUBTITLE_SIDECAR_EXTENSIONS } from "../../../../services/torrent/files.js";
import { contentsOf } from "../../../../services/torrent/Contents.js";

const metadataWarmups = new Map();
const METADATA_RETRY_MS = 2500;

function startMetadataWarmup({ sourceKey, items, preferredFileIndex, userAgent, playbackPlanner, torrentPool, torrent }) {
  if (!playbackPlanner || !Array.isArray(items) || items.length === 0) {
    return false;
  }
  let state = metadataWarmups.get(sourceKey);
  if (!state) {
    state = { pending: new Set(), preferredFileIndex: null, running: false, items: [] };
    metadataWarmups.set(sourceKey, state);
  }
  state.items = items;
  for (const item of items) {
    if (Number.isInteger(item?.fileIndex)) {
      state.pending.add(item.fileIndex);
    }
  }
  if (Number.isInteger(preferredFileIndex) && state.pending.has(preferredFileIndex)) {
    state.preferredFileIndex = preferredFileIndex;
  }
  if (state.running) {
    return true;
  }
  state.running = true;
  void (async () => {
    try {
      while (state.pending.size > 0) {
        const fileIndex = state.preferredFileIndex !== null && state.pending.has(state.preferredFileIndex)
          ? state.preferredFileIndex
          : state.pending.values().next().value;
        state.preferredFileIndex = null;
        if (!Number.isInteger(fileIndex)) {
          break;
        }
        const item = state.items.find((entry) => entry.fileIndex === fileIndex);
        if (!item) {
          state.pending.delete(fileIndex);
          continue;
        }
        const sidecars = contentsOf(torrent).sidecarsOf(fileIndex);
        const sidecarFiles = [...sidecars.audio, ...sidecars.subtitles];
        await Promise.all(sidecarFiles.map((file) =>
          torrentPool.prefetchFileEdges(torrent, file.fileIndex, {
            tailBytes: 0,
            headBytes: TEXT_SUBTITLE_SIDECAR_EXTENSIONS.has(file.extension)
              ? Math.max(1, file.length)
              : undefined,
            timeoutMs: 10_000
          }).catch((error) => {
            logger.info(`warm ${sourceKey.slice(0, 8)}:${fileIndex}: sidecar metadata not ready for "${file.name}": ${error?.message ?? error}`);
          })
        ));
        const plan = await playbackPlanner.getPlan({
          sourceKey,
          fileIndex,
          userAgent,
          maxWaitMs: 0,
          background: true
        }).catch((error) => {
          logger.info(`warm ${sourceKey.slice(0, 8)}:${fileIndex}: media metadata not ready: ${error?.message ?? error}`);
          return null;
        });
        if (plan && !plan.pending) {
          state.pending.delete(fileIndex);
        } else if (torrent.files?.[fileIndex]?.done === true) {
          state.pending.delete(fileIndex);
        }
        if (state.pending.size > 0) {
          await new Promise((resolve) => setTimeout(resolve, METADATA_RETRY_MS));
        }
      }
    } catch (error) {
      logger.warn(`warm ${sourceKey.slice(0, 8)}: metadata queue stopped: ${error?.message ?? error}`);
    } finally {
      state.running = false;
      if (state.pending.size === 0) {
        metadataWarmups.delete(sourceKey);
      }
    }
  })();
  return true;
}

/**
 * Start fetching a source before anyone asks to play it.
 *
 * POST /api/sources/:sourceKey/warm   { fileIndex?: number, positionSeconds?: number, userAgent?: string }
 *
 * Everything a torrent must do before the first byte of video can be served
 * takes seconds and none of it depends on the viewer: announce to the
 * trackers, connect to peers, be unchoked by them, and fetch the two pieces at
 * the file's edges that the codec probe reads. Measured 2026-08-04 on a cold
 * 7.4 GB torrent: 6.7 s of the 10.3 s before playback was those two pieces
 * arriving, with the swarm ramping from nothing.
 *
 * That work used to begin only when a file had been chosen, because it was
 * buried inside the playback plan. It can begin as soon as the viewer has
 * picked a TORRENT — while they are still reading the list of episodes — and
 * then most or all of it has happened by the time they choose.
 *
 * Returns as soon as the work is under way. The caller is not waiting for a
 * result; it is only saying "you may start". Failures are logged and answered
 * as `started: false` rather than as an error, because nothing is broken if a
 * warm-up does not happen — the ordinary path still does all of it.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{
 *   sourceRegistry: ReturnType<import("../../../../store/source-registry.js").createSourceRegistry>,
 *   torrentPool: import("../../../../services/torrent/torrent-pool.js").TorrentPool,
 *   playbackPlanner?: ReturnType<import("../../../../services/media/playback-planner.js").createPlaybackPlanner>,
 *   durationOf?: ({ sourceKey: string, fileIndex: number }) => Promise<number | null>
 * }} deps
 * @returns {Promise<void>}
 */
export async function handleApiSourceWarmPost(req, reply, { sourceRegistry, torrentPool, playbackPlanner = null, durationOf = null }) {
  const sourceKey = typeof req.params.sourceKey === "string" ? req.params.sourceKey.trim() : "";
  if (!sourceKey) {
    return reply.code(400).send({ error: "sourceKey is required." });
  }

  const sourceRecord = sourceRegistry.get(sourceKey);
  if (!sourceRecord) {
    return reply.code(404).send({ error: "Source key was not found." });
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const requestedIndex = Number(body.fileIndex);
  const fileIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0 ? requestedIndex : null;
  // Where the viewer is about to resume, if they are resuming. The edges below
  // are what the codec probe reads; this is what the VIEWER will read, and until
  // now nothing asked for it before the encoder did.
  const requestedPosition = Number(body.positionSeconds);
  const positionSeconds = Number.isFinite(requestedPosition) && requestedPosition > 0
    ? requestedPosition
    : 0;
  const userAgent = typeof body.userAgent === "string" ? body.userAgent : "";

  // Adding the torrent is what announces to the trackers and starts connecting
  // to peers, and it is also what a magnet needs in order to fetch its
  // metadata. It is awaited because everything else needs the torrent object,
  // and because until it resolves there is nothing to report.
  let torrent;
  try {
    torrent = await torrentPool.getTorrent(sourceRecord.sourceType, sourceRecord.source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`warm ${sourceKey.slice(0, 8)}: could not add the torrent: ${message}`);
    return reply.send({ started: false, swarm: false, edges: false });
  }

  const contents = contentsOf(torrent);
  const named = fileIndex !== null && torrent.files?.[fileIndex] ? fileIndex : null;
  if (named !== null) {
    const selectedSidecars = contents.sidecarsOf(named);
    for (const file of [...selectedSidecars.audio, ...selectedSidecars.subtitles]) {
      void torrentPool.prefetchFileEdges(torrent, file.fileIndex, {
        tailBytes: 0,
        headBytes: TEXT_SUBTITLE_SIDECAR_EXTENSIONS.has(file.extension)
          ? Math.max(1, file.length)
          : undefined,
        timeoutMs: 10_000,
        awaited: true
      }).catch((error) => {
        logger.info(`warm ${sourceKey.slice(0, 8)}:${named}: selected sidecar metadata not ready for "${file.name}": ${error?.message ?? error}`);
      });
    }
  }
  const orderedItems = named === null
    ? contents.items
    : [...contents.items.filter((item) => item.fileIndex === named), ...contents.items.filter((item) => item.fileIndex !== named)];
  const metadataStarted = startMetadataWarmup({
    sourceKey,
    items: orderedItems,
    preferredFileIndex: named,
    userAgent,
    playbackPlanner,
    torrentPool,
    torrent
  });
  const sidecarCount = new Set(orderedItems.flatMap((item) => {
    const matched = contents.sidecarsOf(item.fileIndex);
    return [...matched.audio, ...matched.subtitles].map((file) => file.fileIndex);
  })).size;
  const fillStarted = typeof torrentPool.fillTorrent === "function"
    ? await torrentPool.fillTorrent(torrent).catch((error) => {
      logger.warn(`warm ${sourceKey.slice(0, 8)}: whole-torrent fill could not start: ${error?.message ?? error}`);
      return false;
    })
    : false;
  if (named !== null && positionSeconds > 0 && typeof torrentPool.warmResumePosition === "function") {
    void Promise.resolve(
      (typeof durationOf === "function"
        ? durationOf({ sourceKey, fileIndex: named })
        : Promise.resolve(null)
      ).then((durationSeconds) =>
        torrentPool.warmResumePosition(torrent, named, positionSeconds, durationSeconds)
      )
    ).catch((error) => {
      logger.warn(`warm ${sourceKey.slice(0, 8)}: the viewer's position failed: ${error?.message ?? error}`);
    });
  }

  logger.info(
    `warm ${sourceKey.slice(0, 8)}: swarm started for "${torrent.name}"` +
      `, metadata for ${contents.items.length} video file(s) ${metadataStarted ? "queued" : "unavailable"}` +
      `, ${sidecarCount} related audio/subtitle file(s)` +
      (fillStarted ? ", whole-torrent fill enabled at TAIL urgency" : ", whole-torrent fill unavailable")
  );

  return reply.send({ started: true, swarm: true, edges: metadataStarted, sidecars: sidecarCount, fill: fillStarted });
}
