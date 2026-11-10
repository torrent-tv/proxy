/**
 * @file The ffprobe binary a check that runs a real ffprobe uses: the one the
 * proxy would choose at startup, by `selectFfprobe`, from the bundled binary and
 * `ffprobe` on PATH. The choice is made once per test process.
 *
 * A host with no qualifying ffprobe cannot run such a check: the check is skipped,
 * with a reason that names the missing prerequisite and carries the proxy's own
 * one-line message, never silently. Where `CI` is set the skip is a failure, so a
 * CI runner cannot hide a regression of the selection behind a skip.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const SELECTION = new URL("../../../services/media/ffprobe-selection.js", import.meta.url).href;
const RUN_LIMIT_MS = 10_000;

function bundledBinary() {
  try {
    return createRequire(import.meta.url)("@ffprobe-installer/ffprobe").path;
  } catch {
    return null;
  }
}

/** Runs `binary args` and resolves what it printed; rejects when it cannot be started. */
function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: RUN_LIMIT_MS });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

let chosen = null;

/**
 * @returns {Promise<{ source: string, binary: string, version: string }>}
 */
export function chosenFfprobe() {
  chosen ??= import(SELECTION).then(({ selectFfprobe, ffprobeCandidates }) =>
    selectFfprobe({ candidates: ffprobeCandidates({ bundledBinary: bundledBinary() }), run, logger: console }));
  return chosen;
}

/**
 * What a check that needs ffprobe does with the outcome of the selection.
 *
 * @param {{ chosen: { binary: string } | null, missing: string | null, env?: Record<string, string | undefined> }} outcome
 *   `missing` is the message of `FfprobeUnavailableError` when no candidate qualified.
 *   `env.CI` counts as set when it is a non-empty string (GitHub Actions sets `true`);
 *   that rule is CHOSEN, not measured.
 * @returns {{ binary: string } | { skip: string }}
 * @throws {Error} When no candidate qualified and `CI` is set.
 */
export function decideFfprobe({ chosen, missing, env = process.env }) {
  if (chosen) return { binary: chosen.binary };
  const reason = `missing prerequisite: an ffprobe whose -sections names stream_side_data (${missing})`;
  if (env.CI) throw new Error(`${reason}; a check that needs it is not skipped where CI is set`);
  return { skip: reason };
}

/**
 * The ffprobe binary for a check, or the reason the check is skipped.
 *
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<{ binary: string } | { skip: string }>}
 */
export async function ffprobeForTest({ env = process.env } = {}) {
  try {
    return decideFfprobe({ chosen: await chosenFfprobe(), missing: null, env });
  } catch (error) {
    if (error?.name !== "FfprobeUnavailableError") throw error;
    return decideFfprobe({ chosen: null, missing: error.message, env });
  }
}
