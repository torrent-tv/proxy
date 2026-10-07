/**
 * @file How much memory an allocation of this process could obtain, read once.
 *
 * It was written THREE TIMES, in three layers, with the same body each time:
 * `transport/health-collector.js` for the score a proxy publishes to the registry,
 * `storage/memory-report.js` for the line the process prints every second, and
 * `storage/piece-store/shared-piece-store.js` for the budget the piece store takes.
 * One fact, three owners — and the copies had already drifted once: the piece
 * store was corrected from `os.freemem()` to the kernel's own estimate on
 * 2026-08-27 and the health collector went on publishing the wrong quantity
 * until 2026-09-02, so every Linux proxy in the pool understated itself, each
 * by a different amount according to how much cache it happened to hold.
 *
 * It lives in the storage layer because it is a fact about the RESOURCE, and
 * this layer is the resource's owner: what is free, what we already hold, and
 * what everything that is not us has been seen to need.
 *
 * **Why `MemAvailable` and not `os.freemem()`.** On Linux `freemem` counts only
 * the pages free at that instant, and the kernel deliberately keeps that number
 * low by filling the rest with reclaimable cache — so a machine reads as nearly
 * full while it has gigabytes to give. `MemAvailable` is the kernel's own
 * estimate of what an allocation could actually obtain. Where there is no
 * `/proc` — not Linux, or it is unreadable — `freemem` is the best answer there
 * is, and on those systems it is not misleading.
 *
 * **Why a container's limit as well.** `/proc/meminfo` describes the HOST. A
 * proxy run under Docker's `--memory` or systemd's `MemoryMax=` is killed by
 * the kernel at its cgroup's limit whatever the host has free: on 2026-10-07 a
 * 512 MiB container was killed while this reading said 4437 MB
 * (torrent-tv/meta#153). So the answer is the smaller of the host's figure and
 * the room left under every memory limit on this process's cgroup path — its
 * own and each ancestor's, because a slice limit binds every unit inside it.
 * The proxy runs anywhere, so nothing here knows of any particular host: the
 * cgroup is found from `/proc/self/cgroup`, and where nothing is readable the
 * answer is the host's alone, as it always was.
 *
 * **The room under a limit is NOT `limit − usage`,** for the same reason the
 * host's figure is not `freemem`: the cgroup is charged for the file pages its
 * processes read and write, and the kernel takes those back before it kills
 * anything. Measured in a 512 MiB container on the Home Assistant host: after a
 * 600 MB file was written `memory.current` stood at 531 MB of 537 — 515 MB of
 * it file cache, 0.12 MB anonymous — and a 450 MB allocation then succeeded
 * with no OOM kill, the cache shrinking to 50 MB. `limit − usage` said 5 MB. So
 * the reclaimable part is added back, and it is the part the kernel's own
 * `MemAvailable` counts: the file LRU lists and reclaimable slab
 * (`active_file`, `inactive_file`, `slab_reclaimable` in cgroup v2's
 * `memory.stat`; v1 states the file lists hierarchically as `total_*`). The
 * watermark share `MemAvailable` subtracts has no counterpart under a cgroup
 * limit, which is hard, so nothing is subtracted for it.
 */

import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * Where each cgroup version keeps its memory controller, and under which names.
 *
 * Version 1 states the file lists of the cgroup alone as `active_file` and of
 * it with its descendants as `total_active_file`; its usage includes the
 * descendants, so the hierarchical figures are the ones that subtract from it.
 */
const HIERARCHIES = {
  1: {
    mount: "/sys/fs/cgroup/memory",
    limit: "memory.limit_in_bytes",
    usage: "memory.usage_in_bytes",
    reclaimable: ["total_active_file", "total_inactive_file"]
  },
  2: {
    mount: "/sys/fs/cgroup",
    limit: "memory.max",
    usage: "memory.current",
    reclaimable: ["active_file", "inactive_file", "slab_reclaimable"]
  }
};

/**
 * @typedef {Object} MemoryReading
 * @property {number} bytes - What an allocation could obtain right now.
 * @property {"cgroup v2" | "cgroup v1" | "MemAvailable" | "freemem"} source -
 *   Which reading decided `bytes`: a container's limit, the kernel's own
 *   estimate for the host, or free memory where that estimate was unreadable.
 * @property {number | null} limitBytes - The smallest memory limit in force on
 *   this process's cgroup path, or null where there is none. Reported whether
 *   or not it decided, so a log says that a limit exists.
 * @property {number} totalBytes - The most this process could ever hold: the
 *   limit where there is one, the host's memory otherwise.
 */

/**
 * What an allocation of this process could obtain right now.
 *
 * @param {Object} [options]
 * @param {(path: string) => string} [options.readFile] - Reads a file as text,
 *   throwing where it is absent or unreadable; injected by the checks.
 * @returns {MemoryReading}
 */
export function availableMemory({ readFile = (path) => readFileSync(path, "utf8") } = {}) {
  const hostTotal = os.totalmem();
  const host = hostAvailable(readFile);
  const container = containerRoom(readFile, hostTotal);
  if (container !== null && container.roomBytes < host.bytes) {
    return {
      bytes: container.roomBytes,
      source: `cgroup v${container.version}`,
      limitBytes: container.limitBytes,
      totalBytes: container.limitBytes
    };
  }
  return {
    bytes: host.bytes,
    source: host.source,
    limitBytes: container?.limitBytes ?? null,
    totalBytes: container?.limitBytes ?? hostTotal
  };
}

/**
 * What an allocation of this process could obtain right now, as a plain number.
 *
 * @returns {number}
 */
export function availableMemoryBytes() {
  return availableMemory().bytes;
}

/**
 * The host's own estimate, or its free memory where the estimate is unreadable.
 *
 * @param {(path: string) => string} readFile
 * @returns {{ bytes: number, source: "MemAvailable" | "freemem" }}
 */
function hostAvailable(readFile) {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFile("/proc/meminfo"));
    if (match) {
      return { bytes: Number(match[1]) * 1024, source: "MemAvailable" };
    }
  } catch {
    // silent-ok: not Linux, or /proc is not readable.
  }
  return { bytes: os.freemem(), source: "freemem" };
}

/**
 * The room left under every memory limit on this process's cgroup path.
 *
 * @param {(path: string) => string} readFile
 * @param {number} hostTotal - The host's memory; a limit at or above it cannot
 *   be reached by memory use, which is how cgroup v1 says "no limit".
 * @returns {{ version: 1 | 2, roomBytes: number, limitBytes: number } | null}
 *   Null where no limit is in force or nothing is readable.
 */
function containerRoom(readFile, hostTotal) {
  let membership;
  try {
    membership = ownCgroup(readFile("/proc/self/cgroup"));
  } catch {
    return null; // silent-ok: not Linux, or /proc is not readable.
  }
  if (membership === null) {
    return null;
  }
  const hierarchy = HIERARCHIES[membership.version];
  let found = null;
  for (const directory of levelsOf(hierarchy.mount, membership.path)) {
    const level = roomAt(readFile, hierarchy, directory, hostTotal);
    if (level === null) {
      continue;
    }
    found = {
      version: membership.version,
      roomBytes: Math.min(found?.roomBytes ?? Infinity, level.roomBytes),
      limitBytes: Math.min(found?.limitBytes ?? Infinity, level.limitBytes)
    };
  }
  return found;
}

/**
 * Which cgroup this process is in, for the memory controller.
 *
 * A host in hybrid mode lists both versions; the memory controller is then on
 * version 1, named in the line that lists it.
 *
 * @param {string} text - `/proc/self/cgroup`.
 * @returns {{ version: 1 | 2, path: string } | null}
 */
function ownCgroup(text) {
  for (const line of text.split("\n")) {
    const match = /^\d+:([^:]*):(.*)$/.exec(line);
    if (match && match[1].split(",").includes("memory")) {
      return { version: 1, path: match[2] };
    }
  }
  const unified = /^0::(.*)$/m.exec(text);
  return unified ? { version: 2, path: unified[1] } : null;
}

/**
 * The cgroup's own directory and each ancestor's, up to the mount.
 *
 * The own directory may be absent: Docker on cgroup v1 names the host's path
 * while mounting the container's own directory at the root. The mount is
 * always on the list, so in that case it is what is read. A path with `..` is
 * a cgroup outside this namespace's root, which nothing under the mount
 * describes, so nothing is read for it and the host's figure stands.
 *
 * @param {string} mount
 * @param {string} path
 * @returns {string[]}
 */
function levelsOf(mount, path) {
  const parts = path.split("/").filter(Boolean);
  if (parts.includes("..")) {
    return [];
  }
  const levels = [];
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    levels.push([mount, ...parts.slice(0, depth)].join("/"));
  }
  return levels;
}

/**
 * The limit in one cgroup directory and the room left under it.
 *
 * @param {(path: string) => string} readFile
 * @param {(typeof HIERARCHIES)[1]} hierarchy
 * @param {string} directory
 * @param {number} hostTotal
 * @returns {{ roomBytes: number, limitBytes: number } | null} Null where this
 *   level states no limit — `max`, the version 1 sentinel — or is not there.
 */
function roomAt(readFile, hierarchy, directory, hostTotal) {
  let limitBytes;
  let usageBytes;
  try {
    limitBytes = bytesOf(readFile(`${directory}/${hierarchy.limit}`));
    usageBytes = bytesOf(readFile(`${directory}/${hierarchy.usage}`));
  } catch {
    return null; // silent-ok: no such level, or no memory controller on it.
  }
  if (!Number.isFinite(limitBytes) || limitBytes >= hostTotal || !Number.isFinite(usageBytes)) {
    return null;
  }
  let reclaimableBytes = 0;
  try {
    reclaimableBytes = statSum(readFile(`${directory}/memory.stat`), hierarchy.reclaimable);
  } catch {
    // silent-ok: counting nothing as reclaimable understates the room, which
    // errs away from the kill this reading exists to avoid.
  }
  return { limitBytes, roomBytes: Math.max(0, limitBytes - usageBytes + reclaimableBytes) };
}

/**
 * A byte count written by the kernel, or NaN for anything else (`max`).
 *
 * @param {string} text
 * @returns {number}
 */
function bytesOf(text) {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/**
 * The sum of the named fields of a `memory.stat`.
 *
 * @param {string} text
 * @param {string[]} names
 * @returns {number}
 */
function statSum(text, names) {
  let sum = 0;
  for (const line of text.split("\n")) {
    const [name, value = ""] = line.split(" ");
    if (names.includes(name)) {
      const bytes = bytesOf(value);
      sum += Number.isFinite(bytes) ? bytes : 0;
    }
  }
  return sum;
}
