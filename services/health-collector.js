/**
 * @file System health metrics for proxy scoring.
 *
 * Collects lightweight OS-level metrics that allow the registry server to
 * score and rank proxy clients when a browser requests playback.
 * All values are cheap to read and require no background work.
 */

import os from "node:os";
import { availableMemoryBytes } from "./storage/machine-memory.js";

/**
 * Snapshot of system health at a point in time.
 *
 * `cpuLoad`  — 1-minute load average divided by the number of logical CPUs.
 *   0 means idle, 1 means fully utilised, >1 means overloaded.
 *   Suitable as input to `Math.max(0, 1 - Math.min(1, cpuLoad))` for a
 *   normalised "CPU availability" score.
 *
 * `memFree`  — fraction of total system RAM that could still be given out
 *   (0–1). See {@link availableMemoryBytes} for why that is not the same as
 *   free memory.
 *
 * `uptime`   — process uptime in whole seconds (useful for preferring
 *   already-warmed proxies over freshly started ones).
 *
 * @typedef {Object} HealthMetrics
 * @property {number} cpuLoad - 1-min load avg / cpu-count.  0 = idle, 1 = saturated, >1 = overloaded.
 * @property {number} memFree - Memory an allocation could obtain, as a fraction of total RAM (0–1).
 * @property {number} uptime  - Process uptime in seconds.
 */

/**
 * What the machine could give an allocation right now.
 *
 * Re-exported rather than computed: the resource is the storage layer's, and
 * this reading was written three times over before it had one owner.
 *
 * @returns {number}
 */
export { availableMemoryBytes };

/**
 * Collect current system health metrics.
 *
 * All three values are rounded to three decimal places to avoid unnecessary
 * diff noise when serialising to JSON across the tunnel.
 *
 * @returns {HealthMetrics}
 */
export function collectHealthMetrics() {
  const cpuCount = os.cpus().length || 1;
  const cpuLoad = os.loadavg()[0] / cpuCount;
  const memFree = availableMemoryBytes() / os.totalmem();

  return {
    cpuLoad: Math.round(cpuLoad * 1000) / 1000,
    memFree: Math.round(memFree * 1000) / 1000,
    uptime: Math.floor(process.uptime())
  };
}
