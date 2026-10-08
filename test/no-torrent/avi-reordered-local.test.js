import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { AviContainer } from "../../services/media/container/AviContainer.js";
import { matroskaInput } from "../../services/encode/MatroskaInput.js";

// Generated lavfi files only. No torrent boundary is imported or invoked.
// Packets are reassembled only for an AVI without an index; an indexed AVI is
// read from the original file (original-input-avi.test.js).
for (const codec of ["mpeg4", "libxvid", "libx264", "libx265"]) test(`AVI ${codec} B pictures retain presentation order without idx1`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv-avi-reordered-"));
  try {
    const file = path.join(directory, "source.avi");
    const made = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "testsrc2=size=64x64:rate=10", "-t", "3", "-c:v", codec, "-bf", "2", ...(codec === "libx265" ? ["-x265-params", "b-adapt=0", "-vtag", "HEVC"] : []), file], { windowsHide: true, encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    let bytes = await fs.readFile(file);
    {
      let at = 12;
      while (at + 8 <= bytes.length && bytes.toString("ascii", at, at + 4) !== "idx1") at += 8 + bytes.readUInt32LE(at + 4) + (bytes.readUInt32LE(at + 4) & 1);
      assert.ok(at < bytes.length);
      bytes = Buffer.from(bytes.subarray(0, at));
      bytes.writeUInt32LE(bytes.length - 8, 4);
    }
    const container = new AviContainer({ fileSize: bytes.length, readRange: async (a, b) => bytes.subarray(a, b + 1) });
    const [track] = await container.readTracks();
    const index = await container.readPacketIndex();
    const bounds = index.boundsOf(track.trackNumber);
    const input = index.inputFor({ trackId: track.trackNumber, from: bounds.start, to: bounds.end });
    assert.equal(input.kind, "result");
    assert.ok(input.packets.some((packet, position) => position && packet.pts < input.packets[position - 1].pts), JSON.stringify({ codecId: track.codecId, pocProportional: track.pocProportional, fps: track.fps, times: input.packets.map(packet => packet.pts) }));
    const chunks = await Array.fromAsync(matroskaInput({ tracks: [{ track, packets: input.packets }],
      readPacket: async (_input, packet) => packet.ranges.map(([a, b]) => bytes.subarray(a, b + 1)) }));
    const options = { windowsHide: true, encoding: "utf8" };
    const args = ["-map", "0:v", "-vsync", "0", "-f", "framemd5", "pipe:1"];
    const expected = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-i", file, ...args], options);
    const actual = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...args], { ...options, input: Buffer.concat(chunks) });
    assert.equal(expected.status, 0, expected.stderr);
    assert.equal(actual.status, 0, actual.stderr);
    const hashes = text => text.split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1).trim());
    assert.deepEqual(hashes(actual.stdout), hashes(expected.stdout));
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("ttv-avi-reordered-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
