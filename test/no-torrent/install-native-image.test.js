/**
 * @file The proxy image builds its native modules with
 * `scripts/install-native.sh` and checks itself in its final stage; CI's
 * `build` job only builds the image, and the release needs it
 * (torrent-tv/meta#302, design Decisions 3 and 4: AC-1, AC-4).
 *
 * `Dockerfile` and `.github/workflows/main.yml` are read as text. A
 * Dockerfile instruction is its lines joined across trailing backslashes,
 * with comment lines dropped, as Docker reads it. Nothing is built or run.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { sourceOf } from "./helpers/source-text.js";

/**
 * @typedef {{ keyword: string, args: string }} Instruction
 * @typedef {{ name: string | null, instructions: Instruction[] }} Stage
 */

/** @returns {Stage[]} */
function stages() {
  const lines = sourceOf("Dockerfile").replace(/\r\n/g, "\n").split("\n");
  /** @type {Stage[]} */
  const found = [];
  let pending = "";
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    if (pending === "" && line.trim() === "") continue;
    const continued = /\\\s*$/.test(line);
    pending += `${continued ? line.replace(/\\\s*$/, "") : line} `;
    if (continued) continue;
    const text = pending.replace(/\s+/g, " ").trim();
    pending = "";
    const match = /^(\w+)\s*(.*)$/.exec(text);
    if (!match) continue;
    const keyword = match[1].toUpperCase();
    const args = match[2];
    if (keyword === "FROM") {
      const as = /\sAS\s+(\S+)/i.exec(args);
      found.push({ name: as ? as[1] : null, instructions: [] });
    }
    found.at(-1)?.instructions.push({ keyword, args });
  }
  return found;
}

/** @param {string} name @returns {Stage} */
function stageNamed(name) {
  const stage = stages().find((s) => s.name === name);
  assert.ok(stage, `Dockerfile has no stage ${name}`);
  return stage;
}

/**
 * The lines of a job of the workflow, without full-line comments.
 *
 * @param {string} job
 * @returns {string[]}
 */
function jobLines(job) {
  const lines = sourceOf(".github/workflows/main.yml")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line));
  const start = lines.findIndex((line) => line === `  ${job}:`);
  assert.notEqual(start, -1, `main.yml has no job ${job}`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && /^ {0,2}\S/.test(line)) break;
    body.push(line);
  }
  return body;
}

/** @param {string} job @returns {string[]} */
function needsOf(job) {
  const body = jobLines(job);
  const index = body.findIndex((line) => /^ {4}needs:/.test(line));
  assert.notEqual(index, -1, `job ${job} needs nothing`);
  const inline = body[index].replace(/^ {4}needs:\s*/, "").trim();
  if (inline.startsWith("[")) {
    return inline
      .replace(/[[\]]/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (inline !== "") return [inline];
  const items = [];
  for (const line of body.slice(index + 1)) {
    const item = /^ {6}-\s*(\S+)/.exec(line);
    if (!item) break;
    items.push(item[1]);
  }
  return items;
}

// AC-1

test("the Dockerfile holds no node-datachannel build-attempt loop of its own", () => {
  const count = sourceOf("Dockerfile").split("node-datachannel: build attempt").length - 1;
  assert.equal(count, 0);
});

test("the Dockerfile runs no npm rebuild of its own", () => {
  const rebuilds = stages()
    .flatMap((s) => s.instructions)
    .filter((i) => i.keyword === "RUN" && /\bnpm\s+rebuild\b/.test(i.args));
  assert.deepEqual(rebuilds, []);
});

// AC-4

test("stage dependencies copies the script and runs it on /app after npm ci", () => {
  const instructions = stageNamed("dependencies").instructions;
  const ci = instructions.findIndex((i) => i.keyword === "RUN" && /\bnpm\s+ci\b/.test(i.args));
  const copy = instructions.findIndex((i) => i.keyword === "COPY" && /\bscripts\/install-native\.sh\b/.test(i.args));
  const runs = instructions.findIndex((i) => i.keyword === "RUN" && /\bscripts\/install-native\.sh\s+\/app(\s|$)/.test(i.args));
  assert.notEqual(ci, -1, "stage dependencies runs no npm ci");
  assert.notEqual(copy, -1, "stage dependencies does not copy scripts/install-native.sh");
  assert.notEqual(runs, -1, "stage dependencies does not run scripts/install-native.sh /app");
  assert.ok(ci < runs, "install-native.sh runs before npm ci");
  assert.ok(copy < runs, "install-native.sh runs before it is copied");
});

test("the final stage starts the proxy CLI with --help as user app", () => {
  const instructions = stages().at(-1).instructions;
  const user = instructions.findIndex((i) => i.keyword === "USER" && i.args.trim() === "app");
  const help = instructions.findIndex((i) => i.keyword === "RUN" && /^node \/app\/bin\/cli\.js --help\b/.test(i.args));
  assert.notEqual(user, -1, "the final stage has no USER app");
  assert.notEqual(help, -1, "the final stage runs no --help of the proxy CLI");
  assert.ok(user < help, "--help runs before USER app");
});

test("job build builds the image", () => {
  assert.ok(
    jobLines("build").some((line) => /\bdocker build\b/.test(line)),
    "job build runs no docker build"
  );
});

test("job build starts no container, since the image checks itself", () => {
  const runs = jobLines("build").filter((line) => /\bdocker run\b/.test(line));
  assert.deepEqual(runs, []);
});

test("release needs checks and build", () => {
  const needs = needsOf("release");
  assert.ok(needs.includes("checks"), `release needs ${JSON.stringify(needs)}`);
  assert.ok(needs.includes("build"), `release needs ${JSON.stringify(needs)}`);
});
