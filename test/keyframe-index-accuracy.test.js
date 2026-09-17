/**
 * @file How well a container's keyframe index describes its own file.
 *
 * The cut times of a copied video ARE its index — ffmpeg can only cut where a
 * keyframe already is — and an index can be wrong: measured 2026-08-06, one
 * claimed a keyframe at 157.99 s where the real ones were 153.82 and 164.247.
 * Whether a re-encoded rung can be cut on that same grid and spliced into the
 * copy depends entirely on how often that happens, so it is counted.
 *
 * No scan is involved and no undownloaded byte is touched: each produced piece
 * states where it truly begins, and it is already read whole in order to be
 * stamped. Only boundaries that were actually produced are counted — the parts
 * somebody watched.
 *
 * Counted ON THE FILE'S OWN TABLE, because that is whose fact it is: the same
 * finding for every quality step of the film and for every later session of it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SourceFile } from "../services/source/SourceFile.js";
import { Timeline } from "../services/output/Timeline.js";
import { KeyframeTable } from "../services/media/container/KeyframeTable.js";
import { outputSpec } from "./helpers/output-spec.js";

const TOLERANCE = 0.25;

/**
 * A table naming keyframes every four seconds, which is what the grid of a
 * copied picture is built from.
 *
 * @returns {KeyframeTable}
 */
function fourSecondKeyframes() {
  return new KeyframeTable().learn({
    times: [0, 4, 8, 12, 16, 20],
    format: "matroska"
  });
}

test("an index that describes its file exactly is reported as such", () => {
  const table = fourSecondKeyframes();

  for (let index = 0; index < 4; index += 1) {
    table.witness({ index, trueStart: index * 4, deviationSec: 0, toleranceSec: TOLERANCE });
  }

  assert.equal(table.evidence.checked, 4);
  assert.equal(table.evidence.disagreed, 0, "nothing disagreed — which is a finding, not silence");
  assert.equal(table.evidence.maxDeviationSec, 0);
});

test("a boundary the index placed wrongly is counted, with how far out it was", () => {
  const table = fourSecondKeyframes();

  table.witness({ index: 0, trueStart: 0, deviationSec: 0, toleranceSec: TOLERANCE });
  // The measured shape: the playlist said 157.99 s, the file cut at 153.82 s.
  table.witness({ index: 2, trueStart: 3.83, deviationSec: 4.17, toleranceSec: TOLERANCE });
  table.witness({ index: 3, trueStart: 12.01, deviationSec: 0.01, toleranceSec: TOLERANCE });

  assert.equal(table.evidence.checked, 3);
  assert.equal(table.evidence.disagreed, 1);
  assert.equal(table.evidence.firstDisagreementIndex, 2);
  assert.equal(
    table.evidence.maxDeviationSec,
    4.17,
    "the size of the error is what decides whether a rung can be cut on this grid"
  );
});

test("a deviation within tolerance is not a disagreement, but still shows in the worst case", () => {
  const table = fourSecondKeyframes();

  table.witness({ index: 0, trueStart: 0.2, deviationSec: 0.2, toleranceSec: TOLERANCE });

  assert.equal(
    table.evidence.disagreed,
    0,
    "rounding in a container's timestamps is not the index being wrong"
  );
  assert.equal(
    table.evidence.maxDeviationSec,
    0.2,
    "and it is still worth knowing how close to the line it ran"
  );
});

test("a piece that began at ANOTHER time the table names is told apart from one that began nowhere", () => {
  // The discriminator, and it decides which of two opposite faults this is. A
  // piece that began at another keyframe of the same list was not mis-described
  // by the table: the grid was built over a gap in it. One that began where the
  // table names nothing is the table describing times the file does not have.
  // The table answers it itself, because it is the only thing that holds the
  // list — asked of the caller, it was one more fact travelling by hand.
  const table = fourSecondKeyframes();

  table.witness({ index: 1, trueStart: 8, deviationSec: 4, toleranceSec: TOLERANCE });
  table.witness({ index: 2, trueStart: 9.7, deviationSec: 1.7, toleranceSec: TOLERANCE });

  assert.equal(table.evidence.disagreed, 2);
  assert.equal(table.evidence.landedOnAnotherKeyframe, 1);
});

test("a table that has read nothing claims no evidence about itself", () => {
  // It cannot be wrong about a file it has not described. `readable` is false,
  // every picture of the file is re-encoded, and no copy can witness anything.
  const table = new KeyframeTable().learn({ times: null, format: "mpegts" });

  assert.equal(table.evidence, null);
  assert.equal(table.names(4), false);
});

test("a segment requested again is not new evidence", () => {
  const table = fourSecondKeyframes();

  for (let repeat = 0; repeat < 3; repeat += 1) {
    table.witness({ index: 1, trueStart: 4.9, deviationSec: 0.9, toleranceSec: TOLERANCE });
  }

  assert.equal(table.evidence.checked, 1, "a repeat request is the same boundary, counted once");
  assert.equal(table.evidence.disagreed, 1);
});

test("a boundary the index got wrong is replaced by the time the file really has", async (t) => {
  const { wireOutputs } = await import("../services/serving/wire-outputs.js");
  const manager = wireOutputs({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  t.after(() => manager.lifecycle.disposeAll());
  // ONE table for the film, held by both. It used to be a copy each, kept in
  // step by writing the correction into every member — which is what the shared
  // table replaces, and what drifted in the field.
  const boundaries = [0, 10, 20, 30, 40];
  const base = {
    id: "aaaaaaaa11112222",
    spec: outputSpec({ transcodeVideo: false }),
    fileName: "film.mkv",
    state: "ready",
    timeline: new Timeline({ boundaries: boundaries, cutGrid: "uniform" }),
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "film.mkv" }),
    segmentFormat: { segmentFileName: (index) => `segment-${index}.mp4` }
  };
  const rung = {
    id: "bbbbbbbb11112222",
    spec: outputSpec({ transcodeVideo: true, height: 540 }),
    fileName: "film.mkv",
    state: "ready",
    timeline: new Timeline({ boundaries: boundaries, cutGrid: "uniform" }),
    // A step of the picture: the same file, and made as a step.
    file: base.file,
    variantHeight: 540,
    isStep: true
  };
  base.file.stepHeights.set(540, 540);
  manager.outputs.set(base.id, base);
  manager.outputs.set(rung.id, rung);

  // The copy produced segment #2, and it really begins at 17.4 s — the index
  // said 20. This is the shape reproduced from the field on 2026-08-12.
  manager.outputTimes.correctBoundaryFromSegment(base, 2, 17.4);

  assert.equal(
    base.timeline.boundaries[2],
    17.4,
    "the grid must describe the file, not the index — a rung forced onto 20 s would not join the copy"
  );
  assert.equal(
    rung.timeline.boundaries[2],
    17.4,
    "the family shares one grid — the same array, so there is nothing to keep in step"
  );
  assert.deepEqual(
    base.timeline.boundaries,
    [0, 10, 17.4, 30, 40],
    "only the boundary that was shown to be wrong moves"
  );

  // A reading that cannot be a boundary is not evidence about one. It comes
  // from a run that started somewhere else, and applying it would leave the
  // table describing nothing.
  manager.outputTimes.correctBoundaryFromSegment(base, 2, 35);
  manager.outputTimes.correctBoundaryFromSegment(base, 2, 5);
  manager.outputTimes.correctBoundaryFromSegment(base, 0, 3);
  assert.deepEqual(base.timeline.boundaries, [0, 10, 17.4, 30, 40], "out-of-order readings are refused");
});
