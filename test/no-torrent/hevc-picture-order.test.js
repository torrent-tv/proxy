import assert from "node:assert/strict";
import test from "node:test";
import { HevcPictureOrder } from "../../services/media/container/hevc-picture-order.js";

function bytes(binary) {
  return Buffer.from(binary.padEnd(Math.ceil(binary.length / 8) * 8, "0").match(/.{8}/g).map(value => Number.parseInt(value, 2)));
}
const pps = Buffer.concat([Buffer.from([68, 1]), bytes("11000001")]);
function slice(count, type = 1, temporalId = 0) {
  const irap = type >= 16 && type <= 23, idr = type === 19 || type === 20;
  return Buffer.concat([Buffer.from([type << 1, temporalId + 1]),
    bytes("1" + (irap ? "0" : "") + "1" + "011" + (idr ? "" : count.toString(2).padStart(4, "0")) + "1")]);
}

test("HEVC picture-order wrap uses reference temporal-zero pictures and resets at IDR", () => {
  const order = new HevcPictureOrder({ orderBits: 4 }, pps);
  assert.deepEqual(order.read(slice(0, 19)), { count: 0, reset: true });
  assert.equal(order.read(slice(6)).count, 6);
  assert.equal(order.read(slice(2, 0)).count, 2);
  assert.equal(order.read(slice(4, 1, 1)).count, 4);
  assert.equal(order.read(slice(12)).count, 12);
  assert.equal(order.read(slice(2)).count, 18);
  assert.equal(order.read(slice(14, 8)).count, 14);
  assert.deepEqual(order.read(slice(0, 19)), { count: 0, reset: true });
});

test("a first CRA starts a new count and invalid HEVC order declarations are refused", () => {
  assert.deepEqual(new HevcPictureOrder({ orderBits: 4 }, pps).read(slice(12, 21)), { count: 12, reset: true });
  assert.throws(() => new HevcPictureOrder({ orderBits: 17 }, pps), /declarations/);
  assert.throws(() => new HevcPictureOrder({ orderBits: 4 }, pps).read(Buffer.from([2, 1, 0])), /first slice/);
});
