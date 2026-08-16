/**
 * @file What the machine is doing while an encoder runs on it.
 *
 * The budget predicts a rung from two benchmarks taken at startup on an idle
 * machine. On 2026-08-15 it predicted 1.83x for a rung that then ran at
 * 0.90-0.999x with nothing else encoding, and nothing in any log said why. The
 * candidates are all measurable and none of them was being measured:
 *
 *   - the encoder is not getting the cores (something else is taking them, or
 *     it is waiting on input);
 *   - the machine is no longer the machine that was benchmarked, because it has
 *     dropped its clock or grown hot;
 *   - the work around the encode — hashing pieces, serving segments — costs
 *     more than anyone counted.
 *
 * Everything here is Linux-specific and best effort: a host without these files
 * reports nulls and nothing above it changes. The proxy stays
 * deployment-agnostic (`../CLAUDE.md`).
 */

import { readFile } from "node:fs/promises";
import os from "node:os";

/**
 * Clock ticks per second, the unit `/proc/<pid>/stat` counts CPU time in.
 * `getconf CLK_TCK` is 100 on every Linux this runs on; spawning a process to
 * ask would cost more than the measurement.
 */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * @typedef {object} CpuTotals
 * @property {number} busySeconds - Everything but idle.
 * @property {number} idleSeconds
 * @property {number} iowaitSeconds - Idle because it is waiting for a disk.
 */

/**
 * The system's CPU time since boot, from `/proc/stat`.
 *
 * @returns {Promise<CpuTotals | null>}
 */
export async function readSystemCpu() {
  try {
    const text = await readFile("/proc/stat", "utf8");
    const line = text.split("\n", 1)[0];
    if (!line.startsWith("cpu ")) {
      return null;
    }
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 5 || fields.some((value) => !Number.isFinite(value))) {
      return null;
    }
    const [user, nice, system, idle, iowait] = fields;
    const busyTicks = user + nice + system + fields.slice(5).reduce((sum, value) => sum + value, 0);
    return {
      busySeconds: busyTicks / CLOCK_TICKS_PER_SECOND,
      idleSeconds: idle / CLOCK_TICKS_PER_SECOND,
      iowaitSeconds: iowait / CLOCK_TICKS_PER_SECOND
    };
  } catch {
    return null; // not Linux, or /proc is not mounted
  }
}

/**
 * The CPU time one process has used, from `/proc/<pid>/stat`.
 *
 * The comm field can itself contain spaces and brackets, so the fields are
 * counted from the LAST `)` rather than by splitting the whole line — the usual
 * trap with this file.
 *
 * @param {number} pid
 * @returns {Promise<number | null>} Seconds of CPU, or null.
 */
export async function readProcessCpuSeconds(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const afterComm = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
    // After the comm and state fields, utime is index 11 and stime index 12.
    const utime = Number(afterComm[11]);
    const stime = Number(afterComm[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) {
      return null;
    }
    return (utime + stime) / CLOCK_TICKS_PER_SECOND;
  } catch {
    return null; // the process is gone, or this is not Linux
  }
}

/**
 * Is this still the machine the benchmarks were taken on: its clock and its
 * temperature.
 *
 * @returns {Promise<{ megahertz: number | null, celsius: number | null }>}
 */
export async function readMachineState() {
  const [frequency, temperature] = await Promise.all([
    readFile("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", "utf8").catch(() => null),
    readFile("/sys/class/thermal/thermal_zone0/temp", "utf8").catch(() => null)
  ]);
  const kilohertz = frequency === null ? Number.NaN : Number(frequency.trim());
  const milliCelsius = temperature === null ? Number.NaN : Number(temperature.trim());
  return {
    megahertz: Number.isFinite(kilohertz) ? Math.round(kilohertz / 1000) : null,
    celsius: Number.isFinite(milliCelsius) ? Math.round(milliCelsius / 100) / 10 : null
  };
}

/**
 * Turn two readings into the shares of ONE second of wall clock that each part
 * of the machine spent working. A share is per whole machine: 1.0 means every
 * core was busy for the whole interval.
 *
 * @param {{ takenAt: number, processCpuSeconds: number | null, system: CpuTotals | null }} before
 * @param {{ takenAt: number, processCpuSeconds: number | null, system: CpuTotals | null }} after
 * @param {number} [cores=os.cpus().length]
 * @returns {{ elapsedSec: number, processShare: number | null, systemShare: number | null, iowaitShare: number | null } | null}
 */
export function shareOfMachine(before, after, cores = os.cpus().length) {
  const elapsedSec = (after.takenAt - before.takenAt) / 1000;
  if (!(elapsedSec > 0) || !(cores > 0)) {
    return null;
  }
  const machineSeconds = elapsedSec * cores;
  const processShare = before.processCpuSeconds !== null && after.processCpuSeconds !== null
    ? (after.processCpuSeconds - before.processCpuSeconds) / machineSeconds
    : null;
  const systemShare = before.system !== null && after.system !== null
    ? (after.system.busySeconds - before.system.busySeconds) / machineSeconds
    : null;
  const iowaitShare = before.system !== null && after.system !== null
    ? (after.system.iowaitSeconds - before.system.iowaitSeconds) / machineSeconds
    : null;
  return { elapsedSec, processShare, systemShare, iowaitShare };
}

/**
 * One reading of everything above, to be compared against the next.
 *
 * @param {number | null} pid - The encoder's process, when one is running.
 * @returns {Promise<{ takenAt: number, processCpuSeconds: number | null, system: CpuTotals | null }>}
 */
export async function sampleHost(pid) {
  const [processCpuSeconds, system] = await Promise.all([
    pid === null ? Promise.resolve(null) : readProcessCpuSeconds(pid),
    readSystemCpu()
  ]);
  return { takenAt: Date.now(), processCpuSeconds, system };
}

/**
 * How much CPU THIS process has used, across every thread it owns.
 *
 * The proxy is not only its encoders. It downloads the torrent, verifies every
 * piece it receives, keeps the piece store, and pushes segments down a data
 * channel — work that happens in this process and its workers, that scales with
 * the file's own bitrate, and that the encode budget counts as nothing.
 * Measured on the addon host with both encoders suspended, the machine was
 * still 20-29 % busy; this is the number that says how much of that is ours.
 *
 * `process.cpuUsage()` covers all threads of the process, so the torrent
 * worker's hashing is included without asking it anything.
 *
 * @returns {number} Seconds of CPU used since this process began.
 */
export function readProxyCpuSeconds() {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1e6;
}
