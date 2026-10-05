import assert from "node:assert/strict";
import test from "node:test";
import { AvcPictureOrder } from "../../services/media/container/avc-picture-order.js";

function slice(count, { idr = false, reference = true } = {}) {
  let binary = "1110000" + (idr ? "1" : "") + count.toString(2).padStart(4, "0") + "1";
  binary = binary.padEnd(Math.ceil(binary.length / 8) * 8, "0");
  return Buffer.from([idr ? 0x65 : reference ? 0x41 : 0x01,
    ...binary.match(/.{8}/g).map(value => Number.parseInt(value, 2))]);
}

const parameters = { type: 0, frameNumberBits: 4, pocBits: 4, bottomFieldOrderPresent: false, separateColourPlane: false };

function numberedSlice(frame, { idr = false, reference = true, delta = "" } = {}) {
  let binary = "111" + frame.toString(2).padStart(4, "0") + (idr ? "1" : "") + delta + "1";
  binary = binary.padEnd(Math.ceil(binary.length / 8) * 8, "0");
  return Buffer.from([idr ? 0x65 : reference ? 0x41 : 0x01,
    ...binary.match(/.{8}/g).map(value => Number.parseInt(value, 2))]);
}

test("AVC type 2 retains frame-number wrap, non-reference order and IDR reset", () => {
  const order = new AvcPictureOrder({ ...parameters, type: 2 });
  assert.equal(order.read(numberedSlice(0, { idr: true })).count, 0);
  assert.equal(order.read(numberedSlice(14)).count, 28);
  assert.equal(order.read(numberedSlice(15, { reference: false })).count, 29);
  assert.equal(order.read(numberedSlice(0)).count, 32);
  assert.equal(order.read(numberedSlice(0, { idr: true })).count, 0);
});

test("AVC type 1 prices the declared reference cycle, non-reference offset and slice delta", () => {
  const order = new AvcPictureOrder({ ...parameters, type: 1, referenceOffsets: [2, 4],
    nonReferenceOffset: -1, bottomOffset: 1, deltaAlwaysZero: false });
  assert.equal(order.read(numberedSlice(0, { idr: true, delta: "1" })).count, 0);
  assert.equal(order.read(numberedSlice(1, { delta: "1" })).count, 2);
  assert.equal(order.read(numberedSlice(2, { delta: "1" })).count, 6);
  assert.equal(order.read(numberedSlice(3, { reference: false, delta: "010" })).count, 6);
});

test("AVC reference-picture wrap preserves B-frame ordering and IDR resets the count", () => {
  const order = new AvcPictureOrder(parameters);
  assert.deepEqual(order.read(slice(0, { idr: true })), { count: 0, idr: true });
  assert.equal(order.read(slice(6)).count, 6);
  assert.equal(order.read(slice(2, { reference: false })).count, 2);
  assert.equal(order.read(slice(4, { reference: false })).count, 4);
  assert.equal(order.read(slice(12)).count, 12);
  assert.equal(order.read(slice(2)).count, 18);
  assert.equal(order.read(slice(14, { reference: false })).count, 14);
  assert.deepEqual(order.read(slice(0, { idr: true })), { count: 0, idr: true });
});

test("unsupported picture-order declarations refuse timing inference", () => {
  assert.throws(() => new AvcPictureOrder({ ...parameters, type: 1 }).read(slice(0)), /supported frame/);
  assert.throws(() => new AvcPictureOrder({ ...parameters, pocBits: 17 }).read(slice(0)), /supported frame/);
});
