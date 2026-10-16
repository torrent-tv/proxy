/**
 * @file The processor's upper bound and its measured free amount, read from
 * injected file contents (torrent-tv/meta#180, phase 1).
 *
 * No particular machine is described here: each case is a class of machine the
 * proxy may run on — a host with no quota, a container with a fractional
 * quota, a cgroup v1 host, a platform with no `/proc` at all.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  cgroupCpu,
  cpusIdleSeconds,
  describeProcessor,
  processorBetween,
  processorBound
} from "../../services/storage/machine-processor.js";

/**
 * A reader over a fixed set of files: a path not listed is absent.
 *
 * @param {Record<string, string>} files
 * @returns {(path: string) => string}
 */
function filesReader(files) {
  return (path) => {
    if (!Object.hasOwn(files, path)) {
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: "ENOENT" });
    }
    return files[path];
  };
}

const V2_ROOT = { "/proc/self/cgroup": "0::/\n" };

/**
 * @param {number} takenAt
 * @param {object} bound
 * @param {object} [rest]
 */
function sample(takenAt, bound, rest = {}) {
  return { takenAt, bound, cgroup: null, idleSeconds: null, ...rest };
}

const EIGHT_CORES = { cores: 8, parallelism: 8, quotaCores: null, source: "cores" };
const QUOTA_ONE_AND_A_HALF = { cores: 1.5, parallelism: 8, quotaCores: 1.5, source: "cgroup v2 cpu.max" };

test("cgroup v2 with `max`: no quota, the bound is the CPUs this process may run on", () => {
  const bound = processorBound({ readFile: filesReader({ ...V2_ROOT, "/sys/fs/cgroup/cpu.max": "max 100000\n" }), parallelism: 8 });
  assert.deepEqual(bound, { cores: 8, parallelism: 8, quotaCores: null, source: "cores" });
});

test("cgroup v2 with a fractional quota: one and a half cores", () => {
  const bound = processorBound({ readFile: filesReader({ ...V2_ROOT, "/sys/fs/cgroup/cpu.max": "150000 100000\n" }), parallelism: 8 });
  assert.deepEqual(bound, QUOTA_ONE_AND_A_HALF);
});

test("the smallest quota on the path binds, an ancestor's included", () => {
  const readFile = filesReader({
    "/proc/self/cgroup": "0::/system.slice/proxy.service\n",
    "/sys/fs/cgroup/system.slice/proxy.service/cpu.max": "300000 100000\n",
    "/sys/fs/cgroup/system.slice/cpu.max": "50000 100000\n",
    "/sys/fs/cgroup/cpu.max": "max 100000\n"
  });
  assert.equal(processorBound({ readFile, parallelism: 4 }).cores, 0.5);
});

test("a quota above the CPUs this process may use does not raise the bound", () => {
  const bound = processorBound({ readFile: filesReader({ ...V2_ROOT, "/sys/fs/cgroup/cpu.max": "800000 100000\n" }), parallelism: 4 });
  assert.deepEqual(bound, { cores: 4, parallelism: 4, quotaCores: 8, source: "cores" });
});

test("cgroup v1: quota over period, and -1 is no quota", () => {
  const cgroup = { "/proc/self/cgroup": "4:cpu,cpuacct:/docker/abc\n3:memory:/docker/abc\n" };
  const limited = filesReader({ ...cgroup,
    "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "50000\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n" });
  assert.deepEqual(processorBound({ readFile: limited, parallelism: 4 }),
    { cores: 0.5, parallelism: 4, quotaCores: 0.5, source: "cgroup v1 cfs" });
  const unlimited = filesReader({ ...cgroup,
    "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n" });
  assert.equal(processorBound({ readFile: unlimited, parallelism: 4 }).quotaCores, null);
});

test("no /proc at all: the CPUs alone, and no cgroup counters", () => {
  const readFile = filesReader({});
  assert.deepEqual(processorBound({ readFile, parallelism: 2 }), { cores: 2, parallelism: 2, quotaCores: null, source: "cores" });
  assert.equal(cgroupCpu({ readFile }), null);
});

test("a cgroup's own counters: its usage, and throttling read where the quota binds", () => {
  const readFile = filesReader({
    "/proc/self/cgroup": "0::/app\n",
    "/sys/fs/cgroup/app/cpu.stat": "usage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\nnr_periods 10\nnr_throttled 0\nthrottled_usec 0\n",
    "/sys/fs/cgroup/cpu.max": "100000 100000\n",
    "/sys/fs/cgroup/cpu.stat": "usage_usec 9000000\nnr_periods 50\nnr_throttled 7\nthrottled_usec 350000\n"
  });
  assert.deepEqual(cgroupCpu({ readFile }), { usageSeconds: 5, throttledPeriods: 7, throttledSeconds: 0.35 });
});

test("cgroup v1 with cpuacct mounted on its own: the usage is read there", () => {
  const readFile = filesReader({
    "/proc/self/cgroup": "2:cpuacct:/job\n1:cpu:/job\n0::/\n",
    "/sys/fs/cgroup/cpuacct/job/cpuacct.usage": "2500000000\n",
    "/sys/fs/cgroup/cpu/job/cpu.cfs_quota_us": "200000\n",
    "/sys/fs/cgroup/cpu/job/cpu.cfs_period_us": "100000\n",
    "/sys/fs/cgroup/cpu/job/cpu.stat": "nr_periods 40\nnr_throttled 4\nthrottled_time 120000000\n"
  });
  const counters = cgroupCpu({ readFile });
  assert.equal(counters.usageSeconds, 2.5);
  assert.equal(counters.throttledPeriods, 4);
  assert.ok(Math.abs(counters.throttledSeconds - 0.12) < 1e-12, `${counters.throttledSeconds}`);
});

test("os.cpus() idle time adds up every CPU, and a platform with no times says nothing", () => {
  assert.equal(cpusIdleSeconds([{ times: { idle: 1500 } }, { times: { idle: 500 } }]), 2);
  assert.equal(cpusIdleSeconds([{}, {}]), null);
  assert.equal(cpusIdleSeconds([]), null);
});

test("free is the machine's idle where /proc/stat was read", () => {
  const reading = processorBetween(sample(0, EIGHT_CORES), sample(1000, EIGHT_CORES),
    { systemShare: 0.75, ourShare: 0.5, hostCores: 8 });
  assert.equal(reading.freeCores, 2);
  assert.equal(reading.freeSource, "/proc/stat");
});

test("without /proc/stat, free comes from os.cpus() idle time", () => {
  const reading = processorBetween(sample(0, EIGHT_CORES, { idleSeconds: 100 }), sample(2000, EIGHT_CORES, { idleSeconds: 101 }),
    { systemShare: null, ourShare: null, hostCores: 8 });
  assert.equal(reading.freeCores, 0.5);
  assert.equal(reading.freeSource, "os.cpus");
});

test("with no idle reading at all, free is unknown and the line says so", () => {
  const reading = processorBetween(sample(0, EIGHT_CORES), sample(1000, EIGHT_CORES), { systemShare: null, ourShare: null, hostCores: 8 });
  assert.equal(reading.freeCores, null);
  assert.match(describeProcessor(reading), /free-cores=unknown \(no idle reading\)/);
});

test("under a quota, a large idle host leaves only the quota less our own use", () => {
  // Six of eight host CPUs idle, a 1.5-core quota, and the proxy with its
  // encoders on one core (1/8 of the machine): half a core is ours to use.
  const reading = processorBetween(sample(0, QUOTA_ONE_AND_A_HALF), sample(1000, QUOTA_ONE_AND_A_HALF),
    { systemShare: 0.25, ourShare: 1 / 8, hostCores: 8 });
  assert.equal(reading.freeCores, 0.5);
});

test("a fraction of a core free is said as that fraction, not rounded to nothing", () => {
  const reading = processorBetween(sample(0, QUOTA_ONE_AND_A_HALF), sample(1000, QUOTA_ONE_AND_A_HALF),
    { systemShare: 0.25, ourShare: 1.1 / 8, hostCores: 8 });
  assert.ok(Math.abs(reading.freeCores - 0.4) < 1e-9, `${reading.freeCores}`);
});

test("under a quota with our own use unread, free is unknown rather than the host's idle", () => {
  const reading = processorBetween(sample(0, QUOTA_ONE_AND_A_HALF), sample(1000, QUOTA_ONE_AND_A_HALF),
    { systemShare: 0.25, ourShare: null, hostCores: 8 });
  assert.equal(reading.freeCores, null);
  assert.match(reading.freeSource, /our own use is unread under a limit/);
});

test("the cgroup's own use and its throttling are said as differences over the interval", () => {
  const before = sample(0, QUOTA_ONE_AND_A_HALF, { cgroup: { usageSeconds: 10, throttledPeriods: 3, throttledSeconds: 0.1 } });
  const after = sample(2000, QUOTA_ONE_AND_A_HALF, { cgroup: { usageSeconds: 13, throttledPeriods: 8, throttledSeconds: 0.4 } });
  const reading = processorBetween(before, after, { systemShare: 0.5, ourShare: 0.15, hostCores: 8 });
  assert.equal(reading.cgroupUsedCores, 1.5);
  assert.equal(reading.throttledPeriods, 5);
  assert.ok(Math.abs(reading.throttledSeconds - 0.3) < 1e-9);
  assert.match(describeProcessor(reading),
    /^ bound=1\.50 cores \(cgroup v2 cpu\.max; 8 cpus, quota 1\.50\) free-cores=0\.30 \(\/proc\/stat\) cgroup-used=1\.50 cores throttled=5 periods 0\.30s$/);
});

test("one sample is not an interval", () => {
  assert.equal(processorBetween(null, sample(0, EIGHT_CORES), { systemShare: 0.5, ourShare: 0.1, hostCores: 8 }), null);
  assert.equal(describeProcessor(null), " bound=n/a free-cores=n/a");
});
