/**
 * @file How one `Range` header is read against the length of what it asks for
 * (RFC 9110 §14.1.2 and §14.2, a single range): the whole representation, one
 * inclusive range inside it, or a range that cannot be satisfied.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseRange } from "../../utils/parse-range.js";

const WHOLE = { kind: "whole" };
const UNSATISFIABLE = { kind: "unsatisfiable" };
const range = (start, end) => ({ kind: "range", start, end });

/** Each row: what the header is called in the test name, the header, the length, the result. */
const CASES = [
  // A range inside the representation.
  ["bytes=0-", "bytes=0-", 1000, range(0, 999)],
  ["bytes=0-499", "bytes=0-499", 1000, range(0, 499)],
  ["the suffix bytes=-500", "bytes=-500", 1000, range(500, 999)],
  ["bytes=500-5000, whose end is past the last byte,", "bytes=500-5000", 1000, range(500, 999)],
  ["the unit written as Bytes", "Bytes=0-1", 1000, range(0, 1)],
  ["bytes= 0-1 with whitespace around the value", "bytes= 0-1 ", 1000, range(0, 1)],

  // Read as the whole representation: no header, another unit, several ranges, invalid syntax.
  ["no header", undefined, 1000, WHOLE],
  ["an empty header", "", 1000, WHOLE],
  ["a header that is not a string", ["bytes=0-1"], 1000, WHOLE],
  ["the unit items", "items=0-1", 1000, WHOLE],
  ["the multi-range bytes=0-1,5-6", "bytes=0-1,5-6", 1000, WHOLE],
  ["bytes= with no range", "bytes=", 1000, WHOLE],
  ["bytes=- with neither end", "bytes=-", 1000, WHOLE],
  ["bytes=abc", "bytes=abc", 1000, WHOLE],
  ["bytes=1-a", "bytes=1-a", 1000, WHOLE],
  ["bytes=5-3, whose end is before its start,", "bytes=5-3", 1000, WHOLE],
  ["bytes=0 - 1 with whitespace inside the range", "bytes=0 - 1", 1000, WHOLE],
  ["a first byte that is not a safe integer", "bytes=99999999999999999999-", 1000, WHOLE],

  // Not satisfiable against the length.
  ["bytes=2000-", "bytes=2000-", 1000, UNSATISFIABLE],
  ["bytes=2000-3000", "bytes=2000-3000", 1000, UNSATISFIABLE],
  ["the empty suffix bytes=-0", "bytes=-0", 1000, UNSATISFIABLE],

  // Boundaries.
  ["bytes=0-0", "bytes=0-0", 1000, range(0, 0)],
  ["bytes=999-", "bytes=999-", 1000, range(999, 999)],
  ["bytes=999-999", "bytes=999-999", 1000, range(999, 999)],
  ["bytes=1000-, one past the last byte,", "bytes=1000-", 1000, UNSATISFIABLE],
  ["bytes=1000-1000", "bytes=1000-1000", 1000, UNSATISFIABLE],
  ["the suffix bytes=-1", "bytes=-1", 1000, range(999, 999)],
  ["the suffix bytes=-1000, exactly the length,", "bytes=-1000", 1000, range(0, 999)],
  ["the suffix bytes=-1001, longer than the length,", "bytes=-1001", 1000, range(0, 999)],
  ["bytes=0-", "bytes=0-", 1, range(0, 0)],
  ["bytes=1-", "bytes=1-", 1, UNSATISFIABLE],
  ["no header", undefined, 0, WHOLE],
  ["bytes=0-", "bytes=0-", 0, UNSATISFIABLE],
  ["the suffix bytes=-1", "bytes=-1", 0, UNSATISFIABLE]
];

const said = (result) => result.kind === "range" ? `the range ${result.start}-${result.end}` : `${result.kind}`;

for (const [name, header, length, expected] of CASES) {
  test(`${name} of ${length} byte(s) is read as ${said(expected)}`, () => {
    assert.deepEqual(parseRange(header, length), expected);
  });
}
