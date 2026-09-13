import assert from "node:assert/strict";
import test from "node:test";
import { bodySender } from "../services/data-channel-handler.js";

/**
 * Drives the sender over a body arriving in the given read sizes, and answers
 * both what reached the far end and what was written — so "the body is
 * unchanged" is asserted against the body rather than against a length.
 *
 * @param {number}   sizeBytes
 * @param {number[]} readSizes - The sizes the body read hands over, in order.
 * @returns {{ sent: Buffer[], counted: number, written: Buffer }}
 */
function sendBody(sizeBytes, readSizes) {
  /** @type {Buffer[]} */
  const sent = [];
  const sender = bodySender((bytes) => sent.push(Buffer.from(bytes)), sizeBytes);
  /** @type {Buffer[]} */
  const written = [];
  let counted = 0;
  let next = 0;
  for (const size of readSizes) {
    const block = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) {
      block[index] = next & 0xff;
      next += 1;
    }
    written.push(block);
    counted += sender.push(block);
  }
  counted += sender.flush();
  return { sent, counted, written: Buffer.concat(written) };
}

test("with no size chosen, one body read is one message", () => {
  const { sent, counted } = sendBody(0, [1000, 2000, 3]);
  assert.deepEqual(
    sent.map((message) => message.length),
    [1000, 2000, 3]
  );
  assert.equal(counted, 3);
});

test("a smaller size cuts a body read into messages of exactly that size", () => {
  const { sent, counted } = sendBody(400, [1000]);
  assert.deepEqual(
    sent.map((message) => message.length),
    [400, 400, 200]
  );
  assert.equal(counted, 3);
});

test("a larger size joins body reads until it is filled", () => {
  const { sent } = sendBody(2500, [1000, 1000, 1000, 1000]);
  assert.deepEqual(
    sent.map((message) => message.length),
    [2500, 1500]
  );
});

test("every byte arrives once, in order, whatever the size", () => {
  for (const size of [0, 1, 7, 400, 2500, 999_999]) {
    const { sent, written } = sendBody(size, [1000, 3, 5000, 17]);
    assert.deepEqual(Buffer.concat(sent), written, `size ${size} changed the body`);
  }
});

test("a size larger than the whole body still sends it, once, on flush", () => {
  const { sent, written, counted } = sendBody(10_000, [100, 200]);
  assert.equal(sent.length, 1);
  assert.equal(counted, 1);
  assert.deepEqual(sent[0], written);
});

test("the count is of messages, which is what a reading is attributed to", () => {
  // 163 messages for 10 657 210 bytes is the field reading of 2026-09-12; at
  // 16 KB the same body is 651 of them, and that difference is the measurement.
  const { counted } = sendBody(16 * 1024, [10_657_210]);
  assert.equal(counted, Math.ceil(10_657_210 / (16 * 1024)));
});

test("nothing is sent for an empty body, and flush has nothing to release", () => {
  const { sent, counted } = sendBody(400, []);
  assert.deepEqual(sent, []);
  assert.equal(counted, 0);
});
