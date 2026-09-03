/**
 * @file Byte-range aware torrent file streaming endpoint.
 *
 * Accepts either a `sourceKey` (registered via POST /api/sources) or a raw
 * `sourceType` + `source` pair.  Responds with HTTP 206 for range requests
 * and HTTP 200 for full-file requests.
 */

import { parseRange } from "../../utils/parse-range.js";
import { logger } from "../../utils/logger.js";

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
 * How long a request may wait for a torrent that is still being added.
 *
 * Adding a magnet takes as long as its metadata does — seconds when peers
 * answer, forever when none do — and `getTorrent` waits for it. Awaiting that
 * with no bound is what made this route answer nothing at all.
 */
const TORRENT_READY_TIMEOUT_MS = 10_000;

/**
 * The torrent for a source, or a `TORRENT_NOT_READY` error once the wait has
 * gone on long enough to be worth reporting.
 *
 * The underlying add is NOT cancelled: it keeps running and warms the pool, so
 * the client's next attempt is likely to find it ready.
 *
 * @param {import("../../services/torrent-pool.js").TorrentPool} torrentPool
 * @param {string} sourceType
 * @param {string} source
 * @returns {Promise<import("webtorrent").Torrent>}
 */
async function waitForTorrent(torrentPool, sourceType, source) {
  let timer = null;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Torrent metadata is not available yet.");
      error.code = "TORRENT_NOT_READY";
      reject(error);
    }, TORRENT_READY_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([torrentPool.getTorrent(sourceType, source), expiry]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
export async function handleStreamGet(req, reply, { sourceRegistry, torrentPool, noteInputBytes = null }) {
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
    torrent = await waitForTorrent(torrentPool, sourceType, source);
  } catch (error) {
    if (error instanceof Error && error.code === "TORRENT_NOT_READY") {
      // Say so, rather than holding the connection until the client gives up.
      // Reproduced 2026-08-04 on a magnet whose metadata never arrived: both a
      // ranged GET and a HEAD returned nothing at all for the full 30 s the
      // probe was willing to wait, and the route had written neither a status
      // nor a header — from the client that is indistinguishable from the proxy
      // having died, and it left no trace in the log either.
      reply.header("Retry-After", "1");
      return reply.code(503).send({ error: "Torrent metadata is not available yet." });
    }
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
  // Only the encoder's own input read tracks where the viewer is. Everything
  // else that comes through here — the codec probe, the keyframe index, a
  // subtitle fetch — reads the file's edges, and treating those as a viewer
  // position made every session start and every encoder restart look like a
  // burst of seeks (measured: two spurious "the viewer moved" per start).
  torrentPool.prioritizeByteRange(torrent, fileIndex, range ? range.start : 0, undefined, {
    wholeFileRead: range === null,
    isPlaybackRead: req.query.reader === "playback"
  });

  const start = range ? range.start : 0;
  const end = range ? range.end : file.length - 1;
  const contentLength = end - start + 1;

  // Written straight out of the torrent's shared memory when that is available:
  // no copy on either thread, at the cost of doing the writing by hand, because
  // only the write callback tells us when a piece may be released. Falls back to
  // the ordinary stream for sources without a shared pool.
  // How far ahead of its own read head this reader should ask the swarm for.
  // Supplied by whoever knows the media's byte rate — the transcode session
  // puts it on the ffmpeg input URL, sized in seconds of playback — because
  // this thread knows only bytes, and 32 MB is half a minute of a 1080p film
  // but four seconds of a disc remux. Absent or unusable, the reader's own
  // default stands.
  const windowBytesRaw = Number(req.query.windowBytes);
  const windowBytes =
    Number.isFinite(windowBytesRaw) && windowBytesRaw > 0 ? windowBytesRaw : undefined;

  // Which transcode session this read feeds, when it feeds one. Put on the URL
  // by the session that builds it, because this route otherwise knows only a
  // file — and two sessions can read one file, so the file cannot stand in for
  // the session.
  const sessionId = typeof req.query.session === "string" ? req.query.session : "";

  const fragments = typeof file.createFragmentReader === "function"
    ? file.createFragmentReader({ start, end, windowBytes })
    : null;

  if (fragments) {
    reply.hijack();
    reply.raw.writeHead(range ? 206 : 200, {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(contentLength),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${file.length}` } : {})
    });

    // A client that goes away mid-response must stop the read, or pieces keep
    // being fetched for nobody.
    reply.raw.once("close", () => fragments.cancel());

    let sent = 0;
    try {
      for await (const fragment of fragments) {
        if (reply.raw.writableEnded || reply.raw.destroyed) {
          fragment.release();
          break;
        }
        await new Promise((resolve, reject) => {
          reply.raw.write(fragment.bytes, (error) => (error ? reject(error) : resolve()));
        });
        sent += fragment.bytes.length;
        // Say so, if this read belongs to a transcode session. It is the only
        // proof that a session which has produced nothing yet is nevertheless
        // being fed: the encoder's own progress cannot move until its first
        // frame is decoded, and a viewer waiting for that first frame was being
        // told the proxy had died while the swarm was delivering to it. Field
        // 2026-09-03: 46.3 s on one piece, `processedSeconds` frozen at the
        // start position throughout, and the browser gave up 0.4 s before the
        // piece landed.
        if (noteInputBytes) {
          noteInputBytes(sessionId, fragment.bytes.length);
        }
        // Only now are these bytes gone: the piece can be unpinned, and the
        // slot it occupies reused. Releasing before this point corrupts the
        // response silently.
        fragment.release();
      }
      reply.raw.end();
    } catch (error) {
      // The body is already committed by its headers, so there is nothing
      // useful to send instead — drop the connection and let the client retry.
      // But say why: swallowing this made the route close connections with no
      // status and no trace, which from the client looks like the proxy died
      // and from the log looks like nothing happened at all.
      // WHOSE end it was. A write cancelled because the consumer went away is
      // the ordinary end of a read: ffmpeg is terminated on every seek and
      // whenever the look-ahead bound suspends it, and its connection closes
      // with it. Reported as a failure, that line fired several times a minute
      // during healthy playback — and on 2026-08-09 it was read as the cause of
      // broken audio, which it was not. A read that ends because the reader
      // left is not a fault and must not be dressed as one; anything else is.
      const message = error instanceof Error ? error.message : String(error);
      const consumerLeft = req.raw.aborted || reply.raw.destroyed || /ECANCELED|EPIPE|ERR_STREAM_DESTROYED/.test(message);
      const line =
        `stream: read of "${file.name}" bytes ${start}-${end} ended after ` +
        `${sent} of ${contentLength} bytes: ${message}`;
      if (consumerLeft) {
        logger.debug(`${line} (the reader disconnected — expected on an encoder restart)`);
      } else {
        logger.warn(line);
      }
      reply.raw.destroy();
    } finally {
      releaseFile();
    }
    return;
  }

  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", "application/octet-stream");
  reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);

  if (!range) {
    reply.header("Content-Length", String(file.length));
    const stream = file.createReadStream();
    bindRelease(stream, reply, releaseFile);
    return reply.send(stream);
  }

  reply.code(206);
  reply.header("Content-Length", String(contentLength));
  reply.header("Content-Range", `bytes ${start}-${end}/${file.length}`);
  const stream = file.createReadStream({ start, end });
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
