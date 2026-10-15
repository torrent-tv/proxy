import assert from "node:assert/strict";
import test from "node:test";
import { MatroskaContainer } from "../../services/media/container/MatroskaContainer.js";
import { PacketRecords } from "../../services/media/container/PacketRecords.js";
import { BytesUnavailable } from "../../services/media/container/unavailable.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";
import { IndexMemory } from "../../services/storage/IndexMemory.js";
import { SegmentInputs } from "../../services/media/SegmentInputs.js";
import { ID, buildMatroska, element, trackEntry, uintElement } from "./helpers/matroska-file.js";

// A film of SEGMENTS ten-second pieces in five-second clusters, each cluster
// cued on its picture: 24 pictures and about 31 sound frames a second, as the
// soundtrack of r47 was read (torrent-tv/meta#178).
const SEGMENTS = 12, SEGMENT = 10, CLUSTER = 5, FPS = 24, SOUND = 0.032;

function film() {
  const withDuration = (entry, nanoseconds) => element(ID.TRACK_ENTRY, Buffer.concat([entry.subarray(5), uintElement(0x23e383, nanoseconds)]));
  const block = (track, relative, key) => {
    const header = Buffer.from([0x80 | track, 0, 0, key ? 0x80 : 0]);
    header.writeInt16BE(relative, 1);
    return element(ID.SIMPLE_BLOCK, Buffer.concat([header, Buffer.alloc(track === 1 ? 400 : 60, track)]));
  };
  const clusters = [];
  for (let cluster = 0; cluster < SEGMENTS * SEGMENT / CLUSTER; cluster++) {
    const ticks = cluster * CLUSTER * 1000;
    const events = [];
    for (let frame = 0; frame < CLUSTER * FPS; frame++) events.push([Math.round(frame * 1000 / FPS), 1, frame === 0]);
    for (let frame = 0; frame * SOUND < CLUSTER; frame++) events.push([Math.round(frame * SOUND * 1000), 2, true]);
    events.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    clusters.push({ ticks, data: Buffer.concat([uintElement(ID.TIMESTAMP, ticks), ...events.map(event => block(event[1], event[0], event[2]))]) });
  }
  return buildMatroska({ tracks: [withDuration(trackEntry({ number: 1, type: 1, codecId: "V_VP8" }), Math.round(1e9 / FPS)),
    withDuration(trackEntry({ number: 2, type: 2, codecId: "A_AC3" }), 32_000_000)], clusters, cues: [1] });
}

const data = film();
const SOUND_FRAMES = Math.ceil(CLUSTER / SOUND) * SEGMENTS * SEGMENT / CLUSTER;

/** A container over `data` whose reads answer only what `held` says is held. */
async function over({ held = () => true, packetMemory } = {}) {
  const container = new MatroskaContainer({ fileSize: data.file.length, packetMemory, readRange: async (from, to) => {
    if (!held(from, to)) throw new BytesUnavailable(from, to, 0);
    return data.file.subarray(from, to + 1);
  } });
  const tracks = await container.readTracks();
  tracks.find(track => track.type === "video").reorderDepth = 0;
  await container.readMediaInfo();
  await container.readCues();
  return { container, sound: tracks.find(track => track.type === "audio") };
}

/** Every table written from here on, and the packets each holds. */
function countTables(t) {
  const tables = new Set();
  const push = PacketRecords.prototype.push;
  PacketRecords.prototype.push = function (packet) { tables.add(this); return push.call(this, packet); };
  t.after(() => { PacketRecords.prototype.push = push; });
  return () => {
    const offsets = [...tables].flatMap(table => Array.from({ length: table.length }, (_, index) => table.at(index).ranges[0][0]));
    return { tables: tables.size, stored: offsets.length, unique: new Set(offsets).size,
      picture: offsets.filter(at => data.file[at] === 1).length };
  };
}

const soundOf = piece => ({ from: piece * SEGMENT, to: (piece + 1) * SEGMENT, trackIds: [2] });
const inputOf = (index, sound, piece) => new SegmentInputs({ index, tracks: [sound] })
  .forInterval({ ...soundOf(piece), mode: "transcode" });

test("a soundtrack read in the download map's order keeps one table per stretch, no picture and no packet twice", async t => {
  const { container: whole, sound: wholeSound } = await over();
  const complete = await whole.readPacketIndex();
  const expected = Array.from({ length: SEGMENTS }, (_, piece) => inputOf(complete, wholeSound, piece));
  const tables = countTables(t);

  // Nothing held but the declarations and where the first cluster begins: the map's first pass begins a reading
  // for every piece and none of them records anything.
  let heldClusters = new Set();
  // A read answers only when every cluster it touches is held; the
  // declarations, the first cluster's header and the Cues always are.
  const { container, sound } = await over({ held: (from, to) => {
    for (let cluster = 0; cluster < data.clusterAt.length; cluster++) {
      const begin = data.clusterAt[cluster], end = data.clusterAt[cluster + 1] ?? data.cuesAt;
      if (to < begin || from >= end || heldClusters.has(cluster)) continue;
      if (cluster === 0 && to < begin + 24) continue;
      return false;
    }
    return true;
  } });
  for (let piece = 0; piece < SEGMENTS; piece++) {
    await assert.rejects(container.readPacketIndex(soundOf(piece)), BytesUnavailable);
  }
  // Far clusters arrive before near ones, as a swarm brings pieces in any
  // order, and the map asks again after each arrival.
  const answers = new Map();
  for (const arrived of [[12, 13, 20, 21], [2, 3, 8, 9, 14, 15], [0, 1, 4, 5, 6, 7], [10, 11, 16, 17, 18, 19, 22, 23]]) {
    heldClusters = new Set([...heldClusters, ...arrived]);
    for (let pass = 0; pass < 2; pass++) for (let piece = 0; piece < SEGMENTS; piece++) {
      try { answers.set(piece, inputOf(await container.readPacketIndex(soundOf(piece)), sound, piece)); }
      catch (error) { if (!(error instanceof BytesUnavailable)) throw error; }
    }
  }
  for (let piece = 0; piece < SEGMENTS; piece++) {
    assert.deepEqual(answers.get(piece).ranges, expected[piece].ranges, `piece ${piece} reads what the whole table says`);
    assert.equal(answers.get(piece).tracks[0].decodeFrom, expected[piece].tracks[0].decodeFrom);
  }
  const counted = tables();
  assert.equal(counted.picture, 0, "no picture packet is recorded for a soundtrack");
  assert.equal(counted.stored, SOUND_FRAMES, "every sound frame once");
  assert.equal(counted.unique, counted.stored, "and none twice");
});

test("repeated and overlapping intervals add no packet", async t => {
  const tables = countTables(t);
  const { container } = await over();
  await container.readPacketIndex(soundOf(4));
  const first = tables();
  const bytes = container.packetIndexBytes();
  await container.readPacketIndex(soundOf(4));
  await container.readPacketIndex({ from: 42, to: 47, trackIds: [2] });
  await container.readPacketIndex({ from: 38, to: 45, trackIds: [2] });
  assert.deepEqual(tables(), first);
  assert.equal(container.packetIndexBytes(), bytes);
});

test("a known end is not a known middle, and reaching the file's end does not complete the file", async () => {
  const { container, sound } = await over();
  const last = await container.readPacketIndex(soundOf(SEGMENTS - 1));
  assert.equal(inputOf(last, sound, SEGMENTS - 1).kind, "result");
  assert.equal(last.isComplete(), false, "the picture was not read");
  assert.notEqual(last.inputFor({ trackId: 2, from: 20, to: 30 }).kind, "result",
    "an index made for the end says nothing of the middle");
  const middle = await container.readPacketIndex(soundOf(5));
  assert.equal(inputOf(middle, sound, 5).kind, "result");
  const whole = await container.readPacketIndex();
  assert.equal(whole.isComplete(), true);
  assert.equal(whole.boundsOf(2).start, 0);
  assert.equal(whole.boundsOf(1).start, 0);
});

test("a changed selection reads the other track into a table of its own", async t => {
  const tables = countTables(t);
  const { container } = await over();
  await container.readPacketIndex(soundOf(3));
  const sound = tables();
  const picture = await container.readPacketIndex({ from: 30, to: 40, trackIds: [1] });
  assert.equal(picture.inputFor({ trackId: 1, from: 30, to: 40, mode: "copy" }).kind, "result");
  const both = tables();
  assert.equal(both.tables, sound.tables + 1);
  assert.equal(both.unique, both.stored);
});

test("a read refused memory goes on from the same block once memory is given", async () => {
  const memory = new IndexMemory({ reviseBudget() {}, changed() {} });
  memory.allow(1024 * 1024);
  const { container, sound } = await over({ packetMemory: memory.forFile("source", 0) });
  memory.allow(memory.held() + 8192);
  await assert.rejects(container.readPacketIndex(soundOf(2)), IndexMemoryUnavailable);
  memory.allow(memory.held() + 1024 * 1024);
  const index = await container.readPacketIndex(soundOf(2));
  assert.equal(inputOf(index, sound, 2).kind, "result");
  assert.equal(memory.packetBytes(), container.packetIndexBytes());
  memory.forget("source");
  assert.equal(memory.held(), 0);
});

test("two reads of one track at once record each block once", async t => {
  const tables = countTables(t);
  const { container, sound } = await over();
  const [near, far] = await Promise.all([container.readPacketIndex(soundOf(0)), container.readPacketIndex(soundOf(1))]);
  assert.equal(inputOf(near, sound, 0).kind, "result");
  assert.equal(inputOf(far, sound, 1).kind, "result");
  const counted = tables();
  assert.equal(counted.unique, counted.stored);
});

test("a downloaded cluster is walked in portions, not a read per block header", async () => {
  let reads = 0;
  const { container, sound } = await over({ held: () => { reads++; return true; } });
  reads = 0;
  const index = await container.readPacketIndex(soundOf(3));
  assert.equal(inputOf(index, sound, 3).kind, "result");
  // Five clusters of about 280 blocks each are walked: three reads for each
  // cluster's header and one for its contents, where every block header took
  // reads of its own.
  assert.ok(reads <= 25, `${reads} reads`);
});
