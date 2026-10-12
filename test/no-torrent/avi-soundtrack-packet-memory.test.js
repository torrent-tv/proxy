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

// torrent-tv/meta#178: a refused table is not counted and reserved again by
// every reader while the memory's owner says it still would not fit — and the
// refusal ends as soon as it would, including when bytes are released under an
// unchanged allowance, which raises no memory event.
test("an indexed AVI's refused soundtrack table is asked for again only when it would fit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv178-avi-refusal-"));
  try {
    const file = path.join(directory, "source.avi");
    const made = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=5",
      "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "60", "-c:v", "mpeg4", "-vtag", "XVID",
      "-c:a", "libmp3lame", "-b:a", "32k", "-f", "avi", file], { windowsHide: true, encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const bytes = await fs.readFile(file);
    const memory = new IndexMemory({});
    const owner = memory.forFile("local", 0);
    let packetReservations = 0;
    const counted = { fits: owner.fits, forRecord: (record, kind = "packets") => {
      const allocation = owner.forRecord(record, kind);
      return { ...allocation, reserve: size => { if (kind === "packets") packetReservations++; return allocation.reserve(size); } };
    } };
    const container = new AviContainer({ fileSize: bytes.length, readRange: async (start, end) => bytes.subarray(start, end + 1),
      packetMemory: counted });
    for (let attempt = 0; ; attempt++) {
      try { await container.supportsOriginalSourceRanges(); break; } catch (error) {
        if (!(error instanceof IndexMemoryUnavailable) || attempt > 50) throw error;
        memory.allow(memory.wanted());
      }
    }
    const refusal = async () => {
      try { await container.readPacketIndex(); } catch (error) { if (error instanceof IndexMemoryUnavailable) return error.bytes; throw error; }
      return null;
    };
    const before = packetReservations;
    const table = await refusal();
    assert.ok(table > 0, "the table does not fit under the allowance the index left");
    for (let read = 0; read < 99; read++) assert.equal(await refusal(), table);
    assert.equal(packetReservations - before, 1, "one reservation was attempted for a hundred readers");

    // The table would fit, but another holder takes the room: still refused, and still not reserved again.
    memory.allow(memory.held() + table);
    const other = owner.forRecord({}, "index");
    assert.equal(other.reserve(table), true);
    assert.equal(await refusal(), table);
    assert.equal(packetReservations - before, 1);
    // The other holder lets go; the allowance is unchanged, so no event comes. The next reader builds it.
    other.release(table);
    other.dispose();
    assert.equal(await refusal(), null, "released memory ends the refusal without a new allowance");
    const audio = (await container.readTracks()).find(track => track.type === "audio");
    assert.ok((await container.readPacketIndex()).boundsOf(audio.trackNumber).end > 59);
  } finally {
    const absolute = path.resolve(directory);
    assert.ok(path.basename(absolute).startsWith("ttv178-avi-refusal-"));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});

// torrent-tv/meta#178: a two-hour soundtrack is some 300 000 packets, and its
// table built in one stretch held the main thread 5-7 s with the map's first
// pass. It gives the thread back at each portion of the file it reaches, and
// is the same table.
test("an indexed AVI's soundtrack table gives the thread back at each portion of the file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv178-avi-portions-"));
  try {
    const file = path.join(directory, "source.avi");
    const made = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=5",
      "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "60", "-c:v", "mpeg4", "-vtag", "XVID",
      "-c:a", "libmp3lame", "-b:a", "32k", "-f", "avi", file], { windowsHide: true, encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const bytes = await fs.readFile(file);
    const tableOf = async (portionBytes) => {
      const memory = new IndexMemory({});
      memory.allow(Number.MAX_SAFE_INTEGER);
      const container = new AviContainer({ fileSize: bytes.length, portionBytes,
        readRange: async (start, end) => bytes.subarray(start, end + 1), packetMemory: memory.forFile("local", 0) });
      await container.supportsOriginalSourceRanges();
      const audio = (await container.readTracks()).find(track => track.type === "audio");
      let turns = 0;
      let counting = true;
      const count = () => { if (counting) { turns++; setImmediate(count); } };
      setImmediate(count);
      const index = await container.readPacketIndex();
      counting = false;
      return { turns, bounds: index.boundsOf(audio.trackNumber) };
    };
    const whole = await tableOf(undefined);
    const portions = await tableOf(16 * 1024);
    assert.ok(portions.turns > whole.turns + 5, `${portions.turns} turns of the loop against ${whole.turns}`);
    assert.deepEqual(portions.bounds, whole.bounds, "the same table");
  } finally {
    const absolute = path.resolve(directory);
    assert.ok(path.basename(absolute).startsWith("ttv178-avi-portions-"));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
