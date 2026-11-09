/**
 * @file `scripts/retry.mjs <attempts> <delay-s> <cmd> [args]` runs a command
 * again when it fails (torrent-tv/meta#338).
 *
 * CI wraps `npm ci` in it, because the native downloads of the install
 * scripts (ffmpeg-static, node-datachannel, node-gyp's headers) fail on a
 * passing GitHub 504 with no retry of their own worth the name. The command
 * here is a fake: `node -e` that counts its runs in a temp file and exits with
 * a code chosen by the count, so every check reads how many times it ran.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PROXY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RETRY = path.join(PROXY, "scripts/retry.mjs");

const directory = mkdtempSync(path.join(tmpdir(), "ttv-retry-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// Appends one line to the counter file (argv[1]); fails with the code argv[3]
// while the count is at most argv[2], and exits 0 after that.
const FAKE = `
const fs = process.getBuiltinModule("node:fs");
const [counter, failures, code] = process.argv.slice(1);
fs.appendFileSync(counter, "run\\n");
const runs = fs.readFileSync(counter, "utf8").split("\\n").filter(Boolean).length;
process.exit(runs <= Number(failures) ? Number(code) : 0);
`;

let next = 0;

/**
 * Runs `scripts/retry.mjs` around the fake command.
 *
 * @param {{ attempts: string, delay: string, failures: number, code?: number }} options
 * @returns {{ status: number | null, stderr: string, runs: number, ms: number }}
 */
function retry({ attempts, delay, failures, code = 1 }) {
  next += 1;
  const counter = path.join(directory, `runs-${next}`);
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [RETRY, attempts, delay, process.execPath, "-e", FAKE, counter, String(failures), String(code)],
    { cwd: PROXY, encoding: "utf8", timeout: 30_000 }
  );
  const ms = performance.now() - started;
  const runs = existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0;
  return { status: result.status, stderr: result.stderr, runs, ms };
}

test("a command that fails once and then passes runs twice and the call exits 0", () => {
  const result = retry({ attempts: "3", delay: "0", failures: 1 });
  assert.equal(result.runs, 2, `ran ${result.runs} times; stderr: ${result.stderr}`);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /failed on attempt 1 of 3/);
});

test("a command that always fails runs every attempt and the call exits with its code", () => {
  const result = retry({ attempts: "3", delay: "0", failures: Number.POSITIVE_INFINITY, code: 7 });
  assert.equal(result.runs, 3, `ran ${result.runs} times; stderr: ${result.stderr}`);
  assert.equal(result.status, 7, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /failed on attempt 2 of 3/);
  assert.doesNotMatch(result.stderr, /attempt 3 of 3.*retrying/, "the last attempt promises no retry");
});

test("a command that passes at once runs once", () => {
  const result = retry({ attempts: "3", delay: "0", failures: 0 });
  assert.equal(result.runs, 1, `ran ${result.runs} times; stderr: ${result.stderr}`);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /failed/);
});

test("a retry waits the delay before the next attempt", () => {
  const result = retry({ attempts: "2", delay: "1", failures: 1 });
  assert.equal(result.runs, 2, `ran ${result.runs} times; stderr: ${result.stderr}`);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.ok(result.ms >= 1000, `the call took ${Math.round(result.ms)} ms, less than the 1 s delay`);
});

test("zero attempts is a usage error and the command never runs", () => {
  const result = retry({ attempts: "0", delay: "0", failures: 0 });
  assert.equal(result.status, 2, `stderr: ${result.stderr}`);
  assert.equal(result.runs, 0, "the command ran");
});
