/**
 * @file Read usrsctp's live association state, without a rebuild.
 *
 * Roadmap item 11. `node_datachannel.node` ships unstripped — it carries
 * usrsctp's own local symbols, including `system_base_info` and
 * `usrsctp_getsockopt` — so the association's real state (peer receive
 * window, pending data, retransmission timeout, congestion window) can be
 * read out of THIS live process with a short gdb attach. No source rebuild,
 * no SCTP_DEBUG image, no waiting for a packet capture to be read by eye.
 *
 * The walk (hash the association table, call `usrsctp_getsockopt` with
 * `SCTP_STATUS` through the running process) and the healthy baseline it was
 * checked against are in
 * `research/session-2026-08-27-28-freeze-onset-and-sessions.md`, section 1.
 * The script itself is bundled at {@link SCTPSTATE_SCRIPT_PATH} rather than
 * hand-placed on a host, so it ships with every release instead of surviving
 * only as long as someone remembers to copy it back after a container is
 * recreated.
 *
 * `gdb` attaching with ptrace pauses every thread of the process for the
 * duration of the read — one `getsockopt` call, measured at a fraction of a
 * second in the manual procedure this automates.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { shouldStartCapture, WITNESS_COOLDOWN_MS } from "./packet-witness.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The bundled gdb script that performs the usrsctp state walk. */
export const SCTPSTATE_SCRIPT_PATH = path.join(HERE, "..", "assets", "diagnostics", "sctpstate.gdb");

/** How long gdb may run before it is killed. Generous: this is a rare, one-shot read. */
export const GDB_TIMEOUT_MS = 15_000;

/**
 * Create the reader.
 *
 * Single-flight and cooldown-gated the same way the packet witness is
 * ({@link shouldStartCapture}) — a wedge that stays certain for minutes must
 * not spawn a fresh gdb attach on every tick, and two readings ten seconds
 * apart tell the same story a hundred readings would.
 *
 * @param {Object} options
 * @param {(message: string) => void} options.log
 * @param {typeof spawn} [options.spawnProcess] - Seam for tests.
 * @param {number} [options.pid] - Defaults to this process's own pid.
 * @param {string} [options.scriptPath]
 * @param {number} [options.cooldownMs]
 * @returns {{ maybeRead: (reasonText: string) => boolean }}
 */
export function createUsrsctpStateReader({
  log,
  spawnProcess = spawn,
  pid = process.pid,
  scriptPath = SCTPSTATE_SCRIPT_PATH,
  cooldownMs = WITNESS_COOLDOWN_MS
}) {
  /** @type {{ running: boolean, lastStartedAt: number }} */
  const state = { running: false, lastStartedAt: 0 };

  /**
   * Read the association state now, if the gating rules allow it.
   *
   * @param {string} reasonText - What declared the wedge, for the log line.
   * @returns {boolean} True when a read actually started.
   */
  const maybeRead = (reasonText) => {
    if (!shouldStartCapture({ ...state, cooldownMs })) {
      return false;
    }
    state.running = true;
    state.lastStartedAt = Date.now();
    const startedAt = state.lastStartedAt;
    void (async () => {
      let out = "";
      let err = "";
      try {
        await new Promise((resolve) => {
          let settled = false;
          let child;
          const finish = () => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(killer);
            resolve();
          };
          try {
            child = spawnProcess(
              "gdb",
              ["-q", "-batch", "-p", String(pid), "-x", scriptPath],
              { stdio: ["ignore", "pipe", "pipe"] }
            );
          } catch (error) {
            err = `could not start gdb: ${error?.message ?? error}`;
            resolve();
            return;
          }
          child.stdout?.on("data", (chunk) => {
            out += chunk.toString();
          });
          child.stderr?.on("data", (chunk) => {
            err += chunk.toString();
          });
          child.on("error", (error) => {
            err += `${err ? " " : ""}gdb error: ${error?.message ?? error}`;
            finish();
          });
          child.on("close", finish);
          const killer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // already gone
            }
          }, GDB_TIMEOUT_MS);
          if (typeof killer.unref === "function") {
            killer.unref();
          }
        });
      } finally {
        const lines = out.trim().length > 0 ? out.trim().split("\n") : [];
        if (lines.length > 0) {
          log(`usrsctp state (${reasonText}): ${lines.join(" | ")}`);
        } else {
          log(`usrsctp state (${reasonText}): no reading — ${err.trim() || "gdb produced no output"}`);
        }
        state.running = false;
        // Same spacing rule as the packet witness: honour the cooldown even
        // when the read ended quickly.
        const earliestNext = startedAt + cooldownMs;
        if (state.lastStartedAt < earliestNext) {
          state.lastStartedAt = earliestNext;
        }
      }
    })();
    return true;
  };

  return { maybeRead };
}
