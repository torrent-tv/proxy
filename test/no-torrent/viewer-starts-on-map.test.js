/**
 * @file Where viewers stand, read off a merged priority map — the times the
 * subtitle walk reads first.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { emptyMap, mapForViewer, mergeMaps, viewerStartsOn } from "../../services/viewer/PriorityMap.js";

test("each viewer's position is a step up in the merged map", () => {
  const map = mergeMaps([
    mapForViewer({ atSeconds: 30, durationSeconds: 300, allowanceSeconds: 5 }),
    mapForViewer({ atSeconds: 200, durationSeconds: 300, allowanceSeconds: 5 })
  ]);
  assert.deepEqual(viewerStartsOn(map), [30, 200]);
});

test("a viewer at the very start, a stopped viewer, and nobody", () => {
  assert.deepEqual(viewerStartsOn(mapForViewer({ atSeconds: 0, durationSeconds: 60, allowanceSeconds: 5 })), [0]);
  assert.deepEqual(
    viewerStartsOn(mapForViewer({ atSeconds: 12, durationSeconds: 60, allowanceSeconds: 5, playing: false })),
    [12]
  );
  assert.deepEqual(viewerStartsOn(emptyMap(60)), []);
  assert.deepEqual(viewerStartsOn(null), []);
});
