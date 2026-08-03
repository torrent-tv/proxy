/**
 * @file Main-thread face of the torrent worker.
 *
 * Presents the same operations the routes and session manager already use, so
 * moving the torrent to its own thread does not ripple through calling code.
 * The one unavoidable change is that torrents are named by `sourceKey` instead
 * of passed around as objects — objects cannot cross a thread boundary, and
 * pretending otherwise would mean copying them on every call.
 *
 * Reads come back as an ordinary `ReadableStream`, so `/stream` and the codec
 * probe consume them exactly as they consume WebTorrent's own streams today.
 * What that hides is the part that matters: chunks arrive as transferred
 * buffers, never copied — 5.3 ms per 10 MB against 37 ms if cloned and 104 ms
 * through a transferable stream (measured 2026-08-02, see `protocol.js`).
 */

import { Worker } from "node:worker_threads";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { logger } from "../../utils/logger.js";
import { createCaller, createReceiveStream } from "./channel.js";
import { Command, Event } from "./protocol.js";

const WORKER_URL = new URL("./worker.js", import.meta.url);

/**
 * Runs the torrent client on its own thread and exposes it to the main thread.
 *
 * Why this exists at all: profiling during a live seek found the main thread
 * ~85% busy with WebTorrent (buffer concatenation ~15%, wire updates ~9%,
 * garbage collection ~5%), while three of four cores idled. Serving a segment
 * queued behind that work, so reading a finished 10 MB file took 12-23 s where
 * handing it to the channel took 125 ms.
 */
export class TorrentWorkerClient {
  #worker;
  #caller;
  /** Receive-side handles for in-flight reads, keyed by request id. */
  #reads = new Map();

  /**
   * @param {{ maxDiskBytes?: number, memoryBytes?: number }} [options]
   */
  constructor({ maxDiskBytes, memoryBytes } = {}) {
    this.#worker = new Worker(fileURLToPath(WORKER_URL), {
      workerData: { maxDiskBytes, memoryBytes }
    });
    this.#caller = createCaller(this.#worker);

    this.#worker.on("message", (message) => {
      // A failed read must fail its stream. This is checked BEFORE the caller
      // sees the message: until 2.9.76 nothing here handled a read error at
      // all, so the worker's report was dropped as unknown, and because the
      // worker sent the end-of-read marker from its `finally` even when the
      // read had thrown, the reader saw a clean end of file instead. A read
      // that failed before it produced anything simply hung forever.
      if (message?.type === Event.ERROR && this.#reads.has(message.id)) {
        const read = this.#reads.get(message.id);
        this.#reads.delete(message.id);
        read.fail(new Error(message.error ?? "Torrent worker read failed."));
        return;
      }
      if (this.#caller.handleReply(message)) {
        return;
      }
      switch (message?.type) {
        case Event.CHUNK: {
          const bytes = message.bytes;
          this.#reads.get(message.id)?.push(
            new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)
          );
          break;
        }
        case Event.READ_END:
          this.#reads.get(message.id)?.close();
          this.#reads.delete(message.id);
          break;
        case Event.LOG:
          logger.info(`torrent-worker: ${message.message}`);
          break;
        default:
          break;
      }
    });

    this.#worker.on("error", (error) => {
      logger.error(`torrent-worker crashed: ${error?.message ?? error}`);
      // Fail everything outstanding rather than leaving callers hanging: a dead
      // worker will never answer, and a stalled request is worse than an error
      // the loading flow can retry.
      const reason = new Error("Torrent worker stopped unexpectedly.");
      this.#caller.rejectAll(reason);
      for (const [, read] of this.#reads) {
        read.fail(reason);
      }
      this.#reads.clear();
    });
  }

  /**
   * Add (or join) a torrent and register it under `sourceKey`.
   *
   * @param {{ sourceKey: string, sourceType: "magnet" | "torrent", source: string }} params
   * @returns {Promise<{ infoHash: string, name: string, files: { index: number, name: string, path: string, length: number }[] }>}
   */
  async addSource({ sourceKey, sourceType, source }) {
    return this.#caller.call(Command.ADD_SOURCE, { sourceKey, sourceType, source });
  }

  /**
   * The torrent's files, as plain data.
   *
   * @param {string} sourceKey
   * @returns {Promise<{ index: number, name: string, path: string, length: number }[]>}
   */
  async listFiles(sourceKey) {
    return this.#caller.call(Command.LIST_FILES, { sourceKey });
  }

  /**
   * Claim a file so it is not evicted while being read.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {Promise<void>}
   */
  async acquireFile(sourceKey, fileIndex) {
    await this.#caller.call(Command.ACQUIRE_FILE, { sourceKey, fileIndex });
  }

  /**
   * Drop a claim taken with {@link acquireFile}.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {Promise<void>}
   */
  async releaseFile(sourceKey, fileIndex) {
    await this.#caller.call(Command.RELEASE_FILE, { sourceKey, fileIndex });
  }

  /**
   * Live download figures for the progress display.
   *
   * @param {{ sourceKey: string, fileIndex: number, resumeAnchorByteStart?: number | null }} params
   * @returns {Promise<object>}
   */
  async getFileStats({ sourceKey, fileIndex, resumeAnchorByteStart = null }) {
    return this.#caller.call(Command.FILE_STATS, { sourceKey, fileIndex, resumeAnchorByteStart });
  }

  /**
   * Reorder piece selection around a read position (seek prioritisation).
   *
   * @param {{ sourceKey: string, fileIndex: number, byteStart: number, windowBytes?: number }} params
   * @returns {Promise<void>}
   */
  async prioritizeByteRange({ sourceKey, fileIndex, byteStart, windowBytes }) {
    await this.#caller.call(Command.PRIORITIZE, { sourceKey, fileIndex, byteStart, windowBytes });
  }

  /**
   * Pre-fetch the head and tail the codec probe needs.
   *
   * @param {{ sourceKey: string, fileIndex: number, headBytes?: number, tailBytes?: number, timeoutMs?: number }} params
   * @returns {Promise<unknown>}
   */
  async prefetchFileEdges({ sourceKey, fileIndex, headBytes, tailBytes, timeoutMs }) {
    return this.#caller.call(Command.PREFETCH_EDGES, {
      sourceKey,
      fileIndex,
      headBytes,
      tailBytes,
      timeoutMs
    });
  }

  /**
   * Read a byte range as a stream.
   *
   * Returns immediately with a stream that fills as chunks arrive; cancelling it
   * (viewer gone, seek superseded) stops the worker reading, so pieces are not
   * fetched for a stream nobody will drain.
   *
   * @param {{ sourceKey: string, fileIndex: number, start?: number | null, end?: number | null }} params
   * @returns {ReadableStream<Uint8Array>}
   */
  createReadStream({ sourceKey, fileIndex, start = null, end = null }) {
    // Same id sequence as commands — see `nextId` in `channel.js`.
    const readId = this.#caller.nextId();
    const receive = createReceiveStream({
      port: this.#worker,
      requestId: readId,
      onCancel: () => {
        void this.#caller.call(Command.CANCEL_READ, { readId }).catch(() => undefined);
        this.#reads.delete(readId);
      }
    });
    this.#reads.set(readId, receive);

    // The worker replies to READ_RANGE only once the body is fully sent; a
    // failure before that must surface on the stream, not vanish.
    this.#worker.postMessage({
      command: Command.READ_RANGE,
      id: readId,
      params: { sourceKey, fileIndex, start, end }
    });

    return receive.stream;
  }

  /**
   * A stand-in for the WebTorrent torrent object, backed by the worker.
   *
   * Callers already hold a torrent and reach into `torrent.files[i]` — for the
   * length, the name, or a read stream. Handing back an object of the same
   * shape keeps every one of those call sites working unchanged, which matters:
   * they are spread across the stream route, the subtitle route, the playback
   * planner and the health report, and rewriting all of them to thread a
   * `sourceKey` through would be a large change with nothing to show for it.
   *
   * Only what is actually used is provided. Anything else would be a promise we
   * cannot keep — the real object lives on the other thread and its methods are
   * not reachable from here.
   *
   * @param {{ sourceKey: string, sourceType: "magnet" | "torrent", source: string }} params
   * @returns {Promise<{ infoHash: string, name: string, sourceKey: string, files: object[] }>}
   */
  async getTorrent({ sourceKey, sourceType, source }) {
    const info = await this.addSource({ sourceKey, sourceType, source });
    const client = this;
    return {
      infoHash: info.infoHash,
      name: info.name,
      // Carried so helpers that receive only the torrent can still name it to
      // the worker.
      sourceKey,
      files: info.files.map((file) => ({
        ...file,
        /**
         * @param {{ start?: number, end?: number }} [options]
         * @returns {ReadableStream<Uint8Array>}
         */
        createReadStream(options = {}) {
          // Node stream, not a web one: Fastify replies and the ffmpeg pipe
          // both expect that shape, and every existing call site passes the
          // result straight to one of them. `Readable.fromWeb` adds no copy —
          // it wraps the same buffers.
          return Readable.fromWeb(
            client.createReadStream({
              sourceKey,
              fileIndex: file.index,
              start: options.start ?? null,
              end: options.end ?? null
            })
          );
        }
      }))
    };
  }

  /**
   * Shut the torrent client down and stop the thread.
   *
   * @returns {Promise<void>}
   */
  async destroyAll() {
    try {
      await this.#caller.call(Command.DESTROY_ALL, {});
    } catch {
      // Already gone — termination below is what matters.
    }
    await this.#worker.terminate();
  }
}
