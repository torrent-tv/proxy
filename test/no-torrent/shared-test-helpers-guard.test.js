/**
 * @file The shared test helpers stay shared (torrent-tv/meta#310).
 *
 * Byte builders, waiting and source reading were each written again in file
 * after file — `box` in nineteen, an EBML builder in nine, a poll-until-true in
 * nine, a source reader in eight. This holds the three acceptance greps of the
 * issue as one static check, so a new copy fails here instead of being found by
 * the next clone scan:
 *
 *   1. no test file declares its own `box`, `idBytes`, `sizeBytes`, `element`
 *      or `ebml` (and not `fullBox`, `u32`, `full` either, nor a top-level
 *      arrow that writes the header bytes itself);
 *   2. no test file declares its own `waitFor` or `until`, nor sleeps a fixed
 *      `setTimeout` in a promise to prove that something did not happen;
 *   3. a test reads a directory with the synchronous `readdir` only when it is
 *      ABOUT a runtime directory (below, by name) — a test that walks the
 *      proxy's own source uses `jsFilesUnder`.
 *
 * It also pins that the byte builders stay independent of the production
 * writers. They are the oracle the container readers and segment writers are
 * checked against; a builder that imported the writer it checks would agree
 * with it whatever it wrote.
 *
 * What is NOT checked here: that the migrated files still assert what they
 * asserted. That is the existing tests staying green, and the helpers' own
 * tests (`helpers-*.test.js`) stating the exact bytes and behaviours the copies
 * had. The lines are read raw, as the greps of the issue read them, comments
 * included.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROXY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TESTS = path.join(PROXY, "test", "no-torrent");

/**
 * The tests that read a RUNTIME directory — one the proxy writes while it runs
 * (its state directory, the client log, the segment store, the directory an
 * encode writes into) — and assert what is in it. Every other test that walks
 * a directory walks source, and uses `jsFilesUnder`.
 */
const ABOUT_A_RUNTIME_DIRECTORY = new Set([
  "atomic-json.test.js", // the state directory: no temporary file left behind
  "client-log-file.test.js", // the client log directory: its files by name
  "even-grid-cut-by-list.test.js", // the encode directory: what a cut removes
  "segment-store.test.js" // the segment store's directory: what is written and swept
]);

/** The synchronous directory read, spelled so that this file does not name it as a whole word. */
const SYNC_DIRECTORY_READ = `readdir${"Sync"}`;

/** @returns {Promise<Array<{ file: string, lines: string[] }>>} every check, raw */
async function checks() {
  const names = (await readdir(TESTS, { recursive: true })).map(String).filter((name) => name.endsWith(".test.js")).sort();
  return names.map((name) => ({ file: name.split(path.sep).join("/"), lines: readFileSync(path.join(TESTS, name), "utf8").split("\n") }));
}

/**
 * @param {Array<{ file: string, lines: string[] }>} all
 * @param {(line: string, at: number, lines: string[]) => boolean} matches
 * @returns {string[]} `file:line: text`
 */
function where(all, matches) {
  return all.flatMap(({ file, lines }) =>
    lines.flatMap((line, at) => (matches(line, at, lines) ? [`${file}:${at + 1}: ${line.trim()}`] : []))
  );
}

test("no check declares its own box, idBytes, sizeBytes, element or ebml", async () => {
  const offenders = where(await checks(), (line) => /^function (box|idBytes|sizeBytes|element|ebml)\(/.test(line));
  assert.deepEqual(offenders, [], "use helpers/mp4-file.js and helpers/matroska-file.js");
});

test("no check declares its own fullBox, u32 or full, nor writes a box or element header by hand at the top level", async () => {
  const offenders = where(await checks(), (line, at, lines) => {
    if (/^(async )?function (fullBox|u32|full)\(/.test(line)) {
      return true;
    }
    const arrow = /^(const|let) (box|fullBox|u32|full|ebml|element|idBytes|sizeBytes) = (async )?(\([^)]*\)|\w+) =>/.exec(line);
    return arrow !== null && /writeUInt(16|32)?BE|Buffer\.alloc|\.write\(/.test(lines.slice(at, at + 7).join("\n"));
  });
  assert.deepEqual(offenders, [], "use helpers/mp4-file.js (box, fullBox, u32) and helpers/matroska-file.js (element)");
});

test("no check declares its own waitFor or until, nor sleeps a fixed time in a promise", async () => {
  const offenders = where(await checks(), (line) => /function (waitFor|until)\(|setTimeout\(resolve, [1-9]/.test(line));
  assert.deepEqual(offenders, [], "wait for the event with `until`, let queued work run with `settle`, from helpers/wait.js");
});

test("a check reads a directory synchronously only when it is about a runtime directory", async () => {
  const all = await checks();
  const found = all.filter(({ lines }) => lines.some((line) => line.includes(SYNC_DIRECTORY_READ))).map(({ file }) => file);
  const unexpected = found.filter((file) => !ABOUT_A_RUNTIME_DIRECTORY.has(file));
  assert.deepEqual(unexpected, [], "a check that walks the proxy's source uses `jsFilesUnder` from helpers/source-text.js");
  for (const file of ABOUT_A_RUNTIME_DIRECTORY) {
    assert.ok(all.some((one) => one.file === file), `${file} is named as about a runtime directory and is not there`);
  }
});

test("the byte builders import nothing of the proxy: they stay the oracle, independent of the production writers", () => {
  for (const name of ["mp4-file.js", "matroska-file.js"]) {
    const source = (() => {
      try {
        return readFileSync(path.join(TESTS, "helpers", name), "utf8");
      } catch {
        return assert.fail(`helpers/${name} does not exist`);
      }
    })();
    const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((match) => match[1]);
    const outside = specifiers.filter((specifier) => !specifier.startsWith("node:") && !/^\.\/[\w-]+\.js$/.test(specifier));
    assert.deepEqual(outside, [], `helpers/${name} reaches into the proxy; a builder that imports a writer agrees with it by construction`);
  }
});

test("every helper module starts no torrent (the check that runs before the tests)", () => {
  const run = spawnSync(process.execPath, ["scripts/check-tests-start-no-torrent.mjs"], { cwd: PROXY, encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
