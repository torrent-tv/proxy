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
import { handleStreamGet } from "../routes/stream/get.js";

/**
 * Minimal stand-ins for the parts of Fastify and the pool this route touches.
 *
 * @param {{ method: string, range?: string }} request
 * @returns {{ req: object, reply: object, sent: object, opened: string[], claims: number }}
 */
function harness({ method, range }) {
  const opened = [];
  const state = { claims: 0, prioritized: [] };

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
    createReadStream(options = {}) {
      opened.push(`${options.start ?? 0}-${options.end ?? "end"}`);
      return { on() {} };
    }
  };

  const torrentPool = {
    async getTorrent() {
      return { files: [file], sourceKey: "key" };
    },
    acquireFile() {
      state.claims += 1;
      return () => undefined;
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
  assert.equal(state.claims, 0, "HEAD claimed the file it never read");
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
test("a range-less GET is reported as a whole-file read", async () => {
  const { req, reply, state, deps } = harness({ method: "GET" });

  await handleStreamGet(req, reply, deps);

  assert.deepEqual(state.prioritized, [{ byteStart: 0, wholeFileRead: true }]);
});

test("a ranged GET is reported as a real read position", async () => {
  const { req, reply, state, deps } = harness({ method: "GET", range: "bytes=4390000000-" });

  await handleStreamGet(req, reply, deps);

  assert.deepEqual(state.prioritized, [{ byteStart: 4_390_000_000, wholeFileRead: false }]);
});
