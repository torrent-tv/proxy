/**
 * @file The greps that close torrent-tv/meta#294, as tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsFilesUnder } from "./helpers/source-text.js";

const PROXY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** @param {string} directory @returns {string[]} every .js file under it, named from the proxy's root */
const sourcesUnder = (directory) => jsFilesUnder(directory).map((file) => path.relative(PROXY, file));

const services = sourcesUnder("services");
const everything = [...services, ...sourcesUnder("utils")];
const read = (file) => fs.readFileSync(path.join(PROXY, file), "utf8").split("\n");

/** @param {string[]} files @param {RegExp} pattern @returns {string[]} "file:line" of every match */
function hits(files, pattern) {
  return files.flatMap((file) => read(file).flatMap((line, at) => (pattern.test(line) ? [`${file}:${at + 1}`] : [])));
}

test("acceptance 2: halving a sorted length happens in the helper and the named copies only", () => {
  // The helper is utils/median.js (outside services). What stays:
  //  - layers that may not import utils/ and keep a passed-in function:
  //    viewer/, encode/output/, media/container;
  //  - language-detect.js, which splits a text in two and takes no median.
  const allowed = [
    "services/viewer/DownloadMaps.js",
    "services/encode/output/Output.js",
    "services/media/container/KeyframeTable.js",
    "services/media/tracks/language-detect.js"
  ];
  const found = hits(services, /Math\.floor\(\w+\.length \/ 2\)/);
  const outside = found.filter((hit) => !allowed.some((file) => hit.startsWith(`${file}:`)));
  assert.deepEqual(outside, [], "a median written out again; import medianOf / upperMiddleOf from utils/median.js");
  assert.ok(fs.existsSync("utils/median.js"), "utils/median.js exists");
});

test("acceptance 3: a megabyte constant is never part of a value printed as MB", () => {
  // Limits and caps are fine (`const CAP = 8 * 1024 * 1024`). A line that holds
  // the constant AND says MB / MiB / megabytes, outside an identifier such as
  // WITNESS_RING_FILE_MB, divides a size for display.
  const constant = /1048576|1_048_576|1024 \* 1024/;
  const offenders = services.flatMap((file) => read(file).flatMap((line, at) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/^\s*(\*|\/\*)/.test(line) || !constant.test(code)) return [];
    const printed = code.replace(/\b[A-Z0-9_]*_MB\b/g, "");
    return /MiB|MB|megabytes/.test(printed) ? [`${file}:${at + 1}: ${line.trim()}`] : [];
  }));
  assert.deepEqual(offenders, [], "print bytes through utils/units.js");
});

test("the three megabytes() helpers are gone", () => {
  assert.deepEqual(hits(services, /function megabytes\(/), []);
});

test("clamp is defined once", () => {
  // available-share.js and machine-processor.js each had one; either a shared
  // module owns it or one imports the other's. At most one definition remains.
  assert.ok(hits(everything, /(function clamp\(|const clamp\s*=)/).length <= 1,
    `defined at ${hits(everything, /(function clamp\(|const clamp\s*=)/).join(", ")}`);
});
