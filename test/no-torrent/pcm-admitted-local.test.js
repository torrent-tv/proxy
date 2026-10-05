import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { ContainerFactory } from "../../services/media/container/ContainerFactory.js";
import { SegmentInputs } from "../../services/media/SegmentInputs.js";
import { admitInput } from "../../services/encode/AdmittedInput.js";

// Synthetic local audio only. The packet reader returns bytes from this file.
for (const mode of ["transcode", "copy"]) {
for (const [format, codec, bitDepth] of [["mkv", "pcm_s24le", 24], ["mkv", "pcm_f32le", 32], ["mkv", "libopus", 16],
  ["mov", "pcm_s24le", 24], ["mov", "pcm_s16be", 16], ["mov", "pcm_s8", 8],
  ["mov", "pcm_f32be", 32], ["mov", "pcm_f64be", 64],
  ["mp4", "alac", 16], ["mp4", "libopus", 16]]) test(`${format} ${codec} ${mode} input retains decoder declarations and decoded audio`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv-pcm-admitted-"));
  try {
    const file = path.join(directory, `source.${format}`);
    const made = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "sine=sample_rate=48000",
      "-t", "0.2", "-c:a", codec, file], { encoding: "utf8", windowsHide: true });
    assert.equal(made.status, 0, made.stderr);
    const bytes = await fs.readFile(file);
    const container = await ContainerFactory.create({ fileSize: bytes.length,
      readRange: async (a, b) => bytes.subarray(a, b + 1) });
    const tracks = await container.readTracks();
    assert.equal(tracks[0].bitDepth, bitDepth);
    const index = await container.readPacketIndex();
    const bounds = index.boundsOf(tracks[0].trackNumber);
    const input = new SegmentInputs({ tracks, index }).forInterval({ from: Math.max(0, bounds.start), to: bounds.end, mode });
    assert.equal(input.kind, "result", JSON.stringify(input));
    const admitted = await admitInput({ sources: [{ sourceKey: "local", fileIndex: 0, input }],
      reserve: () => () => {}, readRanges: async (_source, ranges) => ranges.map(([a, b]) => bytes.subarray(a, b + 1)) });
    assert.equal(admitted.kind, "result");
    const chunks = await Array.fromAsync(admitted.stream());
    const emitted = Buffer.concat(chunks);
    const replay = await ContainerFactory.create({ fileSize: emitted.length,
      readRange: async (a, b) => emitted.subarray(a, b + 1) });
    const replayTracks = await replay.readTracks();
    const replayIndex = await replay.readPacketIndex();
    const replayBounds = replayIndex.boundsOf(replayTracks[0].trackNumber);
    const replayInput = replayIndex.inputFor({ trackId: replayTracks[0].trackNumber, from: 0, to: replayBounds.end });
    assert.equal(replayInput.kind, "result");
    assert.equal(replayTracks[0].codecDelaySeconds, tracks[0].codecDelaySeconds ?? 0);
    assert.equal(replayInput.packets.length, input.tracks[0].packets.length);
    for (const [position, packet] of replayInput.packets.entries()) {
      const original = input.tracks[0].packets[position];
      assert.ok(Math.abs(packet.pts - (original.pts - admitted.originSeconds)) < 0.000001);
      assert.equal(packet.discardPaddingSeconds, original.discardPaddingSeconds);
    }
    const decode = (source, filename = null) => {
      const decoded = spawnSync(ffmpegBin, ["-v", "error", "-i", filename ?? "pipe:0", "-c:a", "pcm_s32le", "-f", "s32le", "pipe:1"],
        { input: filename ? undefined : source, windowsHide: true });
      assert.equal(decoded.status, 0, decoded.stderr.toString());
      assert.equal(decoded.stderr.length, 0, decoded.stderr.toString());
      return decoded.stdout;
    };
    assert.deepEqual(decode(emitted), decode(bytes, file));
    admitted.release();
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("ttv-pcm-admitted-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
}
