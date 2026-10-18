/**
 * @file What `/stream` does with a HEAD request.
 *
 * Fastify answers HEAD from the GET handler, so without an explicit branch a
 * HEAD started a read of the entire file. Node discards the body, but the read
 * itself runs on and the response never completes, which blocks the next
 * request on that keep-alive connection. The keyframe index asks for the file
 * size with exactly such a HEAD before every transcode session.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { handleStreamGet } from "../../routes/stream/get.js";
import { CompletedFiles } from "../../services/storage/files/CompletedFiles.js";
import { WorkerTorrentPool } from "../../services/torrent/worker/pool-adapter.js";
import { openCompletedInputFile } from "../../services/torrent/worker/completed-input-file.js";

/**
 * Minimal stand-ins for the parts of Fastify and the pool this route touches.
 *
 * @param {{ method: string, range?: string }} request
 * @returns {{ req: object, reply: object, sent: object, opened: string[], state: object }}
 */
function harness({ method, range }) {
  const opened = [];
  const state = { prioritized: [] };

  const sent = { code: 200, headers: {}, body: undefined, called: false };
  const reply = {
    code(value) {
      sent.code = value;
      return reply;
    },
    header(name, value) {
      sent.headers[name.toLowerCase()] = value;
      return reply;
    },
    send(body) {
      sent.called = true;
      sent.body = body;
      return reply;
    },
    hijack() {
      sent.hijacked = true;
    },
    raw: {
      // `bindRelease` listens here; HEAD writes its response here.
      once() {},
      write(_bytes, done) { done(); },
      destroy() { this.destroyed = true; },
      writeHead(code, headers) {
        sent.code = code;
        for (const [name, value] of Object.entries(headers)) {
          sent.headers[name.toLowerCase()] = value;
        }
      },
      end() {
        sent.called = true;
      }
    }
  };

  const file = {
    name: "movie.mkv",
    length: 5_869_669_065,
    createFragmentReader(options = {}) {
      opened.push(`${options.start ?? 0}-${options.end ?? "end"}`);
      return { cancel() {}, async *[Symbol.asyncIterator]() {
        yield { bytes: { length: (options.end ?? 5_869_669_064) - (options.start ?? 0) + 1 }, release() {} };
      } };
    }
  };

  const torrentPool = {
    async getTorrent() {
      return { files: [file], sourceKey: "key" };
    },
    prioritizeByteRange(_torrent, fileIndex, byteStart, _windowBytes, options) {
      state.prioritized.push({ byteStart, wholeFileRead: options?.wholeFileRead === true });
    }
  };

  const req = {
    method,
    query: { sourceType: "magnet", source: "magnet:?xt=urn:btih:abc", fileIndex: "0" },
    headers: range ? { range } : {},
    raw: { once() {} }
  };

  return { req, reply, sent, opened, state, deps: { sourceRegistry: { get: () => null }, torrentPool } };
}

test("HEAD reports the size without opening a read", async () => {
  const { req, reply, sent, opened, state, deps } = harness({ method: "HEAD" });

  await handleStreamGet(req, reply, deps);

  assert.deepEqual(opened, [], "HEAD started a read of the file");
  assert.deepEqual(state.prioritized, [], "HEAD asked the swarm for a read it never made");
  // The real size, not the zero Fastify substitutes for an empty payload — the
  // keyframe index reads this header and treats 0 as "no index".
  assert.equal(sent.headers["content-length"], "5869669065");
  assert.equal(sent.headers["accept-ranges"], "bytes");
  assert.equal(sent.called, true, "HEAD never completed its response");
  assert.equal(sent.body, undefined, "HEAD answered with a body");
});

test("GET still streams the bytes", async () => {
  const { req, reply, sent, opened, deps } = harness({ method: "GET" });

  await handleStreamGet(req, reply, deps);

  assert.equal(opened.length, 1, "GET did not open a read");
  assert.equal(sent.headers["content-length"], "5869669065");
});

test("GET with a range streams only that range", async () => {
  const { req, reply, sent, opened, deps } = harness({ method: "GET", range: "bytes=100-199" });

  await handleStreamGet(req, reply, deps);

  assert.deepEqual(opened, ["100-199"]);
  assert.equal(sent.code, 206);
  assert.equal(sent.headers["content-range"], "bytes 100-199/5869669065");
  assert.equal(sent.headers["content-length"], "100");
});

// A request with no byte range says nothing about where the viewer is: ffmpeg
// opens its input with a plain GET and abandons it the moment it seeks, and the
// keyframe index and the codec probe do the same — four such reads around every
// encoder restart. Reported as ordinary reads at offset 0, they undid the seek
// that had just happened and sent the swarm walking the file from its first
// missing piece; a seek to 89.1% of a 4.7 GB film downloaded 2.47 GB that way.
test("a range-less GET does not create whole-file demand", async () => {
  const { req, reply, state, deps } = harness({ method: "GET" });

  await handleStreamGet(req, reply, deps);

  assert.deepEqual(state.prioritized, []);
});

test("a ranged GET does not change the download map", async () => {
  const { req, reply, state, deps } = harness({ method: "GET", range: "bytes=4390000000-" });

  await handleStreamGet(req, reply, deps);

  assert.deepEqual(state.prioritized, []);
});

test("a file downloaded whole is served from disk without touching the torrent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stream-whole-"));
  const bytes = Buffer.from("a film that is a file now", "utf8");
  const files = new CompletedFiles({ root: path.join(root, "files") });
  await files.allow(bytes.length);
  const held = await files.keep({
    infoHash: "abc",
    fileIndex: 0,
    length: bytes.length,
    name: "film.mkv",
    open: () => Readable.from([bytes])
  });
  try {
    const { req, reply, sent, deps } = harness({ method: "GET", range: "bytes=2-6" });
    let asked = false;
    let read;
    const wholeFiles = new Map([["abc/0", held]]);
    // Supply the worker boundary explicitly: no Worker or torrent is started.
    deps.torrentPool = new WorkerTorrentPool({}, {
      wholeFiles,
      async acquireWholeFile() {
        const pin = files.acquire("abc", 0);
        read = pin && await openCompletedInputFile(pin, () => pin.release());
        return read;
      },
      async getTorrent() {
        asked = true;
        throw new Error("the worker must not be asked for completed bytes");
      }
    });
    assert.equal(deps.torrentPool.wholeFiles, wholeFiles);
    // The source key IS the identity — `torrent:<infohash>` — and it is all the
    // route needs to find the file.
    deps.sourceRegistry = { get: () => ({ sourceType: "torrent", source: "magnet:?xt=urn:btih:abc" }) };
    req.query = { sourceKey: "torrent:abc", fileIndex: "0" };

    await handleStreamGet(req, reply, deps);
    await files.allow(0);

    assert.equal(asked, false, "the torrent was asked for");
    assert.equal(files.bytes, bytes.length, "an active response lost its file lease");
    assert.equal(sent.code, 206);
    assert.equal(sent.headers["content-range"], `bytes 2-6/${bytes.length}`);
    assert.equal(sent.headers["content-length"], "5");
    const chunks = [];
    for await (const chunk of sent.body) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes.subarray(2, 7));
    await read.closed;
    assert.equal(files.bytes, 0, "the file remained after its final read lease ended");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a disconnected whole-file response releases its lease", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stream-cancelled-whole-"));
  const bytes = Buffer.alloc(256 * 1024, 7);
  const files = new CompletedFiles({ root: path.join(root, "files") });
  await files.allow(bytes.length);
  const held = await files.keep({
    infoHash: "abc",
    fileIndex: 0,
    length: bytes.length,
    name: "film.mkv",
    open: () => Readable.from([bytes])
  });
  let read;
  try {
    const { req, reply, sent, deps } = harness({ method: "GET" });
    deps.torrentPool = new WorkerTorrentPool({}, {
      wholeFiles: new Map([["abc/0", held]]),
      async acquireWholeFile() {
        const pin = files.acquire("abc", 0);
        read = pin && await openCompletedInputFile(pin, () => pin.release());
        return read;
      }
    });
    deps.sourceRegistry = { get: () => ({ sourceType: "torrent", source: "magnet:?xt=urn:btih:abc" }) };
    req.query = { sourceKey: "torrent:abc", fileIndex: "0" };

    await handleStreamGet(req, reply, deps);
    await files.allow(0);
    assert.equal(files.bytes, bytes.length, "an active response lost its file lease");
    sent.body.destroy();
    await read.closed;
    assert.equal(files.bytes, 0, "a cancelled response leaked its file lease");
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a response switches to the leased whole file after its first torrent fragment", async () => {
  const bytes = Buffer.from("abcdef");
  const chunks = [];
  const { req, reply, sent, deps } = harness({ method: "GET", range: "bytes=0-5" });
  const wholeFiles = new Map();
  let acquisitions = 0;
  let releases = 0;
  const file = {
    name: "film.mkv",
    length: bytes.length,
    createFragmentReader() {
      return {
        cancel() {},
        async *[Symbol.asyncIterator]() {
          yield { bytes: Buffer.from("ab"), release() {} };
          yield { bytes: Buffer.from("cd"), release() {} };
        }
      };
    }
  };
  deps.sourceRegistry = { get: () => ({ sourceType: "torrent", source: "magnet:?xt=urn:btih:abc" }) };
  req.query = { sourceKey: "torrent:abc", fileIndex: "0" };
  deps.torrentPool = {
    wholeFiles,
    async getTorrent() { return { files: [file] }; },
    async acquireWholeFile() {
      acquisitions++;
      return {
        length: bytes.length,
        stream(start, end) { return Readable.from([bytes.subarray(start, end + 1)]); },
        async release() { releases++; }
      };
    }
  };
  reply.raw.write = (chunk, done) => {
    chunks.push(Buffer.from(chunk));
    if (chunks.length === 1) wholeFiles.set("abc/0", { path: "unused", length: bytes.length, name: "film.mkv" });
    done();
  };
  reply.raw.end = () => { sent.called = true; };

  await handleStreamGet(req, reply, deps);

  assert.equal(sent.hijacked, true, JSON.stringify(sent));
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(acquisitions, 1, "the source switch did not acquire the whole-file lease");
  assert.equal(releases, 1, "the source switch did not release the whole-file lease");
});

test("an announced file removed before opening falls back to the torrent before headers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stream-removed-"));
  try {
    const { req, reply, sent, opened, deps } = harness({ method: "GET", range: "bytes=2-6" });
    deps.torrentPool.wholeFiles = new Map([
      ["abc/0", { path: path.join(root, "missing"), length: 10, name: "gone.mkv" }]
    ]);
    deps.torrentPool.acquireWholeFile = async () => null;
    deps.sourceRegistry = { get: () => ({ sourceType: "magnet", source: "magnet:?xt=urn:btih:abc" }) };
    req.query = { sourceKey: "torrent:abc", fileIndex: "0" };
    await handleStreamGet(req, reply, deps);
    assert.deepEqual(opened, ["2-6"]);
    assert.equal(deps.torrentPool.wholeFiles.size, 0);
    assert.equal(sent.headers["content-range"], "bytes 2-6/5869669065");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a file this proxy does not have whole still goes to the torrent", async () => {
  const { req, reply, state, deps } = harness({ method: "GET", range: "bytes=0-99" });
  deps.torrentPool.wholeFiles = new Map([["other/7", { path: "/nowhere", length: 1, name: "x" }]]);
  await handleStreamGet(req, reply, deps);
  assert.equal(state.prioritized.length, 0, "a read must not change download demand");
});

test("HEAD reads completed-file metadata without acquiring a body lease", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stream-head-whole-"));
  const where = path.join(root, "0");
  const bytes = Buffer.from("a film on disk", "utf8");
  await fs.writeFile(where, bytes);
  let acquisitions = 0;
  try {
    const { req, reply, sent, deps } = harness({ method: "HEAD" });
    deps.torrentPool = new WorkerTorrentPool({}, {
      wholeFiles: new Map([["abc/0", { path: where, length: bytes.length, name: "film.mkv" }]]),
      async acquireWholeFile() { acquisitions++; return null; }
    });
    deps.sourceRegistry = { get: () => ({ sourceType: "torrent", source: "magnet:?xt=urn:btih:abc" }) };
    req.query = { sourceKey: "torrent:abc", fileIndex: "0" };

    await handleStreamGet(req, reply, deps);

    assert.equal(acquisitions, 0, "HEAD acquired a lease despite reading no body");
    assert.equal(sent.headers["content-length"], String(bytes.length));
    assert.equal(sent.headers["accept-ranges"], "bytes");
    assert.equal(sent.called, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("every wait of an encoder's input read is marked for the run its URL names", async () => {
  // The run's processing speed is read over its own working time; the time its
  // input waits for the swarm is what this marks (RunClock).
  const { req, reply, deps } = harness({ method: "GET", range: "bytes=0-5" });
  const { files: [file] } = await deps.torrentPool.getTorrent();
  const pieces = [Buffer.from("abc"), Buffer.from("def")];
  file.createFragmentReader = () => ({
    cancel() {},
    async *[Symbol.asyncIterator]() {
      for (const bytes of pieces) {
        yield { bytes, release() {} };
      }
    }
  });
  reply.raw.write = (_bytes, done) => done();
  reply.raw.writableEnded = false;
  reply.raw.destroyed = false;
  req.query.session = "output-1";
  req.query.run = "7";
  const marks = [];
  deps.noteInputWaiting = (runToken, waiting) => marks.push([runToken, waiting]);

  await handleStreamGet(req, reply, deps);

  assert.deepEqual(marks, [[7, true], [7, false], [7, true], [7, false], [7, true], [7, false]],
    "a wait before each fragment and one before the end, each closed");
});

test("a short source response fails the connection and an unsuccessful write releases its fragment", async () => {
  for (const writeFails of [false, true]) {
    const { req, reply, sent, deps } = harness({ method: "GET", range: "bytes=0-9" });
    let released = 0;
    deps.torrentPool.getTorrent = async () => ({ files: [{ name: "file", length: 10,
      createFragmentReader: () => ({ cancel() {}, async *[Symbol.asyncIterator]() {
        yield { bytes: Buffer.alloc(5), release: () => { released++; } };
      } }) }] });
    if (writeFails) reply.raw.write = (_bytes, done) => done(new Error("Write refused"));
    await handleStreamGet(req, reply, deps);
    assert.equal(released, 1);
    assert.equal(reply.raw.destroyed, true);
    assert.equal(sent.called, false);
  }
});

/**
 * A response read from the torrent whose file is written out whole while it is
 * under way, with a body that is collected byte by byte.
 *
 * @param {{ failAfterFirst?: boolean }} options
 */
async function continuedResponse({ failAfterFirst = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stream-continue-"));
  const where = path.join(root, "0");
  const bytes = Buffer.from("0123456789abcdefghij", "utf8");
  await fs.writeFile(where, bytes);
  const { req, reply, sent, deps } = harness({ method: "GET", range: "bytes=2-17" });
  const body = [];
  reply.raw.write = (chunk, done) => { body.push(Buffer.from(chunk)); done(); };
  reply.raw.writableEnded = false;
  reply.raw.destroyed = false;
  const wholeFiles = new Map();
  let cancelled = 0;
  let released = 0;
  deps.torrentPool.wholeFiles = wholeFiles;
  deps.torrentPool.acquireWholeFile = async ({ sourceKey, fileIndex }) => {
    const infoHash = sourceKey.slice("torrent:".length).toLowerCase();
    const file = wholeFiles.get(`${infoHash}/${fileIndex}`);
    return file ? openCompletedInputFile(file, async () => {}) : null;
  };
  deps.torrentPool.getTorrent = async () => ({ files: [{ name: "film.avi", length: bytes.length,
    createFragmentReader: () => ({ cancel() { cancelled++; }, async *[Symbol.asyncIterator]() {
      yield { bytes: bytes.subarray(2, 6), release: () => { released++; } };
      // The file is written out and announced between two fragments.
      wholeFiles.set("abc/0", { path: where, length: bytes.length, name: "film.avi" });
      if (failAfterFirst) throw new Error("Piece store is closed.");
      yield { bytes: bytes.subarray(6, 10), release: () => { released++; } };
      throw new Error("the torrent was read after the file was there");
    } }) }] });
  deps.sourceRegistry = { get: () => ({ sourceType: "magnet", source: "magnet:?xt=urn:btih:abc" }) };
  req.query = { sourceKey: "torrent:abc", fileIndex: "0" };
  const noted = [];
  deps.noteInputBytes = (_session, length) => noted.push(length);
  try {
    await handleStreamGet(req, reply, deps);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
  return { body: Buffer.concat(body), expected: bytes.subarray(2, 18), sent, reply, cancelled, released, noted };
}

test("a response under way continues from the file once the file is written whole", async () => {
  // torrent-tv/meta#173: an encoder slower than the film reads one response
  // to the end; left on the piece store, it would keep the torrent alive.
  const { body, expected, sent, reply, cancelled, released, noted } = await continuedResponse();
  assert.deepEqual(body, expected, "the body is the same bytes at the same offsets");
  assert.equal(sent.headers["content-length"], String(expected.length));
  assert.equal(sent.called, true, "the response was ended");
  assert.notEqual(reply.raw.destroyed, true);
  assert.ok(cancelled >= 1, "the torrent's read was cancelled");
  assert.equal(released, 2, "every fragment taken from the torrent was released");
  assert.equal(noted.reduce((total, length) => total + length, 0), expected.length,
    "the bytes from the file are counted as the encoder's input too");
});

test("a torrent read that fails after the file is written whole is finished from the file", async () => {
  const { body, expected, sent, reply } = await continuedResponse({ failAfterFirst: true });
  assert.deepEqual(body, expected);
  assert.equal(sent.called, true);
  assert.notEqual(reply.raw.destroyed, true);
});
