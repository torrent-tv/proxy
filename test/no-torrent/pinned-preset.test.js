import test from "node:test";
import assert from "node:assert/strict";
import { managerWithOwnStore } from "./helpers/manager.js";

// The output wiring only; no torrent, no encoder started.
//
// Runs compared at one quality need one preset: three runs of one film on one
// host opened at three presets (r25, r26, r28, torrent-tv/meta#178).

const MODES = [
  { preset: "fast", pixelsPerSec: 9e6 },
  { preset: "faster", pixelsPerSec: 13e6 },
  { preset: "veryfast", pixelsPerSec: 21e6 }
];

test("a pinned preset is the only software mode anything prices or chooses", async () => {
  const { manager } = managerWithOwnStore({ softwarePresetBenchmark: MODES, pinnedPreset: "faster" });
  try {
    assert.equal(manager.encoders.current?.kind, "software");
    assert.deepEqual(manager.softwarePresetBenchmark.map(mode => mode.preset), ["faster"]);
  } finally {
    await manager.lifecycle.disposeAll();
  }
});

test("a preset calibration did not qualify is not pinned, and nothing else is", async () => {
  const { manager: unknown } = managerWithOwnStore({ softwarePresetBenchmark: MODES, pinnedPreset: "placebo" });
  const { manager: free } = managerWithOwnStore({ softwarePresetBenchmark: MODES });
  try {
    assert.deepEqual(unknown.softwarePresetBenchmark.map(mode => mode.preset), ["fast", "faster", "veryfast"]);
    assert.deepEqual(free.softwarePresetBenchmark.map(mode => mode.preset), ["fast", "faster", "veryfast"]);
  } finally {
    await unknown.lifecycle.disposeAll();
    await free.lifecycle.disposeAll();
  }
});
