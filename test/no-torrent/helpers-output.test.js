/**
 * @file `helpers/output.js`: `outputOn` and `segmentsOnDisk` (torrent-tv/meta#309).
 *
 * The output a session serves has about twenty-five fields and was written out by hand in twenty-three
 * places. These checks state what the one shared copy fills, so a migrated file may rely on the
 * defaults and name only what it changes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Output } from "../../services/encode/output/Output.js";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { KeyframeTable } from "../../services/media/container/KeyframeTable.js";
import { SourceFile } from "../../services/media/SourceFile.js";
import { managerWithOwnStore } from "./helpers/manager.js";
import { outputSpec } from "./helpers/output-spec.js";
import { outputOn, segmentsOnDisk } from "./helpers/output.js";

const KEY = "output-helper:fmt=fmp4:grid=uniform:video-only:v=0/copy";
const OTHER_KEY = "output-helper-other:fmt=fmp4:grid=uniform:video-only:v=0/copy";

function own(t, options) {
  const made = managerWithOwnStore({ planless: true, ...options });
  t.after(made.cleanup);
  return made.manager;
}

function put(manager, key, index) {
  manager.segmentStore.useFormat(key, fmp4Format);
  writeFileSync(path.join(manager.segmentStore.directoryFor(key), fmp4Format.segmentFileName(index)), Buffer.alloc(32, 0x5a));
}

test("outputOn registers the output in the manager's catalog under its id and returns it", (t) => {
  const manager = own(t);
  const session = outputOn(manager, { id: "aaaa", key: KEY });
  assert.equal(manager.outputs.get("aaaa"), session);
  assert.equal(session.id, "aaaa");
  assert.equal(session.outputKey, KEY);
});

test("outputOn addresses the output the way production does: the store's directory for its key, made, with its format known", (t) => {
  const manager = own(t);
  const session = outputOn(manager, { id: "aaaa", key: KEY });
  assert.equal(session.dirPath, manager.segmentStore.directoryFor(KEY));
  assert.ok(existsSync(session.dirPath));
  assert.equal(session.dirPath.startsWith(manager.segmentStore.root), true, "inside the manager's own root");
});

test("outputOn fills every field of the output a session serves, with these defaults", (t) => {
  const manager = own(t);
  const session = outputOn(manager, { id: "aaaa", key: KEY });

  const fields = [
    "id", "spec", "outputKey", "dirPath", "timeline", "state", "file", "inputFile", "audioFile", "lastAloneSpeed",
    "startedAt", "lastAccessedAt", "runs", "lastError", "consumers", "viewers", "segmentCount", "segmentFormat",
    "useSyntheticPlaylist", "playlistText", "output", "keyframes", "audioOnly", "waitEpoch"
  ];
  assert.deepEqual(fields.filter((name) => !(name in session)), [], "the 24 fields of the hand-written object");
  assert.equal(session.state, "ready");
  assert.equal(session.lastAloneSpeed, 2);
  assert.equal(session.lastError, "");
  assert.equal(session.segmentCount, 5);
  assert.equal(session.useSyntheticPlaylist, true);
  assert.equal(session.playlistText, "#EXTM3U\n");
  assert.equal(session.audioOnly, false);
  assert.equal(session.waitEpoch, 0);
  assert.equal(Number.isFinite(session.startedAt), true);
  assert.equal(Number.isFinite(session.lastAccessedAt), true);
  assert.ok(session.runs instanceof Set && session.runs.size === 0);
  assert.ok(session.consumers instanceof Set && session.consumers.size === 0);
  assert.ok(session.viewers instanceof Map && session.viewers.size === 0);
});

test("outputOn's file is a 62.5 second video.mkv of source-1, and its input and audio are that file", (t) => {
  const manager = own(t);
  const session = outputOn(manager, { id: "aaaa", key: KEY });
  assert.ok(session.file instanceof SourceFile);
  assert.equal(session.file.sourceKey, "source-1");
  assert.equal(session.file.fileIndex, 0);
  assert.equal(session.file.name, "video.mkv");
  assert.equal(session.file.durationSeconds, 62.5);
  assert.equal(session.inputFile, session.file);
  assert.equal(session.audioFile, session.file);
});

test("outputOn cuts the film on the uniform grid at 12.5 second pieces, with keyframes to match", (t) => {
  const manager = own(t);
  const session = outputOn(manager, { id: "aaaa", key: KEY });
  assert.ok(session.timeline instanceof Timeline);
  assert.equal(session.timeline.cutGrid, "uniform");
  assert.deepEqual([...session.timeline.boundaries], [0, 12.5, 25, 37.5, 50, 62.5]);
  assert.ok(session.keyframes instanceof KeyframeTable);
});

test("outputOn's format is fmp4 that does not rewrite what it is handed (checks serve arbitrary file bytes)", (t) => {
  const manager = own(t);
  const session = outputOn(manager, { id: "aaaa", key: KEY });
  assert.equal(session.segmentFormat.id, "fmp4");
  assert.equal(session.segmentFormat.needsSegmentRewrite, false);
  assert.equal(session.segmentFormat.segmentFileName(3), fmp4Format.segmentFileName(3));
});

test("height and audioOnly shape the spec, the Output record and the flag", (t) => {
  const manager = own(t);
  const video = outputOn(manager, { id: "aaaa", key: KEY, height: 540 });
  assert.ok(video.output instanceof Output);
  assert.equal(video.output.encodeHeight, 540);
  assert.equal(video.spec.toKey(), outputSpec({ transcodeVideo: true, height: 540, audioOnly: false, cutGrid: "uniform" }).toKey());
  const sound = outputOn(manager, { id: "bbbb", key: OTHER_KEY, audioOnly: true });
  assert.equal(sound.audioOnly, true);
  assert.equal(sound.output.encodeHeight, 0, "height defaults to 0, which is a copy");
  assert.equal(sound.spec.toKey(), outputSpec({ transcodeVideo: false, height: 0, audioOnly: true, cutGrid: "uniform" }).toKey());
});

test("any other field named in the call replaces its default", (t) => {
  const manager = own(t);
  const session = outputOn(manager, { id: "aaaa", key: KEY, lastError: "boom", state: "failed", segmentCount: 9, segmentFormat: fmp4Format });
  assert.equal(session.lastError, "boom");
  assert.equal(session.state, "failed");
  assert.equal(session.segmentCount, 9);
  assert.equal(session.segmentFormat, fmp4Format);
  assert.equal(manager.outputs.get("aaaa"), session, "the replaced output is the one registered");
  assert.equal(session.lastAloneSpeed, 2, "and what was not named keeps its default");
});

test("two outputs on one manager share nothing mutable", (t) => {
  const manager = own(t);
  const a = outputOn(manager, { id: "aaaa", key: KEY });
  const b = outputOn(manager, { id: "bbbb", key: OTHER_KEY });
  assert.notEqual(a.runs, b.runs);
  assert.notEqual(a.consumers, b.consumers);
  assert.notEqual(a.viewers, b.viewers);
  assert.notEqual(a.output, b.output);
  assert.notEqual(a.timeline, b.timeline);
  assert.notEqual(a.dirPath, b.dirPath);
  assert.equal(manager.outputs.get("aaaa"), a);
  assert.equal(manager.outputs.get("bbbb"), b);
});

test("segmentsOnDisk(manager, key) is [] for an output with nothing written", (t) => {
  const manager = own(t);
  outputOn(manager, { id: "aaaa", key: KEY });
  assert.deepEqual(segmentsOnDisk(manager, KEY), []);
});

test("segmentsOnDisk lists the segment numbers in the output's directory, ascending, whatever order they were written in", (t) => {
  const manager = own(t);
  outputOn(manager, { id: "aaaa", key: KEY });
  for (const index of [2, 0, 10, 1]) {
    put(manager, KEY, index);
  }
  assert.deepEqual(segmentsOnDisk(manager, KEY), [0, 1, 2, 10]);
});

test("segmentsOnDisk counts segments only, and only this output's", (t) => {
  const manager = own(t);
  const a = outputOn(manager, { id: "aaaa", key: KEY });
  outputOn(manager, { id: "bbbb", key: OTHER_KEY });
  put(manager, KEY, 0);
  put(manager, OTHER_KEY, 1);
  put(manager, OTHER_KEY, 2);
  writeFileSync(path.join(a.dirPath, "notes.txt"), "not a segment");
  assert.deepEqual(segmentsOnDisk(manager, KEY), [0]);
  assert.deepEqual(segmentsOnDisk(manager, OTHER_KEY), [1, 2]);
});

test("segmentsOnDisk reports what is on disk now, not what was written", (t) => {
  const manager = own(t);
  outputOn(manager, { id: "aaaa", key: KEY });
  put(manager, KEY, 0);
  put(manager, KEY, 1);
  rmSync(path.join(manager.segmentStore.directoryFor(KEY), fmp4Format.segmentFileName(0)));
  assert.deepEqual(segmentsOnDisk(manager, KEY), [1]);
});
