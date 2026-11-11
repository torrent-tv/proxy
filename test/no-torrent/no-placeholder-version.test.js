/**
 * @file No test names the abandoned placeholder version (torrent-tv/meta#336, AC 4(c)).
 *
 * The version of every package is the one in its `package.json`, raised by the release from the
 * tags. The placeholder version name of a dropped design must not stay in a fixture, because it
 * states a version source that does not exist. The check reads every test file as the
 * acceptance grep of the issue reads it, comments included.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { jsFilesUnder, sourceOf } from "./helpers/source-text.js";
import path from "node:path";

// Built from two parts so that this file does not hold the name it forbids.
const PLACEHOLDER = ["0.0.0", "development"].join("-");

test("no test file names the placeholder version", { timeout: 30_000 }, () => {
  const found = [];
  for (const file of jsFilesUnder("test")) {
    const relative = path.relative(process.cwd(), file);
    sourceOf(file)
      .split("\n")
      .forEach((line, index) => {
        if (line.includes(PLACEHOLDER)) found.push(`${relative}:${index + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(found, [], `placeholder version ${PLACEHOLDER} found in tests`);
});
