/**
 * @file Bitstream reading is written once (torrent-tv/meta#285).
 *
 * Acceptance 3 of the issue as a static check, plus the leftovers it names:
 * the RBSP rule (`zeroes >= 2 && byte === 3`), the MSB-first bit read
 * (`>> (7 - (`) and the AAC sampling-frequency table live only in
 * `services/media/container/bitstream.js`; `firstUe`, `readPicStruct` and the
 * local readers are gone; the three elementary indexes share one stamp queue.
 * The lines are read raw, comments included, as the grep of the issue reads them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { jsFilesUnder, sourceOf } from "./helpers/source-text.js";

const BITSTREAM = "services/media/container/bitstream.js";
const INDEXES = ["h264-elementary-index.js", "hevc-elementary-index.js", "mpeg-elementary-index.js"].map((name) => `services/media/container/${name}`);

/** @returns {Array<{ file: string, lines: string[] }>} every proxy source file, raw, named from the proxy root */
function sources() {
  return jsFilesUnder("services").map((file) => {
    const name = file.slice(file.indexOf("services/"));
    return { file: name, lines: sourceOf(name).split("\n") };
  });
}

/** @returns {string[]} `file:line: text` of every line outside bitstream.js that matches */
function outsideBitstream(matches) {
  return sources().filter(({ file }) => file !== BITSTREAM).flatMap(({ file, lines }) =>
    lines.flatMap((line, at) => (matches.test(line) ? [`${file}:${at + 1}: ${line.trim()}`] : [])));
}

test("bitstream.js exists in media/container and imports only its own layer", () => {
  const found = sources().find(({ file }) => file === BITSTREAM);
  assert.ok(found, `${BITSTREAM} does not exist`);
  const specifiers = [...found.lines.join("\n").matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]);
  const outside = specifiers.filter((specifier) => !specifier.startsWith("node:") && !/^\.\/[\w-]+\.js$/.test(specifier));
  assert.deepEqual(outside, [], "media/container imports only its own layer");
});

test("the emulation-prevention rule is written only in bitstream.js", () => {
  assert.deepEqual(outsideBitstream(/zeroes\s*>=\s*2\s*&&\s*byte\s*===\s*3/), []);
});

test("the MSB-first bit read is written only in bitstream.js", () => {
  assert.deepEqual(outsideBitstream(/>>\s*\(7\s*-\s*\(/), []);
});

test("the AAC sampling-frequency table is written only in bitstream.js", () => {
  assert.deepEqual(outsideBitstream(/\b88200\b/), []);
});

test("firstUe, readPicStruct and every local bit reader or RBSP are gone", () => {
  assert.deepEqual(outsideBitstream(/\b(firstUe|readPicStruct|unescapeNal|bitReader)\b|function (reader|rbsp)\(|class Bits\b/), []);
});

test("every file that reads bits imports them from bitstream.js", () => {
  const users = sources().filter(({ file, lines }) => file !== BITSTREAM && lines.some((line) => /\bnew Bits\(|\brbsp\(/.test(line)));
  assert.ok(users.length >= 6, `expected the parsers to use bitstream.js, found ${users.map(({ file }) => file).join(", ")}`);
  const offenders = users.filter(({ lines }) => !lines.some((line) => /^import .*\bfrom "(\.\/|(\.\.\/)+media\/container\/|\.\.\/container\/)bitstream\.js"/.test(line)));
  assert.deepEqual(offenders.map(({ file }) => file), []);
});

test("the three elementary indexes share one stamp queue and address map, none keeps its own copy", () => {
  for (const file of INDEXES) {
    const code = sourceOf(file);
    assert.ok(!/stamps\.shift\(\)/.test(code), `${file} keeps its own stamp queue`);
    assert.ok(!/mappings\.filter\(/.test(code), `${file} keeps its own address map`);
  }
  const holders = sources().filter(({ file, lines }) => file.startsWith("services/media/container/") && lines.some((line) => /stamps\.shift\(\)/.test(line)));
  assert.equal(holders.length, 1, `exactly one class holds the stamp queue, found: ${holders.map(({ file }) => file).join(", ")}`);
});

test("SeiTiming keeps per-byte streaming: it takes one byte at a time and never buffers the NAL", () => {
  const code = sourceOf("services/media/container/h264-elementary-index.js");
  const start = code.indexOf("class SeiTiming");
  assert.notEqual(start, -1, "SeiTiming stays a class of the AVC index");
  const body = code.slice(start, code.indexOf("\n}\n", start));
  assert.ok(/\bpush\(byte\)/.test(body), "SeiTiming.push takes one byte");
  assert.ok(!/rbsp\(|Buffer\.concat|Buffer\.from\(this\.#(nal|all|buffer)/.test(body), "SeiTiming buffers the NAL");
});
