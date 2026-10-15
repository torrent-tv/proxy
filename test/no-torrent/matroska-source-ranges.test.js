import test from "node:test";
import assert from "node:assert/strict";
import { MatroskaContainer } from "../../services/media/container/MatroskaContainer.js";
import { buildMatroska, trackEntry, clusterData, pictureBlock, element } from "./helpers/matroska-file.js";
import { ContainerOrchestrator } from "../../services/media/ContainerOrchestrator.js";
import { FFMPEG_STREAM_SEARCH_SECONDS } from "../../services/media/container/ffmpeg-stream-search.js";
import { SegmentInputs } from "../../services/media/SegmentInputs.js";

test("original ranges retain every declared tail element and retry its unavailable header", async () => {
  const declarations = [0x1254c367, 0x1043a770, 0x1941a469].map(id => ({ id,
    bytes: element(id, Buffer.alloc(2 * 1024 * 1024)) }));
  const source = buildMatroska({ tracks: [trackEntry({ number: 1, type: 1, codecId: "V_VP8" })],
    clusters: Array.from({ length: 6 }, (_, index) => ({ ticks: index * 2000,
      data: clusterData({ ticks: index * 2000, blocks: [pictureBlock({ track: 1, payload: Buffer.alloc(2 * 1024 * 1024) })] }) })),
    cues: [1], trailingElements: declarations });
  let missing = true;
  const declarationAt = source.file.length - declarations.reduce((sum, item) => sum + item.bytes.length, 0);
  const params = { sourceKey: "generated", fileIndex: 0, fileSize: source.file.length,
    packetInterval: { from: 0, to: 2 }, portionBytes: 4096,
    readRange: async (start, end) => missing && start === declarationAt ? null : source.file.subarray(start, end + 1) };
  const orchestrator = new ContainerOrchestrator();
  assert.equal((await orchestrator.inspect(params, "source-ranges")).kind, "needs-ranges");
  missing = false;
  const result = await orchestrator.inspect(params, "source-ranges");
  assert.equal(result.kind, "result");
  let at = declarationAt;
  for (const { bytes } of declarations) {
    assert.ok(result.value.ranges.some(([start, end]) => start <= at && end >= at + bytes.length - 1));
    at += bytes.length;
  }
});

test("Cues publish the whole needed cluster range before media bytes arrive", async () => {
  const source = buildMatroska({ tracks: [trackEntry({ number: 1, type: 1, codecId: "V_VP8" })],
    clusters: Array.from({ length: 8 }, (_, index) => ({ ticks: index * 2000, data: clusterData({ ticks: index * 2000,
      blocks: [pictureBlock({ track: 1, payload: Buffer.alloc(2 * 1024 * 1024) })] }) })),
    cues: [1] });
  let reads = 0;
  const container = new MatroskaContainer({ fileSize: source.file.length, portionBytes: 4096,
    readRange: async (start, end) => {
      reads++;
      assert.ok(end < source.clusterAt[0] + 8 || start >= source.cuesAt, "media block bytes are not needed for range mapping");
      return source.file.subarray(start, end + 1);
    } });
  const input = await container.readSourceRanges({ from: 6, to: 10, trackIds: [1] });
  assert.equal(await container.supportsOriginalSourceRanges(), true);
  assert.equal(input.kind, "result");
  assert.equal(input.fileLength, source.file.length);
  assert.ok(input.ranges.some(([start, end]) => start <= source.clusterAt[2] && end >= source.clusterAt[6] - 1));
  assert.ok(reads < 50, "mapping reads metadata rather than each media block");
});

test("the Clusters FFmpeg's stream search reads from the first one are named", async () => {
  // Cues every two seconds; the search stops on the first packet past its
  // stated time, before the first Cue later than it (torrent-tv/meta#165).
  const source = buildMatroska({ tracks: [trackEntry({ number: 1, type: 1, codecId: "V_VP8" })],
    clusters: Array.from({ length: 10 }, (_, index) => ({ ticks: index * 2000, data: clusterData({ ticks: index * 2000,
      blocks: [pictureBlock({ track: 1, payload: Buffer.alloc(2 * 1024 * 1024) })] }) })),
    cues: [1] });
  const container = new MatroskaContainer({ fileSize: source.file.length,
    readRange: async (start, end) => source.file.subarray(start, end + 1) });
  const input = await container.readSourceRanges({ from: 16, to: 18, trackIds: [1] });
  assert.equal(input.kind, "result");
  assert.equal(input.streamSearchSeconds, FFMPEG_STREAM_SEARCH_SECONDS);
  const later = Math.floor(FFMPEG_STREAM_SEARCH_SECONDS / 2) + 1;
  const [head] = input.ranges;
  assert.equal(head[0], 0);
  assert.ok(head[1] >= source.clusterAt[later] - 1, "every Cluster before the first Cue past the search time is held");
  assert.ok(head[1] < source.clusterAt[later + 1], "and nothing of the film beyond it is held for the search");
});

test("an interval beyond the last cue retains the final cluster through EOF", async () => {
  const source = buildMatroska({ tracks: [trackEntry({ number: 1, type: 1, codecId: "V_VP8" })],
    clusters: [{ ticks: 0, data: clusterData({ ticks: 0, blocks: [pictureBlock({ track: 1, payload: Buffer.alloc(1024) })] }) }],
    cues: [1] });
  const container = new MatroskaContainer({ fileSize: source.file.length,
    readRange: async (start, end) => source.file.subarray(start, end + 1) });
  const input = await container.readSourceRanges({ from: 0, to: 10 });
  assert.deepEqual(input.ranges, [[0, source.file.length - 1]]);
});

test("a Matroska file without Cues retains its existing indexed-input path", async () => {
  const source = buildMatroska({ tracks: [trackEntry({ number: 1, type: 1, codecId: "V_VP8" })],
    clusters: [{ ticks: 0, data: clusterData({ ticks: 0, blocks: [pictureBlock({ track: 1, payload: Buffer.alloc(1024) })] }) }], cues: [] });
  const container = new MatroskaContainer({ fileSize: source.file.length,
    readRange: async (start, end) => source.file.subarray(start, end + 1) });
  assert.equal(await container.supportsOriginalSourceRanges(), false);
  assert.equal((await container.readSourceRanges({ from: 0, to: 1 })).kind, "needs-index");
});

test("a soundtrack alone is read from its own packets, not from the picture's clusters", async () => {
  // Each cluster holds 2 MiB of picture and 1 KiB of sound, as a copied 1080p
  // film does at a far larger scale: 38 MB of source for 171 KB of sound per
  // piece on Home Assistant (r44, r46, torrent-tv/meta#178).
  const picture = 2 * 1024 * 1024, sound = 1024;
  const source = buildMatroska({ tracks: [trackEntry({ number: 1, type: 1, codecId: "V_VP8" }),
    trackEntry({ number: 2, type: 2, codecId: "A_AC3" })],
  clusters: Array.from({ length: 8 }, (_, index) => ({ ticks: index * 2000, data: clusterData({ ticks: index * 2000,
    blocks: [pictureBlock({ track: 1, payload: Buffer.alloc(picture) }), pictureBlock({ track: 2, payload: Buffer.alloc(sound, 1) })] }) })),
  cues: [1] });
  const container = new MatroskaContainer({ fileSize: source.file.length, portionBytes: 4096,
    readRange: async (start, end) => source.file.subarray(start, end + 1) });

  assert.equal(await container.supportsOriginalSourceRanges(), true, "the file as a whole answers as its picture");
  assert.equal(await container.supportsOriginalSourceRanges({ from: 6, to: 10, trackIds: [1, 2] }), true);
  assert.equal(await container.supportsOriginalSourceRanges({ from: 6, to: 10, trackIds: [2] }), false,
    "the soundtrack alone is not read from the original file");

  const tracks = await container.readTracks();
  const soundtrack = tracks.find(track => track.trackNumber === 2);
  const index = await container.readPacketIndex({ from: 6, to: 10, trackIds: [2] });
  const input = new SegmentInputs({ index, tracks: [soundtrack] }).forInterval({ from: 6, to: 10, mode: "transcode" });
  assert.equal(input.kind, "result");
  const bytes = input.ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
  assert.ok(bytes < picture, `the sound's input holds no picture block: ${bytes} bytes`);
});
