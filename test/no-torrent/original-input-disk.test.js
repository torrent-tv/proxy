import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { CompletedFiles } from "../../services/storage/files/CompletedFiles.js";
import { openCompletedInputFile } from "../../services/torrent/worker/completed-input-file.js";
import { EncodeInputs } from "../../services/encode/EncodeInputs.js";
import { handleEncodeInputGet } from "../../routes/encode-input/get.js";

const hash = "0123456789abcdef0123456789abcdef01234567";

async function withFile(work) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ttv181-disk-"));
  const files = new CompletedFiles({ root });
  const content = Buffer.from(Array.from({ length: 180000 }, (_, index) => index % 251));
  try {
    await files.allow(content.length);
    await files.keep({ infoHash: hash, fileIndex: 0, length: content.length, name: "generated.bin", open: () => Readable.from([content]) });
    await work(files, content);
  } finally {
    const absolute = path.resolve(root), temporary = path.resolve(os.tmpdir());
    assert.ok(absolute.startsWith(`${temporary}${path.sep}`) && path.basename(absolute).startsWith("ttv181-disk-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

async function openInput(files) {
  const held = files.acquire(hash, 0);
  return held ? openCompletedInputFile(held, held.release) : null;
}

async function consume(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("completed files stream concurrent offsets and remain on disk until the last HTTP response closes", async () => withFile(async (files, content) => {
  const input = await openInput(files);
  let readBytes = 0;
  const first = input.stream(4000, 150000, count => { readBytes += count; });
  const second = input.stream(150000, 179999, count => { readBytes += count; });
  const closed = input.release();
  await files.allow(0);
  assert.equal(files.bytes, content.length, "leased bytes remain accounted on disk");
  assert.ok(files.find(hash, 0));
  const answers = await Promise.all([consume(first), consume(second)]);
  assert.deepEqual(answers[0], content.subarray(4000, 150001));
  assert.deepEqual(answers[1], content.subarray(150000));
  assert.equal(readBytes, 176001);
  await closed;
  assert.equal(files.bytes, 0);
  assert.equal(files.find(hash, 0), null);
}));

test("a response destroyed before reading returns its pin, including an explicit file removal", async () => withFile(async files => {
  const input = await openInput(files);
  const stream = input.stream(0, 100, () => {});
  await files.forget(hash);
  assert.equal(files.find(hash, 0), null);
  assert.ok(files.bytes > 0);
  const closed = input.release();
  stream.destroy();
  await closed;
  assert.equal(files.bytes, 0);
}));

test("closing an HTTP response destroys its unread disk stream and returns the file lease", async () => withFile(async (files, content) => {
  const file = await openInput(files);
  const raw = new EventEmitter();
  const reply = { raw, code() { return this; }, header() { return this; }, send(body) { this.body = body; return this; } };
  const input = { lengthOf: () => content.length,
    read: () => ({ end: content.length - 1, size: content.length, stream: file.stream(0, content.length - 1, () => {}) }) };
  await handleEncodeInputGet({ raw: { socket: { remoteAddress: "127.0.0.1" } }, method: "GET",
    params: { token: "1", fileIndex: "0" }, headers: { range: "bytes=0-" } }, reply, { inputOf: () => input });
  const closed = file.release();
  await files.allow(0);
  raw.emit("close");
  await closed;
  assert.equal(reply.body.destroyed, true);
  assert.equal(files.bytes, 0);
}));

test("an unavailable completed file releases its lease and allows ordinary admission to retry", async () => {
  let released = 0;
  assert.equal(await openCompletedInputFile({ path: path.join(os.tmpdir(), "ttv181-does-not-exist", "missing"), length: 5 }, () => { released++; }), null);
  assert.equal(released, 1);
});

test("withdrawing a request during completed-file acquisition returns the file lease", async () => withFile(async (files, content) => {
  let resume, opened;
  const waiting = new Promise(resolve => { resume = resolve; });
  const acquired = new Promise(resolve => { opened = resolve; });
  const output = { outputKey: "withdrawn" };
  const inputs = new EncodeInputs({
    resolve: async () => ({ kind: "result", sources: [{ sourceKey: `torrent:${hash}`, fileIndex: 0,
      input: { original: true, fileLength: content.length, ranges: [[0, 9]], commonRanges: [[0, 9]], selections: [] } }] }),
    openWholeFile: async () => { const file = await openInput(files); opened(); await waiting; return file; },
    readRanges: async () => { throw new Error("A withdrawn input must not read."); },
    reviseBudget: async () => inputs.allow(0), changed: () => {}, failed: (_output, error) => { throw error; }
  });
  const preparing = inputs.acquire(output, 0, 0);
  await acquired;
  inputs.forget(output);
  resume();
  assert.equal(await preparing, null);
  await files.allow(0);
  assert.equal(files.bytes, 0);
}));

test("disk input needs no full memory reservation and retains full FFmpeg cache accounting", async () => withFile(async (files, content) => {
  const output = { outputKey: "picture" };
  let heldReads = 0, copyReads = 0;
  const inputs = new EncodeInputs({
    resolve: async () => ({ kind: "result", sources: [{ sourceKey: `torrent:${hash}`, fileIndex: 0,
      input: { original: true, fileLength: content.length, ranges: [[0, 100000], [150000, 179999]], commonRanges: [[0, 9]], selections: [] } }] }),
    openWholeFile: () => openInput(files),
    readRanges: async () => { copyReads++; throw new Error("No completed-file input is copied."); },
    heldRanges: async () => { heldReads++; return []; },
    capacity: () => 0, reviseBudget: async () => inputs.allow(0),
    changed: () => {}, failed: (_output, error) => { throw error; }
  });
  const input = await inputs.acquire(output, 0, 0);
  assert.equal(input?.kind, "result");
  assert.equal(await input.whole, true);
  assert.equal(input.bytes, 130001);
  assert.equal(input.copiedBytes, 0);
  assert.equal(input.sharedBytes, 0);
  assert.equal(inputs.held(), 0);
  const answer = input.read(0, 150123, 179999, true);
  assert.deepEqual(await consume(answer.stream), content.subarray(150123));
  assert.equal(input.diskBytes, 29877);
  assert.equal(input.read(0, 100001, 150000, true), null);
  assert.equal(heldReads, 0);
  assert.equal(copyReads, 0);
  await input.release();
  inputs.forget(output);
}));
