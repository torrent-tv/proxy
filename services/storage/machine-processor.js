/**
 * @file How much processor this process could ever use, and how much of it was
 * free over an interval (torrent-tv/meta#180, phase 1: readings only).
 *
 * Two quantities, never put in each other's place:
 *
 * 1. **The upper bound**, in cores: what the operating system lets this process
 *    run on — the CPUs it may be scheduled on (`os.availableParallelism()`,
 *    which follows the affinity mask on Linux) and the CPU quota of every cgroup
 *    on its path (Docker's `--cpus`, systemd's `CPUQuota=`), the smallest of
 *    them. A quota may be fractional: `cpu.max` of `150000 100000` is one and a
 *    half cores. The bound says what can never be exceeded; it says nothing of
 *    what is free.
 * 2. **The measured free amount**, in cores: the idle time of the machine's
 *    CPUs over the interval — from `/proc/stat` where the caller has it, from
 *    `os.cpus()` times on every other platform — and, under a bound smaller
 *    than the machine, no more than the bound less what this proxy and its
 *    encoders used. Inside a container both readings describe the HOST's CPUs,
 *    which is what the other containers left. Where neither reading exists, or
 *    our own use is unknown under such a bound, it is unknown, and said so.
 *
 * A cgroup's own `cpu.stat` is NOT a reading of other work: its usage is what
 * this cgroup and its descendants used, and its throttling says that the quota
 * held our work back. Both are reported as that, and nothing else.
 *
 * Memory had the same defect this file answers for the processor — the host's
 * figure where a container's limit decided — and was fixed in #153/#155
 * (`machine-memory.js`); the cgroup is found the same way.
 */

import { readFileSync } from "node:fs";
import os from "node:os";

import { cgroupOf, levelsOf } from "./machine-memory.js";

/**
 * Where each cgroup version keeps its CPU controller, and under which names.
 *
 * Version 1 keeps the usage in a controller of its own, `cpuacct`, mounted
 * either beside `cpu` (`cpu,cpuacct`, with `cpu` and `cpuacct` as links to
 * it) or on its own; `/sys/fs/cgroup/cpuacct` names it in both cases. Its
 * counters are in nanoseconds; version 2's in microseconds.
 */
const HIERARCHIES = {
  1: { mount: "/sys/fs/cgroup/cpu", source: "cgroup v1 cfs", usageController: "cpuacct", usageMount: "/sys/fs/cgroup/cpuacct",
    usage: "cpuacct.usage", usageUnit: 1e-9, throttledName: "throttled_time", throttledUnit: 1e-9 },
  2: { mount: "/sys/fs/cgroup", source: "cgroup v2 cpu.max", usageController: "cpu", usageMount: "/sys/fs/cgroup",
    usage: "cpu.stat", usageUnit: 1e-6, throttledName: "throttled_usec", throttledUnit: 1e-6 }
};

/**
 * @typedef {object} ProcessorBound
 * @property {number} cores - What this process can never exceed, in cores.
 * @property {number} parallelism - The CPUs it may be scheduled on.
 * @property {number | null} quotaCores - The smallest cgroup quota on its path, or null for none.
 * @property {string} source - Which of the two decided `cores`.
 */

/**
 * @typedef {object} CgroupCpu
 * @property {number | null} usageSeconds - CPU seconds this cgroup and its descendants used.
 * @property {number | null} throttledPeriods - Periods the binding quota held the cgroup back.
 * @property {number | null} throttledSeconds - Time it was held back.
 */

/**
 * @typedef {object} ProcessorSample
 * @property {number} takenAt - Wall clock, ms.
 * @property {ProcessorBound} bound
 * @property {CgroupCpu | null} cgroup
 * @property {number | null} idleSeconds - Idle time of every CPU since boot, from `os.cpus()`.
 */

/**
 * What this process can never exceed.
 *
 * @param {object} [options]
 * @param {(path: string) => string} [options.readFile] - Throws where a file is absent; injected by the checks.
 * @param {number} [options.parallelism]
 * @returns {ProcessorBound}
 */
export function processorBound({ readFile = readText, parallelism = os.availableParallelism() } = {}) {
  const quota = quotaOnPath(readFile);
  const cores = Math.max(1, parallelism);
  if (quota !== null && quota.cores < cores) {
    return { cores: quota.cores, parallelism: cores, quotaCores: quota.cores, source: HIERARCHIES[quota.version].source };
  }
  return { cores, parallelism: cores, quotaCores: quota?.cores ?? null, source: "cores" };
}

/**
 * This cgroup's own CPU counters: its usage, and how often its binding quota
 * held it back. Null where there is no cgroup to read (not Linux, no CPU
 * controller); each counter null where its file is not there.
 *
 * @param {object} [options]
 * @param {(path: string) => string} [options.readFile]
 * @returns {CgroupCpu | null}
 */
export function cgroupCpu({ readFile = readText } = {}) {
  const levels = cpuLevels(readFile);
  if (levels === null) {
    return null;
  }
  const hierarchy = HIERARCHIES[levels.version];
  let usageSeconds = null;
  for (const directory of usageLevels(readFile, levels.version)) {
    const text = tryRead(readFile, `${directory}/${hierarchy.usage}`);
    if (text === null) continue;
    const value = levels.version === 2 ? statField(text, "usage_usec") : wholeNumber(text);
    if (value !== null) {
      usageSeconds = value * hierarchy.usageUnit;
      break;
    }
  }
  let throttledPeriods = null;
  let throttledSeconds = null;
  const binding = bindingLevel(readFile, levels);
  const stat = binding === null ? null : tryRead(readFile, `${binding}/cpu.stat`);
  if (stat !== null) {
    throttledPeriods = statField(stat, "nr_throttled");
    const time = statField(stat, hierarchy.throttledName);
    throttledSeconds = time === null ? null : time * hierarchy.throttledUnit;
  }
  return { usageSeconds, throttledPeriods, throttledSeconds };
}

/**
 * The idle time of every CPU since boot, from `os.cpus()`, which every
 * platform answers. Null where it states no times.
 *
 * @param {Array<{ times?: { idle?: number } }>} [cpus]
 * @returns {number | null} Seconds.
 */
export function cpusIdleSeconds(cpus = os.cpus()) {
  if (!Array.isArray(cpus) || cpus.length === 0) {
    return null;
  }
  let idleMs = 0;
  for (const cpu of cpus) {
    const idle = Number(cpu?.times?.idle);
    if (!Number.isFinite(idle)) return null;
    idleMs += idle;
  }
  return idleMs / 1000;
}

/**
 * One reading of everything above, to be compared against the next.
 *
 * @param {object} [options]
 * @param {(path: string) => string} [options.readFile]
 * @param {() => Array<{ times?: { idle?: number } }>} [options.cpus]
 * @param {number} [options.parallelism]
 * @param {() => number} [options.now]
 * @returns {ProcessorSample}
 */
export function sampleProcessor({ readFile = readText, cpus = () => os.cpus(), parallelism, now = Date.now } = {}) {
  return {
    takenAt: now(),
    bound: processorBound({ readFile, ...(parallelism === undefined ? {} : { parallelism }) }),
    cgroup: cgroupCpu({ readFile }),
    idleSeconds: cpusIdleSeconds(cpus())
  };
}

/**
 * @typedef {object} ProcessorReading
 * @property {ProcessorBound} bound
 * @property {number | null} freeCores - Measured free, in cores; null when unknown.
 * @property {string} freeSource - Where it came from, or why it is unknown.
 * @property {number | null} cgroupUsedCores - This cgroup's own use over the interval.
 * @property {number | null} throttledPeriods
 * @property {number | null} throttledSeconds
 */

/**
 * What two samples say about the interval between them.
 *
 * @param {ProcessorSample | null | undefined} before
 * @param {ProcessorSample | null | undefined} after
 * @param {object} measured - Shares of the WHOLE machine over the same interval.
 * @param {number | null} measured.systemShare - Everything the machine did, from `/proc/stat`; null where unread.
 * @param {number | null} measured.ourShare - The proxy and its encoders; null where either is unread.
 * @param {number} measured.hostCores - The CPUs those shares are fractions of.
 * @returns {ProcessorReading | null} Null without two samples.
 */
export function processorBetween(before, after, { systemShare, ourShare, hostCores }) {
  if (!before || !after) {
    return null;
  }
  const elapsedSec = (after.takenAt - before.takenAt) / 1000;
  if (!(elapsedSec > 0)) {
    return null;
  }
  const cores = Math.max(1, hostCores);
  let idleCores = null;
  let freeSource = "unknown: no idle reading";
  if (Number.isFinite(systemShare)) {
    idleCores = clamp((1 - systemShare) * cores, 0, cores);
    freeSource = "/proc/stat";
  } else if (Number.isFinite(before.idleSeconds) && Number.isFinite(after.idleSeconds) && after.idleSeconds >= before.idleSeconds) {
    idleCores = clamp((after.idleSeconds - before.idleSeconds) / elapsedSec, 0, cores);
    freeSource = "os.cpus";
  }
  let freeCores = idleCores;
  const bound = after.bound;
  if (idleCores !== null && bound.cores < cores) {
    // Under a bound smaller than the machine, an idle CPU is ours only as far
    // as the bound leaves room beside what we already use.
    if (Number.isFinite(ourShare)) {
      freeCores = Math.min(idleCores, Math.max(0, bound.cores - ourShare * cores));
    } else {
      freeCores = null;
      freeSource = "unknown: our own use is unread under a limit";
    }
  }
  const delta = (key) => {
    const from = before.cgroup?.[key];
    const to = after.cgroup?.[key];
    return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : null;
  };
  const used = delta("usageSeconds");
  return {
    bound,
    freeCores,
    freeSource,
    cgroupUsedCores: used === null ? null : used / elapsedSec,
    throttledPeriods: delta("throttledPeriods"),
    throttledSeconds: delta("throttledSeconds")
  };
}

/**
 * The reading as it is written into the machine's line of the log.
 *
 * @param {ProcessorReading | null} reading
 * @returns {string}
 */
export function describeProcessor(reading) {
  if (reading === null) {
    return " bound=n/a free-cores=n/a";
  }
  const { bound } = reading;
  const limit = bound.quotaCores === null ? "no quota" : `quota ${bound.quotaCores.toFixed(2)}`;
  const free = reading.freeCores === null ? `unknown (${reading.freeSource.replace(/^unknown: /, "")})`
    : `${reading.freeCores.toFixed(2)} (${reading.freeSource})`;
  const used = reading.cgroupUsedCores === null ? "n/a" : `${reading.cgroupUsedCores.toFixed(2)} cores`;
  const throttled = reading.throttledPeriods === null && reading.throttledSeconds === null ? "n/a"
    : `${reading.throttledPeriods ?? "n/a"} periods ${reading.throttledSeconds === null ? "n/a" : `${reading.throttledSeconds.toFixed(2)}s`}`;
  return ` bound=${bound.cores.toFixed(2)} cores (${bound.source}; ${bound.parallelism} cpus, ${limit})` +
    ` free-cores=${free} cgroup-used=${used} throttled=${throttled}`;
}

/**
 * This process's cgroup for the CPU controller and the directories to read,
 * its own first, or null where there is none.
 *
 * @param {(path: string) => string} readFile
 * @returns {{ version: 1 | 2, directories: string[] } | null}
 */
function cpuLevels(readFile) {
  const text = tryRead(readFile, "/proc/self/cgroup");
  const membership = text === null ? null : cgroupOf(text, "cpu");
  if (membership === null) {
    return null;
  }
  const directories = levelsOf(HIERARCHIES[membership.version].mount, membership.path);
  return directories.length === 0 ? null : { version: membership.version, directories };
}

/**
 * The directories that hold this process's CPU usage, its own first.
 *
 * @param {(path: string) => string} readFile
 * @param {1 | 2} version
 * @returns {string[]}
 */
function usageLevels(readFile, version) {
  const hierarchy = HIERARCHIES[version];
  const text = tryRead(readFile, "/proc/self/cgroup");
  const membership = text === null ? null : cgroupOf(text, hierarchy.usageController);
  return membership === null ? [] : levelsOf(hierarchy.usageMount, membership.path);
}

/**
 * The quota of one cgroup directory, in cores, or null where it states none.
 *
 * @param {(path: string) => string} readFile
 * @param {1 | 2} version
 * @param {string} directory
 * @returns {number | null}
 */
function quotaAt(readFile, version, directory) {
  if (version === 2) {
    const text = tryRead(readFile, `${directory}/cpu.max`);
    const [quota, period] = (text ?? "").trim().split(/\s+/);
    const cores = Number(quota) / Number(period);
    return /^\d+$/.test(quota ?? "") && Number.isFinite(cores) && cores > 0 ? cores : null;
  }
  const quota = wholeNumber(tryRead(readFile, `${directory}/cpu.cfs_quota_us`) ?? "");
  const period = wholeNumber(tryRead(readFile, `${directory}/cpu.cfs_period_us`) ?? "");
  // `-1` is version 1's "no quota", which `wholeNumber` does not accept.
  return quota !== null && period !== null && quota > 0 && period > 0 ? quota / period : null;
}

/**
 * The smallest quota on this process's cgroup path, and its version.
 *
 * @param {(path: string) => string} readFile
 * @returns {{ version: 1 | 2, cores: number } | null}
 */
function quotaOnPath(readFile) {
  const levels = cpuLevels(readFile);
  if (levels === null) {
    return null;
  }
  const binding = bindingLevel(readFile, levels);
  return binding === null ? null : { version: levels.version, cores: quotaAt(readFile, levels.version, binding) };
}

/**
 * The directory whose quota is the smallest on the path, or null for none.
 *
 * @param {(path: string) => string} readFile
 * @param {{ version: 1 | 2, directories: string[] }} levels
 * @returns {string | null}
 */
function bindingLevel(readFile, levels) {
  let binding = null;
  let smallest = Infinity;
  for (const directory of levels.directories) {
    const cores = quotaAt(readFile, levels.version, directory);
    if (cores !== null && cores < smallest) {
      smallest = cores;
      binding = directory;
    }
  }
  return binding;
}

/**
 * @param {string} path
 * @returns {string}
 */
function readText(path) {
  return readFileSync(path, "utf8");
}

/**
 * @param {(path: string) => string} readFile
 * @param {string} path
 * @returns {string | null}
 */
function tryRead(readFile, path) {
  try {
    return readFile(path);
  } catch {
    return null; // silent-ok: not Linux, no such level, or no CPU controller on it.
  }
}

/**
 * @param {string} text
 * @returns {number | null}
 */
function wholeNumber(text) {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/**
 * One field of a `cpu.stat`.
 *
 * @param {string} text
 * @param {string} name
 * @returns {number | null}
 */
function statField(text, name) {
  for (const line of text.split("\n")) {
    const [key, value = ""] = line.trim().split(/\s+/);
    if (key === name) return wholeNumber(value);
  }
  return null;
}

/**
 * @param {number} value
 * @param {number} low
 * @param {number} high
 * @returns {number}
 */
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}
