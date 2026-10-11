/**
 * @file Where this machine's processor goes: the proxy's own threads and every
 * encoder it runs (torrent-tv/meta#177).
 *
 * The encoders are priced in seconds of work per second of film, and the
 * torrent per megabyte moved. What neither price carries was seen only from
 * outside: at a cold start on the addon host (#166 run 12, 2026-10-10) the main
 * thread ran at 83-108 % of a core for thirty seconds, measured by a shell loop
 * reading `/proc`, while the proxy's own log said nothing for 10.7 s.
 *
 * Read once a second, said once a minute as each part's mean and highest
 * second, and every second while a cold start is being profiled. The Node
 * process is counted ONCE, as `process.cpuUsage()` reports it; the split into
 * threads only says where that time went. Each ffmpeg is its own process and
 * is added beside it. Linux only for the split and for ffmpeg; elsewhere the
 * process figure alone is said.
 */

import { readFile, readdir } from "node:fs/promises";

/** Clock ticks per second of `/proc/<pid>/stat`, as in `encode/host-load.js`. */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * The CPU seconds and the name in one `/proc/.../stat` text.
 *
 * The name can hold spaces and brackets, so it is everything between the first
 * `(` and the LAST `)`, and the fields are counted from there.
 *
 * @param {string} text
 * @returns {{ name: string, seconds: number } | null}
 */
export function parseStat(text) {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const after = text.slice(close + 2).trim().split(/\s+/);
  // After the name and the state, utime is the 12th field and stime the 13th.
  const utime = Number(after[11]);
  const stime = Number(after[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { name: text.slice(open + 1, close), seconds: (utime + stime) / CLOCK_TICKS_PER_SECOND };
}

/**
 * Which part of the proxy a thread belongs to: the main thread, the torrent
 * thread (Node names a worker's thread `WorkerThread`), or the rest — V8's
 * helpers, libuv's pool, the inspector — counted together.
 *
 * @param {number} tid
 * @param {string} name
 * @param {number} pid
 * @returns {"main" | "worker" | "other"}
 */
export function partOfThread(tid, name, pid) {
  if (tid === pid) return "main";
  if (name === "WorkerThread") return "worker";
  return "other";
}

/**
 * CPU seconds of this process's threads, by part, or null where `/proc` cannot
 * be read.
 *
 * @param {number} [pid]
 * @returns {Promise<{ main: number, worker: number, other: number } | null>}
 */
export async function readThreadSeconds(pid = process.pid) {
  let tids;
  try {
    tids = await readdir(`/proc/${pid}/task`);
  } catch {
    return null;
  }
  const parts = { main: 0, worker: 0, other: 0 };
  await Promise.all(tids.map(async (entry) => {
    const tid = Number(entry);
    const stat = await readFile(`/proc/${pid}/task/${entry}/stat`, "utf8").then(parseStat, () => null);
    if (stat) parts[partOfThread(tid, stat.name, pid)] += stat.seconds;
  }));
  return parts;
}

/**
 * CPU seconds of each of these processes that can be read now.
 *
 * @param {number[]} pids
 * @returns {Promise<Map<number, number>>}
 */
export async function readProcessesSeconds(pids) {
  const seconds = new Map();
  await Promise.all(pids.map(async (pid) => {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").then(parseStat, () => null);
    if (stat) seconds.set(pid, stat.seconds);
  }));
  return seconds;
}

/**
 * Shares of one core between two readings, per part. A thread or a process
 * present in only one of the two readings contributes nothing, so a process
 * that came or went in between is not read as a jump.
 *
 * @param {{ at: number, process: number, threads: object | null, ffmpeg: Map<number, number> }} before
 * @param {{ at: number, process: number, threads: object | null, ffmpeg: Map<number, number> }} after
 * @returns {{ seconds: number, process: number, main: number | null, worker: number | null, other: number | null, ffmpeg: number | null } | null}
 */
export function sharesBetween(before, after) {
  const seconds = (after.at - before.at) / 1000;
  if (!(seconds > 0)) return null;
  const share = (from, to) => (Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) / seconds : null);
  let ffmpeg = null;
  for (const [pid, value] of after.ffmpeg) {
    const earlier = before.ffmpeg.get(pid);
    if (earlier !== undefined && value >= earlier) ffmpeg = (ffmpeg ?? 0) + (value - earlier) / seconds;
  }
  return {
    seconds,
    process: share(before.process, after.process),
    main: share(before.threads?.main, after.threads?.main),
    worker: share(before.threads?.worker, after.threads?.worker),
    other: share(before.threads?.other, after.threads?.other),
    ffmpeg
  };
}

/**
 * One line: per part, the mean over the interval and its highest second, as a
 * percentage of one core.
 *
 * @param {object[]} seconds - Per-second shares from `sharesBetween`.
 * @returns {string}
 */
export function describeShares(seconds) {
  const parts = ["process", "main", "worker", "other", "ffmpeg"];
  const said = parts.map((part) => {
    const values = seconds.map((one) => one[part]).filter((value) => Number.isFinite(value));
    if (values.length === 0) return `${part} n/a`;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return `${part} ${Math.round(mean * 100)}% (highest second ${Math.round(Math.max(...values) * 100)}%)`;
  });
  return `${said.join(", ")} of a core over ${seconds.length}s`;
}

/**
 * Read every second, say once a minute, and every second while `detailed()`
 * is true.
 *
 * @param {object} params
 * @param {(line: string) => void} params.log
 * @param {() => number[]} params.ffmpegPids - The encoders running now.
 * @param {() => boolean} [params.detailed]
 * @param {number} [params.everyMs]
 * @param {number} [params.sayEveryMs]
 * @returns {{ stop: () => void }}
 */
export function startProcessorReport({ log, ffmpegPids, detailed = () => false, everyMs = 1000, sayEveryMs = 60_000 }) {
  let previous = null;
  let series = [];
  let since = Date.now();
  let reading = false;
  const tick = async () => {
    if (reading) return;
    reading = true;
    try {
      const usage = process.cpuUsage();
      const [threads, ffmpeg] = await Promise.all([readThreadSeconds(), readProcessesSeconds(ffmpegPids())]);
      const now = { at: Date.now(), process: (usage.user + usage.system) / 1e6, threads, ffmpeg };
      const shares = previous ? sharesBetween(previous, now) : null;
      previous = now;
      if (!shares) return;
      series.push(shares);
      if (detailed()) log(`processor: ${describeShares([shares])}`);
      if (now.at - since >= sayEveryMs) {
        log(`processor: ${describeShares(series)}`);
        series = [];
        since = now.at;
      }
    } finally {
      reading = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, everyMs);
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}
