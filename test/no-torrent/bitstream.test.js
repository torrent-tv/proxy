/**
 * @file The one bit reader, the one RBSP rule and the one AAC table
 * (torrent-tv/meta#285): `services/media/container/bitstream.js`.
 *
 * Assumed API: `new Bits(bytes, label)` with `uint(count)`, `ue()`, `se()`,
 * `skip(count)` and the bit position `at`; `rbsp(nal, start)` returns a Buffer;
 * `AAC_SAMPLE_RATES`; `parseAudioSpecificConfig`. A read past the end throws an
 * Error whose message starts with the label and says "truncated".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Bits, rbsp, AAC_SAMPLE_RATES, parseAudioSpecificConfig } from "../../services/media/container/bitstream.js";

/** @param {string} binary @returns {Buffer} the bits, zero-padded to whole bytes */
function packed(binary) {
  return Buffer.from(binary.padEnd(Math.ceil(binary.length / 8) * 8, "0").match(/.{8}/g).map((value) => Number.parseInt(value, 2)));
}

test("Bits reads MSB first and tracks its position", () => {
  const bits = new Bits(packed("10110000" + "11111111"), "TST");
  assert.equal(bits.at, 0);
  assert.equal(bits.uint(1), 1);
  assert.equal(bits.uint(3), 0b011);
  assert.equal(bits.at, 4);
  assert.equal(bits.uint(0), 0);
  assert.equal(bits.uint(8), 0b00001111);
  assert.equal(bits.at, 12);
});

test("Bits reads 32 bits as an unsigned number", () => {
  assert.equal(new Bits(Buffer.from([0xde, 0xad, 0xbe, 0xef]), "TST").uint(32), 0xdeadbeef);
});

test("Bits reads Exp-Golomb unsigned and signed values", () => {
  const unsigned = new Bits(packed("1" + "010" + "011" + "00100" + "00101" + "0001000"), "TST");
  assert.deepEqual([unsigned.ue(), unsigned.ue(), unsigned.ue(), unsigned.ue(), unsigned.ue(), unsigned.ue()], [0, 1, 2, 3, 4, 7]);
  const signed = new Bits(packed("1" + "010" + "011" + "00100" + "00101"), "TST");
  assert.deepEqual([signed.se(), signed.se(), signed.se(), signed.se(), signed.se()].map((value) => value + 0), [0, 1, -1, 2, -2]);
});

test("Bits skips bits, including more than one word at a time", () => {
  const bits = new Bits(Buffer.alloc(16, 0xff), "TST");
  bits.skip(3);
  assert.equal(bits.at, 3);
  bits.skip(70);
  assert.equal(bits.at, 73);
  bits.skip(0);
  assert.equal(bits.at, 73);
});

test("Bits is bounded: reading or skipping past the end throws under its own label", () => {
  const bits = new Bits(Buffer.from([0xa5]), "TST");
  assert.equal(bits.uint(8), 0xa5, "reading exactly to the end is allowed");
  assert.throws(() => bits.uint(1), /^Error: TST .*truncated/);
  assert.throws(() => new Bits(Buffer.from([0xa5]), "OTHER").uint(9), /^Error: OTHER .*truncated/);
  assert.throws(() => new Bits(Buffer.from([0xa5]), "TST").skip(9), /^Error: TST .*truncated/);
  assert.throws(() => new Bits(Buffer.alloc(0), "TST").ue(), /^Error: TST .*truncated/);
});

test("Bits refuses an Exp-Golomb value of more than 31 leading zeros under its label", () => {
  assert.throws(() => new Bits(Buffer.alloc(8), "TST").ue(), /^Error: TST Exp-Golomb value is invalid/);
});

test("rbsp strips the emulation prevention byte after two zeros and keeps everything else", () => {
  assert.deepEqual(rbsp(Buffer.from([0x65, 0x80, 0, 0, 3, 1, 7]), 1), Buffer.from([0x80, 0, 0, 1, 7]));
  assert.deepEqual(rbsp(Buffer.from([0x65, 0x80, 0, 0, 3, 0, 0, 3, 2]), 1), Buffer.from([0x80, 0, 0, 0, 0, 2]));
  assert.deepEqual(rbsp(Buffer.from([0x65, 0, 3, 5]), 1), Buffer.from([0, 3, 5]), "one zero does not make 03 an escape");
  assert.deepEqual(rbsp(Buffer.from([0x65, 0, 0, 0, 3]), 1), Buffer.from([0, 0, 0]), "a trailing escape byte is dropped");
});

test("rbsp is lenient: 00 00 03 followed by a byte above 3 is accepted and the 03 dropped", () => {
  assert.deepEqual(rbsp(Buffer.from([0x65, 0x80, 0, 0, 3, 4]), 1), Buffer.from([0x80, 0, 0, 4]));
  assert.deepEqual(rbsp(Buffer.from([0x65, 0, 0, 3, 0xff, 0, 0, 3]), 1), Buffer.from([0, 0, 0xff, 0, 0]));
});

test("rbsp starts at the given offset (one byte of AVC header, two of HEVC) and leaves its input alone", () => {
  const avc = Buffer.from([0x67, 0x42, 0, 0, 3, 1]);
  const hevc = Buffer.from([0x42, 0x01, 0x42, 0, 0, 3, 1]);
  const before = Buffer.from(avc);
  assert.deepEqual(rbsp(avc, 1), Buffer.from([0x42, 0, 0, 1]));
  assert.deepEqual(rbsp(hevc, 2), Buffer.from([0x42, 0, 0, 1]));
  assert.deepEqual(avc, before);
  assert.ok(Buffer.isBuffer(rbsp(avc, 1)));
  assert.equal(rbsp(Buffer.from([0x67]), 1).length, 0);
});

test("the AAC sampling-frequency table is ISO/IEC 14496-3 Table 1.18 and written once", () => {
  assert.deepEqual([...AAC_SAMPLE_RATES], [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]);
});

test("one AudioSpecificConfig parser is exported and reads a plain AAC-LC configuration", () => {
  assert.equal(typeof parseAudioSpecificConfig, "function");
  const parsed = parseAudioSpecificConfig(Buffer.from([0x11, 0x90]));
  assert.equal(parsed.sampleRate, 48000);
  assert.equal(parsed.channels, 2);
});
