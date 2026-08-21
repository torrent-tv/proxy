/**
 * @file Keep the last few core dumps and no more.
 *
 * A native fault on the torrent worker writes the whole address space out: on
 * the field host that is **4.18 GB each**, and four of them had nearly filled a
 * 235 GB disk by 2026-08-21. The dumps are worth having — the one read that day
 * named a fault three days of reasoning had not — but only the recent ones are,
 * and a full disk costs more than an old dump is worth.
 *
 * Deliberately not "delete them all": the newest are the evidence for the fault
 * that is still open (roadmap item 7).
 */

import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { logger } from "../utils/logger.js";

/** How many to keep, newest first. */
export const CORE_DUMPS_KEPT = 2;

/**
 * Which dumps to remove, given what is there.
 *
 * Pure, so the rule can be tested without a filesystem: newest first by the
 * time they were written, keep `keep`, name the rest.
 *
 * @param {Array<{ name: string, writtenAt: number }>} dumps
 * @param {number} [keep]
 * @returns {string[]} Names to delete, oldest first.
 */
export function dumpsToRemove(dumps, keep = CORE_DUMPS_KEPT) {
  const sorted = [...(Array.isArray(dumps) ? dumps : [])]
    .filter((dump) => typeof dump?.name === "string" && Number.isFinite(dump?.writtenAt))
    .sort((left, right) => right.writtenAt - left.writtenAt);
  return sorted.slice(Math.max(0, keep)).map((dump) => dump.name).reverse();
}

/**
 * Whether a file name is a core dump this host wrote.
 *
 * The kernel's pattern on the addon host produces `core.<thread>.<pid>.<epoch>`
 * — every one seen so far is `core.WorkerThread.81.…`, the thread the torrent
 * client runs on. Matched loosely on the `core.` prefix so a differently
 * configured host is still swept.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isCoreDump(name) {
  return typeof name === "string" && /^core\.[^/\\]+$/.test(name);
}

/**
 * Delete all but the newest few core dumps in `dir`.
 *
 * Best-effort and never fatal: a proxy that cannot tidy its dumps still has to
 * serve video.
 *
 * @param {string} dir
 * @param {number} [keep]
 * @returns {Promise<void>}
 */
export async function pruneCoreDumps(dir, keep = CORE_DUMPS_KEPT) {
  if (typeof dir !== "string" || dir.length === 0) {
    return;
  }
  /** @type {Array<{ name: string, writtenAt: number, bytes: number }>} */
  const dumps = [];
  try {
    for (const name of await readdir(dir)) {
      if (!isCoreDump(name)) {
        continue;
      }
      try {
        const info = await stat(path.join(dir, name));
        if (info.isFile()) {
          dumps.push({ name, writtenAt: info.mtimeMs, bytes: info.size });
        }
      } catch {
        // silent-ok: it went away between listing and reading, which is the
        // outcome this function wanted anyway.
      }
    }
  } catch {
    return; // No such directory, or unreadable. Nothing to tidy.
  }
  if (dumps.length === 0) {
    return;
  }
  const doomed = dumpsToRemove(dumps, keep);
  const freed = dumps
    .filter((dump) => doomed.includes(dump.name))
    .reduce((total, dump) => total + dump.bytes, 0);
  for (const name of doomed) {
    try {
      await rm(path.join(dir, name), { force: true });
    } catch {
      // silent-ok: best effort, and the next start tries again.
    }
  }
  logger.info(
    `core dumps: ${dumps.length} present, keeping the newest ${Math.min(keep, dumps.length)}` +
      (doomed.length > 0 ? `, removed ${doomed.length} (${(freed / 1e9).toFixed(2)} GB)` : "")
  );
}
