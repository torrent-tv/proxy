/**
 * @file The arithmetic that turns two readings of the machine into shares.
 *
 * The readings themselves are files this host may or may not have; what is
 * tested here is what is DERIVED from them, because that is where a wrong
 * number would quietly become a wrong conclusion about why an encoder is slow.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { freeShareDuring, readProcessCpuSeconds, readSystemCpu, sampleHost, shareOfMachine } from "../../services/encode/host-load.js";
import { HostLoad } from "../../services/encode/quality/HostLoad.js";

test("metadata CPU cannot be learned as torrent download cost", async t => {
  let now = 0, cpu = 0, downloaded = 0, epoch = 0, active = false;
  t.mock.method(Date, "now", () => now);
  const load = new HostLoad({ outputs: new Map(), readProxyCpuSeconds: () => cpu,
    readSystemCpu: async () => null, shareOfMachine,
    getTorrentTotals: async () => ({ downloaded }), readMetadataActivity: () => ({ epoch, active }) });
  await load.reportHostLoad();
  now += 1000;
  await load.reportHostLoad();
  now += 1000; cpu += 100; downloaded += 1e6; epoch += 2;
  await load.reportHostLoad();
  assert.equal(load.observedTorrentCostPerMegabyte, null);
  now += 1000; cpu += 100; downloaded += 1e6; active = true;
  await load.reportHostLoad();
  assert.equal(load.observedTorrentCostPerMegabyte, null);
  now += 1000; active = false; epoch += 1;
  await load.reportHostLoad();
  now += 1000; cpu += 1; downloaded += 1e6;
  await load.reportHostLoad();
  assert.ok(load.observedTorrentCostPerMegabyte > 0);
  assert.ok(load.observedTorrentCostPerMegabyte <= 1);
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
