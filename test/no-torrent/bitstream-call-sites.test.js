/**
 * @file The parsers that read bits keep what they read and the labels they
 * throw, and the places that disagreed now agree (torrent-tv/meta#285).
 *
 * New behaviour (fails before the change): a slice with `00 00 03 04` passes
 * through the AVC index; an AudioSpecificConfig with SBR/PS or a PCE gives the
 * same channels and rate from `parseAudioSpecificConfig` (audio-bound.js) and
 * from `LatmFrames.read` (latm-frame.js); an SEI carrying `00 00 03 05` is read.
 * Pins (pass before and after): the facts read from representative fixtures and
 * the error labels that appear in logs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import ffmpegBin from "ffmpeg-static";
import { H264ElementaryIndex } from "../../services/media/container/h264-elementary-index.js";
import { PacketIndex } from "../../services/media/container/PacketIndex.js";
import { LatmFrames } from "../../services/media/container/latm-frame.js";
import { ac3Frame } from "../../services/media/container/ac3-frame.js";
import { dtsFrame } from "../../services/media/container/dts-frame.js";
import { mpegVideoConfiguration } from "../../services/media/container/mpeg-video-configuration.js";
import { hevcSequence } from "../../services/media/container/hevc-configuration.js";
import { h264Configuration } from "../../services/media/container/h264-configuration.js";
import { parseAudioSpecificConfig } from "../../services/media/tracks/audio-bound.js";
import { configuration } from "./helpers/avc-configuration.js";

/** @param {string} binary @returns {Buffer} the bits, zero-padded to whole bytes */
function packed(binary) {
  return Buffer.from(binary.padEnd(Math.ceil(binary.length / 8) * 8, "0").match(/.{8}/g).map((value) => Number.parseInt(value, 2)));
}
const unit = (bytes) => Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(bytes)]);

/** SPS and PPS of `configuration()` as Annex B units. */
function declarations(options) {
  const avcc = configuration(options);
  return Buffer.concat([unit(avcc.subarray(8, 8 + avcc.readUInt16BE(6))), unit([0x68, 0xe0])]);
}

/**
 * Index `chunks` (each `[bytes, stamp]`) as one AVC elementary stream, pushed in `piece`-byte pieces.
 * @returns {{ packets: object[] }} the packets the index holds
 */
function indexAvc(options, chunks, piece = Infinity) {
  const track = { trackNumber: 1, type: "video", codecId: "h264" };
  const index = new PacketIndex();
  index.declareTrack(1, { type: "video", reorderDepth: 2 });
  const reader = new H264ElementaryIndex(track, index);
  let position = 0;
  for (const [bytes, stamp] of [[declarations(options), { pts: 0, dts: 0 }], ...chunks]) {
    for (let at = 0; at < bytes.length; at += Math.min(piece, bytes.length)) {
      reader.push(bytes.subarray(at, at + piece), position + at, at === 0 ? stamp : undefined);
    }
    position += bytes.length;
  }
  reader.complete();
  return index.inputFor({ trackId: 1, from: 0, to: 1 });
}

const slice = (header, rest) => unit([header, ...rest]);

test("an AVC slice containing 00 00 03 04 passes through H264ElementaryIndex", () => {
  const result = indexAvc({}, [
    [slice(0x65, [0x80, 0, 0, 3, 4]), { pts: 0, dts: 0 }],
    [slice(0x41, [0x80, 0, 0, 3, 4, 1]), { pts: 0.04, dts: 0.04 }]]);
  assert.equal(result.kind, "result");
  assert.deepEqual(result.packets.map((packet) => packet.keyframe), [true, false]);
  assert.deepEqual(result.packets.map((packet) => Math.round(packet.duration * 1000)), [40, 40]);
});

test("AVC indexing of ordinary slices is the same in any chunking and keeps exact ranges", () => {
  const stream = [[slice(0x65, [0x80, 0, 0, 3, 1]), { pts: 0, dts: 0 }], [slice(0x41, [0x80, 9]), { pts: 0.04, dts: 0.04 }]];
  const whole = indexAvc({}, stream);
  assert.equal(whole.kind, "result");
  assert.equal(whole.packets.length, 2);
  for (const piece of [1, 2, 5]) {
    const split = indexAvc({}, stream, piece);
    assert.deepEqual(split.packets.map(({ pts, dts, duration, keyframe }) => ({ pts, dts, duration, keyframe })),
      whole.packets.map(({ pts, dts, duration, keyframe }) => ({ pts, dts, duration, keyframe })));
    assert.equal(split.ranges.length, 1, "contiguous bytes make one range whatever the chunking");
  }
});

// SEI, type 1 (picture timing), `00 00 03 05` escaped inside a three byte payload `00 00 05`: pic_struct 0.
const seiEscaped = unit([6, 1, 3, 0, 0, 3, 5, 0x80]);
const seiPlain = unit([6, 1, 1, 0x80, 0x80]);

test("SEI timing is streamed per byte: chunking does not change what is read", () => {
  const stream = [[slice(0x65, [0x80]), { pts: 0, dts: 0 }], [seiPlain, undefined], [slice(0x41, [0x80]), { pts: 0.04, dts: 0.04 }]];
  const options = { picStruct: true };
  const whole = indexAvc(options, stream);
  assert.deepEqual(whole.packets.map((packet) => packet.duration), [0.04, 0.12]);
  for (const piece of [1, 2, 3]) {
    assert.deepEqual(indexAvc(options, stream, piece).packets.map((packet) => packet.duration), [0.04, 0.12]);
  }
});

test("a large unrelated SEI payload is skipped without disturbing the timing SEI that follows it", () => {
  const big = unit([6, 5, 255, 255, 40, ...new Array(550).fill(7), 0x80]);
  const stream = [[slice(0x65, [0x80]), { pts: 0, dts: 0 }], [big, undefined], [seiPlain, undefined], [slice(0x41, [0x80]), { pts: 0.04, dts: 0.04 }]];
  assert.deepEqual(indexAvc({ picStruct: true }, stream, 7).packets.map((packet) => packet.duration), [0.04, 0.12]);
});

test("an SEI carrying 00 00 03 05 is read with the same lenient rule as the slice", () => {
  const stream = [[slice(0x65, [0x80]), { pts: 0, dts: 0 }], [seiEscaped, undefined], [slice(0x41, [0x80]), { pts: 0.04, dts: 0.04 }]];
  for (const piece of [Infinity, 1]) {
    assert.deepEqual(indexAvc({ picStruct: true }, stream, piece).packets.map((packet) => packet.duration), [0.04, 0.04]);
  }
});

/** Declarations, one SEI, and `complete()` must throw. */
const sei = (bytes, options = { picStruct: true }) => () => indexAvc(options, [[slice(0x65, [0x80]), { pts: 0, dts: 0 }], [unit(bytes), undefined]]);

test("labels of moved AVC code stay in the log", () => {
  assert.throws(sei([6, 1, 0, 0x80]), /AVC SEI picture timing is truncated\./);
  assert.throws(sei([6, 1, 1, 0x90, 0x80]), /AVC SEI picture structure is reserved\./);
  assert.throws(sei([6, 1, 1, 0x80]), /AVC SEI payload or trailing bits are incomplete\./);
  assert.throws(() => indexAvc({}, [[unit([0x65]), { pts: 0, dts: 0 }]]), /AVC slice header is truncated\./);
  assert.throws(() => indexAvc({}, [[slice(0x65, [0, 0, 0, 0, 0, 0x80]), { pts: 0, dts: 0 }]]), /AVC first macroblock is invalid\./);
});

test("the AVC SPS keeps its facts and its bit-reader label", () => {
  const facts = h264Configuration(configuration());
  assert.deepEqual({ width: facts.width, height: facts.height, fps: facts.fps, bitDepth: facts.bitDepth }, { width: 64, height: 64, fps: 25, bitDepth: 8 });
  assert.throws(() => h264Configuration(configuration().subarray(0, 11)), /SPS exceeds/);
});

test("the HEVC SPS keeps its bit-reader label when truncated", () => {
  const sps = Buffer.from("42010101600000030090000003000003001ea020810596566924caf0168080000003008000000504", "hex");
  assert.equal(hevcSequence(sps).width, 64);
  assert.throws(() => hevcSequence(sps.subarray(0, 18)), /HEVC SPS bits are truncated\./);
});

// ---- AudioSpecificConfig: two former call sites, one answer ----------------

/** A LOAS frame holding a LATM stream with `asc` (bits) as its decoder configuration. */
function loas(asc) {
  return loasOf("0010000000000000" + asc + "0001111111100" + "00000010" + "1010101010111011");
}
/** A LOAS frame around raw `bits`. */
function loasOf(bits) {
  const payload = packed(bits);
  return Buffer.concat([Buffer.from([0x56, 0xe0 | (payload.length >> 8), payload.length & 255]), payload]);
}
const SBR = "00101" + "0110" + "0001" + "0011" + "00010" + "000";
const PS = "11101" + "0110" + "0001" + "0011" + "00010" + "000";
/** AAC-LC, 48 kHz, channelConfiguration 0: a program configuration element declares one paired front channel. */
const PCE = (() => {
  const asc = "00010" + "0011" + "0000" + "000"
    + "0000" + "01" + "0011" + "0001" + "0000" + "0000" + "00" + "000" + "0000" + "000" + "10000";
  return asc.padEnd(Math.ceil(asc.length / 8) * 8, "0") + "00000000";
})();

for (const [name, asc, channels] of [["explicit SBR", SBR, 1], ["parametric stereo", PS, 2], ["a program configuration element", PCE, 2]]) {
  test(`${name}: audio-bound and latm-frame give the same channels and rate`, () => {
    const fromBound = parseAudioSpecificConfig(packed(asc));
    const fromLatm = new LatmFrames().read(loas(asc));
    assert.ok(fromBound, "audio-bound reads the configuration");
    assert.equal(fromLatm.channels, channels);
    assert.equal(fromBound.channels, fromLatm.channels, "channels");
    assert.ok(fromBound.sampleRate > 0);
    assert.equal(fromBound.sampleRate, fromLatm.sampleRate, "sample rate");
  });
}

test("labels of moved LATM code stay in the log", () => {
  assert.throws(() => new LatmFrames().read(loas("00111" + "0011" + "0010" + "000")), /AAC LATM requires a supported declared audio configuration\./);
  assert.throws(() => new LatmFrames().read(Buffer.from([0x57, 0xe0, 1, 0])), /AAC LOAS synchronization is invalid\./);
  assert.throws(() => new LatmFrames().read(loasOf("000")), /AAC LATM SPS bits are truncated\.|multiplexed/);
});

// ---- AC-3, DTS, MPEG video -------------------------------------------------

test("AC-3 keeps its facts and its labels, and a frame shorter than its header is refused by label", () => {
  const header = Buffer.from([0x0b, 0x77, 0, 0, 0x40, 8 << 3, 0x40]);
  assert.deepEqual(ac3Frame(header), { size: 138, sampleRate: 44100, channels: 2, duration: 1536 / 44100, codecId: "ac3" });
  for (let length = 0; length < 7; length++) {
    assert.throws(() => ac3Frame(header.subarray(0, length)), /^Error: AC-3 .*(synchronization is invalid|truncated)/);
  }
  assert.throws(() => ac3Frame(Buffer.from([0x0b, 0x77, 0, 0, 0x40, 17 << 3, 0x40])), /AC-3 bitstream version is invalid\./);
  assert.throws(() => ac3Frame(Buffer.from([0x0b, 0x77, 0, 0, 0xff, 8 << 3, 0x40])), /AC-3 frame parameters are invalid\./);
});

test("DTS core frames from a real encoder keep their facts and the truncation label", () => {
  const made = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=sample_rate=48000",
    "-t", "0.1", "-c:a", "dca", "-strict", "-2", "-f", "dts", "pipe:1"], { windowsHide: true });
  assert.equal(made.status, 0, made.stderr.toString());
  const stream = made.stdout;
  let at = 0, frames = 0;
  while (at < stream.length) {
    const frame = dtsFrame(stream.subarray(at));
    assert.equal(frame.codecId, "dts");
    assert.equal(frame.sampleRate, 48000);
    assert.equal(frame.channels, 1);
    assert.ok(frame.duration > 0);
    at += frame.size;
    frames++;
  }
  assert.equal(at, stream.length, "frames tile the stream exactly");
  assert.ok(frames > 1);
  assert.throws(() => dtsFrame(stream.subarray(0, 23)), /DTS core header is truncated\./);
  assert.throws(() => dtsFrame(Buffer.concat([Buffer.from([0x7f, 0xfe, 0x80, 0x01]), Buffer.alloc(20)]).subarray(0, 24)), /DTS/);
});

/** MPEG-1/2 sequence header with 352x288 at 25 fps, optionally with a sequence extension. */
function mpegSequence({ extension }) {
  const header = "000000000000000000000001" + "10110011" + (352).toString(2).padStart(12, "0") + (288).toString(2).padStart(12, "0")
    + "0001" + "0011" + "0".repeat(18) + "1" + "0".repeat(10) + "0" + "0" + "0";
  const ext = extension ? "000000000000000000000001" + "10110101" + "0001" + "0".repeat(8) + "1" + "01" + "00" + "00" + "0".repeat(12) + "1"
    + "0".repeat(8) + "0" + "00" + "00000" : "";
  return packed(header + ext + "0".repeat(32));
}

test("MPEG video sequence headers keep their facts and labels", () => {
  assert.deepEqual(mpegVideoConfiguration(mpegSequence({ extension: false })),
    { width: 352, height: 288, fps: 25, codecId: "mpeg1video", bitDepth: 8, progressiveSequence: true });
  const two = mpegVideoConfiguration(mpegSequence({ extension: true }));
  assert.equal(two.codecId, "mpeg2video");
  assert.equal(two.width, 352);
  assert.equal(two.fps, 25);
  assert.equal(mpegVideoConfiguration(Buffer.from([1, 2, 3])), null);
  assert.throws(() => mpegVideoConfiguration(Buffer.from([0, 0, 1, 0xb3, 0x16, 0x01])), /MPEG video sequence header is truncated\./);
  assert.throws(() => mpegVideoConfiguration(Buffer.concat([Buffer.from([0, 0, 1, 0xb3]), Buffer.alloc(8)])), /MPEG video sequence dimensions or rate are invalid\./);
});
