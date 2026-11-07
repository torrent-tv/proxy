/**
 * @file One way to print bytes (torrent-tv/meta#294, acceptance 3).
 *
 * `utils/units.js` exports:
 * - `megabytes(bytes)` -> "123MB": decimal (10^6), rounded to a whole number,
 *   negative bytes read as 0. For data.
 * - `mebibytes(bytes)` -> "123MiB": binary (2^20), same shape. For memory.
 * - `megabytesPerSecond(bytesPerSecond)` -> "1.05 MB/s": decimal, two decimals,
 *   "?" in place of the number when the rate is not a finite number.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { megabytes, mebibytes, megabytesPerSecond } from "../../utils/units.js";

test("data is printed in decimal megabytes", () => {
  assert.equal(megabytes(0), "0MB");
  assert.equal(megabytes(1_000_000), "1MB");
  assert.equal(megabytes(1_499_999), "1MB");
  assert.equal(megabytes(1_500_000), "2MB");
  assert.equal(megabytes(1_048_576), "1MB", "one MiB is 1.05 MB");
  assert.equal(megabytes(150_000_000), "150MB");
  assert.equal(megabytes(-5), "0MB");
});

test("memory is printed in binary mebibytes, under its own label", () => {
  assert.equal(mebibytes(0), "0MiB");
  assert.equal(mebibytes(1_048_576), "1MiB");
  assert.equal(mebibytes(1_000_000), "1MiB", "0.95 MiB rounds up");
  assert.equal(mebibytes(1_572_864), "2MiB");
  assert.equal(mebibytes(1_572_863), "1MiB");
  assert.equal(mebibytes(400 * 1024 * 1024), "400MiB");
  assert.equal(mebibytes(-5), "0MiB");
});

test("the same byte count reads differently under the two labels, never the same label", () => {
  const bytes = 500 * 1024 * 1024;
  assert.equal(megabytes(bytes), "524MB");
  assert.equal(mebibytes(bytes), "500MiB");
});

test("a rate is decimal megabytes a second with two decimals", () => {
  assert.equal(megabytesPerSecond(1_000_000), "1.00 MB/s");
  assert.equal(megabytesPerSecond(1_048_576), "1.05 MB/s", "the old MiB reading said 1.00");
  assert.equal(megabytesPerSecond(2_500_000), "2.50 MB/s");
  assert.equal(megabytesPerSecond(0), "0.00 MB/s");
});

test("a rate that is not a number is said as a question mark", () => {
  assert.equal(megabytesPerSecond(Number.NaN), "? MB/s");
  assert.equal(megabytesPerSecond(Infinity), "? MB/s");
  assert.equal(megabytesPerSecond(null), "? MB/s");
  assert.equal(megabytesPerSecond(undefined), "? MB/s");
});

test("ViewerRequests and HostLoad print a swarm rate through the same formatter", () => {
  // Under one "MB/s" label they divided by 2^20 and by 10^6, 4.9 % apart.
  for (const file of ["services/server/ViewerRequests.js", "services/encode/quality/HostLoad.js",
    "services/server/wire-outputs.js"]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /import\s*\{[^}]*\bmegabytesPerSecond\b[^}]*\}\s*from\s*"[^"]*utils\/units\.js"/, `${file} imports it`);
    assert.doesNotMatch(source, /1_048_576|1048576/, `${file} has no binary divisor left`);
    assert.doesNotMatch(source, /\)\.toFixed\(2\)\}? MB\/s|toFixed\(2\) : "\?"\} MB\/s/, `${file} formats no rate inline`);
  }
});
