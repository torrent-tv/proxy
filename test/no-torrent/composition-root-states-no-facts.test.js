/**
 * @file The composition root holds no state and no long closures.
 *
 * `server.js` and `services/server/wire-outputs.js` assemble components; they
 * must not own collections or algorithms. Both files are outside biome's layer
 * rules, so this test READS them as text and refuses what a layer rule would:
 * `new Map/WeakMap/Set/WeakSet(`, closures longer than 40 lines, and the late
 * binding the composition root once had. Each refusal names file, line, reason.
 *
 * Text cannot tell a temporary from state created lazily inside a closure, so
 * neither is allowed. Imports nothing from `services/`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { sourceOf } from "./helpers/source-text.js";

const FILES = ["server.js", "services/server/wire-outputs.js"];
const LONGEST_CLOSURE_LINES = 40;
const OUTPUT_PARTS_REACHES = 10;
const COLLECTION = /\bnew\s+(Map|WeakMap|Set|WeakSet)\s*\(/;
const EXEMPT_CLOSURES = [/^\s*export\s+async\s+function\s+startProxyServer\(/, /^\s*export\s+function\s+wireOutputs\(/];
const NOT_CLOSURES = /^\s*(?:\}\s*)?(if|for|while|switch|catch|else)\b/;

/**
 * Lines of code: comment lines blanked, trailing `// …` stripped. Line numbers are kept.
 *
 * @param {string} text
 * @returns {string[]}
 */
function codeLines(text) {
  let inBlock = false;
  return text.split("\n").map((line) => {
    const t = line.trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      return "";
    }
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlock = true;
      return "";
    }
    if (t.startsWith("//") || t.startsWith("*")) return "";
    return line.replace(/\s\/\/.*$/, "");
  });
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function startsClosure(line) {
  if (NOT_CLOSURES.test(line)) return false;
  if (/=>\s*\{\s*$/.test(line)) return true;
  if (/\bfunction\b[^(]*\([^)]*\)\s*\{\s*$/.test(line)) return true;
  return /^\s*(?:async\s+)?(?:static\s+)?[A-Za-z_$][\w$]*\([^)]*\)\s*\{\s*$/.test(line);
}

/**
 * Every refusal in one file's text, as `file:line reason`.
 *
 * @param {string} file
 * @param {string} text
 * @returns {string[]}
 */
export function refusalsIn(file, text) {
  const lines = codeLines(text);
  /** @type {string[]} */
  const out = [];
  lines.forEach((line, i) => {
    const m = COLLECTION.exec(line);
    if (m) out.push(`${file}:${i + 1} holds state: new ${m[1]}( — move the collection to its owner`);
  });
  const indent = (/** @type {string} */ l) => l.length - l.trimStart().length;
  lines.forEach((line, i) => {
    if (!startsClosure(line) || EXEMPT_CLOSURES.some((re) => re.test(line))) return;
    const depth = indent(line);
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim().startsWith("}") && indent(lines[j]) <= depth) {
        end = j;
        break;
      }
    }
    const length = end - i + 1;
    if (length > LONGEST_CLOSURE_LINES) {
      out.push(`${file}:${i + 1} long closure: ${length} lines, at most ${LONGEST_CLOSURE_LINES} — move it to an owner`);
    }
  });
  if (file.endsWith("server.js") && !file.includes("wire-outputs")) {
    for (const word of ["outputPartsReady", "let sourcePreparation", "encodeMetadataRequests"]) {
      lines.forEach((line, i) => {
        if (line.includes(word)) out.push(`${file}:${i + 1} late binding: ${word}`);
      });
    }
    const reaches = lines.join("\n").match(/\boutputParts\./g)?.length ?? 0;
    if (reaches > OUTPUT_PARTS_REACHES) {
      out.push(`${file}: ${reaches} reaches into outputParts., at most ${OUTPUT_PARTS_REACHES}`);
    }
  }
  return out;
}

/**
 * @param {number} n
 * @returns {string}
 */
function closureOf(n) {
  return `const f = () => {\n${"  work();\n".repeat(n - 2)}};\n`;
}

test("a Map in code is refused, in a comment it is not", () => {
  assert.equal(refusalsIn("x.js", "const kept = new Map();\n").length, 1);
  assert.equal(refusalsIn("x.js", "// new Map()\n/* new Set() */\nconst a = 1; // new WeakMap()\n").length, 0);
});

test("a closure of 41 lines is refused, of 40 is not", () => {
  assert.equal(refusalsIn("x.js", closureOf(40)).length, 0);
  const refused = refusalsIn("x.js", closureOf(41));
  assert.equal(refused.length, 1);
  assert.match(refused[0], /^x\.js:1 /);
});

test("late binding named in server.js is refused", () => {
  assert.equal(refusalsIn("server.js", "let outputPartsReady = false;\n").length, 1);
});

for (const file of FILES) {
  test(`${file} holds no collections and no long closures`, () => {
    const text = sourceOf(file);
    const refused = refusalsIn(file, text);
    assert.deepEqual(refused, [], `\n${refused.join("\n")}\n`);
  });
}
