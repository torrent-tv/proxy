/**
 * @file The readings that divide a cold start into its causes
 * (torrent-tv/meta#177): the processor by part, FFmpeg's reads of an original
 * input, a map publication's stages, and a budget revision's passes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { describeShares, parseStat, partOfThread, sharesBetween, threadReader } from "../../services/storage/processor-report.js";
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

test("the threads are read as the process, the main thread and the torrent thread, the rest by difference", () => {
  // Every thread's stat read each second, about a hundred files, took 12 s of
  // the main thread in fifteen minutes on Home Assistant (r22, torrent-tv/meta#178).
  const ticks = { 82: 400, 90: 200, 91: 50, 92: 20 };
  const names = { 82: "MainThread", 90: "WorkerThread", 91: "libuv-worker", 92: "V8 DefaultWorke" };
  let total = 800;
  const opened = [];
  const line = (name, used) => `x (${name}) S 1 2 3 4 5 6 7 8 9 10 ${used} 0 0 0`;
  const readText = (file) => {
    opened.push(file);
    if (file === "/proc/82/stat") return line("node", total);
    const tid = Number(/task\/(\d+)\/stat$/.exec(file)?.[1]);
    if (!(tid in ticks)) throw new Error("gone");
    return line(names[tid], ticks[tid]);
  };
  const list = () => Object.keys(ticks);
  const reader = threadReader({ pid: 82, readText, list });
  const first = reader.read();
  assert.deepEqual({ ...first, epoch: undefined }, { main: 4, worker: 2, other: 2, epoch: undefined });
  opened.length = 0;
  ticks[82] += 100; ticks[90] += 50; total += 200;
  const second = reader.read();
  assert.deepEqual(opened, ["/proc/82/stat", "/proc/82/task/82/stat", "/proc/82/task/90/stat"], "three files, not every thread's");
  const shares = sharesBetween({ at: 0, process: 0, threads: first, ffmpeg: new Map() },
    { at: 1000, process: 2, threads: second, ffmpeg: new Map() });
  assert.equal(shares.main, 1);
  assert.equal(shares.worker, 0.5);
  assert.equal(shares.other, 0.5);
  // The torrent thread is made again: it is looked up again, and the second
  // across that is not read as a jump.
  delete ticks[90];
  assert.equal(reader.read(), null);
  ticks[93] = 10; names[93] = "WorkerThread";
  const third = reader.read();
  assert.equal(third.worker, 0.1);
  const across = sharesBetween({ at: 0, process: 0, threads: second, ffmpeg: new Map() },
    { at: 1000, process: 1, threads: third, ffmpeg: new Map() });
  assert.equal(across.main, null);
  assert.equal(across.other, null);
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
    // The torrent thread's profile arrives as text over the same seconds and is
    // written beside the main thread's (r60, torrent-tv/meta#178).
    const asked = [];
    const profile = startupCpuProfile({ seconds: 0.2, dir, log: (line) => lines.push(line),
      torrentThread: async (seconds) => { asked.push(seconds); return JSON.stringify({ nodes: [{ id: 1 }] }); } });
    profile.begin();
    profile.begin();
    const written = await new Promise((resolve) => {
      const wait = () => (lines.filter((line) => line.includes("written to")).length === 2 ? resolve(true) : setTimeout(wait, 20));
      wait();
    });
    assert.equal(written, true);
    assert.deepEqual(asked, [0.2]);
    const files = (await readdir(dir)).sort();
    assert.equal(files.length, 2);
    assert.match(files[0], /^cpu-start-/);
    assert.match(files[1], /^cpu-torrent-/);
    assert.ok(JSON.parse(await readFile(path.join(dir, files[0]), "utf8")).nodes.length > 0);
    assert.equal(profile.active(), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
