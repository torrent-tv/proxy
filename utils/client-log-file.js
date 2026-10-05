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
 * directory (`/data` on the addon host). One file per viewing session and
 * torrent, named so the two halves join without guessing: the session's start,
 * then the torrent.
 */

import { createWriteStream, fstatSync, mkdirSync, openSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Where a browser's lines go when the proxy was started without `--log-file`.
 *
 * The proxy runs as the Home Assistant addon, from npm, in Docker, on Linux,
 * macOS or Windows; only the addon names a file. Without one these lines were
 * dropped, so on every other host the browser's half of a viewing existed
 * nowhere at all. They go to the proxy's own console instead, beside the
 * proxy's lines, and reach whatever keeps that output on the host: `docker
 * logs`, the journal of a systemd unit, a terminal. Each line carries the
 * session id, which is what the file name carries when there is a file.
 *
 * @param {(message: string) => void} log - The proxy's logger.
 * @returns {{ write: (session: object, lines: string[]) => void, close: () => Promise<void> }}
 */
export function createClientLogConsole(log) {
  return {
    write(session, lines) {
      const id = safeName(session?.sessionId, 8) || "unknown";
      for (const line of lines) {
        log(`client ${id} ${line}`);
      }
    },
    async close() {}
  };
}

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
 * @returns {{ write: (session: object, lines: string[]) => void, close: () => Promise<void> }}
 */
export function createClientLogFiles(proxyLogPath) {
  const directory = typeof proxyLogPath === "string" && proxyLogPath.length > 0
    ? dirname(proxyLogPath)
    : "";
  /**
   * @typedef {object} OpenFile
   * @property {import("node:fs").WriteStream} stream
   * @property {string} path
   * @property {number} bytes
   * @property {string} prefix - `client-<start>-<session>`, the part every file
   *   of one session shares, so they are found together.
   * @property {string} film - Which torrent the name carries; empty while it
   *   still says `no-torrent-yet`.
   */
  /** @type {Map<string, OpenFile>} */
  const open = new Map();
  /**
   * Files taken out of `open` whose last lines are still being flushed: a
   * rotated file, and the file of a film the session has moved away from.
   *
   * @type {Set<Promise<void>>}
   */
  const ending = new Set();

  /**
   * Finish a file that is no longer written to, and remember the wait so that
   * `close()` does not return before its last lines are on disk.
   *
   * @param {OpenFile} record
   * @returns {void}
   */
  function finish(record) {
    const done = new Promise((resolve) => {
      try {
        record.stream.end(() => resolve(undefined));
      } catch {
        // A stream that cannot be ended has nothing left to flush.
        resolve(undefined);
      }
    });
    ending.add(done);
    void done.then(() => ending.delete(done));
  }

  /**
   * Which torrent a batch names, or empty when none is chosen yet.
   *
   * @param {{ torrentName: string, infoHash: string }} session
   * @returns {string}
   */
  function filmOf(session) {
    if (!session.torrentName) return "";
    return session.infoHash || session.torrentName;
  }

  /**
   * @param {string} prefix
   * @param {{ torrentName: string, infoHash: string }} session
   * @returns {string}
   */
  function pathFor(prefix, session) {
    const film = session.torrentName
      ? `${safeName(session.torrentName, 60)}-${safeName(session.infoHash, 8)}`
      : "no-torrent-yet";
    return join(directory, `${prefix}-${film}.log`);
  }

  /**
   * Open a file for appending.
   *
   * The descriptor is opened synchronously and handed to the stream, so the
   * file exists under its path before this returns. A stream that opens its
   * own file does so later, and a rename made in between would leave the
   * stream creating a second file under the old name.
   *
   * @param {string} key
   * @param {string} prefix
   * @param {{ torrentName: string, infoHash: string }} session
   * @returns {OpenFile | null}
   */
  function openFile(key, prefix, session) {
    const path = pathFor(prefix, session);
    try {
      mkdirSync(directory, { recursive: true });
      const fd = openSync(path, "a");
      /** @type {OpenFile} */
      const record = {
        stream: createWriteStream(path, { fd }),
        path,
        bytes: fstatSync(fd).size,
        prefix,
        film: filmOf(session)
      };
      // A file that stops being writable must not take the proxy down with it,
      // and must not be retried on every line.
      record.stream.on("error", () => {
        if (open.get(key) === record) open.delete(key);
      });
      open.set(key, record);
      return record;
    } catch {
      return null;
    }
  }

  /**
   * The file for this session, opened on first use.
   *
   * Keyed by the session's own id rather than by the name. The first batch
   * always arrives before a torrent is chosen, and the lines it carries — the
   * page opening, the proxy being chosen, a connection failing — belong to the
   * film the session goes on to play. So the file is RENAMED when the first
   * torrent arrives, and those lines stay in it.
   *
   * A different torrent chosen later in the same page starts a file of its
   * own under the same prefix: renaming again would leave the first film's
   * lines under the second film's name, where nobody looking for the first
   * film finds them.
   *
   * @param {{ sessionId: string, startedAt: string, torrentName: string, infoHash: string }} session
   * @returns {OpenFile | null}
   */
  function fileFor(session) {
    if (!directory) return null;
    const key = session.sessionId;
    const film = filmOf(session);
    const existing = open.get(key);
    if (!existing) {
      const prefix = `client-${stamp(session.startedAt)}-${safeName(session.sessionId, 8)}`;
      return openFile(key, prefix, session);
    }
    if (film === "" || film === existing.film) return existing;
    if (existing.film === "") {
      const path = pathFor(existing.prefix, session);
      try {
        renameSync(existing.path, path);
        existing.path = path;
      } catch {
        // The lines keep going to the file under its old name; a name that
        // cannot change is better than a session's log lost to an exception.
      }
      // Set even when the rename failed, so it is not retried on every batch.
      existing.film = film;
      return existing;
    }
    open.delete(key);
    finish(existing);
    return openFile(key, existing.prefix, session);
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
        // Renamed before it is ended: the stream writes through its own
        // descriptor, so the lines still in flight follow the file to its new
        // name, and the next batch opens a fresh file under the old one
        // instead of appending to the file that is about to be moved.
        try {
          renameSync(record.path, `${record.path}.1`);
        } catch {
          // A rotation that cannot happen leaves the file growing under its
          // name, which is better than losing the session's log. It is tried
          // again after as much again, not on every batch.
          record.bytes = 0;
          return;
        }
        if (open.get(session.sessionId) === record) open.delete(session.sessionId);
        finish(record);
      }
    },
    /**
     * Finish every open file.
     *
     * Awaitable, and that is not a convenience: a write stream flushes
     * asynchronously, so a process that ends without waiting loses the last
     * lines of every session — which are the ones a crash is explained by.
     * That includes the files already set aside by a rotation or by a change
     * of film.
     *
     * @returns {Promise<void>}
     */
    async close() {
      for (const record of open.values()) finish(record);
      open.clear();
      await Promise.all([...ending]);
    }
  };
}
