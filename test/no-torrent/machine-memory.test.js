/**
 * @file What an allocation could obtain, read from injected file contents.
 *
 * The figures of the 512 MiB container are the ones read on the Home Assistant
 * host on 2026-10-07 (torrent-tv/meta#153): a container that had written a
 * 600 MB file had `memory.current` at 99 % of its limit with 0.12 MB of it
 * anonymous, and a 450 MB allocation inside it then succeeded without an OOM
 * kill — the kernel took the file cache back.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import { availableMemory } from "../../services/storage/machine-memory.js";

const MIB = 1024 * 1024;

/** The host's `/proc/meminfo` as read inside that container. */
const MEMINFO = "MemTotal:        8037600 kB\nMemFree:          301234 kB\nMemAvailable:    4471204 kB\n";
const HOST_AVAILABLE = 4471204 * 1024;

/** `memory.stat` of the 512 MiB container after the 600 MB write, abridged. */
const STAT_V2_AFTER_WRITE = [
  "anon 122880",
  "file 515272704",
  "kernel 16113664",
  "shmem 0",
  "inactive_anon 4096",
  "active_anon 118784",
  "inactive_file 515166208",
  "active_file 106496",
  "unevictable 0",
  "slab_reclaimable 15654768",
  "slab_unreclaimable 458896"
].join("\n");

/**
 * A reader over a fixed set of files: a path not listed is absent.
 *
 * @param {Record<string, string>} files
 * @returns {(path: string) => string}
 */
function filesReader(files) {
  return (path) => {
    if (!Object.hasOwn(files, path)) {
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: "ENOENT" });
    }
    return files[path];
  };
}

test("no cgroup: the host's MemAvailable decides, and no limit is reported", () => {
  const reading = availableMemory({ readFile: filesReader({ "/proc/meminfo": MEMINFO }) });
  assert.deepEqual(reading, {
    bytes: HOST_AVAILABLE,
    source: "MemAvailable",
    limitBytes: null,
    totalBytes: os.totalmem()
  });
});

test("cgroup v2 without a limit: `max` constrains nothing", () => {
  const reading = availableMemory({
    readFile: filesReader({
      "/proc/meminfo": MEMINFO,
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/memory.max": "max\n",
      "/sys/fs/cgroup/memory.current": "3259916288\n",
      "/sys/fs/cgroup/memory.stat": STAT_V2_AFTER_WRITE
    })
  });
  assert.equal(reading.source, "MemAvailable");
  assert.equal(reading.bytes, HOST_AVAILABLE);
  assert.equal(reading.limitBytes, null);
});

test("cgroup v2 with a limit: the container's headroom decides, file cache counted as obtainable", () => {
  const reading = availableMemory({
    readFile: filesReader({
      "/proc/meminfo": MEMINFO,
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/memory.max": "536870912\n",
      "/sys/fs/cgroup/memory.current": "531472384\n",
      "/sys/fs/cgroup/memory.stat": STAT_V2_AFTER_WRITE
    })
  });
  assert.equal(reading.source, "cgroup v2");
  assert.equal(reading.limitBytes, 536870912);
  assert.equal(reading.totalBytes, 536870912);
  // 512 MiB limit, 531 MB charged, of which 515 MB file pages and 15.6 MB
  // reclaimable slab: what the 450 MB allocation was able to obtain. `limit −
  // current` alone says 5 MB here, which is `os.freemem()` again, one level down.
  assert.equal(reading.bytes, 536870912 - 531472384 + 515166208 + 106496 + 15654768);
});

test("cgroup v2 with a limit the host cannot honour: MemAvailable decides, and the limit is still reported", () => {
  const limit = 2048 * MIB;
  assert.ok(os.totalmem() > limit, "this check needs a machine with more than 2 GiB");
  const reading = availableMemory({
    readFile: filesReader({
      "/proc/meminfo": "MemAvailable:    1048576 kB\n",
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/memory.max": `${limit}\n`,
      "/sys/fs/cgroup/memory.current": `${100 * MIB}\n`,
      "/sys/fs/cgroup/memory.stat": "active_file 0\ninactive_file 0\nslab_reclaimable 0\n"
    })
  });
  assert.equal(reading.source, "MemAvailable");
  assert.equal(reading.bytes, 1024 * MIB);
  assert.equal(reading.limitBytes, limit);
});

test("cgroup v2 named in /proc/self/cgroup: the own level and every ancestor constrain", () => {
  // A systemd unit sees the whole hierarchy: its own limit is under its own
  // path, a slice above it may have a tighter one, and the root has no
  // `memory.max` at all.
  const service = "/sys/fs/cgroup/system.slice/torrent-tv.service";
  const slice = "/sys/fs/cgroup/system.slice";
  const noCache = "active_file 0\ninactive_file 0\nslab_reclaimable 0\n";
  const files = {
    "/proc/meminfo": MEMINFO,
    "/proc/self/cgroup": "0::/system.slice/torrent-tv.service\n",
    [`${service}/memory.max`]: `${1024 * MIB}\n`,
    [`${service}/memory.current`]: `${200 * MIB}\n`,
    [`${service}/memory.stat`]: noCache,
    [`${slice}/memory.max`]: `${1536 * MIB}\n`,
    [`${slice}/memory.current`]: `${1200 * MIB}\n`,
    [`${slice}/memory.stat`]: noCache
  };
  const reading = availableMemory({ readFile: filesReader(files) });
  assert.equal(reading.source, "cgroup v2");
  assert.equal(reading.bytes, 336 * MIB, "the slice has less room left than the service");
  assert.equal(reading.limitBytes, 1024 * MIB, "the smallest limit is the most this process can hold");
});

test("cgroup v1 with a limit: the container's own mount is read when its host path is not there", () => {
  // Docker on cgroup v1 names the host's path in /proc/self/cgroup and
  // bind-mounts the container's own directory at the hierarchy's root.
  const reading = availableMemory({
    readFile: filesReader({
      "/proc/meminfo": MEMINFO,
      "/proc/self/cgroup": "12:memory:/docker/0123abcd\n11:cpu,cpuacct:/docker/0123abcd\n0::/system.slice/containerd.service\n",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "536870912\n",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": "500000000\n",
      "/sys/fs/cgroup/memory/memory.stat": "cache 300000000\ninactive_file 1\nactive_file 1\ntotal_inactive_file 250000000\ntotal_active_file 40000000\n"
    })
  });
  assert.equal(reading.source, "cgroup v1");
  assert.equal(reading.limitBytes, 536870912);
  assert.equal(reading.bytes, 536870912 - 500000000 + 250000000 + 40000000);
});

test("cgroup v1 without a limit: the very large sentinel constrains nothing", () => {
  const reading = availableMemory({
    readFile: filesReader({
      "/proc/meminfo": MEMINFO,
      "/proc/self/cgroup": "12:memory:/\n",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": "500000000\n",
      "/sys/fs/cgroup/memory/memory.stat": "total_inactive_file 0\ntotal_active_file 0\n"
    })
  });
  assert.equal(reading.source, "MemAvailable");
  assert.equal(reading.bytes, HOST_AVAILABLE);
  assert.equal(reading.limitBytes, null);
});

test("usage over the limit reads as no room, never as negative room", () => {
  const reading = availableMemory({
    readFile: filesReader({
      "/proc/meminfo": MEMINFO,
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/memory.max": "536870912\n",
      "/sys/fs/cgroup/memory.current": "540000000\n",
      "/sys/fs/cgroup/memory.stat": "active_file 0\ninactive_file 0\nslab_reclaimable 0\n"
    })
  });
  assert.equal(reading.source, "cgroup v2");
  assert.equal(reading.bytes, 0);
});

test("nothing readable: free memory is the estimate, as before", () => {
  const reading = availableMemory({
    readFile: () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }
  });
  assert.equal(reading.source, "freemem");
  assert.ok(Number.isFinite(reading.bytes) && reading.bytes > 0);
  assert.equal(reading.limitBytes, null);
  assert.equal(reading.totalBytes, os.totalmem());
});

/**
 * A cgroup v2 level whose limits are the given files, with no file cache.
 *
 * @param {Record<string, string>} limits - `memory.max`, `memory.high`.
 * @param {number} currentBytes
 * @returns {Record<string, string>}
 */
function v2Level(limits, currentBytes) {
  const files = {
    "/proc/meminfo": MEMINFO,
    "/proc/self/cgroup": "0::/\n",
    "/sys/fs/cgroup/memory.current": `${currentBytes}\n`,
    "/sys/fs/cgroup/memory.stat": "active_file 0\ninactive_file 0\nslab_reclaimable 0\n"
  };
  for (const [name, value] of Object.entries(limits)) {
    files[`/sys/fs/cgroup/${name}`] = `${value}\n`;
  }
  return files;
}

test("cgroup v2 memory.high below memory.max: the throttle limit decides", () => {
  // Past `memory.high` the kernel throttles the cgroup and pushes its memory to
  // swap: on the Home Assistant kernel a 300 MB allocation took 2123 ms instead
  // of 527 ms under a 128 MiB `memory.high`, with 186 MiB swapped out
  // (torrent-tv/meta#155).
  const reading = availableMemory({
    readFile: filesReader(v2Level({ "memory.max": 1024 * MIB, "memory.high": 512 * MIB }, 100 * MIB))
  });
  assert.equal(reading.source, "cgroup v2");
  assert.equal(reading.limitBytes, 512 * MIB);
  assert.equal(reading.totalBytes, 512 * MIB);
  assert.equal(reading.bytes, 412 * MIB);
});

test("cgroup v2 memory.high alone is a limit: systemd's MemoryHigh= without MemoryMax=", () => {
  const reading = availableMemory({
    readFile: filesReader(v2Level({ "memory.max": "max", "memory.high": 512 * MIB }, 100 * MIB))
  });
  assert.equal(reading.source, "cgroup v2");
  assert.equal(reading.limitBytes, 512 * MIB);
  assert.equal(reading.bytes, 412 * MIB);
});

test("cgroup v2 memory.high of max leaves memory.max deciding", () => {
  const reading = availableMemory({
    readFile: filesReader(v2Level({ "memory.max": 512 * MIB, "memory.high": "max" }, 100 * MIB))
  });
  assert.equal(reading.source, "cgroup v2");
  assert.equal(reading.limitBytes, 512 * MIB);
  assert.equal(reading.bytes, 412 * MIB);
});
