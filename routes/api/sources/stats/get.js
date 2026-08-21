import { logger } from "../../../../utils/logger.js";

/**
 * Return download statistics for a registered torrent source.
 *
 * Provides peer count, transfer speeds, and per-file download progress so
 * that the browser client can display meaningful feedback while the proxy is
 * pre-fetching file metadata (MOOV atom / EBML headers) before codec probing.
 *
 * GET /api/sources/:sourceKey/stats?fileIndex=N
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{
 *   sourceRegistry: ReturnType<import("../../../../store/source-registry.js").createSourceRegistry>,
 *   torrentPool: import("../../../../services/torrent-pool.js").TorrentPool
 * }} deps
 * @returns {Promise<void>}
 */
export async function handleApiSourceStatsGet(req, reply, { sourceRegistry, torrentPool }) {
  const sourceKey = typeof req.params.sourceKey === "string" ? req.params.sourceKey.trim() : "";
  if (!sourceKey) {
    return reply.code(400).send({ error: "sourceKey is required." });
  }

  const sourceRecord = sourceRegistry.get(sourceKey);
  if (!sourceRecord) {
    return reply.code(404).send({ error: "Source key was not found." });
  }

  let torrent;
  try {
    // getTorrent resolves immediately when the torrent is already loaded.
    torrent = await torrentPool.getTorrent(sourceRecord.sourceType, sourceRecord.source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: `Failed to load torrent: ${message}` });
  }

  const fileIndexRaw = typeof req.query.fileIndex === "string" ? req.query.fileIndex : "";
  const fileIndex = fileIndexRaw !== "" && /^\d+$/.test(fileIndexRaw) ? Number(fileIndexRaw) : null;

  // Optional: pin the resume window to a FIXED byte offset for the duration of
  // one buffering episode (see getFileStats JSDoc) instead of the live, moving
  // read position — otherwise "bytes needed" can jump up mid-poll as the window
  // slides forward with playback/encoding progress.
  const resumeAnchorRaw = typeof req.query.resumeAnchorByteStart === "string" ? req.query.resumeAnchorByteStart : "";
  const resumeAnchorByteStart = resumeAnchorRaw !== "" && /^\d+$/.test(resumeAnchorRaw) ? Number(resumeAnchorRaw) : null;

  // Awaited: with the torrent on its own thread this is a round trip, not a
  // local lookup. Without the await the reply was the pending promise itself,
  // which serialises to `{}` — the empty stats seen in the field 2026-08-02.
  const stats = await torrentPool.getFileStats(torrent, fileIndex, { resumeAnchorByteStart });

  // Diagnostic: surface the real swarm state per poll so a cold-start download
  // stall (0 peers / header not advancing → playback-plan blocks on the codec
  // probe → browser timeout) is visible in the proxy log.
  const downKbps = (stats.downloadSpeed / 1024).toFixed(0);
  const filePct = stats.fileProgress != null ? `${(stats.fileProgress * 100).toFixed(1)}%` : "n/a";
  const header =
    stats.headerBytes != null
      ? `${stats.headerDownloadedBytes}/${stats.headerBytes}B`
      : "n/a";
  // The swarm, said so that the question this line is asked can be answered
  // from it. "Connected" and "known" are different numbers and their
  // difference is the diagnosis: a tracker offering five while we are
  // connected to none is a connectivity fault, and nobody offering anything is
  // a supply fault. Until 2026-08-21 the line printed `peers=` beside
  // `wires=?` — two quantities of which one looked unknown, while in truth the
  // first WAS the connection count and the second was a field that never
  // printed anything, because the torrent lives on another thread and the
  // property does not exist on this side of it.
  const known = stats.knownPeers === null || stats.knownPeers === undefined ? "?" : stats.knownPeers;
  const queued = stats.queuedPeers === null || stats.queuedPeers === undefined ? "?" : stats.queuedPeers;
  // The BEST answer any tracker gave, and how many answered — not the most
  // recent one. Trackers answer separately, and a dead one replying `0` after a
  // live one replied `500` would otherwise turn "several offered" into "nobody
  // offered", which is the distinction this whole line exists to make.
  const offered = stats.trackerSeeders === null || stats.trackerSeeders === undefined
    ? (stats.trackersAnswered
        // Answered, and none of them knew of anybody — a different state from
        // "no tracker has replied at all", and the line must not read as the
        // second when it means the first.
        ? `${stats.trackersAnswered} tracker(s) answered, none reported a count`
        : "no tracker answer yet")
    : `${stats.trackersAnswered ?? "?"} tracker(s) offered up to ${stats.trackerSeeders} seeders ` +
      `${stats.trackerLeechers ?? "?"} leechers`;
  // The wait for a first peer can be the whole of a cold start — 257 s of it,
  // measured — and it was neither counted nor shown.
  const firstPeer = Number.isFinite(stats.secondsToFirstPeer)
    ? ` firstPeerAfter=${stats.secondsToFirstPeer.toFixed(1)}s`
    : Number.isFinite(stats.secondsWaitingForFirstPeer)
      ? ` noPeerFor=${stats.secondsWaitingForFirstPeer.toFixed(1)}s`
      : "";
  // When the answer is empty, say WHICH thing is missing. Field 2026-08-05: a
  // source reported `peers=0 file=n/a header=n/a` for minutes while that very
  // torrent was announcing to trackers with hundreds of seeders — and the line
  // above cannot tell apart "the torrent handle is not the live one", "the file
  // index did not resolve" and "no file index was asked for". That is what the
  // viewer's loading screen was showing at the time, so it has to be
  // answerable from the log rather than by reasoning about it afterwards.
  const emptyAnswer = stats.fileProgress == null || (stats.numPeers === 0 && torrent.done !== true);
  const detail = emptyAnswer
    ? ` | files=${torrent.files?.length ?? "?"}` +
      ` fileIndex=${fileIndex ?? "none"} resolved=${torrent.files?.[fileIndex ?? -1] ? "yes" : "no"}` +
      ` done=${torrent.done === true}`
    : "";
  // The infohash is on EVERY line, not only on the ones that look empty: it is
  // the one identifier the pool's own lines, the worker's and this one share,
  // and a line that carries it can be lined up with them without a guess.
  logger.info(
    `[stats] ${sourceKey.slice(0, 8)} ${String(torrent.infoHash).slice(0, 8)} ` +
    `peers=${stats.connectedPeers ?? stats.numPeers} connected of ${known} known (${queued} queued, ${offered})` +
    `${firstPeer} down=${downKbps}KB/s file=${filePct} header=${header}${detail}`
  );

  return reply.send(stats);
}
