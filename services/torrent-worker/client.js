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
 * How long a shutdown waits for the thread to end by itself before forcing it.
 *
 * Ending by itself is what lets libuv drain the handle callbacks it is holding;
 * forcing it is what ran one of those against a freed isolate. Five seconds is
 * long enough for a destroyed torrent client to release its sockets and short
 * enough that a shutdown never appears to hang.
 */
const WORKER_EXIT_GRACE_MS = 5_000;

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
  /**
   * Whether this shutdown was asked for, so the thread ending can be told from
   * the thread dying. Without it both look identical from outside, which is how
   * five crashes produced no line in the log.
   */
  #stopping = false;
  #caller;
  /** Receive-side handles for in-flight reads, keyed by request id. */
  #reads = new Map();

  /**
   * The last piece served to each open read, so a fragment arriving out of
   * order can be named. Cleared when the read ends.
   *
   * @type {Map<number, number>}
   */
   #lastPieceByRead = new Map();
  /** Reads consuming fragments in place, keyed by request id. */
  #fragmentReaders = new Map();

  /** @type {(event: { sourceKey: string, fileIndex: number, trackIndex: number, cues: object[], language: string }) => void} */
  #onSubtitleCues;

  /**
   * @param {{ maxDiskBytes?: number, memoryBytes?: number, stateDir?: string, onSubtitleCues?: (event: object) => void }} [options]
   */
  constructor({ maxDiskBytes, memoryBytes, stateDir, onSubtitleCues } = {}) {
    this.#worker = new Worker(fileURLToPath(WORKER_URL), {
      // `stateDir` travels because the worker writes heap snapshots of its own
      // isolate there. It cannot choose a directory any other way: a worker may
      // not change the process's working directory, and the isolate that has
      // died three times is the one no snapshot has ever been taken of.
      workerData: { maxDiskBytes, memoryBytes, stateDir }
    });
    this.#caller = createCaller(this.#worker);
    this.#onSubtitleCues = onSubtitleCues ?? (() => undefined);

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
      if (message?.type === Event.ERROR && this.#fragmentReaders.has(message.id)) {
        const reader = this.#fragmentReaders.get(message.id);
        this.#fragmentReaders.delete(message.id);
        reader.fail(new Error(message.error ?? "Torrent worker read failed."));
        return;
      }
      if (this.#caller.handleReply(message)) {
        return;
      }
      switch (message?.type) {
        case Event.FRAGMENT: {
          const buffer = message.buffer;
          if (!buffer) {
            // No buffer means no way to read the fragment; confirm it so the
            // worker is not left waiting, and let the read end short.
            this.#worker.postMessage({ type: Event.FRAGMENT_DONE, id: message.id });
            break;
          }
          if (message.offset + message.length > buffer.byteLength) {
            logger.warn(
              `torrent-worker: fragment ${message.offset}+${message.length} lies outside ` +
              `its buffer of ${buffer.byteLength}B (read ${message.id}) — ending the read short`
            );
            this.#worker.postMessage({ type: Event.FRAGMENT_DONE, id: message.id });
            break;
          }
          // A sequential read walks the file forwards, so each fragment either
          // continues the piece before it or moves to the very next one.
          // Anything else means the bytes handed to the decoder are not the
          // file's bytes in order — which is what a decoder complaining about
          // its input has twice turned out to mean (2.9.126, and the AC-3
          // failure of 2026-08-09: the encoder ran at 9.3x, the piece store
          // reported no spills and 100% of reads from memory, and the decoder
          // still saw "new coupling strategy must be present in block 0"). The
          // bounds check catches a fragment outside the pool; this catches one
          // inside it that belongs somewhere else.
          const lastPiece = this.#lastPieceByRead.get(message.id);
          if (lastPiece !== undefined && message.pieceIndex !== lastPiece && message.pieceIndex !== lastPiece + 1) {
            logger.warn(
              `torrent-worker: read ${message.id} jumped from piece ${lastPiece} to ` +
              `${message.pieceIndex} (${message.length}B at pool offset ${message.offset}) — ` +
              "the consumer is being handed the file out of order"
            );
          }
          this.#lastPieceByRead.set(message.id, message.pieceIndex);
          const view = new Uint8Array(buffer, message.offset, message.length);

          const reader = this.#fragmentReaders.get(message.id);
          if (reader) {
            // Handed on as a view into the pool — no copy anywhere. The piece
            // stays pinned until the consumer says it is done with these exact
            // bytes, which for a response body means the socket write has
            // completed.
            reader.push(view, () => {
              this.#worker.postMessage({ type: Event.FRAGMENT_DONE, id: message.id });
            });
            break;
          }

          // Plain-stream consumers keep what they are given while the slot may
          // be reused, so they get a copy and the piece is released at once.
          this.#reads.get(message.id)?.push(Uint8Array.prototype.slice.call(view));
          this.#worker.postMessage({ type: Event.FRAGMENT_DONE, id: message.id });
          break;
        }
        case Event.CHUNK: {
          const bytes = message.bytes;
          this.#reads.get(message.id)?.push(
            new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)
          );
          break;
        }
        case Event.READ_END:
          this.#lastPieceByRead.delete(message.id);
          this.#reads.get(message.id)?.close();
          this.#reads.delete(message.id);
          this.#fragmentReaders.get(message.id)?.close();
          this.#fragmentReaders.delete(message.id);
          break;
        case Event.LOG:
          logger.info(`torrent-worker: ${message.message}`);
          break;
        case Event.SUBTITLE_CUES_READY:
          this.#onSubtitleCues({
            sourceKey: message.sourceKey,
            fileIndex: message.fileIndex,
            trackIndex: message.trackIndex,
            cues: message.cues,
            language: message.language,
            cursor: message.cursor
          });
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

    // A worker that ENDS was, until now, not noticed at all: only `message` and
    // `error` were listened for. So when the thread went away the proxy simply
    // stopped, the log ended mid-sentence, and nothing said whether we had
    // asked for it — which is precisely the reading that was missing on
    // 2026-08-21, when a core dump showed the thread faulting inside
    // `Environment::CleanupHandles` and there was no way to tell our own
    // shutdown from the thread ending on its own.
    this.#worker.on("exit", (code) => {
      if (this.#stopping) {
        logger.info(`torrent-worker: thread ended as asked (code ${code})`);
        return;
      }
      logger.error(
        `torrent-worker: thread ended on its own with code ${code} — nobody asked it to. ` +
        "Everything waiting on it is failed; the proxy has no torrent client until it is rebuilt."
      );
      const reason = new Error("Torrent worker ended unexpectedly.");
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
   * @returns {Promise<string>} The claim's identity, for {@link releaseFile}.
   */
  async acquireFile(sourceKey, fileIndex) {
    return this.#caller.call(Command.ACQUIRE_FILE, { sourceKey, fileIndex });
  }

  /**
   * Drop one claim taken with {@link acquireFile}.
   *
   * Named by claim rather than by file: several readers hold the same file at
   * once, and releasing "the file" released somebody else's hold.
   *
   * @param {string} claimId
   * @returns {Promise<void>}
   */
  async releaseFile(claimId) {
    await this.#caller.call(Command.RELEASE_FILE, { claimId });
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
   * The text subtitle tracks a file carries.
   *
   * @param {{ sourceKey: string, fileIndex: number }} params
   * @returns {Promise<{ tracks: object[] }>}
   */
  async getSubtitleTracks({ sourceKey, fileIndex }) {
    return this.#caller.call(Command.SUBTITLE_TRACKS, { sourceKey, fileIndex });
  }

  /**
   * The cues of one subtitle track that can be read from what is downloaded.
   *
   * @param {{ sourceKey: string, fileIndex: number, trackNumber: number }} params
   * @returns {Promise<object>}
   */
  async getSubtitleCues({ sourceKey, fileIndex, trackNumber }) {
    return this.#caller.call(Command.SUBTITLE_CUES, { sourceKey, fileIndex, trackNumber });
  }

  /**
   * Bytes every torrent on the worker has moved, downloaded and uploaded apart.
   *
   * The client lives on the worker thread, so this cannot be read as a property
   * from here — which is exactly the mistake 2.19.0 shipped, leaving the figure
   * always zero and the whole feature inert.
   *
   * @returns {Promise<{ downloaded: number, uploaded: number }>}
   */
  async getTorrentTotals() {
    return this.#caller.call(Command.TORRENT_TOTALS, {});
  }

  /**
   * Reorder piece selection around a read position (seek prioritisation).
   *
   * @param {{ sourceKey: string, fileIndex: number, byteStart: number, windowBytes?: number, wholeFileRead?: boolean }} params
   * @returns {Promise<void>}
   */
  async prioritizeByteRange({ sourceKey, fileIndex, byteStart, windowBytes, wholeFileRead }) {
    await this.#caller.call(Command.PRIORITIZE, {
      sourceKey,
      fileIndex,
      byteStart,
      windowBytes,
      wholeFileRead
    });
  }

  /**
   * Pre-fetch the head and tail the codec probe needs.
   *
   * @param {{ sourceKey: string, fileIndex: number, options?: { headBytes?: number, tailBytes?: number, timeoutMs?: number } }} params
   * @returns {Promise<unknown>}
   */
  async prefetchFileEdges({ sourceKey, fileIndex, options = {} }) {
    return this.#caller.call(Command.PREFETCH_EDGES, { sourceKey, fileIndex, options });
  }

  /**
   * Read a byte range as a stream.
   *
   * Returns immediately with a stream that fills as chunks arrive; cancelling it
   * (viewer gone, seek superseded) stops the worker reading, so pieces are not
   * fetched for a stream nobody will drain.
   *
   * @param {{ sourceKey: string, fileIndex: number, start?: number | null, end?: number | null, windowBytes?: number }} params
   * @returns {ReadableStream<Uint8Array>}
   */
  createReadStream({ sourceKey, fileIndex, start = null, end = null, windowBytes }) {
    // Same id sequence as commands — see `nextId` in `channel.js`.
    const readId = this.#caller.nextId();
    const receive = createReceiveStream({
      port: this.#worker,
      requestId: readId,
      onCancel: () => {
        void this.#caller.call(Command.CANCEL_READ, { readId }).catch(() => undefined);
        this.#reads.delete(readId);
        this.#lastPieceByRead.delete(readId);
      }
    });
    this.#reads.set(readId, receive);

    // The worker replies to READ_RANGE only once the body is fully sent; a
    // failure before that must surface on the stream, not vanish.
    this.#worker.postMessage({
      command: Command.READ_RANGE,
      id: readId,
      params: { sourceKey, fileIndex, start, end, windowBytes }
    });

    return receive.stream;
  }

  /**
   * Read a byte range as fragments of shared memory, without copying.
   *
   * Each fragment is a view straight into the torrent's piece pool, and the
   * piece behind it stays pinned until `release()` is called — so the consumer
   * must call it once it is genuinely finished with those bytes. For a response
   * body that means after the socket write has completed, not when it was
   * queued: verified that writing a shared-memory view and then overwriting the
   * pool from the write callback leaves the client's copy intact, and that
   * overwriting it earlier corrupts it silently.
   *
   * Returns `null` when this source has no shared pool, so the caller can fall
   * back to {@link createReadStream}.
   *
   * @param {{ sourceKey: string, fileIndex: number, start?: number | null, end?: number | null, windowBytes?: number }} params
   * @returns {{ [Symbol.asyncIterator]: () => AsyncGenerator<{ bytes: Uint8Array, release: () => void }>, cancel: () => void } | null}
   */
  createFragmentReader({ sourceKey, fileIndex, start = null, end = null, windowBytes }) {
    const readId = this.#caller.nextId();
    /** @type {{ bytes: Uint8Array, release: () => void }[]} */
    const queue = [];
    let wake = null;
    let finished = false;
    let failure = null;

    const notify = () => {
      const resume = wake;
      wake = null;
      resume?.();
    };

    this.#fragmentReaders.set(readId, {
      push(bytes, confirm) {
        queue.push({ bytes, release: confirm });
        notify();
      },
      close() {
        finished = true;
        notify();
      },
      fail(error) {
        failure = error;
        finished = true;
        notify();
      }
    });

    const cancel = () => {
      if (this.#fragmentReaders.delete(readId)) {
        void this.#caller.call(Command.CANCEL_READ, { readId }).catch(() => undefined);
      }
      finished = true;
      notify();
    };

    this.#worker.postMessage({
      command: Command.READ_RANGE,
      id: readId,
      params: { sourceKey, fileIndex, start, end, windowBytes }
    });

    return {
      cancel,
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            while (queue.length > 0) {
              yield queue.shift();
            }
            if (failure) {
              throw failure;
            }
            if (finished) {
              return;
            }
            await new Promise((resolve) => {
              wake = resolve;
            });
          }
        } finally {
          // Covers the consumer breaking out early — a client that hung up, a
          // superseded seek — which must stop the read rather than leave it
          // fetching pieces nobody will take.
          if (!finished) {
            cancel();
          }
        }
      }
    };
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
         * @param {{ start?: number, end?: number, windowBytes?: number }} [options]
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
              end: options.end ?? null,
              windowBytes: options.windowBytes
            })
          );
        },

        /**
         * Fragments of shared memory, for a caller that can say when it has
         * finished with each one. `null` when this source has no shared pool.
         *
         * @param {{ start?: number, end?: number, windowBytes?: number }} [options]
         * @returns {ReturnType<TorrentWorkerClient["createFragmentReader"]>}
         */
        createFragmentReader(options = {}) {
          return client.createFragmentReader({
            sourceKey,
            fileIndex: file.index,
            start: options.start ?? null,
            end: options.end ?? null,
            windowBytes: options.windowBytes
          });
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
    this.#stopping = true;
    try {
      await this.#caller.call(Command.DESTROY_ALL, {});
    } catch {
      // Already gone — the wait below settles either way.
    }
    // Let the thread END rather than tearing it down under itself.
    //
    // `terminate()` frees the environment immediately, with the handle
    // callbacks libuv still holds queued. One of those is utp-native's UDP
    // read, and running it against a freed isolate is what the core dump of
    // 2026-08-21 caught: `on_utp_accept` → `napi_get_buffer_info` →
    // `v8::Value::IsArrayBufferView` inside `Environment::CleanupHandles`.
    // Once the client inside is destroyed the thread has nothing left holding
    // its loop open, so it exits by itself and the callbacks drain first.
    //
    // `terminate()` stays as the bounded fallback, because a shutdown that
    // hangs is worse than one that is forced.
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        logger.warn("torrent-worker: thread did not end in 5s; terminating it");
        void this.#worker.terminate().finally(resolve);
      }, WORKER_EXIT_GRACE_MS);
      this.#worker.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
