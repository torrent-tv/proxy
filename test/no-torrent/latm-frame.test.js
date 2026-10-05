import assert from "node:assert/strict";
import test from "node:test";
import { LatmFrames } from "../../services/media/container/latm-frame.js";
import { bitPayloadSlices } from "../../services/encode/bit-payload.js";

function loas(bits) {
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0");
  const payload = Buffer.from(padded.match(/.{8}/g).map(byte => Number.parseInt(byte, 2)));
  return Buffer.concat([Buffer.from([0x56, 0xe0 | (payload.length >> 8), payload.length & 255]), payload]);
}

function configured(asc, version = 0) {
  const header = version ? "010" + "0000000000" + "10000000000000" + "00" + asc.length.toString(2).padStart(8, "0")
    : "0010000000000000";
  return loas(header + asc + "0001111111100" + "00000010" + "1010101010111011");
}

test("explicit SBR and parametric stereo preserve core-frame duration and output configuration", () => {
  for (const [type, channels] of [[5, 1], [29, 2]]) {
    const asc = type.toString(2).padStart(5, "0") + "0110" + "0001" + "0011" + "00010" + "000";
    const bytes = configured(asc);
    const frame = new LatmFrames().read(bytes);
    assert.equal(frame.sampleRate, 48000);
    assert.equal(frame.channels, channels);
    assert.equal(frame.duration, 1024 / 24000);
    assert.deepEqual(Buffer.concat(bitPayloadSlices([bytes], frame.bitOffset, frame.bitLength)), Buffer.from([0xaa, 0xbb]));
  }
});

test("LATM version 1 retains the entire declared decoder configuration", () => {
  const asc = "0001000110001000" + "00000000";
  const frame = new LatmFrames().read(configured(asc, 1));
  assert.equal(frame.codecPrivateB64, Buffer.from([0x11, 0x88, 0]).toString("base64"));
  assert.equal(frame.sampleRate, 48000);
});

test("an AAC program configuration locates a paired output channel", () => {
  let asc = "00010" + "0011" + "0000" + "000";
  asc += "0000" + "01" + "0011" + "0001" + "0000" + "0000" + "00" + "000" + "0000" + "000" + "10000";
  asc = asc.padEnd(Math.ceil(asc.length / 8) * 8, "0") + "00000000";
  const bytes = configured(asc);
  const frame = new LatmFrames().read(bytes);
  assert.equal(frame.channels, 2);
  assert.equal(frame.sampleRate, 48000);
  assert.deepEqual(Buffer.concat(bitPayloadSlices([bytes], frame.bitOffset, frame.bitLength)), Buffer.from([0xaa, 0xbb]));
});

test("LATM stream configuration and reused configuration locate unaligned AAC payloads", () => {
  const reader = new LatmFrames();
  // One program/layer/subframe, AAC-LC at 48 kHz mono, variable packet length.
  const first = loas("0010000000000000" + "0001000110001000" + "0001111111100" + "00000010" + "1010101010111011");
  const frame = reader.read(first);
  assert.equal(frame.sampleRate, 48000);
  assert.equal(frame.channels, 1);
  assert.equal(frame.duration, 1024 / 48000);
  assert.equal(frame.codecPrivateB64, Buffer.from([0x11, 0x88]).toString("base64"));
  assert.deepEqual(Buffer.concat(bitPayloadSlices([first], frame.bitOffset, frame.bitLength)), Buffer.from([0xaa, 0xbb]));
  const next = loas("1" + "00000010" + "1100110011011101");
  const repeated = reader.read(next);
  assert.deepEqual(Buffer.concat(bitPayloadSlices([next.subarray(0, 4), next.subarray(4)], repeated.bitOffset, repeated.bitLength)), Buffer.from([0xcc, 0xdd]));
  assert.equal(repeated.codecPrivateB64, frame.codecPrivateB64);
});

test("missing, truncated and damaged LATM configuration never produces a packet", () => {
  const reader = new LatmFrames();
  assert.throws(() => reader.read(loas("10000000110101010")), /precedes/);
  assert.deepEqual(reader.read(Buffer.from([0x56, 0xe0, 10, 0])), { size: 13 });
  assert.throws(() => reader.read(Buffer.from([0x57, 0xe0, 1, 0])), /synchronization/);
  assert.throws(() => reader.read(loas("000")), /multiplexed|truncated/);
});

test("bit payload normalization preserves every alignment across borrowed fragments", () => {
  const source = Buffer.from(Array.from({ length: 40 }, (_unused, index) => (index * 37 + 13) & 255));
  const bits = [...source].map(byte => byte.toString(2).padStart(8, "0")).join("");
  for (let shift = 0; shift < 8; shift++) {
    const offset = 8 + shift, length = 24 * 8;
    const expected = Buffer.from(bits.slice(offset, offset + length).match(/.{8}/g).map(byte => Number.parseInt(byte, 2)));
    const actual = bitPayloadSlices([source.subarray(0, 2), source.subarray(2, 7), source.subarray(7)], offset, length);
    assert.deepEqual(Buffer.concat(actual), expected);
    if (shift === 0) assert.equal(actual[0].buffer, source.buffer);
  }
  assert.throws(() => bitPayloadSlices([source], 1, source.length * 8), /incomplete/);
});
