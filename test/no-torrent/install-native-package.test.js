/**
 * @file `scripts/install-native.sh` ships in the npm package as its only new
 * file, with LF line endings and the executable bit (torrent-tv/meta#302,
 * design Decision 2: AC-3).
 *
 * The add-on installs the proxy from npm and runs the script from the
 * installed package, so the package must carry it. `package.json` and the
 * script are read as text; git is asked for the mode it records.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sourceOf } from "./helpers/source-text.js";

const PROXY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = "scripts/install-native.sh";
const BEFORE = ["assets/", "bin/", "routes/", "services/", "store/", "utils/", "server.js"];

/** @returns {string[]} */
function files() {
  return JSON.parse(sourceOf("package.json")).files;
}

/** @returns {string} */
function scriptText() {
  const file = path.join(PROXY, SCRIPT);
  assert.ok(existsSync(file), `${SCRIPT} does not exist`);
  return readFileSync(file, "latin1");
}

test("package.json files lists scripts/install-native.sh", () => {
  assert.ok(files().includes(SCRIPT), `files: ${JSON.stringify(files())}`);
});

test("the script is the only entry added to files", () => {
  const added = files().filter((entry) => !BEFORE.includes(entry));
  assert.deepEqual(added, [SCRIPT], `files: ${JSON.stringify(files())}`);
  for (const entry of BEFORE) assert.ok(files().includes(entry), `files lost ${entry}`);
});

test("files ships no scripts/ folder and no other script", () => {
  const scripts = files().filter((entry) => entry === "scripts" || entry.startsWith("scripts/"));
  assert.deepEqual(scripts, [SCRIPT], `files: ${JSON.stringify(files())}`);
});

test("the script has LF line endings", () => {
  assert.equal(scriptText().includes("\r"), false, `${SCRIPT} holds a CR byte`);
});

test("git records the script as executable", () => {
  const result = spawnSync("git", ["ls-files", "-s", "--", SCRIPT], { cwd: PROXY, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^100755 /, `git ls-files -s: ${JSON.stringify(result.stdout)}`);
});

test("the script calls npm and node by name only, never by an absolute path", () => {
  const code = scriptText()
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.doesNotMatch(code, /\/(npm|node)(?=[\s"';)|&]|$)/m, `${SCRIPT} names npm or node by a path`);
});
