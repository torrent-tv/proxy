/**
 * @file Where a browser's own log lands: a file beside the proxy's, per session.
 *
 * WHY THIS EXISTS. Both halves of every failure this project investigates live
 * in two places at once — what the proxy did, and what the page saw — and until
 * now the second half went to the SERVER's standard output on the droplet.
 * Every release recreates that container and destroys it. On 2026-09-13 a
 * viewer reported a desync and a frozen picture, and the analysis ran on half
 * the evidence for exactly this reason.
 *
 * Written here instead, next to the proxy's own log, on the same durable
 * directory (`/data` on the addon host). One file per viewing session, named so
 * the two halves join without guessing: the session's start, then the torrent.
 */

import { createWriteStream, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** One file may reach this before it is rotated. */
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * Make a name safe for a file and short enough to read in a directory listing.
 *
 * Deliberately strict: a torrent name is arbitrary bytes chosen by a stranger,
 * and it is about to become a path.
 *
 * @param {string} value
 * @param {number} max
 * @returns {string}
 */
function safeName(value, max) {
  const cleaned = String(value ?? "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.slice(0, max);
}

/**
 * `2026-09-13T16:05:24.123Z` → `20260913-160524`, which sorts and reads.
 *
 * @param {string} iso
 * @returns {string}
 */
function stamp(iso) {
  const when = new Date(iso);
  const at = Number.isNaN(when.getTime()) ? new Date() : when;
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
}

/**
 * A sink that writes one session's browser lines to its own file.
 *
 * @param {string} proxyLogPath - The proxy's own log file; its directory is
 *   used, so the two halves are always side by side.
 * @returns {{ write: (session: object, lines: string[]) => void, close: () => void }}
 */
export function createClientLogFiles(proxyLogPath) {
  const directory = typeof proxyLogPath === "string" && proxyLogPath.length > 0
    ? dirname(proxyLogPath)
    : "";
  /** @type {Map<string, { stream: import("node:fs").WriteStream, path: string, bytes: number }>} */
  const open = new Map();

  /**
   * The file for this session, opened on first use.
   *
   * Keyed by the session's own id rather than by the name, because the name
   * gains the torrent the moment one is chosen and the earlier lines — the
   * page opening, the proxy being chosen, a connection failing — belong to the
   * same session and must not start a second file.
   *
   * @param {{ sessionId: string, startedAt: string, torrentName: string, infoHash: string }} session
   * @returns {{ stream: import("node:fs").WriteStream, path: string, bytes: number } | null}
   */
  function fileFor(session) {
    if (!directory) return null;
    const key = session.sessionId;
    const existing = open.get(key);
    if (existing) return existing;
    const film = session.torrentName
      ? `${safeName(session.torrentName, 60)}-${safeName(session.infoHash, 8)}`
      : "no-torrent-yet";
    const path = join(directory, `client-${stamp(session.startedAt)}-${safeName(session.sessionId, 8)}-${film}.log`);
    try {
      mkdirSync(directory, { recursive: true });
      const record = {
        stream: createWriteStream(path, { flags: "a" }),
        path,
        bytes: statSync(path, { throwIfNoEntry: false })?.size ?? 0
      };
      // A file that stops being writable must not take the proxy down with it,
      // and must not be retried on every line.
      record.stream.on("error", () => open.delete(key));
      open.set(key, record);
      return record;
    } catch {
      return null;
    }
  }

  return {
    write(session, lines) {
      const record = fileFor(session);
      if (!record) return;
      for (const line of lines) {
        const text = `${line}\n`;
        record.bytes += Buffer.byteLength(text);
        record.stream.write(text);
      }
      if (record.bytes >= MAX_BYTES) {
        try {
          record.stream.end(() => {
            try {
              renameSync(record.path, `${record.path}.1`);
            } catch {
              // Renaming a file that has gone leaves nothing to do.
            }
          });
        } catch {
          // A rotation that cannot happen leaves the file growing, which is
          // better than losing the session's log to an exception.
        }
        open.delete(session.sessionId);
      }
    },
    /**
     * Finish every open file.
     *
     * Awaitable, and that is not a convenience: a write stream opens and
     * flushes asynchronously, so a process that ends without waiting loses the
     * last lines of every session — which are the ones a crash is explained by.
     *
     * @returns {Promise<void>}
     */
    async close() {
      const ending = [...open.values()].map((record) => new Promise((resolve) => {
        try {
          record.stream.end(resolve);
        } catch {
          resolve(undefined);
        }
      }));
      open.clear();
      await Promise.all(ending);
    }
  };
}
