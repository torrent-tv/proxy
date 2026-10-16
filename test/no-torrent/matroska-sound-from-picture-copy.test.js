/**
 * @file A soundtrack's packets are walked from the bytes the picture's input
 * copied for the same piece (torrent-tv/meta#178, r65).
 *
 * Clusters here are larger than the 1 MB the picture's ranges reach into the
 * next one, as on a 1080p film; with smaller ones the ranges merge and the
 * check passes whatever the walk's start. Nothing here reaches a torrent.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MatroskaContainer } from "../../services/media/container/MatroskaContainer.js";
import { ID, buildMatroska, element, trackEntry, uintElement } from "./helpers/matroska-file.js";

const CLUSTERS = 14, CLUSTER = 5, FPS = 24, SOUND = 0.032, PICTURE_BYTES = 20_000;

function film() {
  const withDuration = (entry, nanoseconds) => element(ID.TRACK_ENTRY, Buffer.concat([entry.subarray(5), uintElement(0x23e383, nanoseconds)]));
  const block = (track, relative, key) => {
    const header = Buffer.from([0x80 | track, 0, 0, key ? 0x80 : 0]);
    header.writeInt16BE(relative, 1);
    return element(ID.SIMPLE_BLOCK, Buffer.concat([header, Buffer.alloc(track === 1 ? PICTURE_BYTES : 60, track)]));
  };
  const clusters = [];
  for (let cluster = 0; cluster < CLUSTERS; cluster++) {
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

async function container(held = () => true) {
  const opened = new MatroskaContainer({ fileSize: data.file.length, readRange: async (start, end) => held(start, end) ? data.file.subarray(start, end + 1) : null });
  const tracks = await opened.readTracks();
  tracks.find(track => track.type === "video").reorderDepth = 0;
  await opened.readMediaInfo();
  await opened.readCues();
  return opened;
}

test("each piece's soundtrack is walked from the picture's copy of that piece, and its own read then reads nothing", async () => {
  const picture = await container();
  let reads = 0;
  const sound = await container(() => { reads++; return true; });
  for (let piece = 6; piece < 11; piece++) {
    const interval = { from: piece * CLUSTER, to: (piece + 1) * CLUSTER };
    const { ranges } = await picture.readSourceRanges({ ...interval, trackIds: [1] });
    assert.ok(ranges.length > 2, "the picture's ranges do not cover the whole file");
    const copy = (start, end) => ranges.some(([first, last]) => first <= start && end <= last) ? data.file.subarray(start, end + 1) : null;
    const holdsUntil = start => { const range = ranges.find(([first, last]) => first <= start && start <= last); return range ? range[1] + 1 : null; };
    assert.equal(await sound.learnPackets({ ...interval, trackIds: [2] }, copy, holdsUntil), "walked", `piece ${piece}`);
    reads = 0;
    const account = { lockMs: 0, reads: 0, bytes: 0 };
    assert.ok(await sound.readPacketIndex({ ...interval, trackIds: [2] }, { account }));
    assert.equal(account.reads, 0, `piece ${piece} reads nothing of the file`);
    assert.equal(reads, 0, "and the file was asked for nothing");
  }
});
