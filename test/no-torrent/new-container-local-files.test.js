import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import ffprobe from "@ffprobe-installer/ffprobe";
import { ContainerFactory } from "../../services/media/container/ContainerFactory.js";
import { matroskaInput } from "../../services/encode/MatroskaInput.js";

// All inputs are synthetic lavfi sources. No torrent classes, clients or URLs.
for (const [format, video, audio, removeAud = false] of [["mpegts", "libx264", "aac_latm"], ["mpegts", "libx265", "aac", true], ["mpegts", "libx265", "aac"], ["mpegts", "mpeg2video", "ac3"], ["mpegts", "mpeg2video", "eac3"], ["mpegts", "mpeg2video", "mp2"], ["mpegts", "mpeg2video", "aac"], ["mpegts", "libx264", "aac"], ["mpegts", "libx264", "aac", true], ["mpeg", "mpeg2video", "ac3"], ["mpeg", "libx264", "mp2"], ["mpeg", "mpeg2video", "mp2"], ["asf", "wmv2", "wmav2"], ["avi", "mpeg4", "mp3"], ["matroska", "libx264", "aac"], ["mp4", "libx264", "aac"], ["mp4", "libx265", "aac"], ["matroska", "libx265", "aac"]]) {
  test(`the ${format} reader accepts local ${video} and ${audio}${removeAud ? " without AUD" : ""}`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "torrent-tv-container-"));
    try {
      const file = path.join(directory, "media.bin");
      const encoded = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "1", "-c:v", video, ...(video === "libx265" ? ["-x265-params", "pools=1:frame-threads=1:wpp=0:log-level=error"] : []), ...(["mpeg", "mpegts"].includes(format) ? ["-bf", "2"] : []),
        "-c:a", audio === "aac_latm" ? "aac" : audio, ...(audio === "aac_latm" ? ["-mpegts_flags", "+latm"] : []), ...(removeAud ? ["-bsf:v", video === "libx265" ? "filter_units=remove_types=35" : "filter_units=remove_types=9"] : []), "-f", format, file], { windowsHide: true, encoding: "utf8" });
      assert.equal(encoded.status, 0, encoded.stderr);
      const bytes = await fs.readFile(file);
      const container = await ContainerFactory.create({ fileSize: bytes.length, readRange: async (a, b) => bytes.subarray(a, b + 1) });
      assert.ok(container, `No container identified ${format}.`);
      const tracks = await container.readTracks();
      assert.ok(tracks.some(track => track.type === "video"));
      assert.ok(tracks.some(track => track.type === "audio"));
      if (video === "libx265") {
        await container.readMediaInfo();
        const picture = tracks.find(track => track.type === "video");
        assert.equal(picture.width, 64);
        assert.equal(picture.height, 64);
        assert.equal(picture.bitDepth, 8);
        assert.ok(picture.reorderDepth > 0);
      }
      if (["mpeg", "mpegts"].includes(format)) {
        const info = await container.readMediaInfo();
        const videoTrack = tracks.find(track => track.type === "video");
        assert.equal(videoTrack.width, 64);
        assert.equal(videoTrack.height, 64);
        if (video !== "libx264") assert.equal(videoTrack.fps, 10);
        assert.ok(Number.isFinite(info.startTimeSeconds));
        if (format === "mpegts") {
          const available = Math.floor(bytes.length * 3 / 4);
          let complete = false;
          const partial = await ContainerFactory.create({ fileSize: bytes.length,
            readRange: async (a, b) => complete || b < available ? bytes.subarray(a, b + 1) : null });
          const partialTracks = await partial.readTracks();
          assert.ok(Number.isFinite((await partial.readMediaInfo()).startTimeSeconds));
          assert.equal(partialTracks.find(track => track.type === "video").width, 64);
          if (video !== "libx264") assert.equal(partialTracks.find(track => track.type === "video").fps, 10);
          const origin = (await partial.readMediaInfo()).startTimeSeconds;
          const interval = { from: origin, to: origin + 0.2 };
          const earlyIndex = await partial.readPacketIndex(interval);
          assert.equal(earlyIndex.isComplete(), false);
          const picture = partialTracks.find(track => track.type === "video");
          const earlyInput = earlyIndex.inputFor({ trackId: picture.trackNumber, ...interval });
          assert.equal(earlyInput.kind, "result");
          await assert.rejects(partial.readPacketIndex(), { name: "BytesUnavailable" });
          complete = true;
          const fullIndex = await partial.readPacketIndex();
          assert.equal(fullIndex, earlyIndex);
          assert.equal(fullIndex.isComplete(), true);
          assert.deepEqual(fullIndex.inputFor({ trackId: picture.trackNumber, ...interval }), earlyInput);
        }
      }
      const earlyInfo = format === "asf" ? await container.readMediaInfo() : null;
      if (["avi", "matroska", "mp4", "asf", "mpegts", "mpeg"].includes(format)) {
        const index = await container.readPacketIndex();
        const startSeconds = (await container.readMediaInfo()).startTimeSeconds ?? 0;
        if (format === "mpegts" && ["libx264", "libx265"].includes(video)) {
          const checked = spawnSync(process.env.FFPROBE_BIN || ffprobe.path, ["-v", "error", "-select_streams", "v:0",
            "-show_packets", "-show_entries", "packet=pts_time,dts_time,duration_time,flags", "-of", "json", file],
            { windowsHide: true, encoding: "utf8" });
          assert.equal(checked.status, 0, checked.error?.message || checked.stderr || `ffprobe terminated with ${checked.signal}`);
          const expected = JSON.parse(checked.stdout).packets;
          const picture = tracks.find(track => track.type === "video");
          const bounds = index.boundsOf(picture.trackNumber);
          const actual = index.inputFor({ trackId: picture.trackNumber, from: bounds.start, to: bounds.end });
          assert.equal(actual.kind, "result");
          assert.equal(actual.packets.length, expected.length);
          actual.packets.forEach((packet, position) => {
            if (expected[position].pts_time !== undefined) assert.ok(Math.abs(packet.pts - Number(expected[position].pts_time)) < 1e-6);
            if (expected[position].dts_time !== undefined) assert.ok(Math.abs(packet.dts - Number(expected[position].dts_time)) < 1e-6);
            assert.ok(Math.abs(packet.duration - Number(expected[position].duration_time)) < 1e-6);
            assert.equal(packet.keyframe, expected[position].flags.includes("K"));
          });
          if (format === "mpeg") {
            const presented = actual.packets.map(packet => packet.pts).sort((a, b) => a - b);
            presented.forEach((time, position) => assert.ok(Math.abs(time - bounds.start - position / 10) < 1e-6));
          }
        }
        if (earlyInfo) assert.equal(earlyInfo.startTimeSeconds, startSeconds, "Timeline origin must be known before full packet indexing.");
        const inputs = [];
        for (const track of tracks.filter(track => ["video", "audio"].includes(track.type))) {
          const input = index.inputFor({ trackId: track.trackNumber, from: startSeconds, to: startSeconds + 0.5 });
          assert.equal(input.kind, "result", JSON.stringify(input));
          assert.ok(input.packets.length > 0);
          assert.ok(input.ranges.every(([start, end]) => start >= 0 && end < bytes.length));
          inputs.push({ track, ...input });
        }
        const originSeconds = inputs.reduce((origin, input) => input.packets.reduce((value, packet) => Math.min(value, packet.pts), origin), 0);
        const chunks = [];
        for await (const chunk of matroskaInput({ tracks: inputs, originSeconds,
          readPacket: async (_input, packet) => Buffer.concat(packet.ranges.map(([a, b]) => bytes.subarray(a, b + 1))) })) chunks.push(chunk);
        const decoded = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-f", "matroska", "-i", "pipe:0", "-map", "0", "-f", "null", "pipe:1"],
          { windowsHide: true, input: Buffer.concat(chunks), encoding: "utf8" });
        assert.equal(decoded.status, 0, decoded.stderr);
        assert.equal(decoded.stderr, "", "The admitted packet input emitted decode errors.");
      }
      if (format === "asf") {
        const info = await container.readMediaInfo();
        assert.ok(info.durationSeconds > 0 && info.durationSeconds < 2);
      }
    } finally {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith("torrent-tv-container-"));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
