import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { probePackets } from "../../services/media/probe-packets.js";
import { FfprobeContainer } from "../../services/media/container/FfprobeContainer.js";
import { SegmentInputs } from "../../services/media/SegmentInputs.js";
import { admitInput } from "../../services/encode/AdmittedInput.js";

// Only generated media files are passed to ffprobe; no torrent boundary is imported.
for (const format of ["mp4", "flv"]) test(`ffprobe reads synthetic ${format} packet bytes and codec declarations without an input URL`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "torrent-tv-ffprobe-"));
  try {
    const file = path.join(directory, `input.${format}`);
    const encoded = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1",
      "-c:v", "libx264", "-bf", "2", "-c:a", "aac", file], { windowsHide: true, encoding: "utf8" });
    assert.equal(encoded.status, 0, encoded.stderr);
    const bytes = await fs.readFile(file);
    const container = new FfprobeContainer({ fileSize: bytes.length, readRange: async (a, b) => bytes.subarray(a, b + 1),
      probe: async (statement, onRecord) => ({ kind: "result", value: await probePackets({ url: file, statement, onRecord }) }) });
    const tracks = await container.readTracks();
    assert.equal(tracks[0].codecId, "h264");
    assert.ok(Buffer.from(tracks[0].codecPrivateB64, "base64").length > 0);
    const index = await container.readPacketIndex();
    const bounds = index.boundsOf(tracks[0].trackNumber);
    const input = new SegmentInputs({ tracks, index }).forInterval({ from: bounds.start, to: bounds.end });
    assert.equal(input.kind, "result");
    let released = false;
    const admitted = await admitInput({ sources: [{ sourceKey: "synthetic", fileIndex: 0, input }],
      reserve: () => () => { released = true; }, readRanges: async (_source, ranges) => ranges.map(([a, b]) => bytes.subarray(a, b + 1)) });
    assert.equal(admitted.kind, "result");
    const chunks = [];
    for await (const chunk of admitted.stream()) chunks.push(chunk);
    const decoded = spawnSync(ffmpegBin, ["-v", "error", "-i", "pipe:0", "-f", "null", "-"],
      { input: Buffer.concat(chunks), encoding: "utf8", windowsHide: true });
    assert.equal(decoded.status, 0, decoded.stderr);
    assert.equal(decoded.stderr.trim(), "");
    admitted.release();
    assert.equal(released, true);
  } finally {
    const absolute = path.resolve(directory), temporary = path.resolve(os.tmpdir());
    assert.ok(absolute.startsWith(`${temporary}${path.sep}`) && path.basename(absolute).startsWith("torrent-tv-ffprobe-"));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
