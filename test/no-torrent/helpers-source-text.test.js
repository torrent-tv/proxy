/**
 * @file `helpers/source-text.js`: `sourceOf`, `jsFilesUnder`, `codeOf` — how a
 * static check reads the proxy's own source.
 *
 * Eight checks each carried a reader, three their own directory walker, and
 * only `scripts/check-tests-start-no-torrent.mjs` took comments out, so a rule
 * that something must not appear was tripped by a comment explaining why. A
 * check that asks "is this still called" asks `codeOf`: comments gone, strings
 * kept, because a string is code and a `//` inside one is not a comment.
 *
 * Paths are named from the proxy's root (`services/...`, `server.js`); an
 * absolute path is used as it is.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codeOf, jsFilesUnder, sourceOf } from "./helpers/source-text.js";

const PROXY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("sourceOf reads a file named from the proxy's root, as text", () => {
  const text = sourceOf("package.json");
  assert.equal(typeof text, "string");
  assert.equal(JSON.parse(text).name, "@torrent-tv/proxy");
  assert.equal(sourceOf("services/media/container/Mp4Container.js"), readFileSync(path.join(PROXY, "services/media/container/Mp4Container.js"), "utf8"));
});

test("sourceOf reads an absolute path as it is", () => {
  assert.equal(sourceOf(path.join(PROXY, "package.json")), sourceOf("package.json"));
});

test("sourceOf of a file that is not there throws, naming it", () => {
  assert.throws(() => sourceOf("services/no-such-file.js"), /no-such-file\.js/);
});

test("jsFilesUnder lists every .js file at any depth, as absolute paths, in a stable order", () => {
  const root = mkdtempSync(path.join(tmpdir(), "source-text-"));
  try {
    mkdirSync(path.join(root, "a", "b"), { recursive: true });
    for (const name of ["z.js", "a/y.js", "a/b/x.js", "a/b/not-js.txt", "a/b/data.json", "a/b/mod.mjs"]) {
      writeFileSync(path.join(root, name), "");
    }
    const found = jsFilesUnder(root);
    assert.deepEqual(found, [path.join(root, "a", "b", "x.js"), path.join(root, "a", "y.js"), path.join(root, "z.js")]);
    assert.deepEqual(jsFilesUnder(root), found);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jsFilesUnder reads a directory named from the proxy's root", () => {
  const found = jsFilesUnder("services/media/container");
  assert.ok(found.length > 5);
  assert.ok(found.every((file) => path.isAbsolute(file) && file.endsWith(".js")));
  assert.ok(found.includes(path.join(PROXY, "services/media/container/Mp4Container.js")));
});

test("jsFilesUnder of a directory with no .js file is empty", () => {
  const root = mkdtempSync(path.join(tmpdir(), "source-text-"));
  try {
    assert.deepEqual(jsFilesUnder(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codeOf takes out line comments, whole-line and trailing", () => {
  const code = codeOf("// whole line\nconst a = 1; // trailing\nconst b = 2;\n");
  assert.equal(code.includes("whole line"), false);
  assert.equal(code.includes("trailing"), false);
  assert.ok(code.includes("const a = 1;") && code.includes("const b = 2;"));
});

test("codeOf takes out block comments, JSDoc and multi-line", () => {
  const code = codeOf("/**\n * @file mentions waitFor(\n */\nfunction f() { /* inner */ return 1; }\n/* a\nb */\nconst c = 3;");
  assert.equal(code.includes("waitFor"), false);
  assert.equal(code.includes("inner"), false);
  assert.ok(code.includes("function f()") && code.includes("return 1;") && code.includes("const c = 3;"));
});

test("codeOf keeps a // inside a string, a URL included", () => {
  assert.ok(codeOf('const u = "http://example.com/a"; // gone').includes("http://example.com/a"));
  assert.ok(codeOf("const u = 'https://example.com'; // gone").includes("https://example.com"));
  assert.ok(codeOf("const u = `http://x/${a} // kept`; // gone").includes("// kept"));
  assert.equal(codeOf('const u = "x"; // gone').includes("gone"), false);
});

test("codeOf keeps a /* inside a string and a // inside a regular expression", () => {
  assert.ok(codeOf('const s = "/* not a comment */"; const t = 1;').includes("/* not a comment */"));
  assert.ok(codeOf("const re = /a\\/\\/b/; const t = 1; // gone").includes("const t = 1;"));
});

test("codeOf keeps the line structure, so a match can still be located by line", () => {
  const source = "// one\n/* two\nthree */\nconst a = 1;\n";
  const lines = codeOf(source).split("\n");
  assert.equal(lines.length, source.split("\n").length);
  assert.equal(lines[3].trim(), "const a = 1;");
});

test("codeOf of code with no comment is that code", () => {
  const code = 'import x from "node:fs";\nexport const y = x;\n';
  assert.equal(codeOf(code), code);
});
