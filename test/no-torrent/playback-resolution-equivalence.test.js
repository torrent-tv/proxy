// TEMPORARY (torrent-tv/meta#273, design.md section 3): delete this file and
// `support/resolve-playback-before-270.js` in the next commit of the change on
// `main` after #273 is merged. It exists to prove the class equal to the
// closure it replaced and has nothing to say once the closure is gone.
//
// The verbatim closure and `PlaybackResolution` run side by side over the same
// sequence of maps on local AVI, MKV and MP4 files made by ffmpeg-static: one
// picture output and one soundtrack output, each side with a container
// orchestrator and a packet memory of its own. Every pass must return deep-equal
// windows, write the same wait-trace and tell the input table the same
// `(outputKey, index, joined)`. Fixtures are generated; no torrent.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { ContainerOrchestrator } from "../../services/media/ContainerOrchestrator.js";
import { SegmentSourceRanges } from "../../services/media/SegmentSourceRanges.js";
import { segmentReading } from "../../services/media/segment-reading.js";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { SourceFile } from "../../services/media/SourceFile.js";
import { PlaybackResolution } from "../../services/torrent/PlaybackResolution.js";
import { IndexMemory } from "../../services/storage/IndexMemory.js";
import { fakeEncodeInputs } from "./helpers/admitted-input.js";
import { managerWithOwnStore } from "./helpers/manager.js";
import { outputSpec } from "./helpers/output-spec.js";
import { resolvePlaybackBefore270 } from "./support/resolve-playback-before-270.js";

const PIECE_LENGTH = 16 * 1024;
const FORMATS = {
  avi: ["-c:v", "mpeg4", "-g", "20", "-c:a", "libmp3lame", "-b:a", "64k", "-f", "avi"],
  mkv: ["-c:v", "libx264", "-g", "20", "-keyint_min", "20", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "64k", "-f", "matroska"],
  mp4: ["-c:v", "libx264", "-g", "20", "-keyint_min", "20", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "64k", "-f", "mp4"]
};

async function fixture(directory, format) {
  const file = path.join(directory, `source.${format}`);
  const made = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "12", ...FORMATS[format], file],
  { windowsHide: true, encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  return fs.readFile(file);
}

const settle = () => new Promise(resolve => setImmediate(resolve));

/** One side's world: a file held whole, a container orchestrator and a packet memory of its own. */
function world(bytes) {
  const orchestrator = new ContainerOrchestrator();
  const memory = new IndexMemory({ reviseBudget() {}, changed() {} });
  memory.allow(Number.MAX_SAFE_INTEGER);
  const record = { events: [], notes: [], refreshed: [], lines: [] };
  const mediaParams = {
    paramsFor: async ({ sourceKey, fileIndex, requestId, packetInterval, demand }) => ({ sourceKey, fileIndex, requestId, packetInterval,
      packetMemory: memory.forFile(sourceKey, fileIndex), downloadInterval: demand ? { from: demand.from, to: demand.to } : null,
      fileSize: bytes.length, portionBytes: PIECE_LENGTH,
      readRange: async (start, end) => bytes.subarray(start, Math.min(end, bytes.length - 1) + 1) })
  };
  const ports = {
    sourceRanges: new SegmentSourceRanges({ orchestrator }),
    torrentPool: { knownTorrent: () => ({ pieceLength: PIECE_LENGTH }) },
    waitTrace: { source: (sourceKey, event, fields) => record.events.push({ sourceKey, event, fields }) },
    segmentInputs: { set: (sourceKey, fileIndex, outputKey, index, joined) => record.notes.push([sourceKey, fileIndex, outputKey, index, joined]) },
    downloadMaps: { refresh: async (sourceKey, fileIndex) => { record.refreshed.push([sourceKey, fileIndex]); } },
    logger: { info: line => record.lines.push(line), warn: line => assert.fail(line) },
    mediaParams
  };
  return { record, ports, mediaParams };
}

/** The wait-trace without what differs from run to run: instants and the pass's start in the id. */
const traceOf = events => events.map(({ sourceKey, event, fields }) => {
  const { resolutionId, startedAt, endedAt, durationMs, ...rest } = fields;
  return { sourceKey, event, ...rest, resolutionId: resolutionId.replace(/:[0-9.]+$/, "") };
});

const base = 10_000;
/** The maps of a viewer: from the start, a seek to 8 s with the film before it behind, and back. */
const MAPS = [
  [{ from: 0, to: 12, priority: 100, urgent: true, deadlineAt: base }],
  [{ from: 0, to: 12, priority: 100, urgent: true, deadlineAt: base }],
  [{ from: 8, to: 12, priority: 100, urgent: true, deadlineAt: base + 8000 }, { from: 0, to: 8, priority: 10, behind: true }],
  [{ from: 8, to: 12, priority: 100, urgent: true, deadlineAt: base + 8000 }, { from: 0, to: 8, priority: 10, behind: true }],
  [{ from: 2, to: 12, priority: 100, urgent: true, deadlineAt: base + 2000 }],
  []
];

for (const format of Object.keys(FORMATS)) {
  test(`the class gives the windows, the trace and the notes of the closure it replaced on a local ${format}`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv273-equivalence-"));
    const { manager, cleanup } = managerWithOwnStore({ encodeInputs: fakeEncodeInputs() });
    manager.encodeRuns.planEncodersSoon = () => {};
    t.after(async () => {
      cleanup();
      const absolute = path.resolve(directory);
      assert.ok(path.basename(absolute).startsWith("ttv273-equivalence-"));
      await fs.rm(absolute, { recursive: true, force: true });
    });
    const bytes = await fixture(directory, format);

    // One picture with its sound and one soundtrack, watched by one viewer.
    const boundaries = [0, 2, 4, 6, 8, 10, 12];
    const outputs = [outputSpec({ sourceKey: "local", transcodeVideo: false, transcodeAudio: true }),
      outputSpec({ sourceKey: "local", audioOnly: true, transcodeAudio: true })].map((spec, number) => ({
      id: `output-${number}`, spec, get outputKey() { return spec.toKey(); },
      timeline: new Timeline({ boundaries, cutGrid: "keyframe" }),
      file: new SourceFile({ sourceKey: "local", fileIndex: 0, name: `source.${format}` }) }));
    manager.viewers.present("viewer");
    for (const output of outputs) {
      manager.outputs.set(output.id, output);
      manager.viewers.of(output, "viewer");
    }
    assert.equal(manager.playedOutputsOf("local", 0).length, 2);

    const before = world(bytes), after = world(bytes);
    const closure = resolvePlaybackBefore270({ ...before.ports, outputParts: manager }).resolvePlayback;
    const resolution = new PlaybackResolution({
      paramsFor: request => after.mediaParams.paramsFor(request),
      sourceRanges: after.ports.sourceRanges,
      segmentReading,
      playedOutputsOf: (sourceKey, fileIndex) => manager.playedOutputsOf(sourceKey, fileIndex),
      pieceLengthOf: sourceKey => Number(after.ports.torrentPool.knownTorrent(sourceKey)?.pieceLength),
      noteSegmentInput: (...args) => after.ports.segmentInputs.set(...args),
      refresh: (sourceKey, fileIndex) => after.ports.downloadMaps.refresh(sourceKey, fileIndex),
      observeWait: (sourceKey, event, fields) => after.ports.waitTrace.source(sourceKey, event, fields),
      log: line => after.ports.logger.info(line),
      warn: line => after.ports.logger.warn(line)
    });

    const mapOf = (zones, stated) => ({ sourceKey: "local", fileIndex: 0, zones, isCurrent: () => true,
      workingOut: priority => stated.push(priority) });
    let told = 0;
    for (const [number, zones] of MAPS.entries()) {
      const statedBefore = [], statedAfter = [];
      const expected = await closure(mapOf(zones, statedBefore));
      const actual = await resolution.resolve(mapOf(zones, statedAfter));
      await settle();
      assert.deepEqual(actual, expected, `windows of map ${number}`);
      assert.deepEqual(statedAfter, statedBefore, `what was stated before each zone, map ${number}`);
      assert.deepEqual(after.record.notes, before.record.notes, `notes after map ${number}`);
      assert.deepEqual(traceOf(after.record.events), traceOf(before.record.events), `trace after map ${number}`);
      assert.deepEqual(after.record.refreshed, before.record.refreshed, `refreshes after map ${number}`);
      told += actual.length;
    }
    assert.ok(told > 0, "the windows are not empty");
    assert.ok(after.record.notes.length > 0, "the table was told what segments read");
    assert.ok(after.record.events.some(({ fields }) => fields.outcome === "resolved"), "some zone was resolved");
  });
}
