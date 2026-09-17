/**
 * @file How much of the machine's memory is available, read once.
 *
 * It was written THREE TIMES, in three layers, with the same body each time:
 * `transport/health-collector.js` for the score a proxy publishes to the registry,
 * `storage/memory-report.js` for the line the process prints every second, and
 * `storage/piece-store/shared-piece-store.js` for the budget the piece store takes.
 * One fact, three owners — and the copies had already drifted once: the piece
 * store was corrected from `os.freemem()` to the kernel's own estimate on
 * 2026-08-27 and the health collector went on publishing the wrong quantity
 * until 2026-09-02, so every Linux proxy in the pool understated itself, each
 * by a different amount according to how much cache it happened to hold.
 *
 * It lives in the storage layer because it is a fact about the RESOURCE, and
 * this layer is the resource's owner: what is free, what we already hold, and
 * what everything that is not us has been seen to need.
 *
 * **Why `MemAvailable` and not `os.freemem()`.** On Linux `freemem` counts only
 * the pages free at that instant, and the kernel deliberately keeps that number
 * low by filling the rest with reclaimable cache — so a machine reads as nearly
 * full while it has gigabytes to give. `MemAvailable` is the kernel's own
 * estimate of what an allocation could actually obtain. Where there is no
 * `/proc` — not Linux, or it is unreadable — `freemem` is the best answer there
 * is, and on those systems it is not misleading.
 */

import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * What the machine could give an allocation right now.
 *
 * @returns {{ bytes: number, measured: boolean }} `measured` is false where the
 *   kernel's own estimate was not available, so a caller that prints the figure
 *   can say which of the two it is holding.
 */
export function availableMemory() {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (match) {
      return { bytes: Number(match[1]) * 1024, measured: true };
    }
  } catch {
    // silent-ok: not Linux, or /proc is not readable.
  }
  return { bytes: os.freemem(), measured: false };
}

/**
 * What the machine could give an allocation right now, as a plain number.
 *
 * @returns {number}
 */
export function availableMemoryBytes() {
  return availableMemory().bytes;
}
