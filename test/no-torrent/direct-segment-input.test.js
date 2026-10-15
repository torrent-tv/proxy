import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { directSegmentInput } from "../../services/media/direct-segment-input.js";
import { AviContainer } from "../../services/media/container/AviContainer.js";
import { IndexMemory } from "../../services/storage/IndexMemory.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";

// Stub containers and a generated local file only; no torrent.
//
// torrent-tv/meta#178, field r42: the download map's pass waited 3.2 s for an
// AVI's sound packet table between the soundtrack's first segment and the
// picture's next ones, and the swarm was asked for the picture's next piece
// only after it.

const sound = { type: "audio", trackNumber: 1 };

function stubContainer({ wouldWait, table }) {
  const asked = [];
  return {
    asked,
    supportsOriginalSourceRanges: async interval => interval.trackIds.includes(0),
    readSourceRanges: async interval => ({ kind: "result", ranges: [[interval.from, interval.to]] }),
    packetTableWouldWait: () => wouldWait,
    readPacketIndex: () => { asked.push("table"); return table; }
  };
}

const index = { inputFor: ({ from, to }) => ({ kind: "result", ranges: [[from * 10, to * 10]] }) };

test("a segment read from the original file is answered from the index", async () => {
  const container = stubContainer({ wouldWait: true, table: new Promise(() => {}) });
  const answer = await directSegmentInput(container, { interval: { from: 4, to: 8, trackIds: [0] }, tracks: [], mode: () => "transcode" },
    () => assert.fail("nothing is waited for"));
  assert.deepEqual(answer, { kind: "result", ranges: [[4, 8]] });
  assert.deepEqual(container.asked, []);
});

test("a soundtrack segment whose table is being built is answered pending, and its building is handed on", async () => {
  let build;
  const container = stubContainer({ wouldWait: true, table: new Promise(resolve => { build = resolve; }) });
  let built = null;
  const answer = await directSegmentInput(container, { interval: { from: 4, to: 8, trackIds: [1] }, tracks: [sound], mode: () => "copy" },
    promise => { built = promise; });
  assert.deepEqual(answer, { kind: "pending" });
  assert.deepEqual(container.asked, ["table"], "the table is begun, or joined");
  let settled = false;
  void built.then(() => { settled = true; });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  build(index);
  await new Promise(setImmediate);
  assert.equal(settled, true);
});

test("a refused table settles the handed-on building too, so the map is built again", async () => {
  const container = stubContainer({ wouldWait: true, table: Promise.reject(new IndexMemoryUnavailable(1024)) });
  let built = null;
  await directSegmentInput(container, { interval: { from: 4, to: 8, trackIds: [1] }, tracks: [sound], mode: () => "copy" },
    promise => { built = promise; });
  await built;
});

test("a soundtrack segment whose table is built is answered from it", async () => {
  const container = stubContainer({ wouldWait: false, table: Promise.resolve(index) });
  const answer = await directSegmentInput(container, { interval: { from: 4, to: 8, trackIds: [1] }, tracks: [sound], mode: () => "copy" },
    () => assert.fail("nothing is waited for"));
  assert.equal(answer.kind, "result");
  assert.deepEqual(answer.ranges, [[40, 80]]);
});

test("an indexed AVI says its sound table would wait only while it is unbuilt and not refused", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv178-avi-table-"));
  try {
    const file = path.join(directory, "source.avi");
    const made = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=5",
      "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "30", "-c:v", "mpeg4", "-vtag", "XVID",
      "-c:a", "libmp3lame", "-b:a", "32k", "-f", "avi", file], { windowsHide: true, encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const bytes = await fs.readFile(file);
    const memory = new IndexMemory({});
    const container = new AviContainer({ fileSize: bytes.length, readRange: async (start, end) => bytes.subarray(start, end + 1),
      packetMemory: memory.forFile("local", 0) });
    assert.equal(container.packetTableWouldWait(), false, "nothing is known before the index is read");
    for (;;) {
      try { await container.supportsOriginalSourceRanges(); break; } catch (error) {
        if (!(error instanceof IndexMemoryUnavailable)) throw error;
        memory.allow(memory.wanted());
      }
    }
    assert.equal(container.packetTableWouldWait(), true, "the index is read and the table is not");
    await assert.rejects(container.readPacketIndex(), IndexMemoryUnavailable);
    assert.equal(container.packetTableWouldWait(), false, "a refusal that still stands is answered at once");
    memory.allow(memory.wanted());
    assert.equal(container.packetTableWouldWait(), true, "the refusal ends once the table would fit");
    await container.readPacketIndex();
    assert.equal(container.packetTableWouldWait(), false, "a built table is answered at once");
  } finally {
    const absolute = path.resolve(directory);
    assert.ok(path.basename(absolute).startsWith("ttv178-avi-table-"));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
