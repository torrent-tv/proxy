/**
 * @file System health metrics for proxy scoring.
 *
 * Collects lightweight OS-level metrics that allow the registry server to
 * score and rank proxy clients when a browser requests playback.
 * All values are cheap to read and require no background work.
 */

import { readFileSync } from "node:fs";
import os from "node:os";

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
 * How much memory the machine could still give out, in bytes.
 *
 * NOT `os.freemem()`. On Linux that counts only the pages free at this
 * instant, and the kernel keeps that number low on purpose: what is not in use
 * is filled with cache, which is handed back the moment anything asks. A host
 * with 4 GB of cache and 200 MB genuinely free reports 200 MB and looks full
 * while it has 4.2 GB to give.
 *
 * The kernel publishes its own estimate as `MemAvailable`, and that is what is
 * read here. The same mistake was fixed in the piece store's budget on
 * 2026-08-27 and stayed in this file until 2026-09-02, where it weighed 0.4 of
 * every proxy's score — so every Linux proxy in the pool understated itself,
 * and by a different amount each, according to how much cache it happened to
 * hold.
 *
 * @returns {number}
 */
export function availableMemoryBytes() {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (match) {
      return Number(match[1]) * 1024;
    }
  } catch {
    // silent-ok: not Linux, or /proc is not readable. `os.freemem()` is then
    // the best available answer and on those systems it is not misleading.
  }
  return os.freemem();
}

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
