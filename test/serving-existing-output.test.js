/**
 * @file An output already made serves a viewer when the rules decided with the
 * user 2026-09-16 allow it, through the paths a real request takes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { managerWithOwnStore } from "./helpers/manager.js";
import { outputSpec } from "./helpers/output-spec.js";
import { SourceFile } from "../services/media/SourceFile.js";
import { Timeline } from "../services/output/Timeline.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";
import { Output } from "../services/output/Output.js";
import { viewersOf } from "../services/viewer/Viewer.js";

const TORRENT = "torrent:11f0929918e2b5aa2e5b71ecdbe5c0f1a4bbf7d1";

function hostWithA1080pOutput(t) {
  const { manager, store, cleanup } = managerWithOwnStore({
    startupWaitMs: 0,
    videoEncoder: { kind: "vaapi", name: "h264_vaapi", inputArgs: [] }
  });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    cleanup();
  });
  manager.encodeRuns.planEncodersNow = () => {};
  manager.encodeRuns.planEncodersSoon = () => {};
  manager.getCachedMediaInfo = () => ({ durationSeconds: 400, width: 1920, height: 1080, fps: 24 });
  const spec = outputSpec({
    sourceKey: TORRENT,
    transcodeVideo: true,
    transcodeAudio: false,
    encoder: "h264_vaapi",
    width: 1920,
    height: 1080,
    fps: 24,
    cutGrid: "uniform"
  });
  const key = spec.toKey();
  store.useFormat(key, fmp4Format);
  // The piece at the start of the film is made.
  writeFileSync(path.join(store.directoryFor(key), fmp4Format.segmentFileName(0)), Buffer.alloc(100));
  const file = new SourceFile({ sourceKey: TORRENT, fileIndex: 0, name: "film.mkv" }).learn({ width: 1920, height: 1080, durationSeconds: 400 });
  const made = {
    id: spec.toName(),
    spec,
    get outputKey() { return this.spec.toKey(); },
    file,
    timeline: new Timeline({ boundaries: Array.from({ length: 101 }, (_, index) => index * 4), cutGrid: "uniform" }),
    output: new Output({ encodeWidth: 1920, encodeHeight: 1080, outputFps: 24 }),
    segmentFormat: fmp4Format,
    claims: new Set(),
    useSyntheticPlaylist: true
  };
  manager.outputs.set(made.id, made);
  return { manager, made };
}

function request(over) {
  return {
    sourceKey: TORRENT,
    fileIndex: 0,
    fileName: "film.mkv",
    transcodeVideo: true,
    transcodeAudio: false,
    segmentFormatId: "fmp4",
    ...over
  };
}

test("the automatic choice is served by a better output whose piece at the viewer's position is made", async (t) => {
  const { manager, made } = hostWithA1080pOutput(t);
  const answered = await manager.viewerRequests.createOrGetSession(
    request({ consumerId: "auto-viewer", targetWidth: 1280, targetHeight: 720 })
  );
  assert.equal(answered, made);
});

test("a size picked by hand is not served by another size", async (t) => {
  const { manager, made } = hostWithA1080pOutput(t);
  let answered = null;
  try {
    answered = await manager.viewerRequests.createOrGetSession(
      request({ consumerId: "picker", targetWidth: 1280, targetHeight: 720, exactSize: true })
    );
  } catch {
    answered = null;
  }
  assert.notEqual(answered, made);
});

test("a step asked for by an automatic viewer and served by the picture leaves the picture a picture", async (t) => {
  const { manager, made } = hostWithA1080pOutput(t);
  manager.viewers.of(made, "auto-viewer").qualityMode = "auto";

  const variant = await manager.renditions.resolveVariantSession(made.id, 720, 0, "auto-viewer");

  assert.equal(variant, made, "the picture already made at 1080p serves the 720p request");
  assert.notEqual(made.isStep, true, "and is not turned into a step of itself");
  assert.ok(viewersOf(made).has("auto-viewer"));
});
