/**
 * @file Centralised logger for the proxy process — to the console always, and
 * to a file when one is named.
 *
 * All messages are prefixed with `[proxy-client]` and coloured with chalk for
 * consistent, readable terminal output.
 *
 * **Why a file at all.** The console is the container's stdout, and the
 * container does not survive what we most need to read about. On 2026-08-18 the
 * proxy died thirteen times with SIGSEGV; each death had Home Assistant's
 * watchdog RECREATE the container, and every line leading up to the crash went
 * with it. The same day a deploy of ours destroyed the evidence for two field
 * reports that were being investigated at the time. A log that disappears
 * exactly when something goes wrong is not a log, and no amount of care in
 * choosing what to print compensates for it.
 *
 * The file is opt-in and named by the caller (`--log-file`), so nothing here
 * assumes Home Assistant or any other host: the addon points it at `/data`,
 * which survives restarts and updates, and a bare npm or Docker run may point
 * it anywhere or leave it off.
 */

import { createWriteStream, renameSync, statSync } from "node:fs";
import chalk from "chalk";

const PREFIX = "[proxy-client]";
/**
 * When the file is rotated, and how many turns are kept.
 *
 * **Why it is this large.** It was 32 MiB, and that erased the beginning of
 * the very failure it was needed for. Field 2026-09-12: a session froze at
 * 17:20 and printed one established fact about 55 times a second, so the file
 * turned over twice before the session ended — 159 000 lines covering
 * 17:51-18:29, then 76 385 covering 18:29-18:52. Sixty-one minutes was all
 * that survived of ninety-two, and the second rotation overwrote the turn that
 * held the onset. The disk it is bounded for had 91.4 GB free at the time.
 *
 * The repetition is a separate fault and is being fixed separately; a log that
 * cannot hold a session either way is the one that has to go first.
 */
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

/** @type {import("node:fs").WriteStream | null} */
let fileStream = null;
/** @type {string} */
let filePath = "";
let writtenBytes = 0;
/**
 * Where lines go when this module is running in a worker thread.
 *
 * A worker thread is a separate instance of the runtime: it loads its own copy
 * of every module, so `fileStream` above is a DIFFERENT variable there, and
 * `logToFile` is only ever called on the main thread. The result was silent:
 * measured 2026-09-02 over a whole log file of 49 938 lines, every line the
 * torrent thread wrote through this module — the piece reader's, including the
 * comparison of the two claim strategies that had been awaited for weeks, and
 * the torrent pool's — was absent, while the same lines were visible in the
 * container's output, which is destroyed by every release.
 *
 * Two threads cannot both write the file: they would race on the rotation and
 * could interleave mid-line. So there is one writer, and a worker sends its
 * lines to it. Set by the worker at startup; unset on the main thread, where
 * the file is written directly.
 *
 * @type {((level: string, message: string) => void) | null}
 */
let forward = null;

/**
 * Send this thread's log lines to the thread that owns the file.
 *
 * Called by a worker at startup. Until it is, a worker's lines reach the
 * console and nothing else — which is what they did for as long as this module
 * has existed.
 *
 * @param {((level: string, message: string) => void) | null} sink
 * @returns {void}
 */
export function forwardLogsTo(sink) {
  forward = typeof sink === "function" ? sink : null;
}

/**
 * Return the current time as a compact ISO-8601 (UTC) string, e.g.
 * `12:34:56.789`. UTC is used deliberately so proxy and browser logs share the
 * same timezone and line up exactly when correlating them.
 *
 * @returns {string}
 */
function ts() {
  return new Date().toISOString().slice(11, 23); // "HH:MM:SS.mmm" (UTC)
}

/**
 * Start writing every message to a file as well as the console.
 *
 * Appends: a restart must not erase what led up to it, which is the entire
 * reason this exists. Failures are reported once and then ignored — a proxy
 * that cannot write its log still has a viewer to serve.
 *
 * @param {string} pathToFile - Empty or absent leaves logging console-only.
 * @returns {void}
 */
export function logToFile(pathToFile) {
  if (typeof pathToFile !== "string" || pathToFile.length === 0) {
    return;
  }
  try {
    filePath = pathToFile;
    writtenBytes = statSync(pathToFile, { throwIfNoEntry: false })?.size ?? 0;
    fileStream = createWriteStream(pathToFile, { flags: "a" });
    fileStream.on("error", (error) => {
      fileStream = null;
      console.warn(chalk.yellow(`${PREFIX} [${ts()}] log file ${pathToFile} stopped: ${error?.message}`));
    });
    console.log(chalk.cyan(`${PREFIX} [${ts()}] logging to ${pathToFile} as well as the console`));
  } catch (error) {
    fileStream = null;
    console.warn(chalk.yellow(`${PREFIX} [${ts()}] cannot log to ${pathToFile}: ${error?.message}`));
  }
}

/**
 * Write one line to the file, rotating when it has grown past the cap.
 *
 * @param {string} line
 * @returns {void}
 */
function toFile(line) {
  if (!fileStream) {
    return;
  }
  const text = `${line}\n`;
  writtenBytes += Buffer.byteLength(text);
  if (writtenBytes > MAX_FILE_BYTES) {
    try {
      fileStream.end();
      renameSync(filePath, `${filePath}.1`);
      fileStream = createWriteStream(filePath, { flags: "a" });
      writtenBytes = Buffer.byteLength(text);
    } catch {
      // Rotation failed; keep writing to whatever handle still works rather
      // than losing the line that prompted it.
    }
  }
  fileStream.write(text);
}

/**
 * @typedef {Object} ProxyLogger
 * @property {(message: string) => void} info    - Informational message (cyan).
 * @property {(message: string) => void} success - Positive outcome (green).
 * @property {(message: string) => void} warn    - Non-fatal warning (yellow).
 * @property {(message: string) => void} error   - Error condition (red).
 */

/**
 * Shared logger instance used throughout the proxy process.
 *
 * @type {ProxyLogger}
 */
export const logger = {
  info: (message) => write("info", message, chalk.cyan, console.log),
  success: (message) => write("success", message, chalk.green, console.log),
  warn: (message) => write("warn", message, chalk.yellow, console.warn),
  error: (message) => write("error", message, chalk.red, console.error)
};

/**
 * An established fact is said once, then with decreasing frequency.
 *
 * **Why.** A failure that establishes itself and does not change is printed by
 * whatever loop meets it, at that loop's own rate. Field 2026-09-12: one
 * absent piece produced 235 000 lines in 92 minutes — `Error opening input
 * file …` 8514 times, `Error opening input files: End of file` 5712, the same
 * `run-state` transition 2892, the same read failure 2884 — about 55 lines a
 * second, and it turned the log over twice so the beginning of the failure was
 * gone before anyone read it. A log is not vitiated by its size alone; it is
 * vitiated by uniformity, and a bigger file does not fix that.
 *
 * **Matched VERBATIM — the whole line, no normalisation of numbers.** Measured
 * on that log: exact repeats are 52 567 of 76 385 lines, 68.8 %, which is
 * nearly all of the flood and carries no risk at all of merging two different
 * statements. Normalising digits would catch a little more and would also merge
 * the memory series — `rss=327MB`, `rss=726MB` — which exists precisely to
 * catch a runaway, and suppressing it would be worse than the flood.
 */
const REPEAT_FIRST_MS = 1_000;
const REPEAT_MAX_MS = 60_000;
/**
 * How many distinct lines are tracked. Bounded because it is keyed by the full
 * text: a process that logs unique lines for ever must not grow a map of them.
 */
const REPEAT_KEYS = 512;
/** @type {Map<string, { suppressed: number, printedAt: number, interval: number }>} */
const recent = new Map();

/**
 * Whether this line is a repeat to hold back, and what to say if it is not.
 *
 * @param {string} message
 * @returns {{ hold: true } | { hold: false, suffix: string }}
 */
function repeatCheck(message) {
  const now = Date.now();
  const seen = recent.get(message);
  // Unseen, or not seen for longer than the longest interval — which makes it
  // news again rather than a continuing fact.
  if (!seen || now - seen.printedAt > REPEAT_MAX_MS) {
    // WHAT WAS HELD BACK IS STILL SAID. A stale entry can carry repeats that
    // were never reported — a line said just under its interval and then not
    // again for a while — and dropping the count here would be the quiet lie
    // this whole rule exists to avoid.
    const heldBack = seen?.suppressed ?? 0;
    const overMs = seen ? now - seen.printedAt : 0;
    recent.delete(message);
    if (recent.size >= REPEAT_KEYS) {
      // The least recently printed goes: `Map` keeps insertion order and every
      // print re-inserts, so the first key is the oldest.
      const oldest = recent.keys().next();
      if (!oldest.done) {
        recent.delete(oldest.value);
      }
    }
    recent.set(message, { suppressed: 0, printedAt: now, interval: REPEAT_FIRST_MS });
    return {
      hold: false,
      suffix: heldBack > 0
        ? ` [said ${heldBack} more time(s) in the last ${(overMs / 1000).toFixed(1)}s]`
        : ""
    };
  }
  if (now - seen.printedAt < seen.interval) {
    seen.suppressed += 1;
    return { hold: true };
  }
  const heldBack = seen.suppressed;
  const overMs = now - seen.printedAt;
  recent.delete(message);
  recent.set(message, {
    suppressed: 0,
    printedAt: now,
    interval: Math.min(REPEAT_MAX_MS, seen.interval * 2)
  });
  return {
    hold: false,
    // SAID, not merely hidden: the rate is the fact here, and a log that quietly
    // drops repeats reports a healthy proxy where a loop was spinning.
    suffix: heldBack > 0
      ? ` [said ${heldBack} more time(s) in the last ${(overMs / 1000).toFixed(1)}s]`
      : ""
  };
}

/**
 * One path for every level, so a line cannot reach the console and miss the
 * file depending on which method was called or which thread called it.
 *
 * @param {string} level
 * @param {string} message
 * @param {(text: string) => string} colour
 * @param {(text: string) => void} toConsole
 * @returns {void}
 */
function write(level, message, colour, toConsole) {
  const repeat = repeatCheck(message);
  if (repeat.hold) {
    return;
  }
  const line = `${message}${repeat.suffix}`;
  toConsole(colour(`${PREFIX} [${ts()}] ${line}`));
  if (forward) {
    try {
      forward(level, line);
    } catch {
      // silent-ok: a thread whose channel has closed is shutting down, and a
      // failed log line must not be what ends it.
    }
    return;
  }
  toFile(`${PREFIX} [${ts()}] ${line}`);
}
