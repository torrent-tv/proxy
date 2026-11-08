/**
 * @file `startPlayback` subscribes to viewer changes before it adopts what an
 * earlier process left behind, and a viewer change refreshes the source
 * preparation and the download maps (composition-root-owners design §6).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { managerWithOwnStore } from "./helpers/manager.js";
import { outputSpec } from "./helpers/output-spec.js";
import { startPlayback } from "../../services/server/start-playback.js";
import { SourceFile } from "../../services/media/SourceFile.js";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { Output } from "../../services/encode/output/Output.js";

const SOURCE = "torrent:abc";

function host(t) {
  const made = managerWithOwnStore({ planless: true, startupWaitMs: 0 });
  t.after(async () => {
    await made.manager.lifecycle.disposeAll();
    made.cleanup();
  });
  return made;
}

function keyOf() {
  return outputSpec({ sourceKey: SOURCE, transcodeVideo: true, width: 1280, height: 720, audioSeparate: true });
}

function start(manager, over = {}) {
  const calls = [];
  const warnings = [];
  let preparationRead = 0;
  const result = startPlayback({
    outputParts: manager,
    downloadMaps: { viewersChanged: async () => { calls.push("maps"); return []; } },
    preparation: () => {
      preparationRead += 1;
      return { refresh: () => { calls.push("preparation"); } };
    },
    onStateChanged: () => calls.push("state"),
    warn: line => warnings.push(line),
    ...over
  });
  return { calls, warnings, result, reads: () => preparationRead };
}

test("the subscription exists before adoption and the preparation is not read at start", (t) => {
  const { manager, store } = host(t);
  const spec = keyOf();
  const key = spec.toKey();
  store.useFormat(key, fmp4Format);
  writeFileSync(path.join(store.directoryFor(key), fmp4Format.segmentFileName(0)), Buffer.alloc(10));
  const seen = [];
  const adopt = manager.lifecycle.adoptSegmentsLeftBehind.bind(manager.lifecycle);
  manager.lifecycle.adoptSegmentsLeftBehind = () => {
    seen.push(manager.viewerChanges.listenerCount("change"));
    return adopt();
  };
  const started = start(manager);
  assert.deepEqual(seen, [1]);
  assert.deepEqual(Object.keys(started.result).sort(), ["adopted", "dropped", "unprovenRemoved"]);
  assert.equal(started.reads(), 0);
});

test("a viewer change after start refreshes the preparation, the maps and the state, in that order", (t) => {
  const { manager } = host(t);
  const started = start(manager);
  manager.viewers.present("viewer-1");
  assert.deepEqual(started.calls, ["preparation", "maps", "state"]);
  assert.equal(started.reads(), 1);
});

test("a failure of the maps is warned, not thrown", async (t) => {
  const { manager } = host(t);
  const started = start(manager, {
    downloadMaps: { viewersChanged: async () => { throw new Error("boom"); } }
  });
  manager.viewers.present("viewer-1");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started.warnings, ["download maps after a viewer change: boom"]);
});

test("an output left by an earlier process is seen by the maps once a present viewer joins it", (t) => {
  const { manager, store } = host(t);
  const spec = keyOf();
  const key = spec.toKey();
  store.useFormat(key, fmp4Format);
  writeFileSync(path.join(store.directoryFor(key), fmp4Format.segmentFileName(0)), Buffer.alloc(10));
  start(manager);

  const file = new SourceFile({ sourceKey: SOURCE, fileIndex: 0, name: "film.mkv" }).learn({ width: 1280, height: 720, durationSeconds: 400 });
  const output = {
    id: spec.toName(),
    spec,
    get outputKey() { return this.spec.toKey(); },
    file,
    timeline: new Timeline({ boundaries: Array.from({ length: 101 }, (_, index) => index * 4), cutGrid: "uniform" }),
    output: new Output({ encodeWidth: 1280, encodeHeight: 720, outputFps: 24 }),
    segmentFormat: fmp4Format,
    useSyntheticPlaylist: true
  };
  manager.outputs.set(output.id, output);
  manager.viewers.of(output, "viewer-1");
  manager.viewers.present("viewer-1");

  const played = manager.playedOutputsOf(SOURCE, 0);
  const entry = played.find(item => item.outputKey === key);
  assert.ok(entry, "the output is played");
  assert.ok(entry.sizes().has(0), "segment 0 was adopted");
});

test("a viewer change before startPlayback subscribes reaches no subscriber", (t) => {
  const { manager } = host(t);
  manager.viewers.present("early");
  const started = start(manager);
  assert.deepEqual(started.calls, []);
  assert.equal(started.reads(), 0);
});
