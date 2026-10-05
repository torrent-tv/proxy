/**
 * @file Byte-range aware torrent file streaming endpoint.
 *
 * Accepts either a `sourceKey` (registered via POST /api/sources) or a raw
 * `sourceType` + `source` pair.  Responds with HTTP 206 for range requests
 * and HTTP 200 for full-file requests.
 */

import { open } from "node:fs/promises";
import { parseRange } from "../../utils/parse-range.js";
import { logger } from "../../utils/logger.js";

/**
 * The same fragments, with every wait for the next one marked: `mark(true)`
 * before it is asked for and `mark(false)` when it has come. The time between
 * is time the encoder reading this response waits for its input.
 *
 * @template T
 * @param {AsyncIterable<T>} source
 * @param {(waiting: boolean) => void} mark
 * @returns {AsyncGenerator<T>}
 */
async function* markingWaits(source, mark) {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      mark(true);
      let step;
      try {
        step = await iterator.next();
      } finally {
        mark(false);
      }
      if (step.done) {
        return;
      }
      yield step.value;
    }
  } finally {
    await iterator.return?.();
  }
}

/**
 * Resolve source parameters from the query string.
 * Prefers a registered `sourceKey`; falls back to inline `sourceType`+`source`.
 *
 * @param {import("fastify").FastifyRequest["query"]} query
 * @param {ReturnType<import("../../store/source-registry.js").createSourceRegistry>} sourceRegistry
 * @returns {{ sourceType: string, source: string, sourceKey: string }}
 */
function getSourceParams(query, sourceRegistry) {
  const sourceKey = typeof query.sourceKey === "string" ? query.sourceKey : "";
  const sourceTypeFromQuery = typeof query.sourceType === "string" ? query.sourceType : "";
  const sourceFromQuery = typeof query.source === "string" ? query.source : "";

  const sourceRecord = sourceKey ? sourceRegistry.get(sourceKey) : null;
  const sourceType = sourceRecord?.sourceType ?? sourceTypeFromQuery;
  const source = sourceRecord?.source ?? sourceFromQuery;
  return { sourceType, source, sourceKey };
}

/** Torrent metadata has no elapsed-time failure; a disconnected caller cancels its wait. */
async function waitForTorrent(torrentPool, sourceType, source, req, reply) {
  let cancelled;
  const until = new Promise((_resolve, reject) => { cancelled = () => reject(new DOMException("Source read was cancelled.", "AbortError")); });
  const closed = () => { if (!reply.raw?.writableEnded) cancelled(); };
  req.raw?.once?.("aborted", cancelled);
  reply.raw?.once?.("close", closed);
  try {
    if (req.raw?.aborted) throw new DOMException("Source read was cancelled.", "AbortError");
    return await Promise.race([torrentPool.getTorrent(sourceType, source), until]);
  } finally {
    req.raw?.off?.("aborted", cancelled);
    reply.raw?.off?.("close", closed);
  }
}

/**
 * Stream a torrent file over HTTP with byte-range support.
 *
 * GET /stream
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ sourceRegistry: ReturnType<import("../../store/source-registry.js").createSourceRegistry>, torrentPool: import("../../services/torrent/torrent-pool.js").TorrentPool }} deps
 * @returns {Promise<void>}
 */
/**
 * The whole file for this source and index, if this proxy has one.
 *
 * The source key IS the identity: `torrent:<infohash>`, the same for a magnet
 * and for a `.torrent` file of the same content. Nothing the torrent would have
 * told us is needed to find the file, which is the point — asking the torrent
 * would add it back.
 *
 * @param {{ wholeFiles?: Map<string, { path: string, length: number, name: string }> }} torrentPool
 * @param {string} sourceKey
 * @param {number} fileIndex
 * @returns {{ path: string, length: number, name: string } | null}
 */
function wholeFileFor(torrentPool, sourceKey, fileIndex) {
  const held = torrentPool?.wholeFiles;
  if (!(held instanceof Map) || held.size === 0 || !sourceKey.startsWith("torrent:")) {
    return null;
  }
  const infoHash = sourceKey.slice("torrent:".length).toLowerCase();
  return held.get(`${infoHash}/${fileIndex}`) ?? null;
}

/**
 * Serve a whole file off the disk, with ranges.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ path: string, length: number, name: string }} file
 * @param {import("node:fs/promises").FileHandle} handle - Already open; closed for HEAD.
 * @returns {Promise<void> | void}
 */
function serveWholeFile(req, reply, file, handle) {
  const disposition = `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`;
  if (req.method === "HEAD") {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.length),
      "Content-Disposition": disposition
    });
    reply.raw.end();
    return;
  }
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", "application/octet-stream");
  reply.header("Content-Disposition", disposition);
  const range = parseRange(req.headers.range, file.length);
  if (!range) {
    reply.header("Content-Length", String(file.length));
    return reply.send(handle.createReadStream());
  }
  const { start, end } = range;
  reply.code(206);
  reply.header("Content-Length", String(end - start + 1));
  reply.header("Content-Range", `bytes ${start}-${end}/${file.length}`);
  return reply.send(handle.createReadStream({ start, end }));
}

export async function handleStreamGet(req, reply, { sourceRegistry, torrentPool, noteInputBytes = null, noteInputWaiting = null }) {
  const fileIndexRaw = typeof req.query.fileIndex === "string" ? req.query.fileIndex : "";
  const fileIndex = Number(fileIndexRaw);
  const { sourceType, source, sourceKey } = getSourceParams(req.query, sourceRegistry);

  if (!sourceType || !source || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return reply
      .code(400)
      .send({ error: "sourceKey or sourceType+source with fileIndex are required." });
  }

  // A FILE DOWNLOADED WHOLE IS A FILE, and reading it needs no torrent: no
  // piece store, no memory ceiling, no eviction, no revival from a spill, and
  // nothing that can refuse the read for want of memory. The check comes before
  // the torrent is asked for on purpose — asking would add it back.
  //
  // The infohash is in the source key (`torrent:<infohash>`), so this needs
  // nothing the torrent would have told us.
  const whole = wholeFileFor(torrentPool, sourceKey, fileIndex);
  if (whole) {
    let handle;
    try {
      // Open before committing headers: the disk owner may have removed an
      // announced file. An open descriptor also preserves a live POSIX read.
      handle = await open(whole.path, "r");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const key = `${sourceKey.slice("torrent:".length).toLowerCase()}/${fileIndex}`;
      if (torrentPool.wholeFiles.get(key) === whole) torrentPool.wholeFiles.delete(key);
    }
    if (handle) {
      if (req.method === "HEAD") await handle.close();
      try {
        return serveWholeFile(req, reply, whole, handle);
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    }
  }

  let torrent;
  try {
    torrent = await waitForTorrent(torrentPool, sourceType, source, req, reply);
  } catch (error) {
    if (error?.name === "AbortError") return;
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

  const range = parseRange(req.headers.range, file.length);
  const start = range ? range.start : 0;
  const end = range ? range.end : file.length - 1;
  const contentLength = end - start + 1;

  // Written straight out of the torrent's shared memory when that is available:
  // no copy on either thread, at the cost of doing the writing by hand, because
  // only the write callback tells us when a piece may be released. Falls back to
  // the ordinary stream for sources without a shared pool.
  // Which transcode session this read feeds, when it feeds one. Put on the URL
  // by the session that builds it, because this route otherwise knows only a
  // file — and two sessions can read one file, so the file cannot stand in for
  // the session.
  const sessionId = typeof req.query.session === "string" ? req.query.session : "";
  // Which run of that output, so the time its input waits is that run's.
  const runToken = Number(req.query.run);
  const markWaits = noteInputWaiting && Number.isInteger(runToken)
    ? (waiting) => noteInputWaiting(runToken, waiting)
    : null;

  const fragments = typeof file.createFragmentReader === "function"
    ? file.createFragmentReader({ start, end })
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
      for await (const fragment of markWaits ? markingWaits(fragments, markWaits) : fragments) {
        if (reply.raw.writableEnded || reply.raw.destroyed) {
          fragment.release();
          break;
        }
        try {
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
        } finally {
          fragment.release();
        }
      }
      // THE BODY MUST BE AS LONG AS THE HEADER PROMISED, and nothing checked.
      //
      // `Content-Length` is committed before the first byte, and the reader can
      // finish early in silence: its `close()` ends the iteration with no
      // accounting, and only the `fail()` path is logged. A client then has a
      // response shorter than declared, and ffmpeg's mp4 demuxer — which holds
      // the sample table and asks for samples past what arrived — starts
      // parsing at wrong offsets. That is exactly `Invalid NAL unit size` with
      // a negative length and `missing picture in access unit`: 2138 of them in
      // one field session on a COPIED picture, where no encoder touches a frame.
      //
      // A single clean read of the same file through this route produced none,
      // and four concurrent ones produced none; what the field session also had
      // was a piece store whose readers wanted every piece it could hold, and
      // 100 of 1395 evictions took a piece a reader had declared. So this says
      // whether the body was short — which either names the cause or removes
      // the last candidate.
      if (sent !== contentLength) {
        if (req.raw.aborted || reply.raw.destroyed) return;
        throw new Error(`Source response is incomplete: ${sent} of ${contentLength} bytes.`);
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
    }
    return;
  }

  return reply.code(500).send({ error: "The map-governed source reader is unavailable.",
    code: "SOURCE_READER_UNAVAILABLE", canRetry: false });
}
