import { logger } from "../../../../utils/logger.js";

/**
 * Start fetching a source before anyone asks to play it.
 *
 * POST /api/sources/:sourceKey/warm   { fileIndex?: number }
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
 *   torrentPool: import("../../../../services/torrent-pool.js").TorrentPool
 * }} deps
 * @returns {Promise<void>}
 */
export async function handleApiSourceWarmPost(req, reply, { sourceRegistry, torrentPool }) {
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

  // The edges are only worth fetching once it is known WHICH file will be
  // played: on a season pack, warming twenty episodes' worth would spend the
  // pool owner's bandwidth on nineteen files nobody opened. The caller passes
  // an index when the torrent holds a single video, and again later if it
  // wants to.
  let edges = false;
  if (fileIndex !== null && torrent.files?.[fileIndex]) {
    edges = true;
    // Deliberately not awaited: this is the multi-second part, and the point of
    // the whole route is that the viewer goes on choosing while it happens.
    Promise.resolve(torrentPool.prefetchFileEdges(torrent, fileIndex)).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`warm ${sourceKey.slice(0, 8)}: file edges failed: ${message}`);
    });
  }

  logger.info(
    `warm ${sourceKey.slice(0, 8)}: swarm started for "${torrent.name}"` +
      (edges ? `, fetching the edges of file ${fileIndex}` : ", file not chosen yet")
  );

  return reply.send({ started: true, swarm: true, edges });
}
