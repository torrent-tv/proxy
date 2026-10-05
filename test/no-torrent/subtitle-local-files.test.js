import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { ContainerFactory } from "../../services/media/container/ContainerFactory.js";
import { SubtitleOrchestrator } from "../../services/media/SubtitleOrchestrator.js";

// Every input is generated locally; this check imports no torrent client.
for (const [format, codec] of [["mkv", "srt"], ["mkv", "ass"], ["mkv", "webvtt"], ["mp4", "mov_text"]]) {
  test(`mapped ${format}/${codec} subtitle packets preserve ffmpeg text and timing`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "torrent-tv-subtitles-"));
    try {
      const subtitle = path.join(directory, "captions.srt");
      await fs.writeFile(subtitle, "1\n00:00:00,200 --> 00:00:00,800\nFirst line\n\n2\n00:00:01,100 --> 00:00:01,700\nSecond line\n");
      const file = path.join(directory, `input.${format}`);
      const encoded = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10",
        "-i", subtitle, "-t", "2", "-map", "0:v", "-map", "1:s", "-c:v", "libx264", "-bf", "0", "-c:s", codec, file],
      { windowsHide: true, encoding: "utf8" });
      assert.equal(encoded.status, 0, encoded.stderr);
      const reference = spawnSync(ffmpegBin, ["-v", "error", "-i", file, "-map", "0:s:0", "-f", "webvtt", "pipe:1"],
        { windowsHide: true, encoding: "utf8" });
      assert.equal(reference.status, 0, reference.stderr);
      const bytes = await fs.readFile(file);
      const readRange = async (from, to) => bytes.subarray(from, to + 1);
      const container = await ContainerFactory.create({ readRange, fileSize: bytes.length });
      const [track] = (await container.readTracks()).filter(track => track.type === "subtitle");
      assert.equal(track.isTextBased(), true);
      const subtitles = new SubtitleOrchestrator({ containerFor: async () => container });
      const result = await subtitles.inspectPackets({ sourceKey: "synthetic", fileIndex: 0,
        fileSize: bytes.length, readRange, subtitleTrackIndex: track.declaredIndex,
        packetInterval: { from: 0, to: 2, trackIds: [track.trackNumber] } });
      assert.equal(result.kind, "result", JSON.stringify(result));
      const cues = result.value.cues.filter(cue => cue.text.trim());
      assert.deepEqual(cues.map(cue => cue.text), ["First line", "Second line"]);
      assert.deepEqual(cues.map(cue => [Math.round(cue.startSeconds * 1000), Math.round(cue.endSeconds * 1000)]),
        [[200, 800], [1100, 1700]]);
      const { vtt } = subtitles.cuesAsVtt(cues, cues, track.codecId);
      assert.match(reference.stdout, /First line/);
      assert.match(reference.stdout, /Second line/);
      assert.match(vtt, /00:00:00\.200 --> 00:00:00\.800/);
      assert.match(vtt, /00:00:01\.100 --> 00:00:01\.700/);
    } finally {
      const absolute = path.resolve(directory), temporary = path.resolve(os.tmpdir());
      assert.ok(absolute.startsWith(`${temporary}${path.sep}`) && path.basename(absolute).startsWith("torrent-tv-subtitles-"));
      await fs.rm(absolute, { recursive: true, force: true });
    }
  });
}
