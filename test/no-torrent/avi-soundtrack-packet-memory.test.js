import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { AviContainer } from "../../services/media/container/AviContainer.js";
import { IndexMemory } from "../../services/storage/IndexMemory.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";

// A generated local file only; no torrent.
//
// The soundtrack of an indexed AVI is stated from its index into memory the
// shared budget grants. Field 2026-10-10 (torrent-tv/meta#166): the table asked
// for that memory block by block, was discarded at each refusal and built
// again, and a two-hour film's soundtrack was refused 3485 times without an
// encoder ever starting. The index says how many packets there are, so the
// first refusal names the whole table, and one grant is enough.
test("an indexed AVI's soundtrack asks the budget for its whole packet table at once", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv166-avi-memory-"));
  try {
    const file = path.join(directory, "source.avi");
    const made = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=5",
      "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "120", "-c:v", "mpeg4", "-vtag", "XVID",
      "-c:a", "libmp3lame", "-b:a", "32k", "-f", "avi", file], { windowsHide: true, encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const bytes = await fs.readFile(file);
    const memory = new IndexMemory({});
    const container = new AviContainer({ fileSize: bytes.length, readRange: async (start, end) => bytes.subarray(start, end + 1),
      packetMemory: memory.forFile("local", 0) });
    /** Reads until the budget stops refusing, granting what it is told each time; the number of refusals. */
    const refusalsOf = async read => {
      for (let refusals = 0; ; refusals++) {
        try {
          await read();
          return refusals;
        } catch (error) {
          if (!(error instanceof IndexMemoryUnavailable)) throw error;
          assert.ok(refusals < 50, `still refused after ${refusals} grants; the budget is told ${memory.wanted()} bytes`);
          memory.allow(memory.wanted());
        }
      }
    };
    // The declarations and the AVI index first, which the soundtrack table is stated from.
    await refusalsOf(() => container.supportsOriginalSourceRanges());
    const audio = (await container.readTracks()).find(track => track.type === "audio");
    const refusals = await refusalsOf(() => container.readPacketIndex());
    assert.equal(refusals, 1, "the soundtrack table is refused once and names all it needs");
    const index = await container.readPacketIndex();
    assert.ok(index.boundsOf(audio.trackNumber).end > 119, "the table holds the whole soundtrack");
  } finally {
    const absolute = path.resolve(directory);
    assert.ok(path.basename(absolute).startsWith("ttv166-avi-memory-"));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
