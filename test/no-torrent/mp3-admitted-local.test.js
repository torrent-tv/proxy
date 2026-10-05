import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { ContainerFactory } from "../../services/media/container/ContainerFactory.js";
import { AudioTrack } from "../../services/media/tracks/AudioTrack.js";
import { matroskaInput } from "../../services/encode/MatroskaInput.js";

// Local synthetic media and pipes only; no torrent source is opened.
for (const [format, codec, codecName, fragmented] of [["mkv", "libmp3lame", "mp3"], ["mp4", "libmp3lame", "mp3"],
  ["asf", "libmp3lame", "mp3"], ["mp4", "aac", "aac"], ["mov", "aac", "aac"], ["mp4", "libmp3lame", "mp3", true]]) {
  test(`${fragmented ? "fragmented " : ""}${format} ${codecName} declarations and decoder preparation preserve decoded audio`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv-mp3-admitted-"));
    try {
      const file = path.join(directory, `source.${format}`);
      const made = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "sine=sample_rate=48000",
        "-t", "1", "-c:a", codec, ...(codecName === "mp3" ? ["-q:a", "4"] : ["-aac_pns", "0"]),
        ...(fragmented ? ["-movflags", "+frag_keyframe+empty_moov+default_base_moof"] : []), file], { encoding: "utf8", windowsHide: true });
      assert.equal(made.status, 0, made.stderr);
      const bytes = await fs.readFile(file);
      const container = await ContainerFactory.create({ fileSize: bytes.length,
        readRange: async (start, end) => bytes.subarray(start, end + 1) });
      const tracks = await container.readTracks();
      const audio = tracks.find(track => track.type === "audio");
      assert.equal(AudioTrack.codecNameOf(audio), codecName);
      const index = await container.readPacketIndex();
      await index.prepareAudioDependencies(undefined, container.readRange);
      const bounds = index.boundsOf(audio.trackNumber);
      const input = index.inputFor({ trackId: audio.trackNumber, from: Math.max(0, bounds.start), to: bounds.end });
      assert.equal(input.kind, "result");
      if (codecName === "mp3") assert.ok(input.packets.some(packet => packet.decodeFromIndex < input.packets.indexOf(packet)));
      const chunks = await Array.fromAsync(matroskaInput({ tracks: [{ track: audio, packets: input.packets }],
        originSeconds: Math.min(...input.packets.map(packet => packet.pts + (audio.codecDelaySeconds ?? 0))),
        readPacket: async (_input, packet) => packet.ranges.map(([start, end]) => bytes.subarray(start, end + 1)) }));
      const decode = (source, data) => spawnSync(ffmpegBin, ["-v", "error", "-i", source, "-map", "0:a", "-f", "s16le", "pipe:1"],
        { windowsHide: true, input: data });
      const expected = decode(file);
      const actual = decode("pipe:0", Buffer.concat(chunks));
      assert.equal(expected.status, 0, expected.stderr.toString());
      assert.equal(actual.status, 0, actual.stderr.toString());
      assert.deepEqual(actual.stdout, expected.stdout);
      const interval = { from: 0.5, to: 0.7 };
      const middle = index.inputFor({ trackId: audio.trackNumber, ...interval });
      assert.equal(middle.kind, "result");
      // Compare seek decoding against a full decode with the same precise timeline.
      // The source container can quantize timestamps differently, and AAC noise
      // substitution cannot reproduce its random state after a decoder restart.
      const originSeconds = Math.min(...input.packets.map(packet => packet.pts + (audio.codecDelaySeconds ?? 0)));
      const portion = Buffer.concat(await Array.fromAsync(matroskaInput({ tracks: [{ track: audio, packets: middle.packets }],
        originSeconds,
        readPacket: async (_input, packet) => packet.ranges.map(([start, end]) => bytes.subarray(start, end + 1)) })));
      const trimmed = data => spawnSync(ffmpegBin, ["-v", "error", "-copyts",
        "-i", "pipe:0", "-map", "0:a",
        "-af", `atrim=start=${interval.from - originSeconds}:end=${interval.to - originSeconds},asetpts=PTS-STARTPTS`, "-f", "s16le", "pipe:1"],
      { windowsHide: true, input: data });
      const originalMiddle = trimmed(Buffer.concat(chunks)), admittedMiddle = trimmed(portion);
      assert.equal(originalMiddle.status, 0, originalMiddle.stderr.toString());
      assert.equal(admittedMiddle.status, 0, admittedMiddle.stderr.toString());
      assert.equal(admittedMiddle.stdout.length, originalMiddle.stdout.length, admittedMiddle.stderr.toString());
      let maximumDifference = 0, squaredDifference = 0, differingSamples = 0;
      for (let offset = 0; offset < admittedMiddle.stdout.length; offset += 2) {
        const difference = Math.abs(admittedMiddle.stdout.readInt16LE(offset) - originalMiddle.stdout.readInt16LE(offset));
        maximumDifference = Math.max(maximumDifference, difference);
        squaredDifference += difference * difference;
        if (difference) differingSamples++;
      }
      assert.ok(admittedMiddle.stdout.equals(originalMiddle.stdout), JSON.stringify({ format, codecName,
        maximumDifference, differingSamples, rootMeanSquareDifference: Math.sqrt(squaredDifference / (admittedMiddle.stdout.length / 2)),
        codecDelay: audio.codecDelaySeconds, first: middle.packets.slice(0, 4).map(packet => ({ pts: packet.pts, duration: packet.duration, dependency: packet.decodeFromIndex })),
        actual: admittedMiddle.stdout.subarray(0, 24).toString("hex"), expected: originalMiddle.stdout.subarray(0, 24).toString("hex"),
        errors: admittedMiddle.stderr.toString() }));
    } finally {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith("ttv-mp3-admitted-"));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
