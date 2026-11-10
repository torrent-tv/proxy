/**
 * @file A run built by `EncodeRuns` is told where each of its pieces ends on
 * its output's timeline (torrent-tv/meta#414).
 *
 * The run takes its speed reading from the film between the ends of the pieces
 * it closed, and it does not know the timeline: its owner gives it the end of
 * piece `index` (`pieceEndSeconds`), the file's duration for the last piece.
 * The real `EncodeRuns` and `EncodeInputs` are wired by the manager helper as
 * in `run-starts-inside-its-input.test.js`; resolution, held ranges and reads
 * are fakes and the encoder path names no program, so a run that is built
 * cannot open one. Nothing here reaches a torrent.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { EncodeInputs } from "../../services/encode/EncodeInputs.js";
import { EncodeRun } from "../../services/encode/EncodeRun.js";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { KeyframeTable } from "../../services/media/container/KeyframeTable.js";
import { SourceFile } from "../../services/media/SourceFile.js";
import { logger } from "../../utils/logger.js";
import { managerWithOwnStore } from "./helpers/manager.js";
import { outputOn } from "./helpers/output.js";
import { outputSpec } from "./helpers/output-spec.js";
import { fakeProcess, silentLogger } from "./helpers/encode-run.js";
import { matroskaIdOf } from "./support/codec-lookup.js";

const SESSION_ID = "4140000000000188";
const OUTPUT_KEY = "piece-ends:fmt=fmp4:grid=kf@0:video-only:v=0/copy";
const PIECES = 264;
// Cuts that are not an even grid, so a piece's end is not a multiple of anything.
const TIMES = Array.from({ length: PIECES + 1 }, (_, index) => index * 4 + (index % 3) * 0.5);
const FILM_SECONDS = TIMES[PIECES];
const HEADER = [5000, 5009];
const stretchOf = (from, to) => ({ kind: "result", sources: [{ sourceKey: "source-1", fileIndex: 0, timeShiftSeconds: 0,
  input: { original: true, from: TIMES[from], fileLength: 6000, ranges: [[from * 10, to * 10 + 9], HEADER],
    selections: [{ track: { type: "video" }, index: 0 }] } }] });

const turns = async (count = 8) => { for (let turn = 0; turn < count; turn++) await setImmediate(); };

/** A run of #188 on a copied output, built by the real `EncodeRuns`. */
async function aRunBuiltByEncodeRuns(t) {
  mock.method(logger, "info", () => {});
  mock.method(logger, "warn", () => {});
  t.after(() => mock.restoreAll());
  const inputs = new EncodeInputs({ matroskaIdOf,
    resolve: async (_output, from, to) => stretchOf(from, to),
    heldRanges: async () => [[0, 4999], HEADER],
    readRanges: async (_source, ranges) => ranges.map(([start, end]) => Buffer.alloc(end - start + 1)),
    reviseBudget: async () => inputs.allow(100_000),
    changed: () => {}, failed: (_output, error) => { throw error; } });
  const { manager, root } = managerWithOwnStore({ planless: true, encodeInputs: inputs,
    // No program is there: a run that is built cannot start an encoder.
    ffmpegBin: "/nonexistent/ttv-414/no-encoder" });
  const session = outputOn(manager, {
    id: SESSION_ID,
    key: OUTPUT_KEY,
    spec: outputSpec({ transcodeVideo: false, cutGrid: "keyframe" }),
    timeline: new Timeline({ boundaries: TIMES, cutGrid: "keyframe" }),
    keyframes: new KeyframeTable().learn({ times: TIMES.slice(0, -1), format: "matroska" }),
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "piece-ends.mkv" }).learn({ durationSeconds: FILM_SECONDS }),
    segmentCount: PIECES
  });
  t.after(async () => {
    inputs.forget(session);
    await manager.lifecycle.disposeAll();
    await rm(root, { recursive: true, force: true });
  });
  manager.encodeOrchestrator.setSegmentCount(OUTPUT_KEY, PIECES);
  manager.encodeOrchestrator.notePriorityMap(OUTPUT_KEY, [{ from: 187, to: 263, priority: 1, withinSeconds: 0 }]);
  const making = new EncodeRun({ address: OUTPUT_KEY, encoder: { name: "libx264", kind: "software" }, from: 187, to: 187,
    buildArgs: () => [], spawn: () => fakeProcess(), logger: silentLogger, lastSegmentIndex: () => PIECES - 1,
    because: "the piece before is being made" });
  manager.encodeOrchestrator.adopt(OUTPUT_KEY, making);
  assert.equal(inputs.take(session, 187, 263, 187), null, "preparation is never synchronous");
  await turns();
  manager.encodeRuns.makeRunAt(OUTPUT_KEY, 188, 263, "a check asked for it");
  await turns();
  const run = manager.encodeRuns.makeRunAt(OUTPUT_KEY, 188, 263, "a check asked for it");
  assert.ok(run && run.from === 188, `the run built is ${run ? `#${run.from}..#${run.to}` : "none"}`);
  return run;
}

test("a run built by EncodeRuns is told the end of each piece on its output's timeline", { timeout: 10_000 }, async (t) => {
  const run = await aRunBuiltByEncodeRuns(t);
  assert.equal(typeof run.pieceEndSeconds, "function", "the run has no way to ask where a piece ends");
  assert.equal(run.pieceEndSeconds(188), TIMES[189]);
  assert.equal(run.pieceEndSeconds(189), TIMES[190]);
  assert.equal(run.pieceEndSeconds(262), TIMES[263]);
});

test("the end of the last piece is the film's duration", { timeout: 10_000 }, async (t) => {
  const run = await aRunBuiltByEncodeRuns(t);
  assert.equal(typeof run.pieceEndSeconds, "function", "the run has no way to ask where a piece ends");
  assert.equal(run.pieceEndSeconds(PIECES - 1), FILM_SECONDS);
});
