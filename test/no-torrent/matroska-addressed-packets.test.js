import assert from "node:assert/strict";
import test from "node:test";
import { MatroskaContainer } from "../../services/media/container/MatroskaContainer.js";
import { BytesUnavailable } from "../../services/media/container/unavailable.js";
import { IndexMemory } from "../../services/storage/IndexMemory.js";
import { ID, buildMatroska, clusterData, element, trackEntry, uintElement } from "./helpers/matroska-file.js";

function source({ cues = [1] } = {}) {
  const video = trackEntry({ number: 1, type: 1, codecId: "V_VP8" });
  const audio = trackEntry({ number: 2, type: 2, codecId: "A_AC3" });
  const withDuration = (entry, preroll = false) => element(ID.TRACK_ENTRY, Buffer.concat([
    entry.subarray(5), uintElement(0x23e383, 500_000_000),
    ...(preroll ? [uintElement(0x56bb, 500_000_000)] : [])
  ]));
  return buildMatroska({ tracks: [withDuration(video), withDuration(audio, true)], cues,
    clusters: Array.from({ length: 7 }, (_, second) => ({ ticks: second * 1000,
      data: clusterData({ ticks: second * 1000, blocks: [0, 500].flatMap(relative => [1, 2].map(track => {
        const header = Buffer.from([0x80 | track, 0, 0, 0x80]);
        header.writeInt16BE(relative, 1);
        return element(ID.SIMPLE_BLOCK, Buffer.concat([header, Buffer.alloc(128, second)]));
      })) }) })) });
}

async function containerOver(data, readRange, packetMemory) {
  const container = new MatroskaContainer({ fileSize: data.file.length, readRange, packetMemory });
  const tracks = await container.readTracks();
  // The synthetic picture has no reordered frames.
  tracks.find(track => track.type === "video").reorderDepth = 0;
  await container.readMediaInfo();
  await container.readCues();
  return container;
}

test("a later Matroska interval reads its cue and decoder prefix without earlier Cluster bytes", async () => {
  const data = source();
  let selected = false;
  const reads = [];
  const container = await containerOver(data, async (from, to) => {
    reads.push([from, to]);
    if (selected && from >= data.clusterAt[0] && from < data.clusterAt[2]) throw new BytesUnavailable(from, to, 0);
    return data.file.subarray(from, to + 1);
  });
  selected = true;
  reads.length = 0;
  const index = await container.readPacketIndex({ from: 4, to: 5 });
  assert.equal(index.inputFor({ trackId: 1, from: 4, to: 5, mode: "copy" }).kind, "result");
  const audio = index.inputFor({ trackId: 2, from: 4, to: 5 });
  assert.equal(audio.kind, "result");
  assert.equal(audio.decodeFrom, 3.5);
  assert.ok(reads.every(([from]) => from >= data.clusterAt[2]));
  assert.equal(index.isComplete(), false);
});

test("reaching the last Matroska interval cannot cache it as the whole-file packet index", async () => {
  const data = source();
  const container = await containerOver(data, async (from, to) => data.file.subarray(from, to + 1));
  const last = await container.readPacketIndex({ from: 6, to: 7 });
  assert.ok(last.boundsOf(1).start > 0);
  assert.equal(last.inputFor({ trackId: 1, from: 6, to: 7 }).kind, "result");
  const earlier = await container.readPacketIndex({ from: 1, to: 2 });
  assert.equal(earlier.inputFor({ trackId: 1, from: 1, to: 2 }).kind, "result");
  const whole = await container.readPacketIndex();
  assert.equal(whole.isComplete(), true);
  assert.equal(whole.boundsOf(1).start, 0);
});

test("adjacent intervals reuse their addressed packet allocation and source retirement releases it", async () => {
  const data = source();
  const memory = new IndexMemory({ reviseBudget() {}, changed() {} });
  memory.allow(4 * 1024 * 1024);
  const reads = [];
  const container = await containerOver(data, async (from, to) => {
    reads.push(from);
    return data.file.subarray(from, to + 1);
  }, memory.forFile("source", 0));
  await container.readPacketIndex({ from: 3, to: 4 });
  const allocation = container.packetIndexBytes();
  reads.length = 0;
  await container.readPacketIndex({ from: 4, to: 5 });
  assert.ok(reads.every(from => from >= data.clusterAt[4]));
  assert.equal(container.packetIndexBytes(), allocation);
  assert.equal(memory.packetBytes(), container.packetIndexBytes());
  await container.readPacketIndex({ from: 0, to: 1 });
  assert.equal(memory.packetBytes(), container.packetIndexBytes());
  memory.forget("source");
  assert.equal(memory.held(), 0);
});

test("a Matroska file without Cues still walks actual structural headers", async () => {
  const data = source({ cues: null });
  const container = await containerOver(data, async (from, to) => data.file.subarray(from, to + 1));
  const index = await container.readPacketIndex({ from: 4, to: 5 });
  assert.equal(index.inputFor({ trackId: 1, from: 4, to: 5, mode: "copy" }).kind, "result");
  assert.equal(index.boundsOf(1).start, 0);
});

test("an addressed Matroska read resumes after its selected structural bytes arrive", async () => {
  const data = source();
  let missing = true;
  const unavailableAt = data.clusterAt[4];
  const reads = [];
  const container = await containerOver(data, async (from, to) => {
    reads.push(from);
    if (missing && from >= unavailableAt && from < data.clusterAt[5]) throw new BytesUnavailable(from, to, 0);
    return data.file.subarray(from, to + 1);
  });
  await assert.rejects(container.readPacketIndex({ from: 4, to: 5 }), BytesUnavailable);
  missing = false;
  reads.length = 0;
  const index = await container.readPacketIndex({ from: 4, to: 5 });
  assert.equal(index.inputFor({ trackId: 1, from: 4, to: 5, mode: "copy" }).kind, "result");
  assert.ok(reads.every(from => from >= unavailableAt));
});
