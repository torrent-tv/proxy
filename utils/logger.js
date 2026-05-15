/**
 * @file Centralised console logger for the proxy process.
 *
 * All messages are prefixed with `[proxy-client]` and coloured with chalk
 * for consistent, readable terminal output.
 */

import chalk from "chalk";

const PREFIX = "[proxy-client]";

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
  info:    (message) => console.log(chalk.cyan(`${PREFIX} ${message}`)),
  success: (message) => console.log(chalk.green(`${PREFIX} ${message}`)),
  warn:    (message) => console.warn(chalk.yellow(`${PREFIX} ${message}`)),
  error:   (message) => console.error(chalk.red(`${PREFIX} ${message}`)),
};
