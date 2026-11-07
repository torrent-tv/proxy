/**
 * @file The memory report's shared policy lives in memory-report.js
 * (torrent-tv/meta#293).
 *
 * `bin/cli.js` and `worker.js` each called `startMemoryReport` with the same
 * quiet interval, change step, snapshot floor, growth and keep count, so the
 * defaults in `memory-report.js` were dead and the policy was written twice.
 * Now the module's DEFAULTS carry those five values and a caller passes what
 * differs: scope, label, directories (and its own readers, hooks and, for the
 * worker, its buffer thresholds).
 *
 * SEAM: none new. The defaults are read from the signature text of
 * `startMemoryReport` (the defaults are not otherwise observable without a
 * heap); each must be a literal numeric expression.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { sourceOf } from "./helpers/source-text.js";

const MiB = 1024 * 1024;
const POLICY = { quietMs: 60_000, changeBytes: 25 * MiB, snapshotFloorBytes: 400 * MiB, snapshotGrowthBytes: 400 * MiB, keepSnapshots: 3 };
const CLI = ["bin", "cli.js"].join("/");
const WORKER = ["services", "torrent", "worker", "worker.js"].join("/");
const CALLERS = [CLI, WORKER];

/** The text between the braces opened at `open`, comments left in. */
function balanced(text, open) {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "{") depth += 1;
    else if (text[at] === "}" && --depth === 0) return text.slice(open + 1, at);
  }
  throw new Error("unbalanced braces");
}

/** Top-level property names of an object literal body, comments dropped. */
function keysOf(body) {
  const code = body.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  const keys = [];
  let depth = 0;
  let start = 0;
  const flush = (end) => {
    const match = /^\s*([A-Za-z_$][\w$]*)\s*(?::|,|$|\()/.exec(code.slice(start, end));
    if (match) keys.push(match[1]);
  };
  for (let at = 0; at < code.length; at += 1) {
    if ("({[".includes(code[at])) depth += 1;
    else if (")}]".includes(code[at])) depth -= 1;
    else if (code[at] === "," && depth === 0) { flush(at); start = at + 1; }
  }
  flush(code.length);
  return keys;
}

test("memory-report.js defaults carry the shared policy", () => {
  const source = sourceOf("services/storage/memory-report.js");
  const open = source.indexOf("{", source.indexOf("export function startMemoryReport("));
  const defaults = {};
  for (const name of Object.keys(POLICY)) {
    const match = new RegExp(`\\b${name}\\s*=\\s*([0-9_*\\s]+?)\\s*[,}\\n]`).exec(balanced(source, open));
    defaults[name] = match ? Function(`"use strict"; return (${match[1].replaceAll("_", "")});`)() : undefined;
  }
  assert.deepEqual(defaults, POLICY);
});

for (const caller of CALLERS) {
  test(`${caller} passes startMemoryReport no part of the shared policy`, () => {
    const source = sourceOf(caller);
    const call = source.indexOf("startMemoryReport({");
    assert.ok(call >= 0, "the call was not found");
    const passed = keysOf(balanced(source, call + "startMemoryReport(".length));
    assert.deepEqual(passed.filter((key) => key in POLICY), [], "the policy is still written at the call");
  });
}

test("the snapshot floor is named neither by the CLI nor by the torrent thread", () => {
  for (const caller of CALLERS) {
    const lines = sourceOf(caller).split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.includes("snapshotFloorBytes") && !line.includes("bufferSnapshotFloorBytes"));
    assert.deepEqual(lines.map(({ number }) => `${caller}:${number}`), []);
  }
});

test("PINNING: the worker keeps the buffer thresholds only it chooses", () => {
  const source = sourceOf(WORKER);
  const call = source.indexOf("startMemoryReport({");
  const passed = keysOf(balanced(source, call + "startMemoryReport(".length));
  for (const key of ["scope", "label", "bufferSnapshotFloorBytes", "bufferSnapshotGrowthBytes"]) {
    assert.ok(passed.includes(key), `${key} is no longer passed by the worker`);
  }
});
