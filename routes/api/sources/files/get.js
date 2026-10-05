import { contentsOf } from "../../../../services/torrent/Contents.js";
import { logger } from "../../../../utils/logger.js";

/**
 * List the files of a registered source (torrent file OR magnet).
 *
 * GET /api/sources/:sourceKey/files
 *
 * The browser parses `.torrent` files locally, but a magnet URI carries no
 * file list — the metadata comes from the swarm and can take a while to
 * arrive on a cold magnet. Metadata readiness, failure or caller cancellation
 * ends the request; elapsed time does not change the answer about a torrent.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{
 *   sourceRegistry: ReturnType<import("../../../../store/source-registry.js").createSourceRegistry>,
 *   torrentPool: import("../../../../services/torrent/torrent-pool.js").TorrentPool
 * }} deps
 * @returns {Promise<void>}
 */

const CANCELLED = Symbol("cancelled");

export async function handleApiSourceFilesGet(req, reply, { sourceRegistry, torrentPool, viewers }) {
  const sourceKey = typeof req.params?.sourceKey === "string" ? req.params.sourceKey.trim() : "";
  if (!sourceKey) {
    return reply.code(400).send({ error: "sourceKey is required." });
  }
  const sourceRecord = sourceRegistry.get(sourceKey);
  if (!sourceRecord) {
    return reply.code(404).send({ error: "Source key was not found." });
  }

  let cancelled;
  const waitPromise = new Promise(resolve => { cancelled = () => resolve(CANCELLED); });
  reply.raw?.once?.("close", cancelled);
  if (reply.raw?.destroyed) {
    reply.raw?.removeListener?.("close", cancelled);
    return;
  }
  const torrentPromise = torrentPool
    .getTorrent(sourceRecord.sourceType, sourceRecord.source)
    // Swallow so a rejection that loses the race is not an unhandled rejection;
    // the next poll re-issues getTorrent and re-observes any real error.
    .catch((error) => (error instanceof Error ? error : new Error(String(error))));

  let result;
  try {
    result = await Promise.race([torrentPromise, waitPromise]);
  } finally {
    reply.raw?.removeListener?.("close", cancelled);
  }

  if (result === CANCELLED) return;
  if (result instanceof Error) {
    return reply.code(502).send({ error: `Could not load torrent metadata: ${result.message}` });
  }

  const torrent = result;
  // WHAT IS IN THIS TORRENT, decided here and nowhere else. The browser used to
  // decide it again — a list of video extensions in its parser and a second,
  // shorter pair inside its picker — and the three answers had already diverged
  // (measured 2026-09-12: `.dat` was offered there and not counted here, which
  // also decides whether a sidecar whose name matches nothing can belong to the
  // only video present). It ships the paths already relative to the torrent
  // root, so there is no stripping rule on the other side either.
  const contents = contentsOf(torrent);
  for (const file of contents.files()) {
    if (file.excludedReason) logger.info(`contents request=${req.id ?? "unstated"} source=${sourceKey} ` +
      `file=${file.fileIndex} name=${JSON.stringify(file.relativePath)} bytes=${file.length} excluded=${file.excludedReason}`);
  }
  const consumerId = typeof req.query?.consumerId === "string" ? req.query.consumerId.trim() : "";
  if (consumerId) viewers?.visibleFiles(consumerId, sourceKey, contents.items.map(item => item.fileIndex));
  return reply.send({
    name: torrent.name ?? "",
    infoHash: torrent.infoHash ?? "",
    // In the order a person reads them — by folder, then by name, with runs of
    // digits compared as numbers. A torrent's own order is whatever the tool
    // that made it chose, and it is routinely by size.
    files: contents.files(),
    // The pictures, each with what belongs to it. By index, because the files
    // themselves are in the list above and saying them twice is how two copies
    // of one fact start.
    items: contents.items.map((item) => ({
      fileIndex: item.fileIndex,
      audio: item.audio.map((part) => part.fileIndex),
      subtitles: item.subtitles.map((part) => part.fileIndex),
      images: item.images.map((part) => part.fileIndex),
      // What the name says about which episode this is, in the release's own
      // numbering — read by the page to ask which episode of the show it is.
      episode: item.episode
    })),
    // One film, a series, or not known — whether one identification of the
    // whole release applies to its pictures at all.
    shape: contents.shape
  });
}
