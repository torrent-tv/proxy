import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { ContainerOrchestrator } from "../../services/media/ContainerOrchestrator.js";
import { MediaReadRequests } from "../../services/media/MediaReadRequests.js";
import { IndexMemory } from "../../services/storage/IndexMemory.js";
import { MachineBudget } from "../../services/storage/MachineBudget.js";

// Generated files and in-memory byte sources only; no torrent boundary is used.
for (const format of ["avi", "mkv"]) test(`${format} opening completes through memory revision events`, { timeout: 15000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv-open-memory-"));
  try {
    const file = path.join(directory, `source.${format}`);
    const made = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10",
      "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", format === "avi" ? "120" : "1",
      "-c:v", format === "avi" ? "mpeg4" : "libx265", ...(format === "avi" ? ["-vtag", "XVID"] : ["-x265-params", "pools=1:frame-threads=1"]),
      "-c:a", "libmp3lame", file], { windowsHide: true, encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const bytes = await fs.readFile(file);
    const reads = new Map();
    const missingEntry = format === "avi" ? bytes.lastIndexOf(Buffer.from("idx1")) + 8 + 20 * 16 : -1;
    let bytesArrived = false;
    const reader = new ContainerOrchestrator();
    const budget = new MachineBudget({ policy: { kind: "fixed", bytes: 64 * 1024 * 1024 } });
    budget.defineResource({ name: "memory", readFree: () => 64 * 1024 * 1024 });
    const requests = new MediaReadRequests({ read: (params, statement) => reader.inspect(params, statement) });
    const memory = new IndexMemory({ reviseBudget: () => { void budget.revise(); }, changed: () => requests.memoryChanged() });
    budget.register({ name: "metadata", resource: "memory", held: () => memory.held(), wanted: () => memory.wanted(),
      required: () => memory.required(), allow: size => memory.allow(size) });
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });
    const statement = format === "avi" ? "keyframes" : "tracks";
    const params = { sourceKey: "source", fileIndex: 0, fileSize: bytes.length,
      packetMemory: memory.forFile("source", 0), readRange: async (a, b) => {
        reads.set(a, (reads.get(a) ?? 0) + 1);
        if (a === missingEntry && !bytesArrived) {
          bytesArrived = true;
          queueMicrotask(() => requests.bytesChanged("source", 0));
          return null;
        }
        return bytes.subarray(a, b + 1);
      },
      onReadStart: () => ({ storage: requests.revision("source", 0), memory: requests.memoryRevision() }),
      onReadResult: (readStatement, result, revision) => {
        requests.record(params, readStatement, result, revision.storage, revision.memory);
        if (result.kind === "result" || result.kind === "terminal") complete(result);
      } };
    await reader.inspect(params, statement);
    const result = await completed;
    assert.equal(result.kind, "result", JSON.stringify(result));
    if (format === "avi") {
      assert.ok(result.value.times.length > 1);
      const committedEntry = bytes.lastIndexOf(Buffer.from("idx1")) + 8 + 10 * 16;
      assert.equal(reads.get(committedEntry), 1, "memory growth must resume the existing AVI index");
    }
    else assert.ok(result.value.some(track => track.codecId === "V_MPEGH/ISO/HEVC"));
    requests.forget("source");
    memory.forget("source");
    assert.equal(memory.held(), 0);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("ttv-open-memory-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
