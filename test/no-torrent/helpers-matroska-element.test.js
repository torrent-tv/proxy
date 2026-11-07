/**
 * @file `element` of `helpers/matroska-file.js`, extended with a stated size
 * width, and the two deliberate departures from the default.
 *
 * Nine test files wrote their own EBML builder. Four wrote the same bytes as the
 * helper (a four-byte size, `0001xxxx` in the leading byte). Two chose another
 * width ON PURPOSE, because the width is part of what they check:
 * `matroska-packet-index` writes a ONE-byte size, and `chapters` writes the
 * SMALLEST size that fits. The bytes below are what those copies wrote; the
 * expected values are literal so the oracle is not computed by the code under test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ID, element, idBytes, uint32Element, uintElement, stringElement } from "./helpers/matroska-file.js";

const hex = (bytes) => Buffer.from(bytes).toString("hex");

test("the default size is four bytes, `0001xxxx` first, whatever the payload", () => {
  assert.equal(hex(element(0xae, Buffer.from([1, 2, 3]))), "ae10000003010203");
  assert.equal(hex(element(0x2ad7b1, Buffer.from([0x0f, 0x42, 0x40]))), "2ad7b1100000030f4240");
});

test("the default and an explicit sizeWidth of 4 are the same bytes", () => {
  const payload = Buffer.alloc(300, 9);
  assert.equal(hex(element(ID.CLUSTER, payload)), hex(element(ID.CLUSTER, payload, { sizeWidth: 4 })));
  assert.equal(hex(element(ID.CLUSTER, payload, {})), hex(element(ID.CLUSTER, payload)));
});

test("an identifier keeps the bytes it has, one to four", () => {
  assert.equal(hex(element(ID.EBML, Buffer.alloc(0))), "1a45dfa310000000");
  assert.equal(hex(idBytes(0xec)), "ec");
  assert.equal(hex(idBytes(0x4dbb)), "4dbb");
});

test("a one-byte size is `1xxxxxxx` (matroska-packet-index)", () => {
  assert.equal(
    hex(element(ID.CLUSTER, Buffer.from([1, 2, 3]), { sizeWidth: 1 })),
    "1f43b67583010203"
  );
  assert.equal(hex(element(0xe7, Buffer.from([0]), { sizeWidth: 1 })), "e78100");
});

test("a fixed width wider than one byte puts the width marker where the format does", () => {
  assert.equal(hex(element(0xae, Buffer.alloc(5), { sizeWidth: 2 })), "ae4005" + "00".repeat(5));
  assert.equal(hex(element(0xae, Buffer.alloc(5), { sizeWidth: 3 })), "ae200005" + "00".repeat(5));
});

test("a payload that does not fit the stated width is refused, not written with a wrong size", () => {
  assert.throws(() => element(0xae, Buffer.alloc(127), { sizeWidth: 1 }));
  assert.throws(() => element(0xae, Buffer.alloc(16383), { sizeWidth: 2 }));
});

test('sizeWidth "minimal" is the smallest size that fits; all-ones is reserved for "unknown" (chapters)', () => {
  const sizeOf = (length) => hex(element(0xb6, Buffer.alloc(length), { sizeWidth: "minimal" })).slice(2, 2 + 2 * (length < 127 ? 1 : length < 16383 ? 2 : 3));
  assert.equal(sizeOf(0), "80");
  assert.equal(sizeOf(1), "81");
  assert.equal(sizeOf(126), "fe");
  assert.equal(sizeOf(127), "407f");
  assert.equal(sizeOf(128), "4080");
  assert.equal(sizeOf(16382), "7ffe");
  assert.equal(sizeOf(16383), "203fff");
});

test("the other builders of the helper still write four-byte sizes", () => {
  assert.equal(hex(uintElement(0xd7, 1)), "d71000000101");
  assert.equal(hex(uint32Element(0xb3, 5)), "b3100000040000" + "0005");
  assert.equal(hex(stringElement(0x86, "V")), "861000000156");
});
