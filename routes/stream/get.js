/**
 * @file Byte-range aware torrent file streaming endpoint.
 *
 * Accepts either a `sourceKey` (registered via POST /api/sources) or a raw
 * `sourceType` + `source` pair.  Responds with HTTP 206 for range requests
 * and HTTP 200 for full-file requests.
 */

import { parseRange } from "../../utils/parse-range.js";

/**
 * Resolve source parameters from the query string.
 * Prefers a registered `sourceKey`; falls back to inline `sourceType`+`source`.
 *
 * @param {import("fastify").FastifyRequest["query"]} query
 * @param {ReturnType<import("../../store/source-registry.js").createSourceRegistry>} sourceRegistry
 * @returns {{ sourceType: string, source: string }}
 */
function getSourceParams(query, sourceRegistry) {
  const sourceKey = typeof query.sourceKey === "string" ? query.sourceKey : "";
  const sourceTypeFromQuery = typeof query.sourceType === "string" ? query.sourceType : "";
  const sourceFromQuery = typeof query.source === "string" ? query.source : "";

  const sourceRecord = sourceKey ? sourceRegistry.get(sourceKey) : null;
  const sourceType = sourceRecord?.sourceType ?? sourceTypeFromQuery;
  const source = sourceRecord?.source ?? sourceFromQuery;
  return { sourceType, source };
}

/**
 * Stream a torrent file over HTTP with byte-range support.
 *
 * GET /stream
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ sourceRegistry: ReturnType<import("../../store/source-registry.js").createSourceRegistry>, torrentPool: import("../../services/torrent-pool.js").TorrentPool }} deps
 * @returns {Promise<void>}
 */
export async function handleStreamGet(req, reply, { sourceRegistry, torrentPool }) {
  const fileIndexRaw = typeof req.query.fileIndex === "string" ? req.query.fileIndex : "";
  const fileIndex = Number(fileIndexRaw);
  const { sourceType, source } = getSourceParams(req.query, sourceRegistry);

  if (!sourceType || !source || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return reply
      .code(400)
      .send({ error: "sourceKey or sourceType+source with fileIndex are required." });
  }

  let torrent;
  try {
    torrent = await torrentPool.getTorrent(sourceType, source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: `Failed to load torrent source: ${message}` });
  }

  const file = torrent.files[fileIndex];
  if (!file) {
    return reply.code(404).send({ error: "File index was not found in torrent." });
  }

  // HEAD asks what a GET would return, not for the bytes. Fastify serves HEAD
  // from this same handler, which used to mean a HEAD started a read of the
  // WHOLE file: the body was discarded by Node, but the read ran on, the
  // response never finished, and the next request on that keep-alive connection
  // waited behind it. Measured on the field host: the keyframe-index HEAD
  // returned headers in 23 ms and then held the connection until its 15 s
  // timeout, which is where the 73 s transcode-session create went.
  if (req.method === "HEAD") {
    // Written to the raw response on purpose. Answering through `reply.send()`
    // with no payload makes Fastify set `content-length: 0`, which is worse
    // than useless here: the keyframe index asks for the file size with this
    // very request and treats 0 as "no index available", silently falling back
    // to an invented segment grid. Hijacking leaves the response to us, and
    // Node omits the body for HEAD by itself.
    reply.hijack();
    reply.raw.writeHead(200, {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.length),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`
    });
    reply.raw.end();
    return;
  }

  const releaseFile = torrentPool.acquireFile(torrent, fileIndex);

  const range = parseRange(req.headers.range, file.length);
  // Prioritize the pieces at this read position so a seek (a request at a new
  // byte offset) downloads first instead of waiting behind the sequential
  // backlog — this is what caused ~15-18 s stalls when seeking into an
  // undownloaded region.
  torrentPool.prioritizeByteRange(torrent, fileIndex, range ? range.start : 0);
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", "application/octet-stream");
  reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);

  if (!range) {
    reply.header("Content-Length", String(file.length));
    const stream = file.createReadStream();
    bindRelease(stream, reply, releaseFile);
    return reply.send(stream);
  }

  const contentLength = range.end - range.start + 1;
  reply.code(206);
  reply.header("Content-Length", String(contentLength));
  reply.header("Content-Range", `bytes ${range.start}-${range.end}/${file.length}`);
  const stream = file.createReadStream({ start: range.start, end: range.end });
  bindRelease(stream, reply, releaseFile);
  return reply.send(stream);
}

/**
 * Attach event listeners that release the file reference exactly once when
 * the stream or the underlying HTTP connection closes.
 *
 * @param {import("node:stream").Readable} stream
 * @param {import("fastify").FastifyReply} reply
 * @param {() => void} release
 * @returns {void}
 */
function bindRelease(stream, reply, release) {
  let released = false;
  const releaseOnce = () => {
    if (released) {
      return;
    }
    released = true;
    release();
  };

  stream.on("close", releaseOnce);
  stream.on("end", releaseOnce);
  stream.on("error", releaseOnce);
  reply.raw.once("close", releaseOnce);
  reply.raw.once("finish", releaseOnce);
}
