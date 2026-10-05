/**
 * @file An output is named by the format it produces, and nothing may put
 * pieces of another format under that name.
 *
 * Two ways that could still happen once the name became the format: a
 * directory left by an earlier version, whose key named the box a viewer asked
 * for and so cannot say what format is inside; and a hardware encoder failing,
 * after which the proxy encodes with software while outputs named by the failed
 * encoder are still being watched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { managerWithOwnStore } from "./helpers/manager.js";
import { outputSpec } from "./helpers/output-spec.js";
import { ENCODE_EXIT } from "../../services/encode/encode-exit.js";
import { SourceFile } from "../../services/media/SourceFile.js";

test("a directory whose key names an asked-for box is not adopted, and one naming a format is", (t) => {
  const { store, root, manager, cleanup } = managerWithOwnStore();
  t.after(cleanup);
  const oldKey = "torrent:abc:fmt=fmp4:grid=even@0:video-only:v=0/enc:1280x720:budget";
  const newKey = outputSpec({ sourceKey: "torrent:abc", transcodeVideo: true, width: 1280, height: 720, audioSeparate: true }).toKey();
  const oldDir = store.directoryFor(oldKey);
  const newDir = store.directoryFor(newKey);
  writeFileSync(path.join(oldDir, "segment-00000.mp4"), Buffer.alloc(10));
  writeFileSync(path.join(newDir, "segment-00000.mp4"), Buffer.alloc(10));

  const result = manager.lifecycle.adoptSegmentsLeftBehind();

  assert.equal(result.adopted, 1);
  assert.equal(result.dropped, 1);
  assert.equal(existsSync(oldDir), false, "the old directory goes");
  assert.equal(existsSync(newDir), true, "the named format stays");
  assert.ok(root);
});

test("when a hardware encoder fails, the outputs it named are closed rather than continued by software", async (t) => {
  const { manager, cleanup } = managerWithOwnStore({
    videoEncoder: { kind: "vaapi", name: "h264_vaapi", inputArgs: [] }
  });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    cleanup();
  });
  manager.encodeRuns.planEncodersNow = () => {};
  manager.encodeRuns.planEncodersSoon = () => {};
  const file = new SourceFile({ sourceKey: "torrent:abc", fileIndex: 0, name: "film.mkv" });
  const record = (id, encoder) => {
    const spec = outputSpec({ sourceKey: "torrent:abc", transcodeVideo: true, width: 1280, height: 720, encoder });
    const output = { id, spec, get outputKey() { return this.spec.toKey(); }, file };
    manager.outputs.set(id, output);
    return output;
  };
  const failing = record("aaaaaaaa00000001", "h264_vaapi");
  const software = record("aaaaaaaa00000002", "libx264");
  const run = { from: 0, to: -1, argsDescribed: "ffmpeg …" };
  manager.encodeOrchestrator.adopt(failing.outputKey, run);

  manager.encodeRuns.noteRunEnded(failing, run, {
    address: failing.outputKey,
    run,
    ending: ENCODE_EXIT.FAILED,
    from: 0,
    to: -1,
    livedMs: 30_000,
    because: "vaapi failed",
    lastError: "vaapi failed",
    producedCount: 3
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.encoders.current.kind, "software");
  assert.equal(manager.outputs.has(failing.id), false, "an output of the failed encoder is closed");
  assert.equal(manager.outputs.has(software.id), true, "an output of another encoder is untouched");
});
