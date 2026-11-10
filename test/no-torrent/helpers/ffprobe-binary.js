/**
 * @file The ffprobe binary a check that runs a real ffprobe uses: the one the
 * proxy would choose at startup, by `selectFfprobe`, from the bundled binary and
 * `ffprobe` on PATH. The choice is made once per test process. A host with no
 * qualifying ffprobe fails the check with the proxy's own one-line message.
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
