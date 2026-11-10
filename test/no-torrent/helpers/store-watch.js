/**
 * @file Waits until a store's directory watch is delivering events.
 *
 * `fs.watch` returns before the platform is told to report: on macOS a file
 * written in the first milliseconds of a watch is never reported. A check that
 * writes a file and then waits for the store to be told proves the watch first,
 * with the store's own listener, and never sleeps a fixed time and hopes.
 */

import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * CHOSEN, not measured: how long the listener is silent before a probe is
 * written, and how long a probe is given to be heard. The platform reports in
 * batches (on macOS about every 51 ms, measured 2026-11-10), so a report of an
 * earlier write, such as the one that made the directory or the previous probe,
 * is delivered within this time; after it, a report is the probe's own. A heard
 * probe ends its wait at once; the period is only the longest a missing report
 * is waited for.
 */
const PROBE_PERIOD_MS = 200;

/**
 * Writes a file into the output's directory, again and again, until the store's
 * change listener has heard of two writes in a row, then removes it. Fails with
 * its own message when the listener stays silent for `limitMs`.
 *
 * Call it before the check registers its waits and writes its own file.
 *
 * @param {import("../../../services/storage/segment-store/SegmentStore.js").SegmentStore} store
 * @param {string} key - The output key.
 * @param {string} dir - The directory the probe files are written into.
 * @param {{ limitMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function untilWatchIsLive(store, key, dir, { limitMs = 5_000 } = {}) {
  let onHeard = () => {};
  const stop = store.subscribeChanges(key, () => onHeard());
  const probe = path.join(dir, ".watch-probe");
  const deadline = Date.now() + limitMs;
  let inARow = 0;
  try {
    for (let attempt = 0; inARow < 2; attempt += 1) {
      if (Date.now() >= deadline) {
        throw new Error(`the store heard nothing from ${dir} for ${limitMs} ms (${attempt} probes written)`);
      }
      // Reports of earlier writes are delivered before the probe is written.
      await new Promise((resolve) => {
        let silence = setTimeout(resolve, PROBE_PERIOD_MS);
        onHeard = () => {
          clearTimeout(silence);
          silence = setTimeout(resolve, PROBE_PERIOD_MS);
        };
      });
      let timer;
      const heard = new Promise((resolve) => {
        onHeard = () => resolve(true);
        timer = setTimeout(resolve, PROBE_PERIOD_MS, false);
      });
      writeFileSync(probe, String(attempt));
      inARow = (await heard) ? inARow + 1 : 0;
      clearTimeout(timer);
      onHeard = () => {};
    }
  } finally {
    stop();
    rmSync(probe, { force: true });
  }
}
