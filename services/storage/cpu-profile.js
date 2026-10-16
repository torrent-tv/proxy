/**
 * @file CPU profiles of the main thread and of the torrent thread, asked for
 * by the operator and never taken otherwise (torrent-tv/meta#177, #178).
 *
 * At a cold start on the addon host (#166 run 12) the picture's first input
 * waited 29.5 s, 20.2 s of it inside a budget revision, while the main thread
 * ran at 83-108 % of a core; what it was doing is not in any log. A profile of
 * that thread names it.
 *
 * The torrent thread is profiled beside it. After a seek on Home Assistant
 * (r60, #178) a soundtrack's input waited 23.3 s, every read of held bytes took
 * 1.5-6 s in that thread, its loop ran up to 2.7 s late and it drew three
 * quarters of a core; what it spent them on is in no log either.
 *
 * In-process, through `node:inspector`: the sampling profiler runs beside the
 * thread and does not stop it — unlike the debugger that stopped every thread
 * of this process on 2026-09-05 (torrent-tv/meta#77). Both begin at the first
 * source opened, which is where a cold start begins, run for the seconds the
 * operator named, and are written by this thread under the one storage budget
 * as `cpu-start-<time>.cpuprofile` (main) and `cpu-torrent-<time>.cpuprofile`,
 * readable in Chrome's DevTools (Performance, "Load profile").
 */

import { Session } from "node:inspector/promises";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Profile the thread this runs on for `seconds`.
 *
 * @param {number} seconds
 * @returns {Promise<object>} The profile, as `Profiler.stop` gives it.
 */
export async function profileThisThread(seconds) {
  const session = new Session();
  session.connect();
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.start");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, seconds * 1000);
      if (typeof timer.unref === "function") timer.unref();
    });
    const { profile } = await session.post("Profiler.stop");
    return profile;
  } finally {
    session.disconnect();
  }
}

/**
 * @param {object} params
 * @param {number} params.seconds - How long to profile; nothing happens unless positive.
 * @param {string} params.dir - Where to write the profile.
 * @param {(line: string) => void} params.log
 * @param {(bytes: number) => boolean} [params.mayKeep] - Whether the storage budget lets it be kept.
 * @param {(seconds: number) => Promise<string | null>} [params.torrentThread] - The torrent thread's
 *   profile over the same seconds, as JSON text, or null when it could not be taken.
 * @returns {{ begin: () => void, active: () => boolean }}
 */
export function startupCpuProfile({ seconds, dir, log, mayKeep = () => true, torrentThread = null }) {
  let begun = false;
  let running = 0;
  const wanted = Number.isFinite(seconds) && seconds > 0 && typeof dir === "string" && dir.length > 0;
  const keep = async (name, text) => {
    const bytes = Buffer.byteLength(text);
    if (!mayKeep(bytes)) {
      log(`cpu profile: ${name} not kept, ${bytes} bytes refused by the storage budget`);
      return;
    }
    const file = path.join(dir, `cpu-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.cpuprofile`);
    await writeFile(file, text);
    log(`cpu profile: written to ${file} (${bytes} bytes)`);
  };
  const take = async (name, profile) => {
    running += 1;
    try {
      const text = await profile();
      if (text) await keep(name, text);
    } catch (error) {
      log(`cpu profile: ${name} failed — ${error.message}`);
    } finally {
      running -= 1;
    }
  };
  return {
    begin() {
      if (!wanted || begun) return;
      begun = true;
      log(`cpu profile: the main thread${torrentThread ? " and the torrent thread are" : " is"} profiled for ${seconds}s from the first source opened`);
      void take("start", async () => JSON.stringify(await profileThisThread(seconds)));
      if (torrentThread) void take("torrent", () => torrentThread(seconds));
    },
    active: () => running > 0
  };
}
