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
 * One turn holds a few hours of a busy session at the current rate; two turns
 * therefore cover a night's worth of restarts, which is the span a morning
 * report asks about. Bounded because the addon's `/data` is the owner's disk.
 */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** @type {import("node:fs").WriteStream | null} */
let fileStream = null;
/** @type {string} */
let filePath = "";
let writtenBytes = 0;

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
  info: (message) => {
    const line = `${PREFIX} [${ts()}] ${message}`;
    console.log(chalk.cyan(line));
    toFile(line);
  },
  success: (message) => {
    const line = `${PREFIX} [${ts()}] ${message}`;
    console.log(chalk.green(line));
    toFile(line);
  },
  warn: (message) => {
    const line = `${PREFIX} [${ts()}] ${message}`;
    console.warn(chalk.yellow(line));
    toFile(line);
  },
  error: (message) => {
    const line = `${PREFIX} [${ts()}] ${message}`;
    console.error(chalk.red(line));
    toFile(line);
  }
};
