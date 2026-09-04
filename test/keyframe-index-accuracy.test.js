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
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SourceFile } from "../services/source/SourceFile.js";
import { Timeline } from "../services/output/Timeline.js";
import { newIndexCheck, noteIndexDeviation } from "../services/hls-session-manager.js";

test("an index that describes its file exactly is reported as such", () => {
  const check = newIndexCheck();

  for (let index = 0; index < 4; index += 1) {
    noteIndexDeviation(check, index, 0);
  }

  assert.equal(check.checked, 4);
  assert.equal(check.disagreed, 0, "nothing disagreed — which is a finding, not silence");
  assert.equal(check.maxDeviationSec, 0);
});

test("a boundary the index placed wrongly is counted, with how far out it was", () => {
  const check = newIndexCheck();

  noteIndexDeviation(check, 0, 0);
  // The measured shape: the playlist said 157.99 s, the file cut at 153.82 s.
  noteIndexDeviation(check, 2, 4.17);
  noteIndexDeviation(check, 3, 0.01);

  assert.equal(check.checked, 3);
  assert.equal(check.disagreed, 1);
  assert.equal(check.firstDisagreementIndex, 2);
  assert.equal(
    check.maxDeviationSec,
    4.17,
    "the size of the error is what decides whether a rung can be cut on this grid"
  );
});

test("a deviation within tolerance is not a disagreement, but still shows in the worst case", () => {
  const check = newIndexCheck();

  noteIndexDeviation(check, 0, 0.2);

  assert.equal(check.disagreed, 0, "rounding in a container's timestamps is not the index being wrong");
  assert.equal(check.maxDeviationSec, 0.2, "and it is still worth knowing how close to the line it ran");
});

test("a boundary the index got wrong is replaced by the time the file really has", async (t) => {
  const { HlsSessionManager } = await import("../services/hls-session-manager.js");
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  t.after(() => manager.disposeAll());
  // ONE table for the film, held by both. It used to be a copy each, kept in
  // step by writing the correction into every member — which is what the shared
  // table replaces, and what drifted in the field.
  const boundaries = [0, 10, 20, 30, 40];
  const base = {
    id: "aaaaaaaa-1111-2222-3333-444444444444",
    fileName: "film.mkv",
    state: "ready",
    transcodeVideo: false,
    timeline: new Timeline({ boundaries: boundaries, cutGrid: "uniform" }),
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "film.mkv" }),
    segmentFormat: { segmentFileName: (index) => `segment-${index}.mp4` }
  };
  const rung = {
    id: "bbbbbbbb-1111-2222-3333-444444444444",
    fileName: "film.mkv",
    state: "ready",
    transcodeVideo: true,
    timeline: new Timeline({ boundaries: boundaries, cutGrid: "uniform" }),
    // A step of the picture: the same file, and made as a step.
    file: base.file,
    variantHeight: 540,
    isStep: true
  };
  base.file.stepHeights.set(540, 540);
  manager.sessionsById.set(base.id, base);
  manager.sessionsById.set(rung.id, rung);

  // The copy produced segment #2, and it really begins at 17.4 s — the index
  // said 20. This is the shape reproduced from the field on 2026-08-12.
  manager.correctBoundaryFromSegment(base, 2, 17.4);

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
  manager.correctBoundaryFromSegment(base, 2, 35);
  manager.correctBoundaryFromSegment(base, 2, 5);
  manager.correctBoundaryFromSegment(base, 0, 3);
  assert.deepEqual(base.timeline.boundaries, [0, 10, 17.4, 30, 40], "out-of-order readings are refused");
});

test("a segment requested again is not new evidence", () => {
  const check = newIndexCheck();

  noteIndexDeviation(check, 1, 0.9);
  noteIndexDeviation(check, 1, 0.9);
  noteIndexDeviation(check, 1, 0.9);

  assert.equal(check.checked, 1, "a repeat request is the same boundary, counted once");
  assert.equal(check.disagreed, 1);
});
