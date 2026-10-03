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
 * The fake has a pid, as a started process does: a run signals only a process
 * that started. The number is never used to signal anything — every signal goes
 * through the child object, and this one records it.
 */

import { EncodeRun } from "../../services/encode/EncodeRun.js";

/** The working time between two closed pieces of a test measurement. */
const MEASURED_STEP_MS = 1000;

/** Closed pieces in a test measurement: the last two give the reading. */
const MEASURED_STEPS = 3;

/**
 * The clock each run built by `startRunOn` reads: standing while a measurement
 * is said, the wall clock otherwise. @type {WeakMap<EncodeRun, { at: number | null }>}
 */
const wallClocks = new WeakMap();

/**
 * Make a run measure a speed the way it does in the product: progress reports
 * and the names of closed pieces on the encoder's own channels, one second of
 * the run's own work apart. A closed piece is published when the next name
 * arrives, and each publication is one reading against the one before, so the
 * last of three steps reads exactly `speedX` whatever the run measured before.
 *
 * @param {EncodeRun} run - Its process exposes `stdout` and `stdio[3]`.
 * @param {number} speedX - Film seconds per second of the run's work.
 * @param {{ at: number } | null} [clock] - What the run's `now` reads; advanced
 *   here. Absent for a run built by `startRunOn` without one: its clock is
 *   stood just behind the wall clock for the measurement and released after,
 *   so the reading is dated now.
 * @param {number} [waitedMs] - How long the run's input waits for the swarm in
 *   each step, on top of its second of work.
 * @returns {void}
 */
export function measureSpeed(run, speedX, clock = null, waitedMs = 0) {
  if (clock === null) {
    const wall = wallClocks.get(run);
    if (!wall) {
      throw new TypeError("measureSpeed needs the clock the run reads");
    }
    // Never behind the run's start or its own last reading: a step back in
    // time is no work.
    wall.at = Math.max(
      Date.now() - (MEASURED_STEP_MS + waitedMs) * MEASURED_STEPS,
      run.startedAt,
      run.speedReading?.at ?? Number.NEGATIVE_INFINITY
    );
    measureSpeed(run, speedX, wall, waitedMs);
    wall.at = null;
    return;
  }
  const { stdout, stdio } = run.process;
  let produced = run.progress.processedSeconds - run.progress.startPositionSeconds;
  for (let step = 0; step < MEASURED_STEPS; step += 1) {
    if (waitedMs > 0) {
      run.inputWaitBegins();
      clock.at += waitedMs;
      run.inputWaitEnds();
    }
    clock.at += MEASURED_STEP_MS;
    produced += (speedX * MEASURED_STEP_MS) / 1000;
    say(stdout, `out_time_ms=${Math.round(produced * 1_000_000)}\n`);
    say(stdio[3], `measured-${step}\n`);
  }
}

/**
 * @param {{ write?: (text: string) => void, emit?: (event: string, text: string) => void }} channel
 * @param {string} text
 */
function say(channel, text) {
  if (typeof channel.write === "function") {
    channel.write(text);
  } else {
    channel.emit("data", text);
  }
}

/**
 * A child process that records what was done to it.
 *
 * @param {object} [options]
 * @param {number | null} [options.pid] - Null for a process that did not start.
 * @returns {object}
 */
export function fakeProcess({ pid = 4242, exitsWhenKilled = true } = {}) {
  /** @type {Map<string, (...args: unknown[]) => void>} */
  const listeners = new Map();
  const stdout = channel();
  const closedPieces = channel();
  return {
    pid,
    killed: false,
    exitCode: null,
    signalCode: null,
    /** Every signal it was sent, in order. */
    signals: [],
    stdout,
    stderr: { on() {} },
    // The descriptor the encoder names its closed pieces on (`-segment_list pipe:3`).
    stdio: [null, stdout, null, closedPieces],
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
      // Suspending and continuing are not ends.
      if (signal === "SIGSTOP" || signal === "SIGCONT") {
        return true;
      }
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
      // A real child process emits `close` after `exit`, once its stdio has
      // closed, and the run takes its ending from `close`.
      for (const handler of listeners.get("close") ?? []) {
        handler(code, signal);
      }
    }
  };
}

/**
 * A readable side of a pipe that a test writes into.
 *
 * @returns {{ on: (event: string, handler: (chunk: string) => void) => void, write: (text: string) => void }}
 */
function channel() {
  /** @type {((chunk: string) => void)[]} */
  const handlers = [];
  return {
    on(event, handler) {
      if (event === "data") handlers.push(handler);
    },
    write(text) {
      for (const handler of handlers) handler(text);
    }
  };
}

/** A logger that says nothing, for tests that are not about the log. */
export const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * Add a run to a session, started, over a fake process.
 *
 * A session holds a SET of runs — as many as the machine affords — so a test
 * that wants two heads on one output calls this twice.
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
    usesExplicitCuts = false,
    // THE SPEED IT HAS MEASURED: film made over its own working time between
    // two closed pieces. Left at zero, the plan has no speed to compute an
    // arrival from, every arrangement of encoders is equally hopeless, they all
    // tie, and the encoder is taken away for changing nothing.
    speedX = 0,
    // What the run reads as now, for a test that drives time itself. Absent,
    // the run reads the wall clock, which stands still only while a
    // measurement is said.
    clock: given = null
  } = options;
  const clock = given ?? { at: null };
  const run = new EncodeRun({
    address: session.outputKey ?? session.id ?? "output",
    encoder: { name: "libx264", kind: "software" },
    from,
    to,
    buildArgs: () => [],
    spawn: () => child,
    logger: silentLogger,
    lastSegmentIndex: () => lastSegmentIndex,
    usesExplicitCuts,
    now: () => clock.at ?? Date.now(),
    because: "a test asked for it"
  });
  if (given === null) {
    wallClocks.set(run, clock);
  }
  if (speedX > 0) {
    measureSpeed(run, speedX, given);
  }
  if (producing) {
    // What moves a run out of starting is its first segment, in the product as
    // here — so a run that is producing has made one, and its head stands one
    // past where it began. `from` is still where it started, which is what a
    // test asserting a run's position asks for.
    run.noteProduced(from);
  }
  if (!(session.runs instanceof Set)) {
    session.runs = new Set();
  }
  session.runs.add(run);
  return run;
}
