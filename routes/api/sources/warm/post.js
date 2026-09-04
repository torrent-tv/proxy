import { logger } from "../../../../utils/logger.js";
import {
  countVideoFiles,
  matchSidecarFiles,
  TEXT_SUBTITLE_SIDECAR_EXTENSIONS
} from "../../../../services/torrent/files.js";

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
  // Where the viewer is about to resume, if they are resuming. The edges below
  // are what the codec probe reads; this is what the VIEWER will read, and until
  // now nothing asked for it before the encoder did.
  const requestedPosition = Number(body.positionSeconds);
  const positionSeconds = Number.isFinite(requestedPosition) && requestedPosition > 0
    ? requestedPosition
    : 0;

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
    // Started AFTER the edges, and not awaited by them either: the edges gate
    // the playback plan, so they must not queue behind a region nobody is
    // reading yet. This one only has to arrive before the encoder does, and the
    // encoder is a plan and a session away.
    if (positionSeconds > 0 && typeof torrentPool.warmResumePosition === "function") {
      Promise.resolve(torrentPool.warmResumePosition(torrent, fileIndex, positionSeconds)).catch(
        (error) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`warm ${sourceKey.slice(0, 8)}: the viewer's position failed: ${message}`);
        }
      );
    }
  }

  // The files that carry this episode's OTHER soundtracks and its subtitles.
  //
  // Warmed here for the same reason the picture is: none of it depends on the
  // viewer, and every second of it that happens now is a second they do not
  // spend waiting later. Without this the first thing to ask for a dub's header
  // is the playback plan, on the path to the first frame, and the first thing to
  // ask for a subtitle file is the browser once the film is already running —
  // which is why a track the container marks default appears after the opening
  // rather than during it.
  //
  // How much of each is fetched follows from what the file IS, not from a size
  // anyone chose. A text subtitle file is smaller than one piece of this
  // torrent, so its edges and the whole of it are the same pieces — fetch all of
  // it. A soundtrack is tens of megabytes and only its header is needed to name
  // and describe it, so it gets the head and the tail, exactly as the picture
  // does. The rest of it is fetched when it is played, and nothing here spends
  // the pool owner's bandwidth on a track nobody chose.
  let sidecars = 0;
  if (fileIndex !== null && Array.isArray(torrent.files)) {
    const matched = matchSidecarFiles({
      files: torrent.files,
      videoIndex: fileIndex,
      torrentName: typeof torrent.name === "string" ? torrent.name : "",
      videoCount: countVideoFiles(torrent.files)
    });
    const warmOne = (file, options) => {
      sidecars += 1;
      // Not awaited, like the picture's own edges above: the point of this route
      // is that the viewer goes on choosing while it happens.
      Promise.resolve(torrentPool.prefetchFileEdges(torrent, file.fileIndex, options)).catch(
        (error) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`warm ${sourceKey.slice(0, 8)}: "${file.name}" failed: ${message}`);
        }
      );
    };
    for (const file of matched.audio) {
      warmOne(file, { tailBytes: 0 });
      // And then the whole of it, in the room the viewer's own reading leaves.
      // The head is enough to NAME the track; it is not enough to play one, and
      // a viewer who switches otherwise waits for the swarm to deliver its
      // first pieces — 27.7 s in the field on 2026-08-31, longer than the
      // switch is willing to wait. A soundtrack is about a twentieth of the
      // picture, and the fill stands aside for every moment the picture's own
      // reader is blocked, so it uses capacity the viewer is not using.
      if (typeof torrentPool.fillFileInBackground === "function") {
        Promise.resolve(torrentPool.fillFileInBackground(torrent, file.fileIndex)).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`warm ${sourceKey.slice(0, 8)}: filling "${file.name}" failed: ${message}`);
        });
      }
    }
    for (const file of matched.subtitles) {
      warmOne(
        file,
        TEXT_SUBTITLE_SIDECAR_EXTENSIONS.has(file.extension)
          ? { headBytes: Math.max(1, file.length), tailBytes: 0 }
          : { tailBytes: 0 }
      );
    }
  }

  logger.info(
    `warm ${sourceKey.slice(0, 8)}: swarm started for "${torrent.name}"` +
      (edges ? `, fetching the edges of file ${fileIndex}` : ", file not chosen yet") +
      (sidecars > 0 ? ` and of ${sidecars} file(s) beside it` : "")
  );

  return reply.send({ started: true, swarm: true, edges, sidecars });
}
