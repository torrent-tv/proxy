/**
 * @file Packet witness for the delivery freeze: a ring that is always running,
 * and a tail that outlasts the sender's own retransmission timeout.
 *
 * Roadmap item 11. Two captures taken by the earlier version of this file, read
 * on 2026-08-26 (`research/delivery-freeze-sender-silent-2026-08-26.md`), place
 * the failure: while a channel held 67 MB, the proxy put NO packet larger than
 * 89 bytes of UDP payload on the wire for 28 s, twice, in two separate
 * episodes. The receiver never had anything to drop, the path carried STUN and
 * the browser's own requests throughout, and `usrsctp_sendv` refused every byte
 * for 54 minutes. What those captures could NOT show is what happened at the
 * ONSET, because they began 30 s after the queue was already declared stuck,
 * and what happens beyond 28 s, because that is where they stopped.
 *
 * So the capture is in two halves now.
 *
 * The RING runs the whole time a data channel is open, size-bounded and
 * wrapping, filtered to the WebRTC UDP port. It costs a rotating file on disk
 * and nothing else, and it means the seconds BEFORE a freeze are already
 * recorded when the freeze is noticed. On a wedge its files are copied aside
 * before the wrap can reach them.
 *
 * The TAIL then records the wedged session's own 5-tuple for
 * {@linkcode WITNESS_TAIL_SECONDS}, which is three times usrsctp's maximum
 * retransmission timeout. That length is what turns "no zero-window probe in
 * the 28 s we watched" into a statement about the sender: a stalled SCTP sender
 * whose peer advertises a zero window MUST probe once per timeout, and the
 * timeout cannot exceed {@linkcode WITNESS_RTO_CEILING_SECONDS}. Silence across
 * three of those is not a sampling gap.
 *
 * Bounded so it can never cost more than an episode is worth: the ring is
 * capped in bytes and deleted when the last channel closes, the tail process is
 * killed after its window plus grace, one tail runs at a time with a cooldown,
 * and old captures are pruned at startup like core dumps.
 */

import { spawn } from "node:child_process";
import { copyFile, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dumpsToRemove } from "./core-dumps.js";

/** Per-packet capture length. Small: headers are what the signatures need. */
export const WITNESS_SNAPLEN_BYTES = 128;

/**
 * usrsctp's maximum retransmission timeout, seconds (its `RTO.max` default).
 *
 * Not ours to choose: it is the longest a stalled SCTP sender may wait before
 * it must try again, so it is the shortest window in which silence means
 * anything at all.
 */
export const WITNESS_RTO_CEILING_SECONDS = 60;

/**
 * How long the tail capture records the wedged session, seconds.
 *
 * Three retransmission timeouts. One would leave the answer to a single
 * scheduling accident; three is silence that has had three chances to break.
 */
export const WITNESS_TAIL_SECONDS = WITNESS_RTO_CEILING_SECONDS * 3;

/** Megabytes per ring file before tcpdump rotates to the next. */
export const WITNESS_RING_FILE_MB = 16;

/** How many ring files wrap around (16 MB × 4 = 64 MB of history). */
export const WITNESS_RING_FILES = 4;

/** Megabytes per tail file. A wedged session emits a few packets a second. */
export const WITNESS_TAIL_FILE_MB = 8;

/** How many tail files may be written before tcpdump stops on its own. */
export const WITNESS_TAIL_FILES = 2;

/** Extra time before the SIGKILL fallback lands on a hanging tcpdump. */
export const WITNESS_KILL_GRACE_MS = 5_000;

/** Minimum spacing between tail captures, whatever the reason for them. */
export const WITNESS_COOLDOWN_MS = 10 * 60_000;

/** How many old captures survive at startup, newest first. */
export const WITNESS_CAPTURES_KEPT = 8;

/** Base name of the rolling ring, before tcpdump appends its file number. */
export const WITNESS_RING_BASENAME = "packet-witness-ring.pcap";

/**
 * The remote endpoint of a transport snapshot, already structured.
 *
 * @typedef {Object} WitnessRemoteEndpoint
 * @property {string} address - IP literal (may carry a `%zone` suffix).
 * @property {number} port
 */

/**
 * What the watcher hands over when a wedge crosses the capture threshold.
 *
 * @typedef {Object} WitnessTrigger
 * @property {string} sessionId
 * @property {string} tag       - Session id, first 8 characters.
 * @property {string} label     - Data channel label ("proxy", "proxy-control").
 * @property {WitnessRemoteEndpoint | null} remote
 * @property {number} queuedBytes
 * @property {number} stuckForMs
 */

/**
 * Strip a zone suffix and keep only IPv4/IPv6 literals.
 *
 * The address travels into a tcpdump BPF filter argument. The child is spawned
 * as an argv array (no shell), so injection is not reachable, but a garbage or
 * hostname value would produce a capture of nothing — rejected instead, so the
 * log can say why nothing was written.
 *
 * @param {unknown} raw - Address as libdatachannel reports it.
 * @returns {string | null} A clean literal, or null when not usable.
 */
export function normalizeRemoteAddress(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const zoneFree = raw.replace(/%.*$/, "");
  if (zoneFree.length === 0 || zoneFree.length > 45) {
    return null;
  }
  const ipv4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  // Hex groups and at most one "::" compression — enough to keep hostnames,
  // decimal-octet junk and shell metacharacters out of the filter.
  const ipv6 = /^(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}$/;
  if (ipv4.test(zoneFree) || (zoneFree.includes(":") && ipv6.test(zoneFree))) {
    return zoneFree;
  }
  return null;
}

/**
 * The tcpdump command line for a size-rotated capture.
 *
 * `-i any` covers hosts where the UDP mux socket is not on a named interface;
 * `-n` keeps DNS out of the hot path; `-S` prints absolute sequence numbers so
 * duplicate SACKs across file rotations compare equal by eye.
 *
 * Rotation is by SIZE, not by time, and that is a correction rather than a
 * preference. `-G <seconds>` with `-W <count>` and a file name carrying no
 * strftime field makes every rotation write the SAME name: the four files the
 * previous version believed it was keeping were one file overwritten four
 * times, which is why both field captures hold 28 s and not the intended 120.
 * `-C <megabytes>` with `-W <count>` appends a number to the name and wraps
 * around, which is the ring this needs — and a byte bound is the right bound
 * anyway, because the rate varies by two orders of magnitude between a wedged
 * session and a healthy burst.
 *
 * @param {Object} parts
 * @param {string} [parts.host]        - Validated IP literal; omitted captures every peer.
 * @param {number} parts.port          - The WebRTC UDP port.
 * @param {string} parts.filePrefix    - Path prefix; tcpdump appends the file number.
 * @param {number} [parts.snaplen]     - Bytes per packet to store.
 * @param {number} [parts.fileMegabytes]
 * @param {number} [parts.files]
 * @returns {string[]}
 */
export function buildTcpdumpArgs({
  host = "",
  port,
  filePrefix,
  snaplen = WITNESS_SNAPLEN_BYTES,
  fileMegabytes = WITNESS_RING_FILE_MB,
  files = WITNESS_RING_FILES
}) {
  const filter = ["udp", "and", "port", String(port)];
  if (host) {
    filter.push("and", "host", host);
  }
  return [
    "-n",
    "-S",
    "-s",
    String(snaplen),
    "-i",
    "any",
    "-w",
    filePrefix,
    "-C",
    String(fileMegabytes),
    "-W",
    String(files),
    ...filter
  ];
}

/**
 * Whether a new capture may start right now.
 *
 * Pure, so the gating rule is testable without clocks or processes: never two
 * at once, and none within the cooldown of the previous one. `lastStartedAt`
 * of 0 means this process has not captured yet.
 *
 * @param {{ running: boolean, lastStartedAt: number, now?: number, cooldownMs?: number }} state
 * @returns {boolean}
 */
export function shouldStartCapture({ running, lastStartedAt, now = Date.now(), cooldownMs = WITNESS_COOLDOWN_MS }) {
  if (running) {
    return false;
  }
  return lastStartedAt <= 0 || now - lastStartedAt >= cooldownMs;
}

/**
 * Whether a file name is a capture this module wrote (including the
 * timestamp-suffixed rotations tcpdump appends under `-G`).
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isWitnessCapture(name) {
  return typeof name === "string" && /^packet-witness\.[^/\\]+\.pcap/.test(name);
}

/**
 * Whether a file name is one of the rolling ring's own files.
 *
 * The ring is scratch, not evidence: it wraps, and it is deleted when the last
 * channel closes. Only the copies taken at a wedge are kept, and those are
 * named so that {@link isWitnessCapture} — and therefore the pruner — sees
 * them and the ring's own files are left alone.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isWitnessRingFile(name) {
  return typeof name === "string" && name.startsWith(WITNESS_RING_BASENAME) && !name.includes("/") && !name.includes("\\");
}

/**
 * Delete all but the newest few captures in `dir`.
 *
 * Mirrors `pruneCoreDumps`: best-effort, never fatal, one summary line.
 *
 * @param {string} dir
 * @param {number} [keep]
 * @returns {Promise<void>}
 */
export async function pruneWitnessCaptures(dir, keep = WITNESS_CAPTURES_KEPT) {
  if (typeof dir !== "string" || dir.length === 0) {
    return;
  }
  /** @type {Array<{ name: string, writtenAt: number, bytes: number }>} */
  const captures = [];
  try {
    for (const name of await readdir(dir)) {
      if (!isWitnessCapture(name)) {
        continue;
      }
      try {
        const info = await stat(path.join(dir, name));
        if (info.isFile()) {
          captures.push({ name, writtenAt: info.mtimeMs, bytes: info.size });
        }
      } catch {
        // silent-ok: vanished between listing and reading.
      }
    }
  } catch {
    return; // No such directory, or unreadable. Nothing to tidy.
  }
  if (captures.length === 0) {
    return;
  }
  const doomed = dumpsToRemove(captures, keep);
  const freed = captures
    .filter((capture) => doomed.includes(capture.name))
    .reduce((total, capture) => total + capture.bytes, 0);
  for (const name of doomed) {
    try {
      await rm(path.join(dir, name), { force: true });
    } catch {
      // silent-ok: best effort, retried at the next start.
    }
  }
  const keptBytes = captures
    .filter((capture) => !doomed.includes(capture.name))
    .reduce((total, capture) => total + capture.bytes, 0);
  if (freed > 0 || captures.length > keep) {
    logLine(
      `packet witness: ${captures.length} capture(s) present, keeping the newest ${Math.min(keep, captures.length)}, ` +
      `removed ${doomed.length} (${(freed / 1024).toFixed(1)} KB), keeping ${(keptBytes / 1024).toFixed(1)} KB`
    );
  }
}

/**
 * Turn ring files left by a previous process into evidence, at startup.
 *
 * The ring is scratch while a process lives, but a process that was KILLED —
 * which the crash family of roadmap item 1 does regularly, seven times in a
 * fortnight — leaves behind the last seconds it recorded, and those seconds
 * contain the death. Renaming them under a name the pruner recognises keeps
 * them; without this the next viewer's first channel would delete them before
 * anyone had looked.
 *
 * @param {string} dir
 * @returns {Promise<string[]>} Names of the files adopted.
 */
export async function adoptOrphanRingFiles(dir) {
  if (typeof dir !== "string" || dir.length === 0) {
    return [];
  }
  /** @type {string[]} */
  const adopted = [];
  let names;
  try {
    names = (await readdir(dir)).filter((name) => isWitnessRingFile(name)).sort();
  } catch {
    return adopted;
  }
  if (names.length === 0) {
    return adopted;
  }
  const stampSeconds = Math.floor(Date.now() / 1000);
  for (const name of names) {
    const suffix = name.slice(WITNESS_RING_BASENAME.length) || "0";
    const target = `packet-witness.orphan.${stampSeconds}.before${suffix}.pcap`;
    try {
      await rename(path.join(dir, name), path.join(dir, target));
      adopted.push(target);
    } catch {
      // silent-ok: unreadable or already gone.
    }
  }
  if (adopted.length > 0) {
    logLine(
      `packet witness: ${adopted.length} ring file(s) survived the previous process and were kept ` +
      `as ${adopted.join(", ")} — whatever ended it is in them`
    );
  }
  return adopted;
}

/**
 * The logger handed to {@linkcode createPacketWitness}; module-level so the
 * pruner can speak without an options bag threaded everywhere.
 *
 * @type {(message: string) => void}
 */
let logLine = () => {};

/**
 * Create the witness.
 *
 * @param {Object} options
 * @param {(message: string) => void} options.log - Log sink (the shared logger).
 * @param {string} [options.dir]   - Where captures go; empty means os.tmpdir().
 * @param {number} options.port    - The WebRTC UDP port to filter on.
 * @param {typeof spawn} [options.spawnProcess] - Seam for tests; defaults to node's spawn.
 * @returns {{
 *   dir: string,
 *   maybeCapture: (trigger: WitnessTrigger) => boolean,
 *   holdRing: () => void,
 *   releaseRing: () => void
 * }}
 */
export function createPacketWitness({ log, dir = "", port, spawnProcess = spawn }) {
  logLine = typeof log === "function" ? log : logLine;
  const resolvedDir = typeof dir === "string" && dir.length > 0 ? dir : os.tmpdir();

  /** @type {{ running: boolean, lastStartedAt: number, availability: "unknown" | "yes" | "no" }} */
  const state = { running: false, lastStartedAt: 0, availability: "unknown" };

  /**
   * Ask whether tcpdump exists at all — once per process, whichever way it
   * answers. A host without it gets exactly one log line, ever.
   *
   * @returns {Promise<boolean>}
   */
  const probeAvailability = () =>
    new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      try {
        const probe = spawnProcess("tcpdump", ["--version"], { stdio: "ignore" });
        probe.on("error", () => done(false));
        probe.on("spawn", () => done(true));
        probe.on("close", () => done(true));
      } catch {
        done(false);
      }
    });

  /**
   * Keep the ring's history: stop it, copy its files, start it again.
   *
   * This is the half of the evidence the earlier version never had — the
   * seconds BEFORE the freeze. Stopping first is not tidiness: tcpdump buffers,
   * so the newest packets are only on disk once it has been asked to finish,
   * and the file it is currently writing is the one that holds the onset. The
   * gap this leaves is a fraction of a second, and the tail capture that
   * follows covers everything after it.
   *
   * @param {WitnessTrigger} trigger
   * @param {number} stampSeconds - Shared with the tail, so the pair sorts together.
   * @returns {Promise<string[]>} Names of the copies that landed.
   */
  const preserveRing = async (trigger, stampSeconds) => {
    /** @type {string[]} */
    const kept = [];
    ring.preserving = true;
    try {
      await stopRingProcess();
      let names;
      try {
        names = (await readdir(resolvedDir)).filter((name) => isWitnessRingFile(name)).sort();
      } catch {
        return kept;
      }
      for (const name of names) {
        const suffix = name.slice(WITNESS_RING_BASENAME.length) || "0";
        const target = `packet-witness.${trigger.tag}.${stampSeconds}.before${suffix}.pcap`;
        try {
          await copyFile(path.join(resolvedDir, name), path.join(resolvedDir, target));
          kept.push(target);
        } catch {
          // silent-ok: nothing to copy, or it vanished under us.
        }
      }
      return kept;
    } finally {
      ring.preserving = false;
      // Back to recording, unless everyone has gone in the meantime.
      if (ring.holders > 0) {
        await startRingProcess();
      } else {
        await clearRingFiles();
      }
    }
  };

  /**
   * Run one bounded capture and report what it wrote.
   *
   * @param {WitnessTrigger} trigger
   * @param {string} address - Validated remote IP literal.
   * @param {number} stampSeconds
   * @returns {Promise<void>}
   */
  const runCapture = async (trigger, address, stampSeconds) => {
    const prefix = path.join(
      resolvedDir,
      `packet-witness.${trigger.tag}.${stampSeconds}.tail.pcap`
    );
    const args = buildTcpdumpArgs({
      host: address,
      port,
      filePrefix: prefix,
      fileMegabytes: WITNESS_TAIL_FILE_MB,
      files: WITNESS_TAIL_FILES
    });
    logLine(
      `packet witness: capturing ${WITNESS_TAIL_SECONDS}s of udp port ${port} ↔ ${address} ` +
      `(session ${trigger.tag}, "${trigger.label}" queue ${trigger.queuedBytes}B wedged ` +
      `${Math.round(trigger.stuckForMs / 1000)}s; ${WITNESS_TAIL_SECONDS}s is three times ` +
      `usrsctp's ${WITNESS_RTO_CEILING_SECONDS}s retransmission ceiling, so a zero-window ` +
      `probe cannot hide inside it) → ${prefix}`
    );
    await new Promise((resolve) => {
      /** @type {ReturnType<typeof setTimeout> | null} */
      let killer = null;
      /** @type {NodeJS.Timeout | null} */
      let hardKill = null;
      let child;
      try {
        child = spawnProcess("tcpdump", args, { stdio: "ignore" });
      } catch (error) {
        logLine(`packet witness: could not start tcpdump: ${error?.message ?? error}`);
        resolve();
        return;
      }
      const finish = () => {
        if (killer) {
          clearTimeout(killer);
          killer = null;
        }
        if (hardKill) {
          clearTimeout(hardKill);
          hardKill = null;
        }
        resolve();
      };
      child.on("error", (error) => {
        state.availability = "no";
        logLine(`packet witness: tcpdump failed to run: ${error?.message ?? error}`);
        finish();
      });
      child.on("close", (code, signal) => {
        logLine(
          `packet witness: capture ended${signal ? ` (${signal})` : ` (exit ${code ?? "?"})`}`
        );
        finish();
      });
      killer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        hardKill = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }, WITNESS_KILL_GRACE_MS);
      }, WITNESS_TAIL_SECONDS * 1000);
    });
    // Say what landed on disk, so whoever reads the log later knows whether
    // the evidence exists without listing the directory themselves.
    try {
      const names = (await readdir(resolvedDir)).filter((name) => isWitnessCapture(name));
      const mine = [];
      for (const name of names) {
        if (!name.startsWith(path.basename(prefix))) {
          continue;
        }
        try {
          const info = await stat(path.join(resolvedDir, name));
          mine.push(`${name} ${(info.size / 1024).toFixed(1)} KB`);
        } catch { /* gone between listing and reading */ }
      }
      logLine(`packet witness: wrote ${mine.length} file(s): ${mine.join(", ") || "none"}`);
    } catch {
      logLine("packet witness: could not list the capture directory");
    }
  };

  /**
   * Start a capture for this trigger, if the rules allow one.
   *
   * @param {WitnessTrigger} trigger
   * @returns {boolean} True when a capture actually started.
   */
  const maybeCapture = (trigger) => {
    const address = normalizeRemoteAddress(trigger?.remote?.address);
    const portNumber = trigger?.remote?.port;
    if (!address || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      return false;
    }
    if (!shouldStartCapture(state)) {
      return false;
    }
    state.running = true;
    state.lastStartedAt = Date.now();
    const startedAt = state.lastStartedAt;
    void (async () => {
      try {
        if (state.availability === "unknown") {
          state.availability = (await probeAvailability()) ? "yes" : "no";
        }
        if (state.availability === "no") {
          logLine(
            "packet witness: unavailable — no tcpdump on this host; " +
            "the stuck-queue log lines remain the only evidence here"
          );
          return;
        }
        const stampSeconds = Math.floor(Date.now() / 1000);
        const before = await preserveRing(trigger, stampSeconds);
        logLine(
          before.length > 0
            ? `packet witness: kept ${before.length} ring file(s) from before the wedge: ${before.join(", ")}`
            : "packet witness: no ring history to keep — the ring was not running"
        );
        await runCapture(trigger, address, stampSeconds);
        // The disk bound has to hold between restarts too: one episode writes
        // up to four ring copies and two tail files, and the cooldown allows
        // six episodes an hour. Pruning only at startup let that accumulate.
        await pruneWitnessCaptures(resolvedDir);
      } finally {
        state.running = false;
        // Keep the requested spacing honest even when the capture ended early.
        const earliestNext = startedAt + WITNESS_COOLDOWN_MS;
        if (state.lastStartedAt < earliestNext) {
          state.lastStartedAt = earliestNext;
        }
      }
    })();
    return true;
  };

  /**
   * The rolling ring: one tcpdump, reference-counted by open data channels.
   *
   * @type {{
   *   child: import('node:child_process').ChildProcess | null,
   *   holders: number,
   *   starting: boolean,
   *   preserving: boolean,
   *   failed: boolean
   * }}
   */
  const ring = { child: null, holders: 0, starting: false, preserving: false, failed: false };

  /**
   * Delete the ring's own files.
   *
   * Refused while a wedge is copying them out: the copies are the only reason
   * the ring exists, and the viewer closing the tab is exactly when both happen
   * at once. Deferred until the copy is done instead.
   *
   * @returns {Promise<void>}
   */
  const clearRingFiles = async () => {
    if (ring.preserving) {
      return;
    }
    try {
      for (const name of await readdir(resolvedDir)) {
        if (isWitnessRingFile(name)) {
          await rm(path.join(resolvedDir, name), { force: true });
        }
      }
    } catch {
      // silent-ok: best effort, retried when the ring next stops.
    }
  };

  /**
   * Stop the ring's tcpdump and wait for it to flush and exit.
   *
   * The wait matters. tcpdump buffers its output, so the newest packets — the
   * ONSET, which is the whole reason the ring runs — sit in that buffer until
   * the process is asked to finish. `-U` would flush per packet instead, at one
   * write syscall per packet, and at the measured 150 Mbps that is twelve
   * thousand a second on a machine whose spare capacity is already the binding
   * constraint. Stopping costs nothing while nothing is wrong.
   *
   * @returns {Promise<void>}
   */
  const stopRingProcess = () => {
    const child = ring.child;
    ring.child = null;
    if (!child) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          clearTimeout(hardKill);
          resolve();
        }
      };
      const hardKill = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        done();
      }, WITNESS_KILL_GRACE_MS);
      if (typeof hardKill.unref === "function") {
        hardKill.unref();
      }
      child.on("close", done);
      child.on("error", done);
      try {
        child.kill("SIGTERM");
      } catch {
        done();
      }
    });
  };

  /**
   * Start the ring's tcpdump, if it is wanted and not already running.
   *
   * @returns {Promise<void>}
   */
  const startRingProcess = async () => {
    if (ring.child !== null || ring.starting || ring.holders === 0) {
      return;
    }
    ring.starting = true;
    try {
      if (state.availability === "unknown") {
        state.availability = (await probeAvailability()) ? "yes" : "no";
      }
      // Everything above suspended; the last channel may have closed meanwhile.
      // Without this second look the ring starts with nobody holding it and
      // nobody left to stop it.
      if (state.availability === "no" || ring.holders === 0) {
        return;
      }
      const prefix = path.join(resolvedDir, WITNESS_RING_BASENAME);
      const args = buildTcpdumpArgs({ port, filePrefix: prefix });
      let child;
      try {
        child = spawnProcess("tcpdump", args, { stdio: "ignore" });
      } catch (error) {
        ring.failed = true;
        logLine(`packet witness: the ring could not start: ${error?.message ?? error}`);
        return;
      }
      ring.child = child;
      child.on("error", (error) => {
        ring.failed = true;
        if (ring.child === child) {
          ring.child = null;
        }
        logLine(`packet witness: the ring stopped: ${error?.message ?? error}`);
      });
      child.on("close", (code, signal) => {
        if (ring.child !== child) {
          return; // An orderly stop; it has already said what it needed to.
        }
        ring.child = null;
        ring.failed = true;
        // Ending on its own means it never recorded what it claimed to. A host
        // with tcpdump installed but without the capability to capture answers
        // `--version` happily and dies here, which would otherwise leave a
        // "ring recording" line in the log and no history behind it.
        logLine(
          `packet witness: the ring ended on its own${signal ? ` (${signal})` : ` (exit ${code ?? "?"})`}` +
          `${ring.holders > 0 ? " while a viewer was still being served — no history is being kept" : ""}`
        );
      });
      logLine(
        `packet witness: ring recording udp port ${port}, ` +
        `${WITNESS_RING_FILES} × ${WITNESS_RING_FILE_MB} MB wrapping — ` +
        "the seconds before a freeze, kept in advance"
      );
    } finally {
      ring.starting = false;
      // Holders may have gone while the probe or the spawn was in flight.
      if (ring.holders === 0 && ring.child !== null) {
        await stopRingProcess();
        await clearRingFiles();
      }
    }
  };

  /**
   * Begin recording, or note one more reason to keep recording.
   *
   * Reference-counted by open data channels, so the ring runs exactly while a
   * viewer is being served and costs nothing on an idle proxy. Starting it is
   * what makes the ONSET of a freeze readable: by the time a wedge is declared,
   * the seconds before it are already on disk.
   *
   * @returns {void}
   */
  const holdRing = () => {
    ring.holders += 1;
    if (ring.holders !== 1) {
      return;
    }
    void startRingProcess();
  };

  /**
   * Release one reason to keep recording; the last one stops the ring.
   *
   * @returns {void}
   */
  const releaseRing = () => {
    if (ring.holders > 0) {
      ring.holders -= 1;
    }
    if (ring.holders > 0 || ring.starting) {
      return;
    }
    void (async () => {
      await stopRingProcess();
      await clearRingFiles();
    })();
  };

  /**
   * Stop everything this witness owns. For process shutdown.
   *
   * @returns {Promise<void>}
   */
  const dispose = async () => {
    ring.holders = 0;
    await stopRingProcess();
    await clearRingFiles();
  };

  return { dir: resolvedDir, maybeCapture, holdRing, releaseRing, dispose, ring };

}
