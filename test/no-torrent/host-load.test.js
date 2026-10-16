/**
 * @file The arithmetic that turns two readings of the machine into shares.
 *
 * The readings themselves are files this host may or may not have; what is
 * tested here is what is DERIVED from them, because that is where a wrong
 * number would quietly become a wrong conclusion about why an encoder is slow.
 */

import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { freeShareDuring, readProcessCpuSeconds, readSystemCpu, sampleHost, shareOfMachine } from "../../services/encode/host-load.js";
import { HostLoad } from "../../services/encode/quality/HostLoad.js";
import { logger } from "../../utils/logger.js";

test("metadata parsing never becomes this process's base draw", async t => {
  let now = 0, cpu = 0, epoch = 0, active = false;
  t.mock.method(Date, "now", () => now);
  const load = new HostLoad({ outputs: new Map(), readProxyCpuSeconds: () => cpu,
    readSystemCpu: async () => null, shareOfMachine,
    getTorrentTotals: async () => ({ downloaded: 0, threadCpuSeconds: 0 }), readMetadataActivity: () => ({ epoch, active }) });
  t.mock.method(os, "cpus", () => new Array(4).fill({}));
  await load.reportHostLoad();
  now += 1000; cpu += 0.4; epoch += 2;
  await load.reportHostLoad();
  assert.equal(load.baseDraw, 0);
  now += 1000; cpu += 0.4; active = true;
  await load.reportHostLoad();
  assert.equal(load.baseDraw, 0);
  now += 1000; active = false; epoch += 1;
  await load.reportHostLoad();
  now += 1000; cpu += 0.04;
  await load.reportHostLoad();
  // 0.04 s of one core of four over a second: 1 % of the machine.
  assert.ok(Math.abs(load.baseDraw - 0.01) < 1e-9, `${load.baseDraw}`);
});

test("the torrent thread's price of a downloaded byte, its base draw off, is taken while an encoder runs and used by nothing", async t => {
  let now = 0, threadCpu = 0, downloaded = 0, processCpu = 0;
  t.mock.method(Date, "now", () => now);
  const load = new HostLoad({
    outputs: new Map([["s", { id: "s" }]]), runStateOf: () => "PRODUCING", liveRunsOf: () => [],
    readProxyCpuSeconds: () => processCpu, readSystemCpu: async () => null, readProcessCpuSeconds: async () => null,
    readMachineState: async () => ({ megahertz: null, celsius: null }),
    shareOfMachine: (before, after) => shareOfMachine(before, after, 4),
    getTorrentTotals: async () => ({ downloaded, threadCpuSeconds: threadCpu })
  });
  t.mock.method(os, "cpus", () => new Array(4).fill({}));
  await load.reportHostLoad();
  // Three seconds that downloaded nothing: the thread draws 1 % of the machine.
  for (let second = 0; second < 3; second++) {
    now += 1000; threadCpu += 0.04;
    await load.reportHostLoad();
  }
  assert.equal(load.torrentThreadCostPerMegabyte, null, "an interval with nothing downloaded is never a price");
  // 10 MB in a second, the thread 0.44 s of one core, the process 100 s more.
  now += 1000; threadCpu += 0.44; downloaded += 10e6; processCpu += 100;
  await load.reportHostLoad();
  assert.ok(Math.abs(load.torrentThreadCostPerMegabyte - 0.01) < 1e-9, `${load.torrentThreadCostPerMegabyte}`);
  // Until a price is established nothing reads this one (meta#178, control run).
  assert.equal(load.observedTorrentCostPerMegabyte, null);
  // A torrent leaving the pool takes its bytes out of the total: no price.
  now += 1000; threadCpu += 5; downloaded -= 5e6;
  await load.reportHostLoad();
  assert.ok(Math.abs(load.torrentThreadCostPerMegabyte - 0.01) < 1e-9, `${load.torrentThreadCostPerMegabyte}`);
});

test("a process using one core of four for a second reports a quarter of the machine", () => {
  const before = { takenAt: 1_000, processCpuSeconds: 10, system: null };
  const after = { takenAt: 2_000, processCpuSeconds: 11, system: null };
  const share = shareOfMachine(before, after, 4);
  assert.equal(share?.elapsedSec, 1);
  assert.equal(share?.processShare, 0.25);
});

test("a process using every core reports the whole machine", () => {
  const share = shareOfMachine(
    { takenAt: 0, processCpuSeconds: 0, system: null },
    { takenAt: 2_000, processCpuSeconds: 8, system: null },
    4
  );
  assert.equal(share?.processShare, 1);
});

test("waiting for a disk is counted apart from working", () => {
  const before = { takenAt: 0, processCpuSeconds: null, system: { busySeconds: 100, idleSeconds: 900, iowaitSeconds: 10 } };
  const after = { takenAt: 1_000, processCpuSeconds: null, system: { busySeconds: 101, idleSeconds: 902, iowaitSeconds: 11 } };
  const share = shareOfMachine(before, after, 4);
  assert.equal(share?.systemShare, 0.25);
  assert.equal(share?.iowaitShare, 0.25);
});

test("two readings taken at the same instant say nothing rather than dividing by zero", () => {
  assert.equal(shareOfMachine({ takenAt: 5, processCpuSeconds: 1, system: null }, { takenAt: 5, processCpuSeconds: 2, system: null }, 4), null);
});

test("a missing reading leaves that share unknown, not zero", () => {
  const share = shareOfMachine(
    { takenAt: 0, processCpuSeconds: null, system: null },
    { takenAt: 1_000, processCpuSeconds: 1, system: null },
    4
  );
  assert.equal(share?.processShare, null);
  assert.equal(share?.systemShare, null);
});

test("a process that does not exist reports nothing at all", async () => {
  assert.equal(await readProcessCpuSeconds(0), null);
  assert.equal(await readProcessCpuSeconds(-1), null);
  // A pid far above any real one on this machine.
  assert.equal(await readProcessCpuSeconds(4_000_000), null);
});

test("on a host without /proc the readings are null and the sampler still answers", async () => {
  // This runs on Linux in CI and on Windows here; both must be safe. What is
  // asserted is the SHAPE — a reading is either a number or null, never a throw.
  const system = await readSystemCpu();
  assert.ok(system === null || typeof system.busySeconds === "number");
  const sample = await sampleHost(null);
  assert.equal(typeof sample.takenAt, "number");
  assert.equal(sample.processCpuSeconds, null);
});

test("a reading that is more than the whole machine is refused, not stored", () => {
  // Field 2026-10-06: `system=2422%` over 1.7 s on four cores.
  const share = shareOfMachine(
    { takenAt: 0, processCpuSeconds: 0, system: { busySeconds: 0, idleSeconds: 0, iowaitSeconds: 0 } },
    { takenAt: 1700, processCpuSeconds: 1, system: { busySeconds: 165, idleSeconds: 0, iowaitSeconds: 0.02 } },
    4
  );
  assert.equal(share.systemShare, null);
  assert.ok(share.rejected.some((entry) => entry.startsWith("system=")), share.rejected.join());
  // The readings beside it are still shares of the machine and are kept.
  assert.ok(Math.abs(share.processShare - 1 / (1.7 * 4)) < 1e-9);
});

test("one clock tick of rounding over a short interval is still a measurement", () => {
  // 0.1 s on four cores holds 0.4 machine-seconds; counters are whole ticks of
  // 0.01 s, so 0.41 can be a full machine read one tick late.
  const share = shareOfMachine(
    { takenAt: 0, processCpuSeconds: null, system: { busySeconds: 0, idleSeconds: 0, iowaitSeconds: 0 } },
    { takenAt: 100, processCpuSeconds: null, system: { busySeconds: 0.41, idleSeconds: 0, iowaitSeconds: 0 } },
    4
  );
  assert.ok(share.systemShare > 1 && share.systemShare < 1.1, `${share.systemShare}`);
  assert.deepEqual(share.rejected, []);
});

function idleHost({ cpuTotals }) {
  return {
    outputs: new Map(),
    readProxyCpuSeconds: () => 0,
    readSystemCpu: async () => cpuTotals(),
    shareOfMachine: (before, after) => shareOfMachine(before, after, 4)
  };
}

test("an idle machine is measured too, and a bad reading leaves it unknown instead of at zero", async t => {
  let now = 0, busy = 0;
  t.mock.method(Date, "now", () => now);
  const load = new HostLoad(idleHost({ cpuTotals: () => ({ busySeconds: busy, idleSeconds: 0, iowaitSeconds: 0 }) }));
  await load.reportHostLoad();
  assert.equal(load.hostAvailability.known, false);

  now += 1000; busy += 0.2; // 5 % of four cores
  await load.reportHostLoad();
  assert.equal(load.hostAvailability.known, true);
  assert.ok(Math.abs(load.hostAvailability.share - 0.95) < 1e-9, `${load.hostAvailability.share}`);

  now += 1000; busy += 1000; // not a share of anything
  await load.reportHostLoad();
  assert.equal(load.hostAvailability.known, false);
  assert.equal(load.hostAvailability.share, 1);

  now += 1000; busy += 0.4;
  await load.reportHostLoad();
  assert.equal(load.hostAvailability.known, true);
  assert.ok(Math.abs(load.hostAvailability.share - 0.9) < 1e-9, `${load.hostAvailability.share}`);
});

test("two ticks at once take one reading", async t => {
  let reads = 0;
  t.mock.method(Date, "now", () => 0);
  const load = new HostLoad(idleHost({ cpuTotals: () => { reads += 1; return { busySeconds: 0, idleSeconds: 0, iowaitSeconds: 0 }; } }));
  await Promise.all([load.reportHostLoad(), load.reportHostLoad(), load.reportHostLoad()]);
  assert.equal(reads, 1);
  await load.reportHostLoad();
  assert.equal(reads, 2);
});

test("a torrent worker that never answers does not stop the readings of the machine", async t => {
  let now = 0, busy = 0;
  t.mock.method(Date, "now", () => now);
  const host = idleHost({ cpuTotals: () => ({ busySeconds: busy, idleSeconds: 0, iowaitSeconds: 0 }) });
  host.getTorrentTotals = () => new Promise(() => {});
  const load = new HostLoad(host);
  void load.reportHostLoad();
  await new Promise((resolve) => setImmediate(resolve));
  now += 1000; busy += 0.2;
  void load.reportHostLoad();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(load.hostAvailability.known, true);
  assert.ok(Math.abs(load.hostAvailability.share - 0.95) < 1e-9, `${load.hostAvailability.share}`);
});

test("the share a measured process was left is the machine minus what everything else did", () => {
  // Field 2026-10-07: ffmpeg on 3.1 cores of 4 for a second, the whole machine
  // busy 3.8 core-seconds, so other work took 0.7 of 4 cores.
  const before = { takenAt: 0, processCpuSeconds: 10, system: { busySeconds: 100, iowaitSeconds: 0 } };
  const after = { takenAt: 1000, processCpuSeconds: 13.1, system: { busySeconds: 103.8, iowaitSeconds: 0 } };
  assert.ok(Math.abs(freeShareDuring(before, after, 4) - (1 - 0.7 / 4)) < 1e-9);
});

test("the share is unknown, not whole, when either reading is missing", () => {
  const reading = { takenAt: 0, processCpuSeconds: 1, system: { busySeconds: 1, iowaitSeconds: 0 } };
  assert.equal(freeShareDuring(null, reading, 4), null);
  assert.equal(freeShareDuring(reading, { ...reading, takenAt: 1000, processCpuSeconds: null }, 4), null);
  assert.equal(freeShareDuring(reading, { ...reading, takenAt: 1000, system: null }, 4), null);
});

test("a run that ends while its processor is being read does not throw the reading away", async t => {
  // r64 (torrent-tv/meta#178): the run's process was read after the await,
  // and a run that had ended meanwhile threw `reading 'pid'` of null.
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const run = { process: { pid: 4242 }, startedAt: 0 };
  const load = new HostLoad({
    outputs: new Map([["s", { id: "s" }]]), runStateOf: () => "PRODUCING", liveRunsOf: () => run.process ? [run] : [],
    readProxyCpuSeconds: () => 0, readSystemCpu: async () => null,
    readProcessCpuSeconds: async () => { run.process = null; return 1; },
    readMachineState: async () => ({ megahertz: null, celsius: null }),
    shareOfMachine: (before, after) => shareOfMachine(before, after, 4),
    getTorrentTotals: async () => ({ downloaded: 0, threadCpuSeconds: 0 })
  });
  t.mock.method(os, "cpus", () => new Array(4).fill({}));
  await load.reportHostLoad();
});

test("each run's CPU per second of film over an interval is said with the runs beside it, and used by nothing", async t => {
  // torrent-tv/meta#180, phase 1: `k` in CPU seconds per second of film,
  // beside the processor's bound and measured free amount on the machine line;
  // plan 2.3: today's cost `c` and `k` over the bound beside it.
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const lines = [];
  t.mock.method(logger, "info", (line) => lines.push(line));
  const picture = { process: { pid: 11 }, startedAt: 0, from: 3, to: 9, progress: { processedSeconds: 100, startPositionSeconds: 100 } };
  const sound = { process: { pid: 12 }, startedAt: 0, from: 1, to: 1, progress: { processedSeconds: 0, startPositionSeconds: 0 } };
  const cpu = new Map([[11, 0], [12, 0]]);
  const sessions = new Map([
    ["v", { id: "v", outputKey: "v", spec: { transcodesVideo: true } }],
    ["a", { id: "a", outputKey: "a", spec: { carries: "audio-only" } }]
  ]);
  let busy = 0;
  const load = new HostLoad({
    outputs: sessions, runStateOf: () => "PRODUCING",
    liveRunsOf: (session) => (session.id === "v" ? [picture] : [sound]),
    readProxyCpuSeconds: () => 0,
    readSystemCpu: async () => ({ busySeconds: busy, idleSeconds: 0, iowaitSeconds: 0 }),
    readProcessCpuSeconds: async (pid) => cpu.get(pid),
    readEndedChildrenCpuSeconds: async () => 0,
    readMachineState: async () => ({ megahertz: null, celsius: null }),
    shareOfMachine: (before, after) => shareOfMachine(before, after, 4),
    sampleProcessor: () => ({ takenAt: now, bound: { cores: 4, parallelism: 4, quotaCores: null, source: "cores" }, cgroup: null, idleSeconds: null }),
    processorBetween: (before, after, measured) => ({ bound: after.bound, freeCores: (1 - measured.systemShare) * measured.hostCores,
      freeSource: "/proc/stat", cgroupUsedCores: null, throttledPeriods: null, throttledSeconds: null }),
    describeProcessor: (reading) => ` free-cores=${reading.freeCores.toFixed(2)}`,
    // The picture priced, the soundtrack not yet.
    costSecOf: (session) => (session.id === "v" ? 0.3 : null)
  });
  t.mock.method(os, "cpus", () => new Array(4).fill({}));
  await load.reportHostLoad();
  // Five seconds: the picture 7.4 CPU-s for 5 s of film, the sound 0.1 CPU-s for 4 s.
  now += 5000; busy += 10;
  cpu.set(11, 7.4); cpu.set(12, 0.1);
  picture.progress.processedSeconds = 105; sound.progress.processedSeconds = 4;
  await load.reportHostLoad();
  const runCosts = lines.find((line) => line.startsWith("processor: run cost"));
  assert.equal(runCosts,
    "processor: run cost over 5.0s: v #3..#9 decode k=1.480 CPU-s per film-s (7.40 CPU-s, 5.00 film-s, speed 1.00x, 1.48 cores), " +
    "c=0.300 k/U=0.370 (U=4.00 cores), beside 1 [audio]; " +
    "a #1..#1 audio k=0.025 CPU-s per film-s (0.10 CPU-s, 4.00 film-s, speed 0.80x, 0.02 cores), " +
    "c=unpriced k/U=0.006 (U=4.00 cores), beside 1 [decode]");
  const machine = lines.find((line) => line.startsWith("host-load:"));
  // 10 of 20 core-seconds busy: two cores idle.
  assert.match(machine, / free-cores=2\.00/);
  // Phase 1 decides nothing: the availability is today's arithmetic alone.
  assert.equal(load.hostAvailability.known, true);
});
