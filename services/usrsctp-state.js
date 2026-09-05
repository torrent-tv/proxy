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
 * **THIS STOPS THE PRODUCT WHILE IT WORKS, so it is off unless asked for.**
 * `gdb` attaches with ptrace and pauses every thread of this process for as
 * long as it is attached. The manual procedure this automates took a fraction
 * of a second; on 2026-09-05 the automatic one held the proxy for four minutes
 * and the viewer was told the proxy had sent no video. Two things follow, and
 * both are in the code below: the deadline is counted by a separate process,
 * because a timer inside a stopped process never fires; and `--usrsctp-state`
 * has to be given for any of this to happen at all.
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
            // THE DEADLINE IS SET OUTSIDE THE PROCESS THAT IS BEING STOPPED.
            //
            // gdb attaches with ptrace and stops every thread of this process
            // while it works — including whichever one would have counted the
            // seconds. The guard below used to be a `setTimeout` here, and on
            // 2026-09-05 it did not fire: gdb held the proxy for four minutes,
            // the log ended mid-second and the viewer was told the proxy had
            // sent no video. `timeout` is a separate process and keeps counting
            // whatever happens to this one.
            child = spawnProcess(
              "timeout",
              [
                "-s",
                "KILL",
                String(Math.ceil(GDB_TIMEOUT_MS / 1000)),
                "gdb",
                "-q",
                "-batch",
                "-p",
                String(pid),
                "-x",
                scriptPath
              ],
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
          // A second guard, for the case where `timeout` itself is not on the
          // host: it can only fire while this process is running, which is
          // exactly what cannot be relied on here, so it is a backstop and not
          // the deadline.
          const killer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // already gone
            }
          }, GDB_TIMEOUT_MS * 2);
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
