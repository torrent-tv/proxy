/**
 * @file Message protocol between the main thread and the torrent worker.
 *
 * **Why the torrent gets its own thread.** Profiling the live proxy during a
 * seek (2026-08-02) found the main thread ~85% busy, and busy with WebTorrent:
 * buffer concatenation in `uint8-util` ~15%, `_updateWire` and its wrapper ~9%,
 * garbage collection ~5% — and no piece hashing anywhere, which had been the
 * standing assumption. Serving a segment shares that thread, so reading an
 * already-finished 10 MB file off SSD took 12-23 s while handing it to the
 * channel took 125 ms. Two unrelated jobs — one talking to fifty peers in small
 * bursts, one owing a viewer a prompt answer — were queued behind each other
 * for no reason but sharing a thread. Three of the four cores sat idle.
 *
 * **Why this shape, measured rather than assumed** (see the numbers below):
 *
 * | approach                                   | 10 MB   |
 * |--------------------------------------------|---------|
 * | structured clone (copying)                 | 37 ms   |
 * | transferable `ReadableStream` (the standard)| 104 ms  |
 * | **this: transfer inside a stream wrapper**  | **4.8 ms** |
 * | one whole buffer, no chunking              | 0.49 ms |
 *
 * The standard transferable stream is the obvious choice and the wrong one: it
 * negotiates every chunk across the boundary and costs 22x this design. Copying
 * is worse still. So the worker transfers ownership of large buffers, and the
 * main thread wraps the arriving buffers in an ordinary `ReadableStream` —
 * standard interface outside, ownership transfer inside. Callers cannot tell
 * the difference; the cost is a tenth of a percent of a segment's playing time.
 *
 * Chunk size follows from the same measurements: a round trip costs ~100 µs, so
 * 64 KB chunks would spend 13 ms per segment on overhead against 0.5 ms sent
 * whole. {@link STREAM_CHUNK_BYTES} of 1 MB puts a 10 MB segment at ten
 * messages — about 1 ms — while still allowing a read to be cancelled promptly
 * and keeping peak memory bounded.
 *
 * Torrent objects cannot cross a thread boundary, so the main thread names them
 * by `sourceKey` (the identifier the registry already uses) and the worker owns
 * the objects.
 */

/**
 * Commands sent main thread → worker.
 *
 * @readonly
 * @enum {string}
 */
export const Command = {
  /** Add (or join) a torrent; resolves when metadata is ready. */
  ADD_SOURCE: "add-source",
  /** File list and metadata for a source. */
  LIST_FILES: "list-files",
  /** Live download figures for the progress display. */
  FILE_STATS: "file-stats",
  /** Bytes every torrent here has moved, for pricing the torrent's own cost. */
  TORRENT_TOTALS: "torrent-totals",
  /** Which films this proxy holds right now, for content affinity. */
  HELD_TORRENTS: "held-torrents",
  /**
   * The priority map for one file: seconds of film against a number.
   *
   * What anybody wants and in what order, stated once by the side that knows
   * where the viewers are. The download decides what to fetch and what to keep
   * from this, instead of from the windows the reads themselves used to
   * declare — fifteen reads declaring fifteen windows on a store that holds
   * sixteen pieces is what tore a film apart on 2026-09-05.
   */
  PRIORITY_MAP: "priority-map",
  /** Read a byte range; the body arrives as CHUNK messages. */
  READ_RANGE: "read-range",
  /** Abandon an in-flight READ_RANGE (viewer gone, seek superseded). */
  CANCEL_READ: "cancel-read",
  /**
   * The byte ranges of one file the torrent holds WHOLE, so the subtitle walk
   * can decide what it may read without asking the swarm. A list rather than a
   * question per cluster: a pass asks about every cluster of the file, and
   * hundreds of round trips for a walk meant to be free when there is nothing
   * new would be the cost of the split, not of the work.
   */
  HELD_RANGES: "held-ranges",

  /**
   * Bytes of a range the torrent already holds, read from the store and never
   * fetched. The ordinary range read declares demand and steers the swarm,
   * which is right for a viewer waiting on a segment and wrong for a walk that
   * must pull nothing.
   */
  READ_HELD: "read-held",
  /** Acquire all source pieces of an admitted input before copying its ranges. */
  READ_HELD_RANGES: "read-held-ranges",

  /** Shut the client down, optionally deleting downloaded data. */
  /**
   * How much disk the spilled pieces may take between them.
   *
   * Sent from the main thread, because the disk has one owner and this store is
   * not its only user: the segments an encoder produces are on the same disk,
   * and a ceiling one of two users sets for itself is not a ceiling. The worker
   * divides its share between the stores it holds.
   */
  SPILL_ALLOWANCE: "spill-allowance",
  WHOLE_FILES_ALLOWANCE: "whole-files-allowance",
  MEMORY_ALLOWANCE: "memory-allowance",
  DESTROY_ALL: "destroy-all"
};

/**
 * Messages sent worker → main thread.
 *
 * @readonly
 * @enum {string}
 */
export const Event = {
  /** A command completed; carries its result. */
  RESULT: "result",
  /** A command failed; carries a message (`Error`s do not survive the boundary). */
  ERROR: "error",
  /** One piece of a READ_RANGE body; its bytes are transferred, never copied. */
  CHUNK: "chunk",
  /**
   * Where a piece of the body sits in the torrent's shared pool — an offset and
   * a length, no bytes at all. The main thread maps the same memory and reads it
   * in place; see `piece-reader.js` for why this replaces sending the bytes.
   */
  FRAGMENT: "fragment",
  /**
   * The main thread has finished with a FRAGMENT and its pin may be dropped.
   * Distinct from {@link CHUNK_ACK}, which only reports queue capacity: this one
   * is a promise that nothing is reading those bytes any more.
   */
  FRAGMENT_DONE: "fragment-done",
  /** A READ_RANGE ended; no further CHUNKs bear that request id. */
  READ_END: "read-end",
  /** The main thread consumed a chunk — see {@link STREAM_HIGH_WATER_CHUNKS}. */
  CHUNK_ACK: "chunk-ack",
  /** A log line, so worker output reaches the same place as everything else. */
  LOG: "log",
  /**
   * Pieces of these files have arrived.
   *
   * ANNOUNCED, not asked: the torrent is the only thing that knows a piece just
   * verified, and what anybody does about it — walk a subtitle track's new
   * clusters, say — is no business of this thread. It used to walk them itself,
   * which put the cue reading in the thread that owns the swarm.
   */
  PIECES_ARRIVED: "pieces-arrived",
  /** Available source bytes changed after verification or withdrawal. */
  PIECES_CHANGED: "pieces-changed",
  /** A resolved source handle closed; retained media readings must be released. */
  SOURCE_FORGOTTEN: "source-forgotten",

  /**
   * A file has been downloaded whole and written out as a file.
   *
   * The main thread serves it from disk after this, without asking this thread
   * for anything: an ordinary read of an ordinary file, with no piece store
   * between them and nothing that can refuse it for want of memory.
   */
  FILE_COMPLETE: "file-complete"
};

/**
 * Bytes per CHUNK message. See the file header for why 1 MB.
 */
export const STREAM_CHUNK_BYTES = 1024 * 1024;

/**
 * How many chunks may be in flight before the worker waits for an acknowledgement.
 *
 * Unbounded sending would let a fast disk outrun the channel and rebuild, in the
 * message queue, exactly the memory the transfers were saving. Two in flight
 * keeps the pipe full without letting it grow.
 */
export const STREAM_HIGH_WATER_CHUNKS = 2;
