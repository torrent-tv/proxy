/**
 * @file A real `EncodeRun` over a process that is not real.
 *
 * Tests used to set a session's process fields by hand — `session.ffmpeg`,
 * `session.runState`, `session.encodeStartIndex` — which is how a test can pass
 * over code that no longer works: the fields were the thing under test as much
 * as the behaviour was. A run is an object now, so a test builds the object the
 * product builds and injects only the one thing a test may not have, which is a
 * child process.
 *
 * The pid is deliberately absent unless a test asks for one. `pause` and
 * `resume` send signals by pid, and a made-up number is somebody else's process
 * on the machine running the tests.
 */

import { EncodeRun } from "../../services/encode/EncodeRun.js";

/**
 * A child process that records what was done to it.
 *
 * @param {object} [options]
 * @param {number | null} [options.pid] - Only where a test genuinely exercises
 *   suspend or resume, and then it must be this process's own.
 * @returns {object}
 */
export function fakeProcess({ pid = null, exitsWhenKilled = true } = {}) {
  /** @type {Map<string, (...args: unknown[]) => void>} */
  const listeners = new Map();
  return {
    pid,
    killed: false,
    exitCode: null,
    signalCode: null,
    /** Every signal it was sent, in order. */
    signals: [],
    stdout: { on() {} },
    stderr: { on() {} },
    on(event, handler) {
      const kept = listeners.get(event) ?? [];
      kept.push(handler);
      listeners.set(event, kept);
      return this;
    },
    once(event, handler) {
      return this.on(event, handler);
    },
    kill(signal = "SIGTERM") {
      this.signals.push(signal);
      this.killed = true;
      // A real process answers a signal by exiting, and it does so on a later
      // turn. A fake that never exits makes every disposal wait out the grace
      // period, which is two seconds a test spends proving nothing.
      if (exitsWhenKilled && this.exitCode === null && this.signalCode === null) {
        queueMicrotask(() => this.exit(null, signal));
      }
      return true;
    },
    /**
     * Report an exit, as the real thing would.
     *
     * @param {number | null} code
     * @param {string | null} [signal]
     */
    exit(code, signal = null) {
      this.exitCode = code;
      this.signalCode = signal;
      for (const handler of listeners.get("exit") ?? []) {
        handler(code, signal);
      }
    }
  };
}

/** A logger that says nothing, for tests that are not about the log. */
export const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * Put a run on a session, started, over a fake process.
 *
 * @param {object} session - The session under test.
 * @param {object} [options]
 * @param {number} [options.from] - First segment number it is making.
 * @param {number} [options.to] - Last, inclusive; below `from` means no end.
 * @param {object} [options.process] - The process it should own.
 * @param {boolean} [options.producing] - Whether it has already made its first
 *   segment, which is what moves it out of starting.
 * @param {number | null} [options.lastSegmentIndex] - The film's last number,
 *   for telling a finished file from an input that dried up.
 * @param {string} [options.id]
 * @param {boolean} [options.usesExplicitCuts]
 * @returns {import("../../services/encode/EncodeRun.js").EncodeRun}
 */
export function startRunOn(session, options = {}) {
  const {
    from = 0,
    to = -1,
    process: child = fakeProcess(),
    producing = true,
    lastSegmentIndex = null,
    id = `${session.id ?? "session"}/run#1`,
    usesExplicitCuts = false
  } = options;
  const run = new EncodeRun({
    id,
    address: session.outputKey ?? session.id ?? "output",
    encoder: { name: "libx264", kind: "software" },
    from,
    to,
    dirPath: session.dirPath ?? "",
    buildArgs: () => [],
    spawn: () => child,
    logger: silentLogger,
    lastSegmentIndex: () => lastSegmentIndex,
    usesExplicitCuts
  });
  run.start("a test asked for it");
  if (producing) {
    // What moves a run out of starting is its first segment, in the product as
    // here — so a run that is producing has made one, and its head stands one
    // past where it began. `from` is still where it started, which is what a
    // test asserting a run's position asks for.
    run.noteProduced(from);
  }
  session.run = run;
  return run;
}
