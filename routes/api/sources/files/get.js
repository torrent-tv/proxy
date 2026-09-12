import { contentsOf } from "../../../../services/torrent/Contents.js";

/**
 * List the files of a registered source (torrent file OR magnet).
 *
 * GET /api/sources/:sourceKey/files
 *
 * The browser parses `.torrent` files locally, but a magnet URI carries no
 * file list — the metadata comes from the swarm and can take a while to
 * arrive on a cold magnet. Rather than block the request until it does (a
 * single long request racing the transport timeout, which surfaced as a
 * premature "no peers" error while the metadata was in fact still arriving),
 * this waits only a short per-request budget: if the metadata is not ready it
 * returns `{ pending: true }` while the fetch continues in the background. The
 * caller polls again until the file list comes back — mirroring the cold-
 * torrent playback-plan poll.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{
 *   sourceRegistry: ReturnType<import("../../../../store/source-registry.js").createSourceRegistry>,
 *   torrentPool: import("../../../../services/torrent-pool.js").TorrentPool
 * }} deps
 * @returns {Promise<void>}
 */

/** Sentinel resolved when the per-request wait elapses before metadata. */
const PENDING = Symbol("pending");

export async function handleApiSourceFilesGet(req, reply, { sourceRegistry, torrentPool }) {
  const sourceKey = typeof req.params?.sourceKey === "string" ? req.params.sourceKey.trim() : "";
  if (!sourceKey) {
    return reply.code(400).send({ error: "sourceKey is required." });
  }
  const sourceRecord = sourceRegistry.get(sourceKey);
  if (!sourceRecord) {
    return reply.code(404).send({ error: "Source key was not found." });
  }

  // How long to wait within THIS request before returning `pending`. Well
  // under the transport's request timeout so a single poll never races it.
  const rawWait = Number(req.query?.maxWaitMs);
  const maxWaitMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(rawWait, 20_000) : 8_000;

  // getTorrent dedupes concurrent/repeated calls via the pool's in-flight map,
  // so polling keeps joining the same background fetch (metadata keeps
  // downloading between polls). Race it against the wait budget; if the wait
  // wins, the fetch is left running for the next poll to observe.
  let timer;
  const waitPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(PENDING), maxWaitMs);
    timer.unref?.();
  });
  const torrentPromise = torrentPool
    .getTorrent(sourceRecord.sourceType, sourceRecord.source)
    // Swallow so a rejection that loses the race is not an unhandled rejection;
    // the next poll re-issues getTorrent and re-observes any real error.
    .catch((error) => (error instanceof Error ? error : new Error(String(error))));

  let result;
  try {
    result = await Promise.race([torrentPromise, waitPromise]);
  } finally {
    clearTimeout(timer);
  }

  if (result === PENDING) {
    return reply.send({ pending: true });
  }
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
      images: item.images.map((part) => part.fileIndex)
    }))
  });
}
