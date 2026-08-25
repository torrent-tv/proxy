/**
 * @file Automatic packet witness for a send queue that stops draining.
 *
 * Roadmap item 10, occurrence 2026-08-24 (`research/dead-channel-2026-08-24.md`):
 * the proxy counted bytes as sent that never reached the viewer's SCTP stack,
 * and every counter above the wire reported success for 88 minutes. The two
 * candidate causes separate by ONE look at the packets — repeated duplicate
 * SACKs naming a missing TSN with no retransmission (usrsctp retransmit
 * defect) versus SACKs advertising `a_rwnd=0` with no gaps (receiver stopped
 * reading). Occurrences are rare and unpredictable, so the witness fires by
 * itself: a send queue wedged longer than ~30 s starts a bounded tcpdump on
 * the WebRTC UDP port filtered to that session's remote address, writes a few
 * small rotating files, and stops. Where no tcpdump exists the whole thing
 * degrades to a single log line.
 *
 * Bounded three ways so it can never cost more than an episode is worth: the
 * process is killed after {@linkcode WITNESS_CAPTURE_SECONDS} plus grace; the
 * ring keeps at most {@linkcode WITNESS_RING_FILES} files of
 * {@linkcode WITNESS_ROTATE_SECONDS} each; and one capture runs at a time,
 * with a cooldown before the next. Captures land beside the core dumps
 * (`--state-dir`) and are pruned at startup the same way.
 */

import { spawn } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dumpsToRemove } from "./core-dumps.js";

/** Per-packet capture length. Small: headers are what the signatures need. */
export const WITNESS_SNAPLEN_BYTES = 128;

/** One rotation step of the ring, in seconds. */
export const WITNESS_ROTATE_SECONDS = 30;

/** How many rotation steps stay on disk (30 s × 4 = 120 s of evidence). */
export const WITNESS_RING_FILES = 4;

/** Total wall-clock bound on one capture, seconds. */
export const WITNESS_CAPTURE_SECONDS = WITNESS_ROTATE_SECONDS * WITNESS_RING_FILES;

/** Extra time before the SIGKILL fallback lands on a hanging tcpdump. */
export const WITNESS_KILL_GRACE_MS = 5_000;

/** Minimum spacing between captures, whatever the reason for them. */
export const WITNESS_COOLDOWN_MS = 10 * 60_000;

/** How many old captures survive at startup, newest first. */
export const WITNESS_CAPTURES_KEPT = 4;

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
 * The tcpdump command line for one bounded capture.
 *
 * `-i any` covers hosts where the UDP mux socket is not on a named interface;
 * `-n` keeps DNS out of the hot path; `-S` prints absolute sequence numbers so
 * duplicate SACKs across file rotations compare equal by eye.
 *
 * @param {Object} parts
 * @param {string} parts.host          - Validated IP literal.
 * @param {number} parts.port          - The WebRTC UDP port.
 * @param {string} parts.filePrefix    - Path prefix; tcpdump appends timestamps.
 * @param {number} [parts.snaplen]     - Bytes per packet to store.
 * @param {number} [parts.rotateSeconds]
 * @param {number} [parts.ringFiles]
 * @returns {string[]}
 */
export function buildTcpdumpArgs({
  host,
  port,
  filePrefix,
  snaplen = WITNESS_SNAPLEN_BYTES,
  rotateSeconds = WITNESS_ROTATE_SECONDS,
  ringFiles = WITNESS_RING_FILES
}) {
  return [
    "-n",
    "-S",
    "-s",
    String(snaplen),
    "-i",
    "any",
    "-w",
    filePrefix,
    "-G",
    String(rotateSeconds),
    "-W",
    String(ringFiles),
    "udp",
    "and",
    "host",
    host,
    "and",
    "port",
    String(port)
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
 * @returns {{ dir: string, maybeCapture: (trigger: WitnessTrigger) => boolean }}
 */
export function createPacketWitness({ log, dir = "", port }) {
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
        const probe = spawn("tcpdump", ["--version"], { stdio: "ignore" });
        probe.on("error", () => done(false));
        probe.on("spawn", () => done(true));
        probe.on("close", () => done(true));
      } catch {
        done(false);
      }
    });

  /**
   * Run one bounded capture and report what it wrote.
   *
   * @param {WitnessTrigger} trigger
   * @param {string} address - Validated remote IP literal.
   * @returns {Promise<void>}
   */
  const runCapture = async (trigger, address) => {
    const prefix = path.join(
      resolvedDir,
      `packet-witness.${trigger.tag}.${Math.floor(Date.now() / 1000)}.pcap`
    );
    const args = buildTcpdumpArgs({ host: address, port, filePrefix: prefix });
    logLine(
      `packet witness: capturing ${WITNESS_CAPTURE_SECONDS}s of udp port ${port} ↔ ${address} ` +
      `(session ${trigger.tag}, "${trigger.label}" queue ${trigger.queuedBytes}B wedged ` +
      `${Math.round(trigger.stuckForMs / 1000)}s) → ${prefix}`
    );
    await new Promise((resolve) => {
      /** @type {ReturnType<typeof setTimeout> | null} */
      let killer = null;
      /** @type {NodeJS.Timeout | null} */
      let hardKill = null;
      let child;
      try {
        child = spawn("tcpdump", args, { stdio: "ignore" });
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
      }, WITNESS_CAPTURE_SECONDS * 1000);
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
        await runCapture(trigger, address);
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

  return { dir: resolvedDir, maybeCapture };
}
