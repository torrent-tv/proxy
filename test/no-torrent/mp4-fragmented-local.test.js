import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { Mp4Container } from "../../services/media/container/Mp4Container.js";
import { matroskaInput } from "../../services/encode/MatroskaInput.js";
import { isUnavailable } from "../../services/media/container/unavailable.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";

// Synthetic local files only; no torrent boundary is imported or constructed.
test("fragmented MP4 retains exact sample addresses, clocks and decoded picture and sound", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ttv-mp4-fragments-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "source.mp4");
  const made = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10",
    "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "1", "-c:v", "libx264", "-g", "5",
    "-bf", "2", "-c:a", "aac", "-aac_pns", "0", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", file],
    { encoding: "utf8", windowsHide: true });
  assert.equal(made.status, 0, made.stderr);
  const bytes = await fs.readFile(file);
  let held = 0, allowed = Infinity;
  const limited = new Mp4Container({ fileSize: bytes.length, readRange: async (a, b) => bytes.subarray(a, b + 1),
    packetMemory: { reserve(bytes) { if (held + bytes > allowed) return false; held += bytes; return true; },
      release(bytes) { held -= bytes; } } });
  await limited.readTracks();
  const declarations = held;
  const firstMoof = bytes.indexOf(Buffer.from("moof")) - 4;
  const damaged = Buffer.from(bytes);
  const firstTraf = damaged.indexOf(Buffer.from("traf"), firstMoof) - 4;
  damaged.writeUInt32BE(damaged.readUInt32BE(firstMoof), firstTraf);
  const broken = new Mp4Container({ fileSize: damaged.length,
    readRange: async (a, b) => damaged.subarray(a, b + 1) });
  await assert.rejects(broken.readPacketIndex(), /child exceeds its parent/);
  allowed = held + bytes.readUInt32BE(firstMoof) + 131072;
  await assert.rejects(limited.readPacketIndex(), IndexMemoryUnavailable);
  assert.equal(held, declarations, "a refused fragment returns partial packet and temporary allocations");
  allowed = Infinity;
  const retried = await limited.readPacketIndex();
  const limitedVideo = (await limited.readTracks()).find(track => track.type === "video");
  const retriedBounds = retried.boundsOf(limitedVideo.trackNumber);
  assert.equal(retried.inputFor({ trackId: limitedVideo.trackNumber,
    from: retriedBounds.start, to: retriedBounds.end }).packets.length, 10);
  let available = firstMoof + 8;
  const container = new Mp4Container({ fileSize: bytes.length,
    readRange: async (a, b) => b < available ? bytes.subarray(a, b + 1) : null });
  const tracks = await container.readTracks();
  await assert.rejects(container.readPacketIndex(), isUnavailable);
  available = bytes.length;
  const index = await container.readPacketIndex();
  const inputs = tracks.filter(track => ["video", "audio"].includes(track.type)).map(track => {
    const bounds = index.boundsOf(track.trackNumber);
    const input = index.inputFor({ trackId: track.trackNumber, from: bounds.start, to: bounds.end });
    assert.equal(input.kind, "result");
    return { track, packets: input.packets };
  });
  assert.equal(inputs.find(input => input.track.type === "video").packets.length, 10);
  assert.ok((await container.readMediaInfo()).durationSeconds > 0);
  assert.ok((await container.parseKeyframeIndex()).times.length >= 2);
  const chunks = await Array.fromAsync(matroskaInput({ tracks: inputs,
    readPacket: async (_input, packet) => packet.ranges.map(([a, b]) => bytes.subarray(a, b + 1)) }));
  for (const kind of ["video", "audio"]) {
    const decode = (source, input) => spawnSync(ffmpegBin, ["-v", "error", "-i", source, "-map",
      kind === "video" ? "0:v" : "0:a", "-f", kind === "video" ? "framemd5" : "s16le", "pipe:1"], { input, windowsHide: true });
    const expected = decode(file), actual = decode("pipe:0", Buffer.concat(chunks));
    assert.equal(expected.status, 0, expected.stderr.toString());
    assert.equal(actual.status, 0, actual.stderr.toString());
    const hashes = data => data.toString().split("\n").filter(line => line && !line.startsWith("#"))
      .map(line => line.split(",").at(-1).trim());
    if (kind === "video") assert.deepEqual(hashes(actual.stdout), hashes(expected.stdout));
    else assert.deepEqual(actual.stdout, expected.stdout);
  }
});
