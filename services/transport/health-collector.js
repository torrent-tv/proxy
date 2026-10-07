/**
 * @file System health metrics for proxy scoring.
 *
 * Collects lightweight OS-level metrics that allow the registry server to
 * score and rank proxy clients when a browser requests playback.
 * All values are cheap to read and require no background work.
 */

import os from "node:os";

/**
 * Snapshot of system health at a point in time.
 *
 * `cpuLoad`  — 1-minute load average divided by the number of logical CPUs.
 *   0 means idle, 1 means fully utilised, >1 means overloaded.
 *   Suitable as input to `Math.max(0, 1 - Math.min(1, cpuLoad))` for a
 *   normalised "CPU availability" score.
 *
 * `memFree`  — fraction of the memory this process could ever hold that could
 *   still be given out (0–1): of a container's limit where one is in force, of
 *   the host's RAM otherwise — divided by the host's RAM, a 512 MiB container
 *   with half its limit free read as nearly full. The reading is the storage
 *   component's (`storage/machine-memory.js` says why that is not the same as
 *   free memory), handed in.
 *
 * `uptime`   — process uptime in whole seconds (useful for preferring
 *   already-warmed proxies over freshly started ones).
 *
 * @typedef {Object} HealthMetrics
 * @property {number} cpuLoad - 1-min load avg / cpu-count.  0 = idle, 1 = saturated, >1 = overloaded.
 * @property {number} memFree - Memory an allocation could obtain, as a fraction of the most this process could hold (0–1).
 * @property {number} uptime  - Process uptime in seconds.
 */

/**
 * Collect current system health metrics.
 *
 * All three values are rounded to three decimal places to avoid unnecessary
 * diff noise when serialising to JSON across the tunnel.
 *
 * @param {object} params
 * @param {() => { bytes: number, totalBytes: number }} params.availableMemory -
 *   What an allocation could obtain right now and the most this process could
 *   ever hold; the storage component's reading.
 * @returns {HealthMetrics}
 */
export function collectHealthMetrics({ availableMemory }) {
  const cpuCount = os.cpus().length || 1;
  const cpuLoad = os.loadavg()[0] / cpuCount;
  const { bytes, totalBytes } = availableMemory();
  const memFree = bytes / totalBytes;

  return {
    cpuLoad: Math.round(cpuLoad * 1000) / 1000,
    memFree: Math.round(memFree * 1000) / 1000,
    uptime: Math.floor(process.uptime())
  };
}
