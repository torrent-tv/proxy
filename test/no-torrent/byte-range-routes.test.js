/**
 * @file How `/stream`, `/media` and `/encode-input` answer a byte range, over
 * real Fastify with `@fastify/cors` and the private-network `onRequest` hook
 * the proxy installs (`server.js`), requests made through `inject`.
 *
 * Every answer — 200, 206, 416 and HEAD — carries the headers those hooks set:
 * a browser reading these routes directly over HTTP from another origin refuses
 * an answer without them. A whole answer is 200 with the length, a range 206
 * with its `Content-Range`, an unsatisfiable range 416 with
 * `Content-Range: bytes *\/<length>` and a JSON body, and HEAD reports the true
 * length (the keyframe index reads it). `/encode-input` always answers 206 to
 * the end of the admitted range its first byte is in.
 *
 * No torrent anywhere: the torrent pool, its fragment reader, the downloaded
 * file's read and the encoder's original input are fakes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import { handleStreamGet } from "../../routes/stream/get.js";
import { handleMediaGet } from "../../routes/media/get.js";
import { handleEncodeInputGet } from "../../routes/encode-input/get.js";

const LENGTH = 1000;
const BYTES = Buffer.from(Array.from({ length: LENGTH }, (_, index) => index % 251));
const ORIGIN = "http://viewer.test";
const FRAGMENT = 256;
// The original input of an encoder run holds these ranges of the file.
const ADMITTED = [[0, 299], [300, 699], [700, 999]];

/** A Fastify app with the CORS plugin and the private-network hook, as the proxy has them. */
async function appWith(register) {
  const app = Fastify();
  await app.register(fastifyCors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Range"]
  });
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Access-Control-Allow-Private-Network", "true");
  });
  register(app);
  await app.ready();
  return app;
}

/** `/stream` for a file read from the torrent through its fragment reader. */
async function streamFromTorrent() {
  const opened = [];
  const file = {
    name: "film.mkv",
    length: LENGTH,
    createFragmentReader({ start, end }) {
      opened.push([start, end]);
      return {
        cancel() {},
        async *[Symbol.asyncIterator]() {
          for (let at = start; at <= end; at += FRAGMENT) {
            yield { bytes: BYTES.subarray(at, Math.min(end, at + FRAGMENT - 1) + 1), release() {} };
          }
        }
      };
    }
  };
  const deps = {
    sourceRegistry: { get: () => null },
    torrentPool: { async getTorrent() { return { files: [file] }; } }
  };
  const app = await appWith(instance => instance.get("/stream", async (req, reply) => handleStreamGet(req, reply, deps)));
  return {
    app,
    url: `/stream?sourceType=magnet&source=${encodeURIComponent("magnet:?xt=urn:btih:abc")}&fileIndex=0`,
    nothingRead: () => assert.deepEqual(opened, [], "a read of the torrent was opened")
  };
}

/** `/stream` for a file this proxy has downloaded whole, read off a real file. */
async function streamFromFile(directory) {
  const where = path.join(directory, "film.mkv");
  await fsp.writeFile(where, BYTES);
  const streams = [];
  let acquired = 0;
  let released = 0;
  const deps = {
    sourceRegistry: { get: () => ({ sourceType: "torrent", source: "magnet:?xt=urn:btih:abc" }) },
    torrentPool: {
      wholeFiles: new Map([["abc/0", { path: where, length: LENGTH, name: "film.mkv" }]]),
      async acquireWholeFile() {
        acquired++;
        return {
          length: LENGTH,
          stream(start, end) {
            streams.push([start, end]);
            return fs.createReadStream(where, { start, end });
          },
          async release() { released++; }
        };
      },
      async getTorrent() { throw new Error("The torrent was asked for a file this proxy has whole."); }
    }
  };
  const app = await appWith(instance => instance.get("/stream", async (req, reply) => handleStreamGet(req, reply, deps)));
  return {
    app,
    url: `/stream?sourceKey=${encodeURIComponent("torrent:abc")}&fileIndex=0`,
    nothingRead: () => {
      assert.deepEqual(streams, [], "the file was read");
      assert.equal(released, acquired, "a lease on the file was kept");
    }
  };
}

/** `/media` over a torrent whose every byte is held. */
async function media() {
  const reads = [];
  const torrent = { pieceLength: FRAGMENT, files: [{ length: LENGTH }] };
  const deps = {
    torrentPool: {
      knownTorrent: key => key === "known" ? torrent : null,
      async readHeldOf(_torrent, _fileIndex, start, end) {
        reads.push([start, end]);
        return BYTES.subarray(start, end + 1);
      }
    }
  };
  const app = await appWith(instance => instance.get("/media", async (req, reply) => handleMediaGet(req, reply, deps)));
  return { app, url: "/media?sourceKey=known&fileIndex=0", nothingRead: () => assert.deepEqual(reads, [], "bytes were read") };
}

/** `/encode-input` over an original input that holds the ADMITTED ranges. */
async function encodeInput() {
  const reads = [];
  const input = {
    lengthOf: () => LENGTH,
    read(fileIndex, start, end, wait) {
      reads.push([fileIndex, start, end, wait]);
      const held = ADMITTED.find(([from, to]) => from <= start && start <= to);
      if (!held) return null;
      const bytes = BYTES.subarray(start, held[1] + 1);
      return { end: held[1], size: bytes.length, bytes, release() {} };
    }
  };
  const app = await appWith(instance => instance.get("/encode-input/:token/:fileIndex",
    (req, reply) => handleEncodeInputGet(req, reply, { inputOf: () => input })));
  return { app, url: "/encode-input/1/0", nothingRead: () => assert.deepEqual(reads, [], "the input was read") };
}

/** The headers every answer carries: those set by `@fastify/cors` and the private-network hook. */
function assertHookHeaders(response) {
  assert.equal(response.headers["access-control-allow-origin"], ORIGIN, "access-control-allow-origin");
  assert.equal(response.headers["access-control-allow-private-network"], "true", "access-control-allow-private-network");
}

/**
 * @param {import("light-my-request").Response} response
 * @param {{ status: number, contentRange?: string, contentLength: number, body?: [number, number] }} expected
 *   `body` is the inclusive slice of the file the body must equal; HEAD expects no body.
 */
function assertAnswer(response, { status, contentRange, contentLength, body }) {
  assert.equal(response.statusCode, status, `status (body: ${response.payload.slice(0, 200)})`);
  assert.equal(response.headers["content-range"], contentRange, "content-range");
  assert.equal(response.headers["content-length"], String(contentLength), "content-length");
  if (body) {
    assert.deepEqual(response.rawPayload, BYTES.subarray(body[0], body[1] + 1), "body");
  } else {
    assert.equal(response.rawPayload.length, 0, "body");
  }
  assertHookHeaders(response);
}

function assertUnsatisfiable(response) {
  assert.equal(response.statusCode, 416, `status (body: ${response.payload.slice(0, 200)})`);
  assert.equal(response.headers["content-range"], `bytes */${LENGTH}`, "content-range");
  assert.match(response.headers["content-type"] ?? "", /^application\/json/, "a JSON body");
  assert.equal(typeof response.json().error, "string", "a JSON body saying why");
  assertHookHeaders(response);
}

/** One request to a fresh app; the temp directory, when one was made, is removed after. */
async function ask(fixture, { method = "GET", range } = {}) {
  const directory = fixture === streamFromFile ? await fsp.mkdtemp(path.join(os.tmpdir(), "byte-range-routes-")) : null;
  const route = await fixture(directory);
  try {
    const response = await route.app.inject({
      method,
      url: route.url,
      headers: { origin: ORIGIN, ...(range ? { range } : {}) }
    });
    return { response, nothingRead: route.nothingRead };
  } finally {
    await route.app.close();
    if (directory) await fsp.rm(directory, { recursive: true, force: true });
  }
}

const STREAM_PATHS = [
  ["/stream from the torrent", streamFromTorrent],
  ["/stream from a downloaded file", streamFromFile]
];

for (const [name, fixture] of STREAM_PATHS) {
  test(`${name} answers a request with no Range with 200 and the whole file`, async () => {
    const { response } = await ask(fixture);
    assertAnswer(response, { status: 200, contentRange: undefined, contentLength: LENGTH, body: [0, 999] });
  });

  test(`${name} answers bytes=0- with 206 and every byte`, async () => {
    const { response } = await ask(fixture, { range: "bytes=0-" });
    assertAnswer(response, { status: 206, contentRange: "bytes 0-999/1000", contentLength: LENGTH, body: [0, 999] });
  });

  test(`${name} answers bytes=-500 with 206 and the last 500 bytes`, async () => {
    const { response } = await ask(fixture, { range: "bytes=-500" });
    assertAnswer(response, { status: 206, contentRange: "bytes 500-999/1000", contentLength: 500, body: [500, 999] });
  });

  test(`${name} answers bytes=2000- with 416 and reads nothing`, async () => {
    const { response, nothingRead } = await ask(fixture, { range: "bytes=2000-" });
    assertUnsatisfiable(response);
    nothingRead();
  });

  test(`${name} answers bytes=2000-3000 with 416 and reads nothing`, async () => {
    const { response, nothingRead } = await ask(fixture, { range: "bytes=2000-3000" });
    assertUnsatisfiable(response);
    nothingRead();
  });

  test(`${name} answers a multi-range header with 200 and the whole file`, async () => {
    const { response } = await ask(fixture, { range: "bytes=0-1,5-6" });
    assertAnswer(response, { status: 200, contentRange: undefined, contentLength: LENGTH, body: [0, 999] });
  });

  test(`${name} answers HEAD with 200, the true length and no body`, async () => {
    const { response, nothingRead } = await ask(fixture, { method: "HEAD" });
    assertAnswer(response, { status: 200, contentRange: undefined, contentLength: LENGTH });
    nothingRead();
  });

  test(`${name} answers HEAD with a Range as HEAD without one`, async () => {
    const { response } = await ask(fixture, { method: "HEAD", range: "bytes=0-1" });
    assertAnswer(response, { status: 200, contentRange: undefined, contentLength: LENGTH });
  });
}

test("/media answers a request with no Range with 200 and the whole file", async () => {
  const { response } = await ask(media);
  assertAnswer(response, { status: 200, contentRange: undefined, contentLength: LENGTH, body: [0, 999] });
});

test("/media answers bytes=0- with 206 and every byte", async () => {
  const { response } = await ask(media, { range: "bytes=0-" });
  assertAnswer(response, { status: 206, contentRange: "bytes 0-999/1000", contentLength: LENGTH, body: [0, 999] });
});

test("/media answers bytes=-500 with 206 and the last 500 bytes", async () => {
  const { response } = await ask(media, { range: "bytes=-500" });
  assertAnswer(response, { status: 206, contentRange: "bytes 500-999/1000", contentLength: 500, body: [500, 999] });
});

test("/media answers bytes=2000- with 416 and reads nothing", async () => {
  const { response, nothingRead } = await ask(media, { range: "bytes=2000-" });
  assertUnsatisfiable(response);
  nothingRead();
});

test("/media answers bytes=2000-3000 with 416 and reads nothing", async () => {
  const { response, nothingRead } = await ask(media, { range: "bytes=2000-3000" });
  assertUnsatisfiable(response);
  nothingRead();
});

test("/media answers a multi-range header with 200 and the whole file", async () => {
  const { response } = await ask(media, { range: "bytes=0-1,5-6" });
  assertAnswer(response, { status: 200, contentRange: undefined, contentLength: LENGTH, body: [0, 999] });
});

test("/media answers HEAD with 200 and the true length", async () => {
  const { response, nothingRead } = await ask(media, { method: "HEAD" });
  assertAnswer(response, { status: 200, contentRange: undefined, contentLength: LENGTH });
  nothingRead();
});

// FFmpeg reads `/encode-input`; an answer runs to the end of the admitted
// range its first byte is in (300-699 holds byte 500, 0-299 holds byte 0).

test("/encode-input answers a request with no Range with 206 from byte 0 to the end of its admitted range", async () => {
  const { response } = await ask(encodeInput);
  assertAnswer(response, { status: 206, contentRange: "bytes 0-299/1000", contentLength: 300, body: [0, 299] });
});

test("/encode-input answers bytes=0- with 206 to the end of the admitted range", async () => {
  const { response } = await ask(encodeInput, { range: "bytes=0-" });
  assertAnswer(response, { status: 206, contentRange: "bytes 0-299/1000", contentLength: 300, body: [0, 299] });
});

test("/encode-input answers bytes=-500 with 206 from byte 500 to the end of its admitted range", async () => {
  const { response } = await ask(encodeInput, { range: "bytes=-500" });
  assertAnswer(response, { status: 206, contentRange: "bytes 500-699/1000", contentLength: 200, body: [500, 699] });
});

test("/encode-input answers bytes=2000- with 416 and does not read the input", async () => {
  const { response, nothingRead } = await ask(encodeInput, { range: "bytes=2000-" });
  assertUnsatisfiable(response);
  nothingRead();
});

test("/encode-input answers bytes=2000-3000 with 416 and does not read the input", async () => {
  const { response, nothingRead } = await ask(encodeInput, { range: "bytes=2000-3000" });
  assertUnsatisfiable(response);
  nothingRead();
});

test("/encode-input answers a multi-range header with 206 from byte 0 to the end of its admitted range", async () => {
  const { response } = await ask(encodeInput, { range: "bytes=0-1,5-6" });
  assertAnswer(response, { status: 206, contentRange: "bytes 0-299/1000", contentLength: 300, body: [0, 299] });
});

test("/encode-input answers HEAD with 200 and the true length", async () => {
  const { response, nothingRead } = await ask(encodeInput, { method: "HEAD" });
  assertAnswer(response, { status: 200, contentRange: undefined, contentLength: LENGTH });
  nothingRead();
});
