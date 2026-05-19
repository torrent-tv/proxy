/**
 * @file Centralised console logger for the proxy process.
 *
 * All messages are prefixed with `[proxy-client]` and coloured with chalk
 * for consistent, readable terminal output.
 */

import chalk from "chalk";

const PREFIX = "[proxy-client]";

/**
 * Return the current time as a compact ISO-8601 string, e.g. `12:34:56.789`.
 * Uses only the time portion to keep log lines short.
 *
 * @returns {string}
 */
function ts() {
  return new Date().toISOString().slice(11, 23); // "HH:MM:SS.mmm"
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
  info:    (message) => console.log(chalk.cyan(`${PREFIX} [${ts()}] ${message}`)),
  success: (message) => console.log(chalk.green(`${PREFIX} [${ts()}] ${message}`)),
  warn:    (message) => console.warn(chalk.yellow(`${PREFIX} [${ts()}] ${message}`)),
  error:   (message) => console.error(chalk.red(`${PREFIX} [${ts()}] ${message}`)),
};
