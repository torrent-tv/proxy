import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { ContainerFactory } from "../../services/media/container/ContainerFactory.js";
import { matroskaInput } from "../../services/encode/MatroskaInput.js";

// Synthetic local files only; neither the container nor its byte reader starts a torrent.
// An AVI with an index is read by FFmpeg from the original file
// (original-input-avi.test.js); packets are admitted for ASF here.
for (const [format, videoCodec] of [["asf", "wmv2"]]) {
for (const audioCodec of ["pcm_s16le", "wmav2"]) {
  test(`${format} ${videoCodec} and ${audioCodec} preserve their decoder declarations in admitted input`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv-avi-admitted-"));
    try {
      const file = path.join(directory, `source.${format}`);
      const made = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10",
        "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "1",
        "-c:v", videoCodec, "-c:a", audioCodec, file], { windowsHide: true, encoding: "utf8" });
      assert.equal(made.status, 0, made.stderr);
      const bytes = await fs.readFile(file);
      const container = await ContainerFactory.create({ fileSize: bytes.length,
        readRange: async (a, b) => bytes.subarray(a, b + 1) });
      const tracks = await container.readTracks();
      const media = await container.readMediaInfo();
      const start = media.startTimeSeconds ?? 0;
      const index = await container.readPacketIndex();
      const inputs = tracks.map(track => {
        const input = index.inputFor({ trackId: track.trackNumber, from: start, to: start + 0.5 });
        assert.equal(input.kind, "result", JSON.stringify(input));
        return { track, packets: input.packets };
      });
      const chunks = await Array.fromAsync(matroskaInput({ tracks: inputs,
        readPacket: async (_input, packet) => packet.ranges.map(([a, b]) => bytes.subarray(a, b + 1)) }));
      const decoded = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0",
        "-map", "0:v", "-map", "0:a", "-f", "null", "pipe:1"],
      { windowsHide: true, input: Buffer.concat(chunks), encoding: "utf8" });
      assert.equal(decoded.status, 0, decoded.stderr);
      assert.equal(decoded.stderr, "");
      assert.equal(tracks[0].matroskaCodecId, "V_MS/VFW/FOURCC");
      assert.equal(tracks[1].matroskaCodecId, "A_MS/ACM");
    } finally {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith("ttv-avi-admitted-"));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
}
