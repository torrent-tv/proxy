/**
 * @file How a static check reads the proxy's own source: `sourceOf`,
 * `jsFilesUnder` and `codeOf` (comments taken out, strings kept).
 *
 * Paths are named from the proxy's root; an absolute path is used as it is.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROXY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** @param {string} file @returns {string} */
export function sourceOf(file) {
  return readFileSync(path.resolve(PROXY, file), "utf8");
}

/** @param {string} directory @returns {string[]} every .js file at any depth, absolute, sorted */
export function jsFilesUnder(directory) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".js")) {
        found.push(full);
      }
    }
  };
  walk(path.resolve(PROXY, directory));
  return found.sort();
}

const BEFORE_REGEX = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/**
 * The source with its comments taken out. Line structure is kept (a block
 * comment leaves its newlines). A `//` inside a string, template or regular
 * expression is not a comment.
 *
 * @param {string} source
 * @returns {string}
 */
export function codeOf(source) {
  let out = "";
  let last = ""; // last significant character written
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        j += source[j] === "\\" ? 2 : 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      last = c;
    } else if (c === "/" && (BEFORE_REGEX.has(last) || /\b(return|typeof|case)$/.test(out.trimEnd()))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n" && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") j += 1;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j += 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      last = "/";
    } else {
      out += c;
      if (!/\s/.test(c)) last = c;
      i += 1;
    }
  }
  return out;
}
