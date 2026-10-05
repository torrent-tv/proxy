import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import ffmpegBin from "ffmpeg-static";
import { MpegTsContainer } from "../../services/media/container/MpegTsContainer.js";
import { MpegPsContainer } from "../../services/media/container/MpegPsContainer.js";

// Synthetic audio is generated through pipes without starting a torrent source.
for (const [format, Container] of [["mpegts", MpegTsContainer], ["mpeg", MpegPsContainer]]) {
  test(`${format} audio-only input obtains duration from its indexed audio frames`, async () => {
    const made = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "sine=sample_rate=48000", "-t", "0.5", "-c:a", "mp2", "-f", format, "pipe:1"], { windowsHide: true });
    assert.equal(made.status, 0, made.stderr.toString());
    const bytes = made.stdout;
    const container = new Container({ fileSize: bytes.length, portionBytes: 188,
      readRange: async (start, end) => bytes.subarray(start, end + 1) });
    const tracks = await container.readTracks();
    assert.equal(tracks.some(track => track.type === "video"), false);
    const audio = tracks.find(track => track.type === "audio");
    assert.ok(audio);
    const index = await container.readPacketIndex();
    const bounds = index.boundsOf(audio.trackNumber);
    const media = await container.readMediaInfo();
    assert.equal(media.startTimeSeconds, bounds.start);
    assert.equal(media.durationSeconds, bounds.end - bounds.start);
    assert.ok(media.durationSeconds >= 0.5);
  });
}
