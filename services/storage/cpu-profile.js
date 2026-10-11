/**
 * @file A CPU profile of the main thread at a cold start, asked for by the
 * operator and never taken otherwise (torrent-tv/meta#177).
 *
 * At a cold start on the addon host (#166 run 12) the picture's first input
 * waited 29.5 s, 20.2 s of it inside a budget revision, while the main thread
 * ran at 83-108 % of a core; what it was doing is not in any log. A profile of
 * that thread names it.
 *
 * In-process, through `node:inspector`: the sampling profiler runs beside the
 * thread and does not stop it — unlike the debugger that stopped every thread
 * of this process on 2026-09-05 (torrent-tv/meta#77). It begins at the first
 * source opened, which is where a cold start begins, runs for the seconds the
 * operator named, and writes `cpu-start-<time>.cpuprofile` beside the log,
 * readable in Chrome's DevTools (Performance, "Load profile").
 */

import { Session } from "node:inspector/promises";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * @param {object} params
 * @param {number} params.seconds - How long to profile; nothing happens unless positive.
 * @param {string} params.dir - Where to write the profile.
 * @param {(line: string) => void} params.log
 * @param {(bytes: number) => boolean} [params.mayKeep] - Whether the storage budget lets it be kept.
 * @returns {{ begin: () => void, active: () => boolean }}
 */
export function startupCpuProfile({ seconds, dir, log, mayKeep = () => true }) {
  let begun = false;
  let running = false;
  const wanted = Number.isFinite(seconds) && seconds > 0 && typeof dir === "string" && dir.length > 0;
  const take = async () => {
    const session = new Session();
    session.connect();
    try {
      await session.post("Profiler.enable");
      await session.post("Profiler.start");
      running = true;
      log(`cpu profile: the main thread is profiled for ${seconds}s from the first source opened`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, seconds * 1000);
        if (typeof timer.unref === "function") timer.unref();
      });
      const { profile } = await session.post("Profiler.stop");
      const text = JSON.stringify(profile);
      if (!mayKeep(Buffer.byteLength(text))) {
        log(`cpu profile: not kept, ${Buffer.byteLength(text)} bytes refused by the storage budget`);
        return;
      }
      const file = path.join(dir, `cpu-start-${new Date().toISOString().replace(/[:.]/g, "-")}.cpuprofile`);
      await writeFile(file, text);
      log(`cpu profile: written to ${file} (${Buffer.byteLength(text)} bytes)`);
    } finally {
      running = false;
      session.disconnect();
    }
  };
  return {
    begin() {
      if (!wanted || begun) return;
      begun = true;
      void take().catch((error) => log(`cpu profile: failed — ${error.message}`));
    },
    active: () => running
  };
}
