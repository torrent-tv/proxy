/**
 * List the files of a registered source (torrent file OR magnet).
 *
 * GET /api/sources/:sourceKey/files
 *
 * The browser parses `.torrent` files locally, but a magnet URI carries no
 * file list — the metadata comes from the swarm. This route resolves the
 * torrent (waiting for metadata on a cold magnet; callers should use a
 * generous timeout) and returns the file inventory.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{
 *   sourceRegistry: ReturnType<import("../../../../store/source-registry.js").createSourceRegistry>,
 *   torrentPool: import("../../../../services/torrent-pool.js").TorrentPool
 * }} deps
 * @returns {Promise<void>}
 */
export async function handleApiSourceFilesGet(req, reply, { sourceRegistry, torrentPool }) {
  const sourceKey = typeof req.params?.sourceKey === "string" ? req.params.sourceKey.trim() : "";
  if (!sourceKey) {
    return reply.code(400).send({ error: "sourceKey is required." });
  }
  const sourceRecord = sourceRegistry.get(sourceKey);
  if (!sourceRecord) {
    return reply.code(404).send({ error: "Source key was not found." });
  }

  const torrent = await torrentPool.getTorrent(sourceRecord.sourceType, sourceRecord.source);
  const files = (torrent.files ?? []).map((file, index) => ({
    index,
    name: file?.name ?? "",
    // Path relative to the torrent root (matches the browser's own parser).
    relativePath: file?.path ?? file?.name ?? "",
    length: Number.isFinite(file?.length) ? file.length : 0
  }));

  return reply.send({
    name: torrent.name ?? "",
    infoHash: torrent.infoHash ?? "",
    files
  });
}
