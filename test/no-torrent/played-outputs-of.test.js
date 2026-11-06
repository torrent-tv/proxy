import test from "node:test";
import assert from "node:assert/strict";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { SourceFile } from "../../services/media/SourceFile.js";
import { fakeEncodeInputs } from "./helpers/admitted-input.js";
import { managerWithOwnStore } from "./helpers/manager.js";
import { outputSpec } from "./helpers/output-spec.js";

// The real output graph over a store of its own; no torrent.
//
// What the download map's pass reads of the outputs: `playedOutputsOf(sourceKey,
// fileIndex)` (torrent-tv/meta#273), which was a loop inside `resolvePlayback`.

let counter = 0;

/** An output of `sourceKey` reading file `fileIndex`: the picture, copied or not, and the soundtrack muxed with it. */
function outputOf({ sourceKey = "src", fileIndex = 0, transcodeVideo = false } = {}) {
  const spec = outputSpec({ sourceKey, fileIndex, transcodeVideo, audioSourceTrackIndex: 0 });
  const id = `output-${counter += 1}`;
  return {
    id,
    spec,
    get outputKey() { return spec.toKey(); },
    timeline: new Timeline({ boundaries: [0, 4, 8, 12], cutGrid: "keyframe" }),
    file: new SourceFile({ sourceKey, fileIndex, name: "film.mkv" })
  };
}

function graph(options = {}) {
  const { manager, cleanup } = managerWithOwnStore({ encodeInputs: fakeEncodeInputs(), ...options });
  // Where encoders are placed is not what is read here.
  manager.encodeRuns.planEncodersSoon = () => {};
  return { manager, cleanup };
}

function watch(manager, output, ...viewerIds) {
  manager.outputs.set(output.id, output);
  for (const id of viewerIds) {
    manager.viewers.present(id);
    manager.viewers.of(output, id);
  }
  return output;
}

test("an output a present viewer watches is played, with its own timeline", t => {
  const { manager, cleanup } = graph();
  t.after(cleanup);
  const output = watch(manager, outputOf(), "viewer");
  const played = manager.playedOutputsOf("src", 0);
  assert.equal(played.length, 1);
  assert.equal(played[0].outputKey, output.outputKey);
  assert.equal(played[0].timeline, output.timeline);
  assert.deepEqual(played[0].choices, [{ type: "video", index: 0, mode: "copy" }, { type: "audio", index: 0, mode: "transcode" }]);
  assert.deepEqual(Object.keys(played[0]).sort(),
    ["choices", "encodeSpeed", "linkMbps", "outputKey", "revision", "sizes", "target", "timeline"]);
  assert.notEqual(manager.playedOutputsOf("src", 0)[0].choices, played[0].choices, "a new list of choices for each call");
});

test("an output nobody present watches is not played", t => {
  const { manager, cleanup } = graph();
  t.after(cleanup);
  const output = watch(manager, outputOf(), "viewer");
  manager.viewers.get("viewer").gone = true;
  assert.deepEqual(manager.playedOutputsOf("src", 0), []);
  manager.viewers.present("viewer");
  assert.equal(manager.playedOutputsOf("src", 0).length, 1);
  manager.outputs.set("unwatched", { ...outputOf(), id: "unwatched" });
  assert.deepEqual(manager.playedOutputsOf("src", 0).map(entry => entry.outputKey), [output.outputKey]);
});

test("another file or another source is not played", t => {
  const { manager, cleanup } = graph();
  t.after(cleanup);
  watch(manager, outputOf({ sourceKey: "src", fileIndex: 0 }), "viewer");
  assert.deepEqual(manager.playedOutputsOf("src", 1), []);
  assert.deepEqual(manager.playedOutputsOf("other", 0), []);
});

test("an output the viewer stepped off is not played", t => {
  const { manager, cleanup } = graph();
  t.after(cleanup);
  const output = watch(manager, outputOf(), "viewer");
  manager.viewers.get("viewer").activeVariantId = "another-step";
  assert.deepEqual(manager.playedOutputsOf("src", 0), []);
  manager.viewers.get("viewer").activeVariantId = output.id;
  assert.equal(manager.playedOutputsOf("src", 0).length, 1);
});

test("outputs are listed in catalog order", t => {
  const { manager, cleanup } = graph();
  t.after(cleanup);
  const picture = watch(manager, outputOf(), "viewer");
  const encoded = watch(manager, outputOf({ transcodeVideo: true }), "viewer");
  assert.deepEqual(manager.playedOutputsOf("src", 0).map(entry => entry.outputKey), [picture.outputKey, encoded.outputKey]);
  assert.deepEqual(manager.playedOutputsOf("src", 0)[1].choices[0], { type: "video", index: 0, mode: "transcode" });
});

test("the slowest link of the present viewers is stated, and none when no one reported one", t => {
  const { manager, cleanup } = graph();
  t.after(cleanup);
  watch(manager, outputOf(), "fast", "slow", "silent");
  assert.equal(manager.playedOutputsOf("src", 0)[0].linkMbps, null);
  manager.viewers.get("fast").netReport = { linkMbps: 8 };
  manager.viewers.get("slow").netReport = { linkMbps: 3 };
  assert.equal(manager.playedOutputsOf("src", 0)[0].linkMbps, 3);
  manager.viewers.get("slow").netReport = { linkMbps: 0 };
  assert.equal(manager.playedOutputsOf("src", 0)[0].linkMbps, 8, "a reading that is not positive is not a link");
});

test("what the output has made, its revision, its speed and its next input are read from the graph", t => {
  const target = 4096;
  const { manager, cleanup } = graph({ encodeInputs: { ...fakeEncodeInputs(), targetInputBytes: () => target } });
  t.after(cleanup);
  const output = watch(manager, outputOf(), "viewer");
  manager.segmentStore.revisionOf = key => key === output.outputKey ? 7 : -1;
  manager.segmentStore.sizesOf = key => new Map(key === output.outputKey ? [[0, 1234]] : []);
  manager.encodeCost.latestSpeedReadingOf = candidate => candidate === output ? { speed: 2.5 } : null;
  const [entry] = manager.playedOutputsOf("src", 0);
  assert.equal(entry.revision, 7);
  assert.deepEqual([...entry.sizes()], [[0, 1234]]);
  assert.equal(entry.encodeSpeed, 2.5);
  assert.equal(entry.target, target);
});

test("an output with no reading of its speed or its next input says so", t => {
  const { manager, cleanup } = graph();
  t.after(cleanup);
  watch(manager, outputOf(), "viewer");
  const [entry] = manager.playedOutputsOf("src", 0);
  assert.equal(entry.encodeSpeed, undefined);
  assert.equal(entry.target, null);
  assert.equal(entry.sizes().size, 0);
});

test("an output with no cut grid is skipped before anything is costed", t => {
  const { manager, cleanup } = graph();
  t.after(cleanup);
  const output = outputOf();
  output.timeline = {};
  watch(manager, output, "viewer");
  const called = [];
  manager.segmentStore.revisionOf = () => { called.push("revision"); return 0; };
  manager.encodeCost.latestSpeedReadingOf = () => { called.push("encodeSpeed"); return undefined; };
  manager.encodeInputs.targetInputBytes = () => { called.push("target"); return null; };
  const viewer = manager.viewers.get("viewer");
  viewer.linkReading = () => { called.push("links"); return null; };
  assert.deepEqual(manager.playedOutputsOf("src", 0), []);
  assert.deepEqual(called, []);
});
