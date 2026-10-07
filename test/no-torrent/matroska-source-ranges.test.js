import test from "node:test";
import assert from "node:assert/strict";
import { MatroskaContainer } from "../../services/media/container/MatroskaContainer.js";
import { buildMatroska, trackEntry, clusterData, pictureBlock, element } from "./helpers/matroska-file.js";
import { ContainerOrchestrator } from "../../services/media/ContainerOrchestrator.js";

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
