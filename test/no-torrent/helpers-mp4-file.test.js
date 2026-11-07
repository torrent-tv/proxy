/**
 * @file The MP4 byte builders every check shares: `box`, `fullBox`, `u32`.
 *
 * They are the ORACLE for the container readers and the segment writers, so
 * what they emit is stated here as literal bytes — never computed by the code
 * under test, and never by a production writer. Before they were shared, nineteen
 * test files each carried a copy; the bytes below are what those copies wrote,
 * and a migration must not change one of them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { box, fullBox, u32 } from "./helpers/mp4-file.js";

const hex = (bytes) => Buffer.from(bytes).toString("hex");

test("u32 writes each value as four big-endian bytes, in order", () => {
  assert.equal(hex(u32(1, 2, 0xffffffff)), "0000000100000002ffffffff");
  assert.equal(hex(u32(1000, 4000)), "000003e800000fa0");
});

test("u32 of one value is four bytes, of none is empty", () => {
  assert.equal(hex(u32(0)), "00000000");
  assert.equal(u32().length, 0);
});

test("u32 keeps a negative value as its unsigned four bytes (the copies that used `>>> 0` did)", () => {
  assert.equal(hex(u32(-1)), "ffffffff");
});

test("box is a four-byte size that counts its own header, the four-character type, then the payload", () => {
  assert.equal(hex(box("ftyp", Buffer.from("isom"))), "0000000c6674797069736f6d");
  assert.equal(hex(box("free", Buffer.alloc(0))), "0000000866726565");
});

test("box accepts several parts, Buffers or strings, as one payload (init-compat's form)", () => {
  assert.equal(hex(box("moov", "ab", Buffer.from([1]))), "0000000b6d6f6f766162" + "01");
});

test("box writes its type as latin1, so a type such as ©nam is one byte a9, not two", () => {
  assert.equal(hex(box("©nam", Buffer.from([1]))), "00000009a96e616d01");
});

test("box returns a fresh Buffer of the stated length", () => {
  const payload = Buffer.alloc(100, 7);
  const made = box("mdat", payload);
  assert.ok(Buffer.isBuffer(made));
  assert.equal(made.length, 108);
  assert.equal(made.readUInt32BE(0), 108);
});

test("fullBox is a box whose payload starts with four zero bytes of version and flags", () => {
  assert.equal(hex(fullBox("mdhd", u32(1000, 4000))), "000000146d64686400000000000003e800000fa0");
  assert.equal(hex(fullBox("mdhd", u32(1000, 4000))), hex(box("mdhd", Buffer.concat([Buffer.alloc(4), u32(1000, 4000)]))));
});

test("boxes nest by their payload", () => {
  assert.equal(
    hex(box("moov", box("trak", fullBox("tkhd", Buffer.from([7]))))),
    "0000001d6d6f6f76000000157472616b0000000d746b68640000000007"
  );
});

test("fullBox takes an optional version for the leading byte (mp4-composition-times wrote `version` there)", () => {
  assert.equal(hex(fullBox("ctts", u32(7), { version: 1 })), "000000106374747301000000" + "00000007");
  assert.equal(hex(fullBox("ctts", u32(7), { version: 0 })), hex(fullBox("ctts", u32(7))));
});
