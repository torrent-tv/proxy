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

import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import v8 from "node:v8";
import path from "node:path";

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
 * Anonymous memory this process holds, from the kernel's own rollup.
 *
 * `process.memoryUsage()` sees what V8 knows about. It cannot see memory the
 * allocator has taken and not returned, and on musl — which is what the addon
 * runs on — a heavy churn of 8 MiB pieces leaves exactly that. The rollup's
 * `Anonymous` counts every mapping backed by nothing but memory, which is
 * where both a live `SharedArrayBuffer` and a freed-but-retained span sit, so
 * the difference between it and what the isolates admit to is the size of what
 * neither can explain (roadmap item 2, step 4).
 *
 * @returns {Promise<number | null>} Bytes, or null off Linux.
 */
export async function readAnonymousMemory() {
  try {
    const text = await readFile("/proc/self/smaps_rollup", "utf8");
    const match = /^Anonymous:\s+(\d+)\s+kB$/m.exec(text);
    if (match) {
      return Number(match[1]) * 1024;
    }
  } catch {
    // silent-ok: not Linux, or the kernel is too old for the rollup. The line
    // simply leaves the term out rather than printing a worse one.
  }
  return null;
}

/**
 * How much room is left where this proxy spills pieces and writes segments.
 *
 * A budget for memory alone is half a budget: pieces evicted from memory go to
 * disk, so a store that is well behaved about RAM can still fill the card an
 * addon host boots from. Both limits are the machine's, and neither was
 * measured before (roadmap item 2).
 *
 * @param {string} directory
 * @returns {Promise<number | null>} Bytes free, or null where it cannot be read.
 */
export async function readDiskFree(directory) {
  try {
    const stats = await statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // silent-ok: `statfs` is not everywhere, and a missing disk figure must not
    // cost the memory reading beside it.
  }
  return null;
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
 * Two scopes, because two things are being asked and only one of them is
 * per-thread. `rss` and the kernel's rollup belong to the PROCESS, so they are
 * read once, on the main thread. The heap, external and arrayBuffer figures
 * belong to an ISOLATE, and the torrent worker's are the ones that matter —
 * the piece pool is a `SharedArrayBuffer` allocated there, which the main
 * isolate cannot see at all. Reporting only the main thread's was half the
 * reason 650 MB of a 893 MB process had no explanation on 2026-08-28.
 *
 * @param {Object} reading
 * @param {"process" | "thread"} [reading.scope]
 * @param {string} [reading.label] - Which thread the isolate figures are of.
 * @param {{ rss: number, heapUsed: number, heapTotal: number, external: number, arrayBuffers: number }} reading.process
 * @param {number} [reading.availableBytes]
 * @param {boolean} [reading.availableMeasured]
 * @param {number | null} [reading.anonymousBytes]
 * @param {number | null} [reading.diskFreeBytes]
 * @param {{ name: string, residentBytes: number, committedBytes: number, spilledBytes: number, budgetBytes: number }[]} [reading.stores]
 * @returns {string}
 */
export function describeMemory({
  scope = "process",
  label = "",
  process: usage,
  availableBytes,
  availableMeasured,
  anonymousBytes = null,
  diskFreeBytes = null,
  stores = []
}) {
  const total = (field) => stores.reduce((sum, store) => sum + (store[field] || 0), 0);
  const storeResident = total("residentBytes");
  const storeCommitted = total("committedBytes");
  const storeSpilled = total("spilledBytes");
  const storeBudget = total("budgetBytes");
  // Holding and having taken are different quantities, and the gap between
  // them is the whole of the growth this series exists to find: the pool only
  // grows, so a spilled piece frees a slot and no memory.
  const storesPart = stores.length === 0
    ? "no torrent stores"
    : `${stores.length} torrent store(s) holding ${megabytes(storeResident)}, ` +
      `committed ${megabytes(storeCommitted)} of ${megabytes(storeBudget)} allowed, ` +
      `${megabytes(storeSpilled)} spilled to disk`;
  const isolate =
    `heap=${megabytes(usage.heapUsed)}/${megabytes(usage.heapTotal)} ` +
    `external=${megabytes(usage.external)} arrayBuffers=${megabytes(usage.arrayBuffers)}`;
  if (scope === "thread") {
    return `memory (${label || "thread"}): ${isolate}; ${storesPart}`;
  }
  return (
    `memory: rss=${megabytes(usage.rss)} ${isolate}` +
    `${anonymousBytes === null ? "" : ` anon=${megabytes(anonymousBytes)}`}; ` +
    `${storesPart}; ` +
    `machine has ${megabytes(availableBytes ?? 0)} available` +
    `${availableMeasured ? "" : " (estimated — /proc/meminfo could not be read)"}` +
    `${diskFreeBytes === null ? "" : `, ${megabytes(diskFreeBytes)} free on disk`}`
  );
}

/**
 * Report memory on a timer until stopped.
 *
 * @param {Object} options
 * @param {(message: string) => void} options.log
 * @param {() => { name: string, residentBytes: number, budgetBytes: number }[]} [options.readStores]
 * @param {"process" | "thread"} [options.scope] - `thread` leaves out the
 *   process-wide figures, so the torrent worker can report its own isolate
 *   without reading /proc twice.
 * @param {string} [options.label] - Which thread the isolate figures are of.
 * @param {string} [options.diskPath] - Where pieces spill, for the free-space
 *   reading. Omitted, the disk term is left out rather than guessed.
 * @param {number} [options.intervalMs]
 * @returns {{ stop: () => void }}
 */
export function startMemoryReport({
  log,
  readStores,
  scope = "process",
  label = "",
  diskPath = "",
  intervalMs = MEMORY_REPORT_INTERVAL_MS
}) {
  let highWaterRss = 0;
  const tick = async () => {
    try {
      let stores = [];
      try {
        stores = typeof readStores === "function" ? readStores() ?? [] : [];
      } catch {
        // silent-ok: a store list that cannot be read must not stop the reading
        // that matters, which is the process's own.
      }
      const processMemory = readProcessMemory();
      if (scope === "thread") {
        log(describeMemory({ scope, label, process: processMemory, stores }));
        return;
      }
      const { bytes, measured } = await availableMemory();
      const anonymousBytes = await readAnonymousMemory();
      const diskFreeBytes = diskPath ? await readDiskFree(diskPath) : null;
      log(describeMemory({
        scope,
        label,
        process: processMemory,
        availableBytes: bytes,
        availableMeasured: measured,
        anonymousBytes,
        diskFreeBytes,
        stores
      }));
      // High-water and heap snapshot on growth — gives a file to open in Chrome DevTools
      // when the kernel is about to kill the process. One snapshot per high-water.
      if (processMemory.rss > highWaterRss + 100 * 1024 * 1024 && processMemory.rss > 500 * 1024 * 1024) {
        highWaterRss = processMemory.rss;
        try {
          const snapPath = path.join(os.tmpdir(), `heap-${Date.now()}-${processMemory.rss}.heapsnapshot`);
          v8.writeHeapSnapshot(snapPath);
          log(`memory: wrote heap snapshot to ${snapPath} rss=${Math.round(processMemory.rss / (1024 * 1024))}MB anon=${anonymousBytes ? Math.round(anonymousBytes / (1024 * 1024)) : "?"}MB`);
        } catch {}
      }
      if (anonymousBytes !== null && processMemory.rss > 800 * 1024 * 1024) {
        log(`memory: high rss=${Math.round(processMemory.rss / (1024 * 1024))}MB anon=${Math.round(anonymousBytes / (1024 * 1024))}MB heap=${Math.round(processMemory.heapUsed / (1024 * 1024))}MB — watch for OOM`);
      }
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
