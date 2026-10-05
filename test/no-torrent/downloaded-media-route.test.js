import test from "node:test";
import assert from "node:assert/strict";
import { handleMediaGet } from "../../routes/media/get.js";

function replyFor() {
  return {
    status: 200, headers: {}, raw: { destroyed: false },
    code(value) { this.status = value; return this; },
    header(name, value) { this.headers[name] = value; return this; },
    send(value) { this.body = value; return this; }
  };
}

function request(range) {
  return { id: "read-1", query: { sourceKey: "known", fileIndex: "0" }, headers: range ? { range } : {} };
}

function poolOver(bytes, available = () => true) {
  const torrent = { pieceLength: 4, files: [{ length: bytes.length }] };
  const reads = [];
  return {
    reads,
    knownTorrent: (key) => key === "known" ? torrent : null,
    async readHeldOf(_torrent, _index, start, end) {
      reads.push([start, end]);
      return available(start, end) ? bytes.subarray(start, end + 1) : null;
    }
  };
}

test("a media read serves existing bytes through bounded storage reads", async () => {
  const pool = poolOver(Buffer.from("0123456789"));
  const reply = replyFor();
  await handleMediaGet(request("bytes=2-8"), reply, { torrentPool: pool });
  const chunks = [];
  for await (const chunk of reply.body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "2345678");
  assert.equal(reply.status, 206);
  assert.equal(reply.headers["Content-Range"], "bytes 2-8/10");
  assert.deepEqual(pool.reads, [[2, 5], [6, 8]]);
});

test("missing initial bytes return explicit ranges without a source wait", async () => {
  const pool = poolOver(Buffer.from("0123456789"), () => false);
  const missing = [];
  const reply = replyFor();
  await handleMediaGet(request(), reply, { torrentPool: pool, onMissing: (range) => missing.push(range) });
  assert.equal(reply.status, 409);
  assert.equal(reply.body.kind, "needs-ranges");
  assert.deepEqual(reply.body.ranges, [[0, 3]]);
  assert.equal(missing[0].requestId, "read-1");
  assert.deepEqual(pool.reads, [[0, 3]]);
});

test("missing later bytes fail the response and report the required range", async () => {
  const pool = poolOver(Buffer.from("0123456789"), (start) => start === 0);
  const missing = [];
  const reply = replyFor();
  await handleMediaGet(request(), reply, { torrentPool: pool, onMissing: (range) => missing.push(range) });
  await assert.rejects(async () => {
    for await (const _chunk of reply.body) { /* Consume the available prefix. */ }
  }, { code: "MEDIA_BYTES_UNAVAILABLE" });
  assert.deepEqual(missing.map(({ start, end }) => [start, end]), [[4, 7]]);
});

test("unknown media does not create a torrent and invalid ranges read nothing", async () => {
  const pool = poolOver(Buffer.from("0123456789"));
  const unknown = replyFor();
  await handleMediaGet({ ...request(), query: { sourceKey: "absent", fileIndex: "0" } }, unknown, { torrentPool: pool });
  assert.equal(unknown.status, 404);
  const invalid = replyFor();
  await handleMediaGet(request("bytes=20-30"), invalid, { torrentPool: pool });
  assert.equal(invalid.status, 416);
  assert.deepEqual(pool.reads, []);
});

test("suffix ranges return the final bytes and malformed ranges read nothing", async () => {
  const pool = poolOver(Buffer.from("0123456789"));
  const reply = replyFor();
  await handleMediaGet(request("bytes=-3"), reply, { torrentPool: pool });
  const chunks = [];
  for await (const chunk of reply.body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "789");
  assert.equal(reply.headers["Content-Range"], "bytes 7-9/10");
  for (const range of ["bytes=-0", "bytes=", "bytes=1-2-3", "bytes=1-2,4-5", "bytes=1e2-200"]) {
    const invalid = replyFor();
    await handleMediaGet(request(range), invalid, { torrentPool: pool });
    assert.equal(invalid.status, 416);
  }
  assert.deepEqual(pool.reads, [[7, 9]]);
});

test("HEAD reports media length without reading or demanding bytes", async () => {
  const pool = poolOver(Buffer.from("0123456789"), () => false);
  const reply = replyFor();
  await handleMediaGet({ ...request(), method: "HEAD" }, reply, { torrentPool: pool });
  assert.equal(reply.headers["Content-Length"], "10");
  assert.deepEqual(pool.reads, []);
});
