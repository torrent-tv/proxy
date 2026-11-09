/**
 * @file The `checks` job caches and retries the native downloads of `npm ci`
 * (torrent-tv/meta#338).
 *
 * `npm ci` fetches node-datachannel's binary and ffmpeg-static's ffmpeg from
 * GitHub releases and node's headers from nodejs.org; a GitHub 504 failed every
 * pull request on 2026-11-08. The job keeps those downloads in a cache of their
 * own, restored before the install and saved only after it succeeds, and
 * retries the whole install through `scripts/retry.mjs`.
 *
 * The workflow is read as text: no YAML parser is a dependency. The reader
 * below knows only what a workflow step uses (mappings, block scalars `|`,
 * plain or quoted scalars, lists) and ignores full-line comments, so the
 * checks hold for any indentation or quoting of a correct workflow.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { sourceOf } from "./helpers/source-text.js";

const CACHE_PATHS = ["~/.npm/_prebuilds", "~/.cache/node-gyp", "~/.cache/torrent-tv/ffmpeg-static"];

/** @param {string} line @returns {number} */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** @param {string} value @returns {string} */
function unquoted(value) {
  const text = value.trim();
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0]) {
    return text.slice(1, -1);
  }
  return text.replace(/\s+#.*$/, "");
}

/**
 * The mapping whose keys start at `indent`: each key to its value. A plain or
 * quoted scalar is its text; a block scalar (`|`, `>`) is its lines without
 * the common indentation; a nested mapping or list is its raw lines.
 *
 * @param {string[]} lines lines without full-line comments
 * @param {number} indent
 * @returns {Map<string, string | string[]>}
 */
function mappingAt(lines, indent) {
  const result = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || indentOf(line) !== indent) continue;
    const match = /^\s*([\w.-]+):(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const children = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === "" || indentOf(lines[i + 1]) > indent)) {
      i += 1;
      children.push(lines[i]);
    }
    const value = (match[2] ?? "").trim();
    if (/^[|>][-+]?$/.test(value)) {
      const inner = children.filter((child) => child.trim() !== "");
      const common = Math.min(...inner.map(indentOf));
      result.set(match[1], inner.map((child) => child.slice(common)).join("\n"));
    } else if (value === "") {
      result.set(match[1], children);
    } else {
      result.set(match[1], unquoted(value));
    }
  }
  return result;
}

/**
 * The steps of the `checks` job, each as its mapping, in order.
 *
 * @returns {Map<string, string | string[]>[]}
 */
function checksSteps() {
  const lines = sourceOf(".github/workflows/main.yml")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));
  const jobs = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert.notEqual(jobs, -1, "main.yml has no jobs");
  const jobIndent = indentOf(lines.slice(jobs + 1).find((line) => line.trim() !== ""));
  const job = mappingAt(lines.slice(jobs + 1), jobIndent).get("checks");
  assert.ok(Array.isArray(job), "main.yml has no checks job");
  const jobKeys = mappingAt(job, indentOf(job.find((line) => line.trim() !== "")));
  const list = jobKeys.get("steps");
  assert.ok(Array.isArray(list), "the checks job has no steps");
  const itemIndent = indentOf(list.find((line) => line.trim() !== ""));

  const steps = [];
  for (const line of list) {
    if (indentOf(line) === itemIndent && /^\s*-(\s|$)/.test(line)) {
      steps.push([line.replace("-", " ")]);
    } else if (steps.length > 0) {
      steps.at(-1).push(line);
    }
  }
  return steps.map((step) => mappingAt(step, indentOf(step.find((line) => line.trim() !== "" && !/^\s*-\s*$/.test(line)))));
}

/**
 * @param {Map<string, string | string[]>[]} steps
 * @param {string} name
 * @returns {{ step: Map<string, string | string[]>, index: number }}
 */
function stepNamed(steps, name) {
  const index = steps.findIndex((step) => step.get("name") === name);
  assert.notEqual(index, -1, `the checks job has no step "${name}"`);
  return { step: steps[index], index };
}

/** @param {Map<string, string | string[]>} step @returns {Map<string, string | string[]>} */
function withOf(step) {
  const lines = step.get("with");
  assert.ok(Array.isArray(lines), `step "${step.get("name")}" has no with:`);
  return mappingAt(lines, indentOf(lines.find((line) => line.trim() !== "")));
}

/**
 * The entries of a `path` input, from a block scalar, a list or one line.
 *
 * @param {string | string[] | undefined} value
 * @returns {string[]}
 */
function pathEntries(value) {
  const lines = Array.isArray(value) ? value : String(value ?? "").split("\n");
  return lines
    .map((line) => unquoted(line.trim().replace(/^-\s*/, "")))
    .filter((line) => line !== "")
    .sort();
}

/** @param {string | string[] | undefined} key @returns {string} the key with the spacing inside `${{ }}` made uniform */
function normalizedKey(key) {
  assert.equal(typeof key, "string", "the cache step has no key");
  return key.replace(/\$\{\{\s*/g, "${{ ").replace(/\s*\}\}/g, " }}").trim();
}

test("setup-node in the checks job has id node, so the cache key can name the node version", () => {
  const setup = checksSteps().find((step) => /^actions\/setup-node@/.test(String(step.get("uses"))));
  assert.ok(setup, "the checks job has no setup-node step");
  assert.equal(setup.get("id"), "node");
});

test("the native download cache is restored with an exact key and no fallback", () => {
  const { step } = stepNamed(checksSteps(), "Restore native download cache");
  assert.match(String(step.get("uses")), /^actions\/cache\/restore@v6$/);
  const inputs = withOf(step);
  assert.deepEqual(pathEntries(inputs.get("path")), [...CACHE_PATHS].sort());
  const key = normalizedKey(inputs.get("key"));
  for (const part of [/\$\{\{ runner\.os \}\}/, /\$\{\{ runner\.arch \}\}/, /\$\{\{ steps\.node\.outputs\.node-version \}\}/, /\$\{\{ hashFiles\(\s*['"]package-lock\.json['"]\s*\) \}\}/]) {
    assert.match(key, part);
  }
  assert.equal(inputs.has("restore-keys"), false, "a partial match could restore an older ffmpeg");
});

test("the native download cache is saved under the same paths and key, and only when the job got that far", () => {
  const steps = checksSteps();
  const restore = withOf(stepNamed(steps, "Restore native download cache").step);
  const { step } = stepNamed(steps, "Save native download cache");
  assert.match(String(step.get("uses")), /^actions\/cache\/save@v6$/);
  const inputs = withOf(step);
  assert.deepEqual(pathEntries(inputs.get("path")), pathEntries(restore.get("path")));
  assert.equal(normalizedKey(inputs.get("key")), normalizedKey(restore.get("key")));
  assert.equal(step.has("continue-on-error"), false);
  assert.doesNotMatch(String(step.get("if") ?? ""), /\b(always|failure|cancelled)\s*\(/, "a failed install must save nothing");
});

test("restore, install, save, then lint and tests", () => {
  const steps = checksSteps();
  const restore = stepNamed(steps, "Restore native download cache").index;
  const install = stepNamed(steps, "Install dependencies").index;
  const save = stepNamed(steps, "Save native download cache").index;
  const tests = stepNamed(steps, "Lint and tests").index;
  assert.ok(restore < install, "the cache is restored after the install");
  assert.ok(install < save, "the cache is saved before the install");
  assert.ok(save < tests, "the cache is saved after the tests, so a failed test loses it");
});

test("the install retries npm ci and takes ffmpeg from the cache", () => {
  const { step } = stepNamed(checksSteps(), "Install dependencies");
  const run = String(step.get("run") ?? "");
  const retry = /\bnode\s+(?:\.\/)?scripts\/retry\.mjs\s+(\d+)\s+(\d+(?:\.\d+)?)\s+npm\s+ci\b/.exec(run);
  assert.ok(retry, `npm ci is not run through scripts/retry.mjs:\n${run}`);
  assert.ok(Number(retry[1]) >= 2, `${retry[1]} attempts is no retry`);
  assert.ok(Number(retry[2]) >= 10, `a ${retry[2]} s delay is too short for a GitHub 504 to pass`);
  for (const line of run.split("\n").filter((text) => /\bnpm\s+ci\b/.test(text))) {
    assert.match(line, /scripts\/retry\.mjs/, `npm ci runs without the retry: ${line.trim()}`);
  }
  assert.match(run, /\bFFMPEG_BIN=/, "the install does not point ffmpeg-static at the cached ffmpeg");
  assert.match(run, /node_modules\/ffmpeg-static\/ffmpeg/, "the install does not name the ffmpeg the tests use");
  assert.doesNotMatch(run, /--ignore-scripts/);
  assert.doesNotMatch(run, /\|\|\s*true\b/, "a failed install must fail the step");
  assert.equal(step.has("continue-on-error"), false);
});
