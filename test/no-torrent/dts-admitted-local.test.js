import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import ffmpegBin from "ffmpeg-static";
import { dtsFrame } from "../../services/media/container/dts-frame.js";
import { MpegElementaryIndex } from "../../services/media/container/mpeg-elementary-index.js";
import { matroskaInput } from "../../services/encode/MatroskaInput.js";

function swapWords(bytes) {
  const result = Buffer.from(bytes);
  for (let at = 0; at + 1 < result.length; at += 2) [result[at], result[at + 1]] = [result[at + 1], result[at]];
  return result;
}

function packedWords(bytes) {
  const result = Buffer.alloc(Math.ceil(bytes.length * 8 / 14) * 2);
  for (let word = 0; word < result.length / 2; word++) {
    let value = 0;
    for (let bit = 0; bit < 14; bit++) {
      const logical = word * 14 + bit;
      value = value * 2 + (logical < bytes.length * 8 ? (bytes[logical >> 3] >> (7 - (logical & 7))) & 1 : 0);
    }
    result.writeUInt16BE(value | (word === 1 ? 0xc000 : 0), word * 2);
  }
  return result;
}

// The encoder receives synthetic lavfi audio; the decoder receives stdin only.
test("DTS core word layouts preserve duration, exact ranges and admitted audio samples", async () => {
  const made = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "sine=sample_rate=48000", "-t", "0.1", "-c:a", "dca", "-strict", "-2", "-f", "dts", "pipe:1"],
  { windowsHide: true });
  assert.equal(made.status, 0, made.stderr.toString());
  const original = made.stdout;
  const packets = [];
  for (let at = 0; at < original.length;) {
    const header = dtsFrame(original.subarray(at));
    packets.push(original.subarray(at, at + header.size));
    at += header.size;
  }
  const decode = bytes => {
    const result = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-f", "s16le", "-c:a", "pcm_s16le", "pipe:1"], { windowsHide: true, input: bytes });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stderr.length, 0);
    return result.stdout;
  };
  const expected = decode(original);
  assert.ok(expected.length > 0);
  for (const transform of [bytes => bytes, swapWords, packedWords, bytes => swapWords(packedWords(bytes))]) {
    const bytes = Buffer.concat(packets.map(transform));
    const track = { trackNumber: 1, type: "audio", codecId: "dts" };
    const reader = new MpegElementaryIndex([track]);
    reader.push(1, bytes.subarray(0, 10), 100, { pts: 0 });
    reader.push(1, bytes.subarray(10), 300);
    const index = reader.complete();
    const input = index.inputFor({ trackId: 1, from: 0, to: index.boundsOf(1).end });
    assert.equal(input.kind, "result");
    assert.equal(track.samplingFrequency, 48000);
    assert.equal(input.packets.length, packets.length);
    assert.deepEqual(input.ranges, [[100, 109], [300, 300 + bytes.length - 11]]);
    const admitted = await Array.fromAsync(matroskaInput({ tracks: [{ track, packets: input.packets }],
      readPacket: async (_input, packet) => packet.ranges.map(([a, b]) => {
        const offset = a < 300 ? a - 100 : a - 300 + 10;
        return bytes.subarray(offset, offset + b - a + 1);
      }) }));
    assert.deepEqual(decode(Buffer.concat(admitted)), expected);
  }
});
