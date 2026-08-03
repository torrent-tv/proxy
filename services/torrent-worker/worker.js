/**
 * @file The torrent thread: WebTorrent and nothing else.
 *
 * Everything that made the main thread unresponsive lives here now — peer
 * connections, buffer concatenation, piece bookkeeping, garbage collection from
 * all of it. The main thread keeps only what owes a viewer a prompt answer.
 *
 * This file deliberately holds no HTTP, no session logic and no knowledge of
 * HLS: it answers the commands in `protocol.js` and streams bytes back. That
 * boundary is what keeps the split honest — anything added here will compete
 * with the torrent for this thread, which is exactly the problem being solved.
 *
 * The existing `TorrentPool` is reused wholesale rather than reimplemented. It
 * already carries the parts that took field failures to get right — refcounted
 * file claims, idle removal, the global disk cap with LRU eviction, seek-aware
 * piece prioritisation, adaptive upload — and none of that changes by moving
 * threads.
 */

// MUST stay first: it redirects `webrtc-polyfill` to a JavaScript WebRTC stack
// before WebTorrent can reach the native one. Two isolates using
// node-datachannel at once abort the process, and the torrent's wss trackers
// create peer connections of their own.
import "./install-webrtc-shim.js";
import { parentPort, workerData } from "node:worker_threads";
import { createSendStream } from "./channel.js";
import { Command, Event, STREAM_CHUNK_BYTES } from "./protocol.js";

// Imported dynamically, and that is load-bearing: static imports are RESOLVED
// during linking, before any module body runs, so a statically imported pool
// would drag in WebTorrent — and with it the real `webrtc-polyfill` — before
// the hook above had a chance to register. Verified the hard way: with a static
// import the process still aborted, and the stack named the genuine polyfill.
const { TorrentPool } = await import("../torrent-pool.js");

const pool = new TorrentPool({ maxDiskBytes: workerData?.maxDiskBytes });

/** Torrents by sourceKey — the main thread names them, this thread owns them. */
const torrentsByKey = new Map();
/** File-claim release callbacks, keyed `${sourceKey}:${fileIndex}`. */
const releaseByClaim = new Map();
/** In-flight reads, so a cancel can stop one mid-body. */
const readsById = new Map();

/**
 * Forward a log line to the main thread, so worker output is not lost or
 * interleaved separately from everything else.
 *
 * @param {string} message
 * @returns {void}
 */
function log(message) {
  parentPort.postMessage({ type: Event.LOG, message });
}

/**
 * The torrent for a sourceKey, or throw a message the caller can surface.
 *
 * @param {string} sourceKey
 * @returns {import("webtorrent").Torrent}
 */
function requireTorrent(sourceKey) {
  const torrent = torrentsByKey.get(sourceKey);
  if (!torrent) {
    throw new Error(`Unknown source ${sourceKey}.`);
  }
  return torrent;
}

/**
 * Stream a byte range back as CHUNK messages.
 *
 * Reads through WebTorrent's own read stream — which serves already-downloaded
 * pieces from disk and waits for the rest — and forwards it in
 * {@link STREAM_CHUNK_BYTES} pieces, transferring ownership of each so nothing
 * is copied across the boundary. `createSendStream` applies the backpressure,
 * so a fast disk cannot outrun the main thread and rebuild the queue in memory.
 *
 * @param {object} params
 * @param {number} params.id - Request id; CHUNK/READ_END carry it.
 * @param {string} params.sourceKey
 * @param {number} params.fileIndex
 * @param {number | null} params.start - Inclusive, or null for the whole file.
 * @param {number | null} params.end - Inclusive.
 * @returns {Promise<void>}
 */
async function streamRange({ id, sourceKey, fileIndex, start, end }) {
  const torrent = requireTorrent(sourceKey);
  const file = torrent.files?.[fileIndex];
  if (!file) {
    throw new Error(`File ${fileIndex} not found in ${sourceKey}.`);
  }

  const sender = createSendStream({ port: parentPort, requestId: id });
  readsById.set(id, sender);

  // Hold the file for as long as this read runs. The caller also acquires it,
  // but that acquire and its release are separate messages from another thread
  // and can be reordered; this one cannot, because it lives entirely inside the
  // read. Without it the idle sweep saw a zero reader count and removed the
  // torrent AND its store mid-read — field 2026-08-02: "removed idle torrent
  // ... and its store", after which every subsequent read hung and ffmpeg got
  // an empty input.
  const releaseRead = pool.acquireFile(torrent, fileIndex);

  const options = start === null || start === undefined ? {} : { start, end };
  const source = file.createReadStream(options);

  // Coalesce WebTorrent's own chunking (piece-sized, often much smaller) up to
  // our chunk size: a round trip costs ~100 µs, so sending its native pieces
  // straight through would multiply the crossings for no benefit.
  let pendingParts = [];
  let pendingBytes = 0;

  const flush = async () => {
    if (pendingBytes === 0) {
      return;
    }
    const merged = pendingParts.length === 1 ? pendingParts[0] : Buffer.concat(pendingParts, pendingBytes);
    pendingParts = [];
    pendingBytes = 0;
    await sender.send(merged);
  };

  try {
    for await (const part of source) {
      if (sender.isCancelled()) {
        break;
      }
      pendingParts.push(part);
      pendingBytes += part.length;
      if (pendingBytes >= STREAM_CHUNK_BYTES) {
        await flush();
      }
    }
    if (!sender.isCancelled()) {
      await flush();
    }
  } finally {
    readsById.delete(id);
    releaseRead();
    sender.end();
    // A cancelled read must stop the underlying torrent stream too, or the
    // pieces keep being fetched for a viewer who has gone.
    if (typeof source.destroy === "function") {
      source.destroy();
    }
  }
}

/**
 * Run one command and return its result.
 *
 * @param {string} command
 * @param {object} params
 * @param {number} id
 * @returns {Promise<unknown>}
 */
async function runCommand(command, params, id) {
  switch (command) {
    case Command.ADD_SOURCE: {
      const torrent = await pool.getTorrent(params.sourceType, params.source);
      torrentsByKey.set(params.sourceKey, torrent);
      return {
        infoHash: torrent.infoHash,
        name: torrent.name,
        // Files cross as plain data; the objects stay here.
        files: (torrent.files ?? []).map((file, index) => ({
          index,
          name: file.name,
          path: file.path,
          length: file.length
        }))
      };
    }

    case Command.LIST_FILES: {
      const torrent = requireTorrent(params.sourceKey);
      return (torrent.files ?? []).map((file, index) => ({
        index,
        name: file.name,
        path: file.path,
        length: file.length
      }));
    }

    case Command.ACQUIRE_FILE: {
      const torrent = requireTorrent(params.sourceKey);
      const claimKey = `${params.sourceKey}:${params.fileIndex}`;
      // One claim per key; a second acquire without release would leak the
      // first release callback and pin the file forever.
      if (!releaseByClaim.has(claimKey)) {
        releaseByClaim.set(claimKey, pool.acquireFile(torrent, params.fileIndex));
      }
      return true;
    }

    case Command.RELEASE_FILE: {
      const claimKey = `${params.sourceKey}:${params.fileIndex}`;
      const release = releaseByClaim.get(claimKey);
      if (release) {
        releaseByClaim.delete(claimKey);
        release();
      }
      return true;
    }

    case Command.FILE_STATS: {
      const torrent = requireTorrent(params.sourceKey);
      return pool.getFileStats(torrent, params.fileIndex, {
        resumeAnchorByteStart: params.resumeAnchorByteStart ?? null
      });
    }

    case Command.PRIORITIZE: {
      const torrent = requireTorrent(params.sourceKey);
      pool.prioritizeByteRange(torrent, params.fileIndex, params.byteStart, params.windowBytes);
      return true;
    }

    case Command.PREFETCH_EDGES: {
      const torrent = requireTorrent(params.sourceKey);
      return pool.prefetchFileEdges(torrent, params.fileIndex, params.headBytes, params.tailBytes, params.timeoutMs);
    }

    case Command.READ_RANGE: {
      // Streams its own reply; the caller's promise resolves once the body has
      // been fully sent, which is what lets the client await completion.
      await streamRange({
        id,
        sourceKey: params.sourceKey,
        fileIndex: params.fileIndex,
        start: params.start ?? null,
        end: params.end ?? null
      });
      return true;
    }

    case Command.CANCEL_READ: {
      readsById.get(params.readId)?.cancel();
      return true;
    }

    case Command.DESTROY_ALL: {
      for (const [, release] of releaseByClaim) {
        release();
      }
      releaseByClaim.clear();
      torrentsByKey.clear();
      await pool.destroyAll();
      return true;
    }

    default:
      throw new Error(`Unknown torrent-worker command: ${command}`);
  }
}

parentPort.on("message", async (message) => {
  // Chunk acknowledgements are not commands — they release backpressure on an
  // in-flight read.
  if (message?.type === Event.CHUNK_ACK) {
    readsById.get(message.id)?.ack();
    return;
  }

  const { command, id, params } = message ?? {};
  try {
    const result = await runCommand(command, params ?? {}, id);
    parentPort.postMessage({ type: Event.RESULT, id, result });
  } catch (error) {
    parentPort.postMessage({ type: Event.ERROR, id, error: error?.message ?? String(error) });
  }
});

log("torrent worker started");
