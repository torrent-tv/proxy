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
  /** Claim a file for reading, so it is not evicted while in use. */
  ACQUIRE_FILE: "acquire-file",
  /** Drop a claim; the worker applies its own idle-removal policy. */
  RELEASE_FILE: "release-file",
  /** File list and metadata for a source. */
  LIST_FILES: "list-files",
  /** Live download figures for the progress display. */
  FILE_STATS: "file-stats",
  /** Bytes every torrent here has moved, for pricing the torrent's own cost. */
  TORRENT_TOTALS: "torrent-totals",
  /** Reorder piece selection around a read position (seek prioritisation). */
  PRIORITIZE: "prioritize",
  /** Read a byte range; the body arrives as CHUNK messages. */
  READ_RANGE: "read-range",
  /** Abandon an in-flight READ_RANGE (viewer gone, seek superseded). */
  CANCEL_READ: "cancel-read",
  /** Pre-fetch the head and tail a codec probe needs. */
  PREFETCH_EDGES: "prefetch-edges",
  /**
   * Fetch one whole file using only the room the viewer's own reading leaves —
   * a soundtrack or subtitle file they may switch to later. Returns as soon as
   * the work is under way.
   */
  FILL_FILE: "fill-file",
  /** The text subtitle tracks a file carries, for the viewer's menu. */
  SUBTITLE_TRACKS: "subtitle-tracks",
  /**
   * Every track a file declares, read from its own header by the container
   * layer. Answers what ffmpeg's `-i` banner cannot: FlagOriginal,
   * FlagCommentary, FlagVisualImpaired, FlagEnabled and LanguageBCP47 appear
   * nowhere in it. Asked of the picture AND of a soundtrack shipped as its own
   * file beside it, which is the same question about a different file.
   */
  CONTAINER_TRACKS: "container-tracks",
  /** Cues of one subtitle track, from the clusters already downloaded. */
  SUBTITLE_CUES: "subtitle-cues",
  /** Shut the client down, optionally deleting downloaded data. */
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
   * New subtitle cues were read for one track, unprompted — the worker found
   * them off its own `verified`-piece walk, not in answer to a
   * {@link Command.SUBTITLE_CUES} call. Lets the main thread PUSH them to
   * whichever browser is watching instead of waiting to be asked.
   */
  SUBTITLE_CUES_READY: "subtitle-cues-ready"
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
