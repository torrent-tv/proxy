import test from "node:test";
import assert from "node:assert/strict";
import { MatroskaContainer } from "../../services/media/container/MatroskaContainer.js";
import { buildMatroska, trackEntry, clusterData, pictureBlock } from "./helpers/matroska-file.js";

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
  assert.ok(input.ranges.some(([start, end]) => start === source.clusterAt[2] && end >= source.clusterAt[6] - 1));
  assert.ok(reads < 50, "mapping reads metadata rather than each media block");
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
