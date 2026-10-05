import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { AviContainer } from "../../services/media/container/AviContainer.js";
import { matroskaInput } from "../../services/encode/MatroskaInput.js";

// Only synthetic local files; no torrent client or source is used.
for (const indexed of [true, false]) test(`AVI variable-bitrate MP3 retains samples ${indexed ? "with" : "without"} idx1`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv-avi-vbr-"));
  try {
    const file = path.join(directory, "source.avi");
    const made = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10",
      "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "1", "-c:v", "mjpeg", "-c:a", "libmp3lame", "-q:a", "4", file],
    { windowsHide: true, encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    let bytes = await fs.readFile(file);
    if (!indexed) {
      let at = 12;
      while (at + 8 <= bytes.length && bytes.toString("ascii", at, at + 4) !== "idx1") at += 8 + bytes.readUInt32LE(at + 4) + (bytes.readUInt32LE(at + 4) & 1);
      assert.ok(at < bytes.length);
      bytes = Buffer.from(bytes.subarray(0, at)); bytes.writeUInt32LE(bytes.length - 8, 4);
    }
    let allowed = false;
    const container = new AviContainer({ fileSize: bytes.length, portionBytes: 188,
      packetMemory: { reserve: () => allowed }, readRange: async (a, b) => bytes.subarray(a, b + 1) });
    await assert.rejects(container.readPacketIndex(), { name: "IndexMemoryUnavailable" });
    allowed = true;
    const tracks = await container.readTracks();
    const audio = tracks.find(track => track.type === "audio");
    const index = await container.readPacketIndex();
    const bounds = index.boundsOf(audio.trackNumber);
    const input = index.inputFor({ trackId: audio.trackNumber, from: bounds.start, to: bounds.end });
    assert.equal(input.kind, "result");
    assert.ok(new Set(input.packets.map(packet => packet.ranges.reduce((sum, [a, b]) => sum + b - a + 1, 0))).size > 1);
    assert.ok(input.packets.every(packet => Math.abs(packet.duration - 1152 / 48000) < 1e-9));
    const chunks = await Array.fromAsync(matroskaInput({ tracks: [{ track: audio, packets: input.packets }],
      readPacket: async (_input, packet) => packet.ranges.map(([a, b]) => bytes.subarray(a, b + 1)) }));
    const args = ["-map", "0:a", "-f", "s16le", "pipe:1"];
    const expected = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-i", file, ...args], { windowsHide: true });
    const actual = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...args], { windowsHide: true, input: Buffer.concat(chunks) });
    assert.equal(expected.status, 0, expected.stderr.toString());
    assert.equal(actual.status, 0, actual.stderr.toString());
    assert.deepEqual(actual.stdout, expected.stdout);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("ttv-avi-vbr-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
