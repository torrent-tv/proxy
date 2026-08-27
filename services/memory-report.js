/**
 * @file What this process is holding, said out loud on a regular cadence.
 *
 * Written 2026-08-28, after the kernel killed the proxy and the log could not
 * say why. The supervisor recorded `exit code 137` — SIGKILL, so no core dump —
 * and the kernel ring buffer held the whole of what was known:
 *
 *   Out of memory: Killed process 3036113 (MainThread)
 *     anon-rss: 2422628kB  total-vm: 20856720kB  oom_score_adj: 200
 *
 * Two point four gigabytes, on a host with under two free, and the addon is the
 * first thing the kernel picks because Home Assistant gives addons a positive
 * `oom_score_adj`. What the proxy had been logging all along was its share of a
 * CPU. Nothing anywhere said how much memory it held, so the growth that ended
 * in that line has no shape: one final reading taken by the kernel, and no
 * series leading to it.
 *
 * This is that series. It costs one line a minute and reads only counters the
 * runtime already maintains.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";

/** How often the reading is taken and written. */
export const MEMORY_REPORT_INTERVAL_MS = 60_000;

/**
 * What the process is holding, from the runtime's own counters.
 *
 * `rss` is what the kernel counts against us and therefore what the OOM killer
 * reads. The rest says where it went: the JavaScript heap, and everything held
 * outside it — which for this proxy is where the interesting growth lives,
 * since torrent pieces sit in a `SharedArrayBuffer` and segment bodies pass
 * through buffers.
 *
 * @returns {{ rss: number, heapUsed: number, heapTotal: number, external: number, arrayBuffers: number }}
 */
export function readProcessMemory() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers ?? 0
  };
}

/**
 * How much memory the machine could still give out, in bytes.
 *
 * `os.freemem()` is the wrong quantity on Linux and the difference is not
 * academic: it counts only pages that are free RIGHT NOW, while the kernel
 * deliberately keeps that number low by filling the rest with reclaimable page
 * cache. `MemAvailable` is the kernel's own estimate of what a new allocation
 * could actually obtain, cache included. Reading the estimate the kernel
 * publishes beats recomputing a worse one.
 *
 * @returns {Promise<number | null>} Bytes, or null where /proc is not there.
 */
export async function readAvailableMemory() {
  try {
    const text = await readFile("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
    if (match) {
      return Number(match[1]) * 1024;
    }
  } catch {
    // silent-ok: not Linux, or /proc is not mounted. The fallback below is a
    // worse answer, and saying so is the point of returning it separately.
  }
  return null;
}

/**
 * Available memory, falling back to what the runtime can offer.
 *
 * @returns {Promise<{ bytes: number, measured: boolean }>}
 */
export async function availableMemory() {
  const fromKernel = await readAvailableMemory();
  if (fromKernel !== null) {
    return { bytes: fromKernel, measured: true };
  }
  return { bytes: os.freemem(), measured: false };
}

/**
 * Render a size the way a person reads one.
 *
 * @param {number} bytes
 * @returns {string}
 */
function megabytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/**
 * One line saying what the process holds and what the machine has left.
 *
 * Pure, so the wording and the arithmetic can be pinned without a running
 * process. Store figures are given in BYTES rather than in pieces: the piece
 * count is meaningless without the piece size, and the piece size differs per
 * torrent — on the film this proxy died under, 63 pieces meant 504 MB.
 *
 * @param {Object} reading
 * @param {{ rss: number, heapUsed: number, heapTotal: number, external: number, arrayBuffers: number }} reading.process
 * @param {number} reading.availableBytes
 * @param {boolean} reading.availableMeasured
 * @param {{ name: string, residentBytes: number, budgetBytes: number }[]} [reading.stores]
 * @returns {string}
 */
export function describeMemory({ process: usage, availableBytes, availableMeasured, stores = [] }) {
  const storeResident = stores.reduce((total, store) => total + (store.residentBytes || 0), 0);
  const storeBudget = stores.reduce((total, store) => total + (store.budgetBytes || 0), 0);
  const storesPart = stores.length === 0
    ? "no torrent stores"
    : `${stores.length} torrent store(s) holding ${megabytes(storeResident)} ` +
      `of ${megabytes(storeBudget)} allowed`;
  return (
    `memory: rss=${megabytes(usage.rss)} heap=${megabytes(usage.heapUsed)}/${megabytes(usage.heapTotal)} ` +
    `external=${megabytes(usage.external)} arrayBuffers=${megabytes(usage.arrayBuffers)}; ` +
    `${storesPart}; ` +
    `machine has ${megabytes(availableBytes)} available` +
    `${availableMeasured ? "" : " (estimated — /proc/meminfo could not be read)"}`
  );
}

/**
 * Report memory on a timer until stopped.
 *
 * @param {Object} options
 * @param {(message: string) => void} options.log
 * @param {() => { name: string, residentBytes: number, budgetBytes: number }[]} [options.readStores]
 * @param {number} [options.intervalMs]
 * @returns {{ stop: () => void }}
 */
export function startMemoryReport({ log, readStores, intervalMs = MEMORY_REPORT_INTERVAL_MS }) {
  const tick = async () => {
    try {
      const { bytes, measured } = await availableMemory();
      let stores = [];
      try {
        stores = typeof readStores === "function" ? readStores() ?? [] : [];
      } catch {
        // silent-ok: a store list that cannot be read must not stop the reading
        // that matters, which is the process's own.
      }
      log(describeMemory({
        process: readProcessMemory(),
        availableBytes: bytes,
        availableMeasured: measured,
        stores
      }));
    } catch {
      // silent-ok: a reading that fails is not worth ending the series over.
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return { stop: () => clearInterval(timer) };
}
