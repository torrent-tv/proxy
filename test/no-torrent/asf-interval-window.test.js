import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { AsfContainer } from "../../services/media/container/AsfContainer.js";
import { ContainerOrchestrator } from "../../services/media/ContainerOrchestrator.js";
import { SegmentInputs } from "../../services/media/SegmentInputs.js";

// A synthetic lavfi film: 30 s, a picture keyframe every 5 s, sound beside it.
async function film(args) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "torrent-tv-asf-window-"));
  try {
    const file = path.join(directory, "film.wmv");
    const encoded = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050",
      "-t", "30", ...args, "-f", "asf", file], { windowsHide: true, encoding: "utf8" });
    assert.equal(encoded.status, 0, encoded.stderr);
    return await fs.readFile(file);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const wmv = () => film(["-c:v", "wmv2", "-g", "50", "-b:v", "200k", "-c:a", "wmav2", "-b:a", "64k", "-packet_size", "1500"]);

/** What a segment reads, apart from record numbers that count from where an index begins. */
function inputOf(index, tracks, interval) {
  const input = new SegmentInputs({ index, tracks }).forInterval(interval);
  return JSON.parse(JSON.stringify(input, (key, value) => key === "decodeFromIndex" || key === "decodeDependencyUnknown" ? undefined : value));
}

test("an ASF interval is read from a window of its packets with the same input as the whole walk", async () => {
  const bytes = await film(["-c:v", "mpeg4", "-bf", "2", "-g", "50", "-c:a", "libmp3lame", "-packet_size", "1500"]);
  const readRange = async (start, end) => bytes.subarray(start, end + 1);
  const whole = new AsfContainer({ fileSize: bytes.length, readRange });
  const tracks = await whole.readTracks();
  const full = await whole.readPacketIndex();
  const windowed = new AsfContainer({ fileSize: bytes.length, readRange });
  await windowed.readTracks();
  const { startTimeSeconds: start } = await windowed.readMediaInfo();
  const media = tracks.filter(track => ["video", "audio"].includes(track.type));
  for (let from = start; from < start + 29; from += 2.5) {
    for (const selected of [media, ...media.map(track => [track])]) {
      const interval = { from, to: from + 2.5, trackIds: selected.map(track => track.trackNumber) };
      const index = await windowed.readPacketIndex(interval);
      assert.notEqual(index, full);
      await index.prepareAudioDependencies(interval, windowed.readRange);
      await full.prepareAudioDependencies(interval, whole.readRange);
      assert.deepEqual(inputOf(index, selected, interval), inputOf(full, selected, interval), `${from}s of ${interval.trackIds}`);
    }
  }
});

test("the first segment of an ASF film is answered from the start of its Data Object alone", async () => {
  // Field 2026-10-23 (proxy 2.105.10): a WMV's inputs answered only
  // needs-ranges until the walk had read the whole file, and it never started
  // (torrent-tv/meta#243).
  const bytes = await wmv();
  // The preroll is sent ahead: 2 s of film are read from about its first 5.5 s.
  const third = Math.floor(bytes.length / 3);
  let furthest = 0;
  const params = { sourceKey: "generated", fileIndex: 0, fileSize: bytes.length,
    readRange: async (start, end) => {
      furthest = Math.max(furthest, end);
      return end < third ? bytes.subarray(start, end + 1) : null;
    } };
  const orchestrator = new ContainerOrchestrator();
  const tracks = await orchestrator.inspect(params, "tracks");
  const info = await orchestrator.inspect(params, "media-info");
  const interval = { from: info.value.startTimeSeconds, to: info.value.startTimeSeconds + 2 };
  const packets = await orchestrator.inspect({ ...params, packetInterval: interval }, "packets");
  assert.equal(packets.kind, "result");
  const input = new SegmentInputs({ index: packets.value, tracks: tracks.value }).forInterval(interval);
  assert.equal(input.kind, "result");
  assert.ok(input.ranges.every(([, end]) => end < third));
  assert.ok(furthest < third, "nothing past the window is read");
  assert.equal((await orchestrator.inspect(params, "packets")).kind, "needs-ranges", "the whole walk still needs the whole file");
});

test("a seek in an ASF film asks for its window, not for the film before it", async () => {
  const bytes = await wmv();
  const pieceLength = 16384;
  const held = new Set();
  const holds = (start, end) => {
    for (let piece = Math.floor(start / pieceLength); piece <= Math.floor(end / pieceLength); piece++) if (!held.has(piece)) return false;
    return true;
  };
  const params = { sourceKey: "generated", fileIndex: 0, fileSize: bytes.length,
    readRange: async (start, end) => holds(start, end) ? bytes.subarray(start, end + 1) : null };
  const orchestrator = new ContainerOrchestrator();
  const answer = async (statement, extra = {}) => {
    for (let asked = 0; asked < 20; asked++) {
      const result = await orchestrator.inspect({ ...params, ...extra }, statement);
      if (result.kind !== "needs-ranges") return { result, asked };
      for (const [start, end] of result.ranges) {
        for (let piece = Math.floor(start / pieceLength); piece <= Math.floor(end / pieceLength); piece++) held.add(piece);
      }
    }
    assert.fail(`${statement} was never answered`);
  };
  const tracks = (await answer("tracks")).result.value;
  const start = (await answer("media-info")).result.value.startTimeSeconds;
  const before = held.size;
  const interval = { from: start + 21, to: start + 23 };
  const { result, asked } = await answer("packets", { packetInterval: interval });
  assert.equal(result.kind, "result");
  assert.equal(new SegmentInputs({ index: result.value, tracks }).forInterval(interval).kind, "result");
  const pieces = Math.ceil(bytes.length / pieceLength);
  // The window begins a preroll and a little before the 21st second; the
  // film before 12 s is not asked for at all, its head apart.
  const early = [...held].filter(piece => piece > 0 && piece < pieces * 0.4);
  assert.deepEqual(early, [], `pieces ${early} before the window were fetched`);
  assert.ok(held.size - before < pieces / 2, `fetched ${held.size - before} of ${pieces} pieces`);
  assert.ok(asked <= 4, `answered after ${asked} rounds of missing bytes`);
});

test("an obsolete ASF interval stops reading its packet window", async () => {
  const bytes = await wmv();
  const dataOffset = Number(bytes.readBigUInt64LE(16));
  const packetReads = [];
  const container = new AsfContainer({ fileSize: bytes.length, readRange: async (start, end) => {
    if (start >= dataOffset) packetReads.push([start, end]);
    return bytes.subarray(start, end + 1);
  } });
  const info = await container.readMediaInfo();
  packetReads.length = 0;
  let checks = 0;
  const index = await container.readPacketIndex({ from: info.startTimeSeconds, to: info.startTimeSeconds + 2 }, {
    isCurrent: () => ++checks < 9
  });

  assert.equal(index, null);
  assert.ok(checks >= 9);
  assert.ok(packetReads.length < 20, `read ${packetReads.length} packet ranges after the request was withdrawn`);
});

test("cancelling a blocked ASF range releases the file read queue for a newer interval", async () => {
  const bytes = await wmv();
  const dataOffset = Number(bytes.readBigUInt64LE(16));
  let blocked = false, signal, release;
  let started;
  const readStarted = new Promise(resolve => { started = resolve; });
  const blockedRead = new Promise(resolve => { release = resolve; });
  const params = { sourceKey: "generated", fileIndex: 0, fileSize: bytes.length,
    readRange: async (start, end, options) => {
      if (start >= dataOffset && options?.signal && !blocked) {
        blocked = true;
        signal = options?.signal;
        started();
        return blockedRead;
      }
      return bytes.subarray(start, end + 1);
    } };
  const orchestrator = new ContainerOrchestrator();
  const tracks = await orchestrator.inspect(params, "tracks");
  const info = await orchestrator.inspect(params, "media-info");
  const interval = { from: info.value.startTimeSeconds + 10, to: info.value.startTimeSeconds + 12 };
  const oldRequest = new AbortController();
  const stale = orchestrator.inspect({ ...params, signal: oldRequest.signal, packetInterval: interval }, "packets");
  await readStarted;
  assert.equal(signal, oldRequest.signal);
  oldRequest.abort();
  const cancelled = await stale;
  assert.equal(cancelled.kind, "terminal");
  assert.equal(cancelled.reason, "request-obsolete");

  release(bytes.subarray(dataOffset, dataOffset + 50_000));
  const current = await orchestrator.inspect({ ...params, packetInterval: interval }, "packets");
  assert.equal(current.kind, "result");
  assert.equal(new SegmentInputs({ index: current.value, tracks: tracks.value }).forInterval(interval).kind, "result");
});

test("WMV keyframe warm-up does not walk packet data that the re-encoded output cannot copy", async () => {
  const bytes = await wmv();
  const dataOffset = Number(bytes.readBigUInt64LE(16));
  const packetReads = [];
  const container = new AsfContainer({ fileSize: bytes.length,
    readRange: async (start, end) => {
      if (start >= dataOffset) packetReads.push([start, end]);
      return bytes.subarray(start, end + 1);
    } });

  const index = await container.parseKeyframeIndex();

  assert.deepEqual(index.times, []);
  assert.equal(index.copyable, false);
  assert.deepEqual(packetReads, []);
});

test("ASF packets of different lengths are still read by the whole walk", async () => {
  const bytes = await wmv();
  const container = new AsfContainer({ fileSize: bytes.length, readRange: async (start, end) => bytes.subarray(start, end + 1) });
  const tracks = await container.readTracks();
  const info = await container.readMediaInfo();
  // A file whose least packet length differs from its most cannot address a
  // packet by its number; the answer is the whole walk's, as before.
  const properties = bytes.indexOf(Buffer.from("a1dcab8c47a9cf118ee400c00c205365", "hex"));
  const varied = Buffer.from(bytes);
  varied.writeUInt32LE(info.packetLength - 1, properties + 24 + 68);
  const other = new AsfContainer({ fileSize: varied.length, readRange: async (start, end) => varied.subarray(start, end + 1) });
  await other.readTracks();
  const interval = { from: info.startTimeSeconds, to: info.startTimeSeconds + 2 };
  const index = await other.readPacketIndex(interval);
  assert.equal(index, await other.readPacketIndex(), "the whole walk's index is the one answered");
  assert.equal(new SegmentInputs({ index, tracks }).forInterval(interval).kind, "result");
});
