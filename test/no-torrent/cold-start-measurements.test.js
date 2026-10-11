/**
 * @file The readings that divide a cold start into its causes
 * (torrent-tv/meta#177): the processor by part, FFmpeg's reads of an original
 * input, a map publication's stages, and a budget revision's passes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { describeShares, parseStat, partOfThread, sharesBetween } from "../../services/storage/processor-report.js";
import { describeAnswers } from "../../services/encode/OriginalInput.js";
import { DownloadMaps } from "../../services/viewer/DownloadMaps.js";
import { MachineBudget } from "../../services/storage/MachineBudget.js";

test("a stat line names its thread and its CPU, whatever the name holds", () => {
  const fields = "S 1 2 3 4 5 6 7 8 9 10 250 50 0 0";
  assert.deepEqual(parseStat(`82 (Main) Thread) ${fields}`), { name: "Main) Thread", seconds: 3 });
  assert.equal(parseStat("garbage"), null);
});

test("the main thread is the one whose id is the process's; WorkerThread is the torrent thread", () => {
  assert.equal(partOfThread(82, "MainThread", 82), "main");
  assert.equal(partOfThread(90, "WorkerThread", 82), "worker");
  assert.equal(partOfThread(91, "libuv-worker", 82), "other");
});

test("shares are per core, and a process present in one reading only adds nothing", () => {
  const before = { at: 0, process: 10, threads: { main: 4, worker: 2, other: 1 }, ffmpeg: new Map([[7, 5], [8, 1]]) };
  const after = { at: 2000, process: 12, threads: { main: 5.5, worker: 2.4, other: 1.1 }, ffmpeg: new Map([[7, 6], [9, 3]]) };
  const shares = sharesBetween(before, after);
  assert.equal(shares.seconds, 2);
  assert.equal(shares.process, 1);
  assert.equal(shares.main, 0.75);
  assert.ok(Math.abs(shares.worker - 0.2) < 1e-9);
  assert.equal(shares.ffmpeg, 0.5);
  assert.match(describeShares([shares, { ...shares, main: 1.05 }]), /main 90% \(highest second 105%\)/);
});

test("FFmpeg's answers are described by what it took, not by the ranges answered", () => {
  const answers = describeAnswers([
    { fileIndex: 0, start: 0, end: 999, written: 100, handedOver: false, at: 1 },
    { fileIndex: 0, start: 5000, end: 9999, written: 5000, handedOver: true, at: 2 },
    { fileIndex: 0, start: 50, end: 999, written: 100, handedOver: false, at: 3 }
  ]);
  assert.equal(answers.written, 5200);
  assert.equal(answers.unfinished, 2);
  assert.equal(answers.largestBackBytes, 10000 - 50);
  assert.equal(answers.rewritten, 50);
  assert.ok(Math.abs(answers.forwardShare - 2 / 3) < 1e-9);
});

test("a publication's line divides its time into stages, maps not sent included", async () => {
  let clock = 0;
  const lines = [];
  let now = 0;
  const maps = new DownloadMaps({
    publish: (map) => {
      clock += 3; // the synchronous post
      return Promise.resolve({ appliedMs: 4, receivedAt: map.postedAt + 3 + 10, repliedAt: map.postedAt + 20 });
    },
    log: (line) => lines.push(line),
    now: () => now,
    clock: () => clock
  });
  await maps.native({ sourceKey: "s", fileIndex: 0, zones: [{ byteStart: 0, byteEnd: 9, priority: 1 }] });
  await maps.native({ sourceKey: "s", fileIndex: 0, zones: [{ byteStart: 0, byteEnd: 9, priority: 1 }] });
  now = 61_000;
  await maps.native({ sourceKey: "s", fileIndex: 0, zones: [{ byteStart: 0, byteEnd: 19, priority: 1 }] });
  const line = lines.at(-1);
  assert.match(line, /2 sent and 1 unchanged/);
  assert.match(line, /posted median 3\.0ms/);
  assert.match(line, /post to the torrent thread's handler median 10\.0ms/);
  assert.match(line, /maps built and not sent took/);
});

test("a budget pass says which pass of how many asks it is", async () => {
  const lines = [];
  const budget = new MachineBudget({ logger: { info: (line) => lines.push(line) } });
  budget.defineResource({ name: "memory", readFree: async () => 100 });
  budget.register({ name: "inputs", resource: "memory", held: () => 0, wanted: () => 10, allow: () => {} });
  const first = budget.revise();
  budget.revise();
  await first;
  assert.match(lines[0], /pass 1 of a revision asked 2 time\(s\)/);
  assert.match(lines.at(-1), /pass 2 of a revision asked 2 time\(s\).*reading what is free/);
});

test("every answer says what was handed over before its connection closed", async () => {
  const { default: Fastify } = await import("fastify");
  const { handleEncodeInputGet } = await import("../../routes/encode-input/get.js");
  const http = await import("node:http");
  const size = 8 * 1024 * 1024;
  const bytes = Buffer.alloc(size, 7);
  const answers = [];
  const input = {
    lengthOf: () => size,
    read: (_fileIndex, start, end) => ({ end: Math.min(end, size - 1), bytes: bytes.subarray(start, Math.min(end, size - 1) + 1) }),
    noteAnswer: (answer) => answers.push(answer)
  };
  const app = Fastify();
  app.get("/encode-input/:token/:fileIndex", (req, reply) => handleEncodeInputGet(req, reply, { inputOf: () => input }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address();
  const closed = (count) => new Promise((resolve) => {
    const wait = () => (answers.length >= count ? resolve() : setImmediate(wait));
    wait();
  });
  try {
    await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/encode-input/1/0", headers: { range: "bytes=0-" } }, (res) => {
        res.resume();
        res.on("end", resolve);
      }).on("error", reject);
    });
    await closed(1);
    await new Promise((resolve) => {
      const request = http.get({ host: "127.0.0.1", port, path: "/encode-input/1/0", headers: { range: "bytes=0-" } }, (res) => {
        res.once("data", () => { request.destroy(); resolve(); });
      });
      request.on("error", () => {});
    });
    await closed(2);
  } finally {
    await app.close();
  }
  // Read to the end: all of it handed over. Closed after the first chunk:
  // whatever the kernel took before the close, never more than the answer —
  // how much depends on the system's buffers, so only the bound is asserted.
  assert.equal(answers[0].handedOver, true);
  assert.ok(answers[0].written >= size);
  assert.ok(answers[1].written <= size + 1024);
});

test("the cold-start profile is taken once, from the first source, and only when asked", async () => {
  const { startupCpuProfile } = await import("../../services/storage/cpu-profile.js");
  const { mkdtemp, readdir, readFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "cpu-profile-"));
  const lines = [];
  try {
    const off = startupCpuProfile({ seconds: 0, dir, log: (line) => lines.push(line) });
    off.begin();
    assert.equal(off.active(), false);
    const profile = startupCpuProfile({ seconds: 0.2, dir, log: (line) => lines.push(line) });
    profile.begin();
    profile.begin();
    const written = await new Promise((resolve) => {
      const wait = () => (lines.some((line) => line.includes("written to")) ? resolve(true) : setTimeout(wait, 20));
      wait();
    });
    assert.equal(written, true);
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.ok(JSON.parse(await readFile(path.join(dir, files[0]), "utf8")).nodes.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
