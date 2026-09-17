/**
 * @file An output holds what is born with it, and not what is produced.
 *
 * Decided with the user 2026-09-16: which pieces are made is the segment
 * store's, and which encoders run is the encoding orchestrator's. A second
 * holder of either is how item 87 stopped playback outright.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EncodedOutput } from "../services/encode/output/EncodedOutput.js";
import { outputSpec } from "./helpers/output-spec.js";

function made() {
  return new EncodedOutput({
    id: "aaaaaaaabbbbcccc",
    spec: outputSpec({ transcodeVideo: true, width: 1280, height: 720 }),
    file: { key: "source-1:0" },
    keyframes: null,
    timeline: null,
    segmentFormat: null,
    output: null,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    variantHeight: 720
  });
}

test("its address is its format, read from the spec and kept nowhere else", () => {
  const output = made();
  assert.equal(output.outputKey, output.spec.toKey());
});

test("it keeps no statement of what has been produced or what is running", () => {
  const output = made();
  for (const field of ["runs", "runState", "progress", "produced", "ready", "state", "lastError", "failedStartCount"]) {
    assert.equal(field in output, false, `${field} belongs to the store or the encoding orchestrator`);
  }
});
