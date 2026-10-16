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
 *
 * Each run is also said on its own once a minute: the middle of its seconds'
 * processor and speed, and how far those seconds sit from it
 * (torrent-tv/meta#180, phase 1). That scatter is what a slowdown of the most
 * urgent run would have to exceed before it could be put down to another run
 * beside it; nothing decides on it yet.
 */

import { readFileSync, readdirSync } from "node:fs";

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
 * One `/proc` stat file, or null when it cannot be read.
 *
 * @param {string} file
 * @returns {{ name: string, seconds: number } | null}
 */
function statOf(file) {
  try {
    return parseStat(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * CPU seconds of this process's threads, by part, or null where `/proc` cannot
 * be read. Each reading names which torrent threads it counted (`epoch`): the
 * difference between two readings that counted different ones says nothing.
 *
 * READ SYNCHRONOUSLY, with the clock read beside it: a reading is only a share
 * when every counter in it and its time belong to one instant. Read as
 * promises on the field host (2.97.0), the counters were taken while the main
 * thread was busy and the time after, and a second read "process 1238 %" of a
 * core (torrent-tv/meta#177).
 *
 * THREE OR FOUR FILES A SECOND, NOT EVERY THREAD'S. The line names the main
 * thread, the torrent thread and the rest, and the rest is the whole process
 * less the two: the process's own counter carries every thread it has had.
 * Reading the stat of each of its threads every second, about a hundred
 * files, took 12 s of the main thread in fifteen minutes on Home Assistant
 * (r22, torrent-tv/meta#178). Which threads are the torrent thread is looked
 * up again when one of them is gone and at every `rediscover()`.
 *
 * @param {object} [params]
 * @param {number} [params.pid]
 * @param {(file: string) => string} [params.readText]
 * @param {(dir: string) => string[]} [params.list]
 * @returns {{ read: () => ({ main: number, worker: number, other: number, epoch: number } | null), rediscover: () => void }}
 */
export function threadReader({ pid = process.pid, readText = (file) => readFileSync(file, "utf8"), list = readdirSync } = {}) {
  const stat = (file) => {
    try {
      return parseStat(readText(file));
    } catch {
      return null;
    }
  };
  /** The torrent thread's ids, or null until they are looked up. @type {number[] | null} */
  let workers = null;
  /** How many times they have been looked up. */
  let epoch = 0;
  const lookUp = () => {
    let tids;
    try {
      tids = list(`/proc/${pid}/task`);
    } catch {
      return null;
    }
    return tids.map(Number).filter((tid) => {
      const one = stat(`/proc/${pid}/task/${tid}/stat`);
      return one && partOfThread(tid, one.name, pid) === "worker";
    });
  };
  return {
    read() {
      if (workers === null) {
        workers = lookUp();
        epoch += 1;
      }
      if (workers === null) return null;
      const total = stat(`/proc/${pid}/stat`);
      const main = stat(`/proc/${pid}/task/${pid}/stat`);
      if (!total || !main) return null;
      let worker = 0;
      for (const tid of workers) {
        const one = stat(`/proc/${pid}/task/${tid}/stat`);
        if (!one) {
          workers = null;
          return null;
        }
        worker += one.seconds;
      }
      return { main: main.seconds, worker, other: Math.max(0, total.seconds - main.seconds - worker), epoch };
    },
    rediscover() {
      workers = null;
    }
  };
}

/**
 * CPU seconds of each of these processes that can be read now.
 *
 * @param {number[]} pids
 * @returns {Map<number, number>}
 */
export function readProcessesSeconds(pids) {
  const seconds = new Map();
  for (const pid of pids) {
    const stat = statOf(`/proc/${pid}/stat`);
    if (stat) seconds.set(pid, stat.seconds);
  }
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
  // The torrent threads looked up again in between: their counters and the
  // rest's are not comparable across that.
  const threads = before.threads?.epoch === after.threads?.epoch;
  let ffmpeg = null;
  for (const [pid, value] of after.ffmpeg) {
    const earlier = before.ffmpeg.get(pid);
    if (earlier !== undefined && value >= earlier) ffmpeg = (ffmpeg ?? 0) + (value - earlier) / seconds;
  }
  return {
    seconds,
    process: share(before.process, after.process),
    main: threads ? share(before.threads?.main, after.threads?.main) : null,
    worker: threads ? share(before.threads?.worker, after.threads?.worker) : null,
    other: threads ? share(before.threads?.other, after.threads?.other) : null,
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
 * One second of each run read at both ends of it: the cores its ffmpeg used
 * and the film it made per second of wall clock. A run whose film is not
 * known at either end says its processor alone.
 *
 * @param {{ at: number, ffmpeg: Map<number, number>, runs: Map<number, { label: string, film: number | null }> }} before
 * @param {{ at: number, ffmpeg: Map<number, number>, runs: Map<number, { label: string, film: number | null }> }} after
 * @returns {Map<number, { label: string, cores: number, speed: number | null }>}
 */
export function runSecondsBetween(before, after) {
  /** @type {Map<number, { label: string, cores: number, speed: number | null }>} */
  const seconds = new Map();
  const elapsed = (after.at - before.at) / 1000;
  if (!(elapsed > 0)) return seconds;
  for (const [pid, run] of after.runs) {
    const from = before.ffmpeg.get(pid);
    const to = after.ffmpeg.get(pid);
    const earlier = before.runs.get(pid);
    if (!earlier || !Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
    const made = Number.isFinite(run.film) && Number.isFinite(earlier.film) && run.film >= earlier.film ? run.film - earlier.film : null;
    seconds.set(pid, { label: run.label, cores: (to - from) / elapsed, speed: made === null ? null : made / elapsed });
  }
  return seconds;
}

/**
 * Per run, over the interval: the median of its seconds and the median of
 * their distances to it, for its processor and its speed.
 *
 * @param {Map<number, { label: string, cores: number[], speed: number[] }>} runs
 * @returns {string} Empty when no run was read for two seconds.
 */
export function describeRuns(runs) {
  const said = [];
  for (const run of runs.values()) {
    if (run.cores.length < 2) continue;
    const cores = middleAndScatter(run.cores);
    const speed = middleAndScatter(run.speed);
    said.push(`${run.label} cores ${cores.middle.toFixed(2)} (scatter ${cores.scatter.toFixed(2)})` +
      (speed === null ? ", speed n/a" : `, speed ${speed.middle.toFixed(2)}x (scatter ${speed.scatter.toFixed(2)})`) +
      ` over ${run.cores.length}s`);
  }
  return said.join("; ");
}

/**
 * @param {number[]} values
 * @returns {{ middle: number, scatter: number } | null}
 */
function middleAndScatter(values) {
  if (values.length === 0) return null;
  const median = (list) => {
    const sorted = [...list].sort((a, b) => a - b);
    const half = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[half - 1] + sorted[half]) / 2 : sorted[half];
  };
  const middle = median(values);
  return { middle, scatter: median(values.map((value) => Math.abs(value - middle))) };
}

/**
 * Read every second, say once a minute, and every second while `detailed()`
 * is true.
 *
 * @param {object} params
 * @param {(line: string) => void} params.log
 * @param {() => Array<{ pid: number, label: string, film: number | null }>} params.ffmpegRuns - The encoders running now, with the film each has made.
 * @param {() => boolean} [params.detailed]
 * @param {(seconds: Map<number, { label: string, cores: number, speed: number | null }>) => void} [params.onRunSeconds] -
 *   Each second's readings of every run, by process, for whoever decides
 *   from them (`EncodeOrchestrator.noteRunSeconds`, torrent-tv/meta#180).
 * @param {number} [params.everyMs]
 * @param {number} [params.sayEveryMs]
 * @returns {{ stop: () => void }}
 */
export function startProcessorReport({ log, ffmpegRuns, detailed = () => false, onRunSeconds = () => {}, everyMs = 1000, sayEveryMs = 60_000 }) {
  let previous = null;
  let series = [];
  /** @type {Map<number, { label: string, cores: number[], speed: number[] }>} */
  let runSeries = new Map();
  let since = Date.now();
  const threads = threadReader();
  const tick = () => {
    const at = Date.now();
    const usage = process.cpuUsage();
    const runs = new Map(ffmpegRuns().map((run) => [run.pid, { label: run.label, film: run.film }]));
    const now = { at, process: (usage.user + usage.system) / 1e6, threads: threads.read(), ffmpeg: readProcessesSeconds([...runs.keys()]), runs };
    const shares = previous ? sharesBetween(previous, now) : null;
    const perRun = previous ? runSecondsBetween(previous, now) : new Map();
    previous = now;
    if (perRun.size > 0) {
      // A fault in whoever decides from the readings must not end the
      // readings, nor reach the timer as an uncaught exception.
      try {
        onRunSeconds(perRun);
      } catch (error) {
        log(`processor: run seconds not handled: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!shares) return;
    series.push(shares);
    for (const [pid, second] of perRun) {
      const kept = runSeries.get(pid) ?? { label: second.label, cores: [], speed: [] };
      kept.cores.push(second.cores);
      if (second.speed !== null) kept.speed.push(second.speed);
      runSeries.set(pid, kept);
    }
    if (detailed()) log(`processor: ${describeShares([shares])}`);
    if (now.at - since >= sayEveryMs) {
      log(`processor: ${describeShares(series)}`);
      const perRunLine = describeRuns(runSeries);
      if (perRunLine) log(`processor: per run, by second: ${perRunLine}`);
      series = [];
      runSeries = new Map();
      since = now.at;
      // A torrent thread made again since is counted as the rest until then.
      threads.rediscover();
    }
  };
  const timer = setInterval(tick, everyMs);
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}
