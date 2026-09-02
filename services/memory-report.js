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

import { readdir, readFile, rm, statfs } from "node:fs/promises";
import os from "node:os";
import v8 from "node:v8";
import path from "node:path";

/** How often the reading is taken and written. */
export const MEMORY_REPORT_INTERVAL_MS = 60_000;

/**
 * How often the torrent worker takes its own reading.
 *
 * A minute cannot see what killed it. Three times — 2026-08-30 14:00 and 23:19,
 * 2026-08-31 13:27 — the worker's heap read 28-36 MB in one sample and the
 * thread was dead by the sample after next, with the whole rise from 30 MB to
 * the 2240 MB heap limit fitting inside a single gap. A second is short enough
 * that the rise is a curve rather than a step, and the line is only WRITTEN when
 * something moved, so a quiet session costs what it costs today.
 */
export const WORKER_MEMORY_SAMPLE_MS = 1_000;

/**
 * What the process is holding, from the runtime's own counters.
 *
 * `rss` is what the kernel counts against us and therefore what the OOM killer
 * reads. The rest says where it went: the JavaScript heap, and everything held
 * outside it — which for this proxy is where the interesting growth lives,
 * since torrent pieces sit in a `SharedArrayBuffer` and segment bodies pass
 * through buffers.
 *
 * `heapLimit` is this isolate's own ceiling, and it belongs beside the heap
 * figures because it is what the runtime kills the thread for reaching — a
 * worker created without `resourceLimits` inherits the main isolate's, 2240 MB
 * on the addon host. Without it the log said 30 MB and gave no idea how far
 * that was from the end.
 *
 * @returns {{ rss: number, heapUsed: number, heapTotal: number, external: number, arrayBuffers: number, heapLimit: number }}
 */
export function readProcessMemory() {
  const usage = process.memoryUsage();
  let heapLimit = 0;
  try {
    heapLimit = v8.getHeapStatistics().heap_size_limit ?? 0;
  } catch {
    // silent-ok: a missing ceiling leaves the term out, it does not cost the
    // reading beside it.
  }
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers ?? 0,
    heapLimit
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
 * Anonymous memory grouped by the SHAPE of the mappings holding it.
 *
 * The rollup says how much there is; this says what it looks like, and the
 * three shapes it can take are three different diagnoses of the same number:
 *
 *  - **one growing `[heap]`** — the allocator's break-managed arena. Freed
 *    blocks stay in it, and on musl there is no `malloc_trim` to ask for them
 *    back. Nothing above the allocator is holding anything.
 *  - **many large anonymous mappings** — one per big allocation, which is what
 *    a 4 MiB piece buffer is. If their count tracks the pieces the store says
 *    it holds, the memory is accounted for; if it keeps climbing while the
 *    store's count does not, the buffers are being kept alive by somebody.
 *  - **many medium ones** — the allocator's own per-thread arenas, taken and
 *    not returned.
 *
 * The field failure of 2026-08-31 is 700 MB that is none of the JavaScript
 * heaps, none of the piece store, and none of ffmpeg. Which of the three
 * shapes it has decides what to change, and no reading so far can tell them
 * apart (roadmap item 2, step 4).
 *
 * @param {string} text - The contents of `/proc/self/smaps`.
 * @returns {{ heapBytes: number, largeBytes: number, largeCount: number,
 *   largestBytes: number, smallBytes: number, smallCount: number,
 *   fileBytes: number }}
 */
export function summariseMappings(text) {
  const summary = {
    heapBytes: 0,
    largeBytes: 0,
    largeCount: 0,
    largestBytes: 0,
    smallBytes: 0,
    smallCount: 0,
    fileBytes: 0
  };
  // A mapping is a header line followed by its fields; only `Rss` is wanted,
  // because a mapping that is reserved and untouched costs no memory.
  let pathName = null;
  for (const line of String(text ?? "").split("\n")) {
    const header = /^[0-9a-f]+-[0-9a-f]+ \S{4} [0-9a-f]+ \S+ \d+\s*(.*)$/.exec(line);
    if (header) {
      pathName = header[1].trim();
      continue;
    }
    const rss = /^Rss:\s+(\d+)\s+kB$/.exec(line);
    if (!rss || pathName === null) {
      continue;
    }
    const bytes = Number(rss[1]) * 1024;
    if (bytes === 0) {
      continue;
    }
    if (pathName === "[heap]") {
      summary.heapBytes += bytes;
    } else if (pathName !== "" && !pathName.startsWith("[")) {
      // Backed by a file: the executable, the libraries, anything mapped in.
      // Counted so the anonymous figures can be checked against `rss`.
      summary.fileBytes += bytes;
    } else if (bytes >= LARGE_MAPPING_BYTES) {
      summary.largeBytes += bytes;
      summary.largeCount += 1;
      summary.largestBytes = Math.max(summary.largestBytes, bytes);
    } else {
      summary.smallBytes += bytes;
      summary.smallCount += 1;
    }
  }
  return summary;
}

/**
 * Where "large" begins. Two megabytes, so a 4 MiB piece buffer is always large
 * and an allocator's ordinary arena is not.
 */
const LARGE_MAPPING_BYTES = 2 * 1024 * 1024;

/**
 * The mapping summary for this process, or null where /proc is not there.
 *
 * @returns {Promise<ReturnType<typeof summariseMappings> | null>}
 */
export async function readMappingSummary() {
  try {
    return summariseMappings(await readFile("/proc/self/smaps", "utf8"));
  } catch {
    // silent-ok: not Linux, or the kernel does not publish it. The line leaves
    // the term out rather than printing a worse one.
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
 * @param {ReturnType<typeof summariseMappings> | null} [reading.mappings]
 * @param {number | null} [reading.diskFreeBytes]
 * @param {{ name: string, residentBytes: number, committedBytes: number, spilledBytes: number, budgetBytes: number }[]} [reading.stores]
 * @param {string} [reading.extra] - Figures the caller wants on the same line
 *   rather than on one of its own. The piece-buffer counters are read here so
 *   that the number of buffers alive and the off-heap mass they should account
 *   for are the SAME instant: printed on separate timers they were up to a
 *   minute apart, and 950 MB of `arrayBuffers` could not be checked against the
 *   62 buffers a reading half a minute away said were alive (roadmap item 2).
 * @returns {string}
 */
export function describeMemory({
  scope = "process",
  label = "",
  process: usage,
  availableBytes,
  availableMeasured,
  anonymousBytes = null,
  mappings = null,
  diskFreeBytes = null,
  stores = [],
  extra = ""
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
    `heap=${megabytes(usage.heapUsed)}/${megabytes(usage.heapTotal)}` +
    `${usage.heapLimit ? ` of ${megabytes(usage.heapLimit)} allowed` : ""} ` +
    `external=${megabytes(usage.external)} arrayBuffers=${megabytes(usage.arrayBuffers)}`;
  const tail = extra ? `; ${extra}` : "";
  if (scope === "thread") {
    return `memory (${label || "thread"}): ${isolate}; ${storesPart}${tail}`;
  }
  const shape = mappings === null
    ? ""
    : ` mappings=[heap ${megabytes(mappings.heapBytes)}, ` +
      `${mappings.largeCount} anon ≥2MB = ${megabytes(mappings.largeBytes)} ` +
      `(largest ${megabytes(mappings.largestBytes)}), ` +
      `${mappings.smallCount} anon <2MB = ${megabytes(mappings.smallBytes)}, ` +
      `files ${megabytes(mappings.fileBytes)}]`;
  return (
    `memory: rss=${megabytes(usage.rss)} ${isolate}` +
    `${anonymousBytes === null ? "" : ` anon=${megabytes(anonymousBytes)}`}${shape}; ` +
    `${storesPart}; ` +
    `machine has ${megabytes(availableBytes ?? 0)} available` +
    `${availableMeasured ? "" : " (estimated — /proc/meminfo could not be read)"}` +
    `${diskFreeBytes === null ? "" : `, ${megabytes(diskFreeBytes)} free on disk`}` +
    tail
  );
}

/**
 * The figures whose movement earns a line, each under its own name.
 *
 * Not the same question as what the scope WATCHES for a heap snapshot. A
 * thread's heap is only one of the three ways its isolate holds memory, and on
 * 2026-09-02 it was the one that did not move: `heapTotal` stayed at 31-173 MB
 * through a session where `arrayBuffers` swung between 130 and 950 MB, so the
 * change trigger was watching the one quantity that stood still and every
 * reading of the one that grew came out on the quiet interval, a minute apart.
 *
 * Each figure is compared against its own last written value and any one of
 * them moving is enough. Nothing is added together, because `arrayBuffers` is
 * documented as part of `external` and reads larger than it on this runtime —
 * a contradiction this code has no business resolving.
 *
 * @param {"process" | "thread"} scope
 * @param {{ rss: number, heapTotal: number, external: number, arrayBuffers: number }} memory
 * @returns {Record<string, number>}
 */
export function watchedFigures(scope, memory) {
  if (scope === "thread") {
    return {
      heap: memory.heapTotal ?? 0,
      external: memory.external ?? 0,
      buffers: memory.arrayBuffers ?? 0
    };
  }
  return { rss: memory.rss ?? 0 };
}

/**
 * Whether this reading is worth writing down, and why.
 *
 * A series taken every second and printed every second is unreadable, and one
 * printed every minute cannot see a rise that takes forty seconds. So the
 * cadence of the READING and the cadence of the LINE are separate: the figure
 * is taken often, and written when it has moved or when the quiet interval has
 * passed. Pure, so the rule can be pinned without a clock.
 *
 * @param {Object} state
 * @param {number} state.watchedBytes - The figure this scope is watching.
 * @param {number} state.lastWrittenBytes
 * @param {number} state.sinceWrittenMs
 * @param {number} state.changeBytes - Movement that earns a line of its own.
 * @param {number} state.quietMs - How long silence may last regardless.
 * @returns {boolean}
 */
export function readingIsWorthWriting({
  watchedBytes,
  lastWrittenBytes,
  sinceWrittenMs,
  changeBytes,
  quietMs
}) {
  if (quietMs <= 0 || sinceWrittenMs >= quietMs) {
    return true;
  }
  if (changeBytes <= 0) {
    return false;
  }
  return Math.abs(watchedBytes - lastWrittenBytes) >= changeBytes;
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
 * @param {number} [options.intervalMs] - How often the figure is READ.
 * @param {number} [options.quietMs] - How long the line may stay silent while
 *   nothing moves. Zero writes every reading, which is what the process scope
 *   has always done.
 * @param {number} [options.changeBytes] - Movement that earns a line before the
 *   quiet interval is up.
 * @param {string} [options.snapshotDir] - Where heap snapshots are written.
 *   Defaults to the temporary directory, as the process scope always did.
 * @param {number} [options.snapshotFloorBytes]
 * @param {number} [options.snapshotGrowthBytes]
 * @param {number} [options.keepSnapshots] - Newest to keep; zero keeps all.
 * @param {() => string} [options.readExtra] - Figures to append to the line,
 *   read at the same instant as the memory itself.
 * @returns {{ stop: () => void }}
 */
export function startMemoryReport({
  log,
  readStores,
  readExtra,
  scope = "process",
  label = "",
  diskPath = "",
  intervalMs = MEMORY_REPORT_INTERVAL_MS,
  quietMs = 0,
  changeBytes = 0,
  snapshotDir = "",
  snapshotFloorBytes = 500 * 1024 * 1024,
  snapshotGrowthBytes = 100 * 1024 * 1024,
  keepSnapshots = 0
}) {
  let highWater = 0;
  /** @type {Record<string, number>} */
  let lastWritten = {};
  let lastWrittenAt = 0;
  // The process watches what the kernel kills it for; a thread watches what the
  // runtime kills IT for, which is its own heap and not the process's resident
  // memory — the main isolate sat at 26 MB while the worker's heap climbed to
  // its 2240 MB ceiling.
  const watchedOf = (memory) => (scope === "thread" ? memory.heapTotal : memory.rss);
  const slug = (label || scope).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const directory = snapshotDir || os.tmpdir();

  /**
   * @param {number} watchedBytes
   * @param {string} why
   * @returns {Promise<void>}
   */
  const takeSnapshot = async (watchedBytes, why) => {
    let snapPath = "";
    try {
      snapPath = path.join(directory, `heap-${slug}-${Date.now()}-${watchedBytes}.heapsnapshot`);
      // Synchronous and proportional to the heap, so it stops this thread for
      // as long as it takes to write. That is the price of the only reading
      // that names what is holding the memory, and it is why it is bounded by
      // a floor, by a growth step and by how many are kept.
      v8.writeHeapSnapshot(snapPath);
      log(`memory: wrote heap snapshot of the ${label || scope} to ${snapPath} (${megabytes(watchedBytes)}, ${why})`);
    } catch {
      // silent-ok: no snapshot is worse than a snapshot, and much better than
      // ending the series that leads to the next one.
      return;
    }
    if (keepSnapshots <= 0) {
      return;
    }
    try {
      const prefix = `heap-${slug}-`;
      const mine = (await readdir(directory))
        .filter((name) => name.startsWith(prefix) && name.endsWith(".heapsnapshot"))
        .sort();
      for (const name of mine.slice(0, Math.max(0, mine.length - keepSnapshots))) {
        await rm(path.join(directory, name), { force: true });
      }
    } catch {
      // silent-ok: a snapshot that could not be pruned is a disk-space problem
      // for later, not a reason to lose the one just written.
    }
  };

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
      const watched = watchedOf(processMemory);
      const figures = watchedFigures(scope, processMemory);
      const now = Date.now();
      const sinceWrittenMs = lastWrittenAt === 0 ? Number.POSITIVE_INFINITY : now - lastWrittenAt;
      const write = Object.entries(figures).some(([name, bytes]) => readingIsWorthWriting({
        watchedBytes: bytes,
        lastWrittenBytes: lastWritten[name] ?? 0,
        sinceWrittenMs,
        changeBytes,
        quietMs
      }));

      let anonymousBytes = null;
      if (write) {
        let extra = "";
        try {
          extra = typeof readExtra === "function" ? readExtra() ?? "" : "";
        } catch {
          // silent-ok: a caller's own figures are worth less than the line they
          // would have taken down with them.
        }
        if (scope === "thread") {
          log(describeMemory({ scope, label, process: processMemory, stores, extra }));
        } else {
          // Read only when the line is written. `smaps` is one entry per
          // mapping and a busy process has thousands; the rollup and
          // `/proc/meminfo` are single lines but still walk page tables, and
          // the reading now happens once a second rather than once a minute.
          const { bytes, measured } = await availableMemory();
          anonymousBytes = await readAnonymousMemory();
          log(describeMemory({
            scope,
            label,
            process: processMemory,
            availableBytes: bytes,
            availableMeasured: measured,
            anonymousBytes,
            mappings: await readMappingSummary(),
            diskFreeBytes: diskPath ? await readDiskFree(diskPath) : null,
            stores,
            extra
          }));
        }
        lastWritten = figures;
        lastWrittenAt = now;
      }

      // A snapshot per high-water, so there is a file to open when the growth
      // has to be named rather than described.
      //
      // Deliberately NOT one taken as the ceiling is approached: a snapshot is
      // written by the isolate itself and is about the size of its heap, so
      // asking for one at 1.9 GB on a machine with 600 MB left is a good way to
      // cause the kill being studied. Whatever holds 1.6 GB is the same thing
      // that holds 2.2 GB, and at one reading a second no step is ever missed.
      if (watched > highWater + snapshotGrowthBytes && watched > snapshotFloorBytes) {
        highWater = watched;
        await takeSnapshot(watched, "a new high-water");
      }
      // Under `write` by construction: `anonymousBytes` is only read when the
      // line is, and at one reading a second an unconditional warning would be
      // a line a second for as long as the process stayed large.
      if (scope !== "thread" && anonymousBytes !== null && processMemory.rss > 800 * 1024 * 1024) {
        log(`memory: high rss=${megabytes(processMemory.rss)} anon=${megabytes(anonymousBytes)} heap=${megabytes(processMemory.heapUsed)} — watch for OOM`);
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
