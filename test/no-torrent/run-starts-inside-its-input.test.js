/**
 * @file No run is started past the end of its input (torrent-tv/meta#341).
 *
 * Field 2026-11-09: the piece before #188 was being made, so the run for #188
 * read from the keyframe before; the input keyed at #187 held the stretch
 * #187..#187, prepared for #187, and the run was built as #188..#187. What is
 * checked: the real `EncodeRuns` and `EncodeInputs`, wired by `wireOutputs`,
 * build no run there, and build one from #188 reaching #188 once its input is
 * ready.
 *
 * Nothing here reaches a torrent or an encoder: resolution, held ranges and
 * reads are fakes, the run already making #187 is a fake process, and the
 * encoder path names no program, so a run that is built cannot open one.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { EncodeInputs } from "../../services/encode/EncodeInputs.js";
import { EncodeRun } from "../../services/encode/EncodeRun.js";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { KeyframeTable } from "../../services/media/container/KeyframeTable.js";
import { logger } from "../../utils/logger.js";
import { managerWithOwnStore } from "./helpers/manager.js";
import { outputOn } from "./helpers/output.js";
import { outputSpec } from "./helpers/output-spec.js";
import { fakeProcess, silentLogger } from "./helpers/encode-run.js";
import { matroskaIdOf } from "./support/codec-lookup.js";

const SESSION_ID = "3410000000000188";
const OUTPUT_KEY = "seek-run-range:fmt=fmp4:grid=kf@0:video-only:v=0/copy";
const PIECES = 264;
const PIECE_SECONDS = 4;
const TIMES = Array.from({ length: PIECES + 1 }, (_, index) => index * PIECE_SECONDS);
// Segment k of the file is the ten bytes at 10k; the header and index are ten
// bytes at 5000 that every stretch needs once.
const HEADER = [5000, 5009];
const stretchOf = (from, to) => ({ kind: "result", sources: [{ sourceKey: "source-1", fileIndex: 0, timeShiftSeconds: 0,
  input: { original: true, from: TIMES[from], fileLength: 6000, ranges: [[from * 10, to * 10 + 9], HEADER],
    selections: [{ track: { type: "video" }, index: 0 }] } }] });

const turns = async (count = 8) => { for (let turn = 0; turn < count; turn++) await setImmediate(); };

/**
 * The field case: an output copying its picture from the original file, its
 * map wanting #187..#263, a live run making #187, and the input keyed at #187
 * ready with #187..#187, prepared for #187.
 */
async function theFieldCase(t) {
  const started = [];
  mock.method(logger, "info", line => { if (/^encode-run #/.test(line)) started.push(line); });
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
    ffmpegBin: "/nonexistent/ttv-341/no-encoder" });
  const session = outputOn(manager, {
    id: SESSION_ID,
    key: OUTPUT_KEY,
    spec: outputSpec({ transcodeVideo: false, cutGrid: "keyframe" }),
    timeline: new Timeline({ boundaries: TIMES, cutGrid: "keyframe" }),
    keyframes: new KeyframeTable().learn({ times: TIMES.slice(0, -1), format: "matroska" }),
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
  assert.equal(inputs.readsOriginal(session), true, "the fixture must read its original file");
  started.length = 0;
  return { manager, started };
}

test("a run for a piece whose held input ends before it is not built", { todo: "AC-3", timeout: 10_000 }, async (t) => {
  const { manager, started } = await theFieldCase(t);
  const run = manager.encodeRuns.makeRunAt(OUTPUT_KEY, 188, 263, "a check asked for it");
  assert.equal(run && `#${run.from}..#${run.to}`, null, "a run was built");
  assert.deepEqual(started, [], "and no encoder was started");
});

test("once an input reaching the piece is ready, the run is built from the piece through it", { todo: "AC-3", timeout: 10_000 }, async (t) => {
  const { manager } = await theFieldCase(t);
  // The plan asks for #188 while the held input ends at #187, and asks again
  // once that input could have been prepared again.
  manager.encodeRuns.makeRunAt(OUTPUT_KEY, 188, 263, "a check asked for it");
  await turns();
  const run = manager.encodeRuns.makeRunAt(OUTPUT_KEY, 188, 263, "a check asked for it");
  assert.ok(run && run.from === 188 && run.to >= 188,
    `the run built is ${run ? `#${run.from}..#${run.to}` : "none"}, not one from #188 reaching #188`);
});
