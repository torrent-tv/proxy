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

  const stats = torrentPool.getFileStats(torrent, fileIndex);

  // Diagnostic: surface the real swarm state per poll so a cold-start download
  // stall (0 peers / header not advancing → playback-plan blocks on the codec
  // probe → browser timeout) is visible in the proxy log.
  const downKbps = (stats.downloadSpeed / 1024).toFixed(0);
  const filePct = stats.fileProgress != null ? `${(stats.fileProgress * 100).toFixed(1)}%` : "n/a";
  const header =
    stats.headerBytes != null
      ? `${stats.headerDownloadedBytes}/${stats.headerBytes}B`
      : "n/a";
  logger.info(
    `[stats] ${sourceKey.slice(0, 8)} peers=${stats.numPeers} down=${downKbps}KB/s file=${filePct} header=${header}`
  );

  return reply.send(stats);
}
