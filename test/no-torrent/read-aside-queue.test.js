/**
 * @file A statement answered from what a container has already read is
 * answered beside a read of the same file still in progress (torrent-tv/meta#178).
 *
 * Field r38 (Home Assistant, 2026-10-14): the picture's first input of an AVI
 * waited about 4 s behind the sound's packet table of the whole film, which it
 * does not use. Generated media and a stub container only; no torrent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { AviContainer } from "../../services/media/container/AviContainer.js";
import { ContainerOrchestrator } from "../../services/media/ContainerOrchestrator.js";

const params = { sourceKey: "film", fileIndex: 0, readRange: async () => Buffer.alloc(0), fileSize: 1 };

test("a statement answered without reading does not wait behind a read in progress, and one that reads still does", async () => {
  let releasePackets;
  const packets = new Promise(resolve => { releasePackets = resolve; });
  const container = {
    answersWithoutReading: statement => statement === "source-ranges",
    readPacketIndex: () => packets,
    readSourceRanges: async () => ({ kind: "result", ranges: [[0, 9]] }),
    readKeyframeIndex: async () => ({ times: [0] })
  };
  const orchestrator = new ContainerOrchestrator();
  orchestrator.cache.set("film:0", container);
  const order = [];
  const sound = orchestrator.inspect({ ...params }, "packets").then(() => order.push("packets"));
  const keyframes = orchestrator.inspect({ ...params }, "keyframes").then(() => order.push("keyframes"));
  const picture = await orchestrator.inspect({ ...params }, "source-ranges");
  order.push("source-ranges");
  assert.deepEqual(picture.value.ranges, [[0, 9]]);
  assert.deepEqual(order, ["source-ranges"], "answered while the sound's table was still being built");
  releasePackets({ prepareAudioDependencies: async () => {} });
  await Promise.all([sound, keyframes]);
  assert.deepEqual(order, ["source-ranges", "packets", "keyframes"], "a statement that reads waits its turn");
});

test("a track table already kept is answered beside the queue too", async () => {
  let releasePackets;
  const packets = new Promise(resolve => { releasePackets = resolve; });
  const orchestrator = new ContainerOrchestrator();
  orchestrator.cache.set("film:0", { readPacketIndex: () => packets, readTracks: async () => [{ type: "video" }] });
  orchestrator.tracks.set("film:0", [{ type: "video", kept: true }]);
  const sound = orchestrator.inspect({ ...params }, "packets");
  const tracks = await orchestrator.inspect({ ...params }, "tracks");
  assert.equal(tracks.value[0].kept, true);
  releasePackets(null);
  await sound;
});

test("an exact playback input runs before a speculative extension at the same urgency", async () => {
  let releaseActive;
  let activeStarted;
  const activeGate = new Promise(resolve => { releaseActive = resolve; });
  const started = new Promise(resolve => { activeStarted = resolve; });
  const order = [];
  const container = {
    readPacketIndex: async interval => {
      order.push(interval.name);
      if (interval.name === "active") {
        activeStarted();
        await activeGate;
      }
      return { prepareAudioDependencies: async () => {} };
    }
  };
  const orchestrator = new ContainerOrchestrator();
  orchestrator.cache.set("film:0", container);
  const active = orchestrator.inspect({ ...params, packetInterval: { from: 0, to: 0, name: "active" } }, "packets");
  await started;
  const extension = orchestrator.inspect({ ...params, packetInterval: { from: 10, to: 20, name: "extension" },
    readPriority: { rank: 100, serves: 10, from: 10, to: 20 } }, "packets");
  const exact = orchestrator.inspect({ ...params, packetInterval: { from: 10, to: 10, name: "exact" },
    readPriority: { rank: 100, serves: 10, from: 10, to: 10 } }, "packets");
  const lowerRank = orchestrator.inspect({ ...params, packetInterval: { from: 5, to: 5, name: "lower-rank" },
    readPriority: { rank: 99, serves: 5, from: 5, to: 5 } }, "packets");
  releaseActive();
  await Promise.all([active, extension, exact, lowerRank]);
  assert.deepEqual(order, ["active", "exact", "extension", "lower-rank"]);
});

test("a withdrawn queued media read is removed before the next urgent read", async () => {
  let releaseActive;
  let activeStarted;
  const activeGate = new Promise(resolve => { releaseActive = resolve; });
  const started = new Promise(resolve => { activeStarted = resolve; });
  const order = [];
  const container = {
    readPacketIndex: async interval => {
      order.push(interval.name);
      if (interval.name === "active") {
        activeStarted();
        await activeGate;
      }
      return { prepareAudioDependencies: async () => {} };
    }
  };
  const orchestrator = new ContainerOrchestrator();
  orchestrator.cache.set("film:0", container);
  const active = orchestrator.inspect({ ...params, packetInterval: { from: 0, to: 0, name: "active" } }, "packets");
  await started;
  const controller = new AbortController();
  const withdrawn = orchestrator.inspect({ ...params, signal: controller.signal,
    packetInterval: { from: 1, to: 2, name: "withdrawn" },
    readPriority: { rank: 100, serves: 1, from: 1, to: 2 } }, "packets");
  controller.abort();
  const urgent = orchestrator.inspect({ ...params, packetInterval: { from: 3, to: 3, name: "urgent" },
    readPriority: { rank: 100, serves: 3, from: 3, to: 3 } }, "packets");
  releaseActive();
  const [activeResult, withdrawnResult, urgentResult] = await Promise.all([active, withdrawn, urgent]);
  assert.equal(activeResult.kind, "result");
  assert.equal(withdrawnResult.reason, "request-obsolete");
  assert.equal(urgentResult.kind, "result");
  assert.deepEqual(order, ["active", "urgent"]);
});

/** A short AVI, written to a file: its sizes are filled in only when the muxer can seek back. */
function avi() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ttv178-aside-"));
  try {
    const file = path.join(directory, "film.avi");
    const result = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25", "-f", "lavfi",
      "-i", "sine=frequency=1000:sample_rate=44100", "-t", "4", "-c:v", "mpeg4", "-g", "25", "-c:a", "libmp3lame", file],
    { windowsHide: true });
    assert.equal(result.status, 0, String(result.stderr));
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function containerOf(bytes, reads) {
  return new AviContainer({ fileSize: bytes.length, readRange: async (start, end) => {
    reads.count += 1;
    return bytes.subarray(start, end + 1);
  } });
}

test("an AVI's index is read once for two asks at once, and only then are the picture's statements answered without reading", async () => {
  const bytes = avi();
  const interval = { from: 1, to: 2 };
  const alone = { count: 0 };
  const one = containerOf(bytes, alone);
  assert.equal(one.answersWithoutReading("source-ranges"), false, "nothing read yet");
  await one.readSourceRanges(interval);
  assert.equal(one.answersWithoutReading("source-ranges"), true);
  assert.equal(one.answersWithoutReading("source-navigation"), true);
  assert.equal(one.answersWithoutReading("packets"), false, "the sound's table is a read of its own");

  const together = { count: 0 };
  const two = containerOf(bytes, together);
  const [first, second] = await Promise.all([two.readSourceRanges(interval), two.readSourceRanges(interval)]);
  assert.deepEqual(first, second);
  assert.equal(together.count, alone.count, "two asks at once read the file as often as one");
});
