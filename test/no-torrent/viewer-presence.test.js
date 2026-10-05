/**
 * @file Presence is a fact of the connection, and it is not the same fact as
 * position.
 *
 * Both halves failed together on 2026-09-05. A viewer who had arrived and asked
 * for nothing counted as absent, so a soundtrack's encoder was stopped 1.25 s
 * after starting with nothing produced — and its `init.mp4` was therefore never
 * made, which is the one file the viewer needed in order to ask for the segment
 * that would have marked them present. And nothing anywhere let a viewer go
 * when their connection closed: the only exits were the browser's own release,
 * which a killed tab never sends, and a silence that a paused viewer produces
 * just as well as a departed one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { wireOutputs } from "../../services/server/wire-outputs.js";
import { SourceFile } from "../../services/media/SourceFile.js";
import { Viewers } from "../../services/viewer/Viewers.js";
import { outputSpec } from "./helpers/output-spec.js";

const PICTURE = "aaaaaaaa00004000";
const SOUND = "aaaaaaaa00004001";

/**
 * @param {string} id
 * @param {string} dirPath
 * @returns {object}
 */
function outputOn(id, dirPath) {
  return {
    id,
    spec: outputSpec(),
    dirPath,
    state: "live",
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" }),
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    claims: new Set(),
    lastAccessedAt: Date.now()
  };
}

test("asking for a viewer of an output is that viewer watching it", () => {
  let changes = 0;
  const viewers = new Viewers({ onChange: () => { changes += 1; } });
  const output = { id: "out-1" };

  const first = viewers.of(output, "someone");
  assert.equal(changes, 1, "a new relation is a change");
  assert.equal(first.outputs.has("out-1"), true);

  viewers.of(output, "someone");
  assert.equal(changes, 1, "asking again about the same output changes nothing");

  const second = { id: "out-2" };
  viewers.of(second, "someone");
  assert.equal(changes, 2, "a second output is a change");
  assert.equal(viewers.get("someone")?.outputs.size, 2);
});

test("a connection closing takes the person off every output at once", () => {
  const viewers = new Viewers();
  const picture = { id: "picture" };
  const sound = { id: "sound" };
  viewers.of(picture, "watcher");
  viewers.of(sound, "watcher");
  viewers.of(picture, "other");

  const left = viewers.hasGone("watcher");

  assert.deepEqual(left.sort(), ["picture", "sound"], "both, not the one the browser holds an id for");
  assert.equal(viewers.forOutput(picture).has("watcher"), false);
  assert.equal(viewers.forOutput(sound).has("watcher"), false);
  assert.equal(viewers.forOutput(picture).has("other"), true, "and nobody else goes with them");
  assert.equal(viewers.get("watcher"), null, "the registry does not keep what it has let go");
});

test("a viewer whose connection closed is let go of every output they were watching", async (t) => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "presence-"));
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });
  const manager = wireOutputs({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });

  const picture = outputOn(PICTURE, dirPath);
  const sound = outputOn(SOUND, dirPath);
  manager.outputs.set(PICTURE, picture);
  manager.outputs.set(SOUND, sound);
  manager.viewers.of(picture, "watcher");
  manager.viewers.of(sound, "watcher");

  const released = await manager.lifecycle.viewerHasGone("watcher", "the connection closed");

  assert.equal(released, 2, "the picture and the soundtrack, from one statement");
  assert.equal(manager.viewers.get("watcher"), null);
});

test("a viewer nobody knows costs nothing to let go of", async () => {
  const manager = wireOutputs({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  assert.equal(await manager.lifecycle.viewerHasGone("never-seen"), 0);
  assert.equal(await manager.lifecycle.viewerHasGone(""), 0);
});
