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
  const state = { claims: 0 };

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
    prioritizeByteRange() {}
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
