/**
 * @file A corrected cut table stops the run that is misplaced, and only that run.
 *
 * `OutputTimes` learns from a produced picture that boundary #N really begins
 * later than the table said. Any other output of the file whose run begins at
 * #N is then producing at the wrong instant, and that run goes. Until
 * torrent-tv/meta#286 it was asked through `stopEncodeRun(output, reason)`,
 * which stops EVERY live run of the output, including a second run the same
 * output has near the viewer, which was positioned correctly.
 *
 * The seam is the real wiring (`wireOutputs`): the real `OutputTimes`, the real
 * `EncodeRuns`, with the runs an output holds replaced by recorders.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Timeline } from "../../services/encode/output/Timeline.js";
import { managerWithOwnStore } from "./helpers/manager.js";

const INDEX = 2;
/** The table before the picture says where #2 really begins. */
const TABLE = [0, 8, 16, 24, 32, 40];
const TRUE_START = 17.5;

/**
 * A run as the encode layer sees it: a position, whether it lives, and a stop
 * that records the reason and ends it.
 *
 * @param {string} name
 * @param {number} from
 * @returns {{ name: string, from: number, isAlive: boolean, stops: string[], stop: (reason: string) => void }}
 */
function fakeRun(name, from) {
  return {
    name,
    from,
    isAlive: true,
    stops: [],
    stop(reason) {
      this.stops.push(reason);
      this.isAlive = false;
    }
  };
}

/**
 * The picture whose segment reports the truth, and a soundtrack of the same
 * file holding the given runs.
 *
 * @param {object[]} soundtrackRuns
 */
function fileWith(soundtrackRuns) {
  const manager = managerWithOwnStore().manager;
  const timeline = new Timeline({ boundaries: [...TABLE], published: [...TABLE], cutGrid: "uniform" });
  const picture = {
    id: "picture",
    outputKey: "picture-key",
    file: { key: "film" },
    spec: { carries: "video-only", transcodesVideo: false },
    timeline
  };
  const soundtrack = {
    id: "sound",
    outputKey: "sound-key",
    file: { key: "film" },
    spec: { carries: "audio-only", transcodesVideo: false },
    timeline
  };
  const pictureRuns = [];
  const runsByOutput = new Map([[picture, pictureRuns], [soundtrack, soundtrackRuns]]);
  manager.outputs.familyOf = () => [picture, soundtrack];
  manager.encodeRuns.runsOf = (output) => runsByOutput.get(output) ?? [];
  manager.encodeOrchestrator.runsOn = (key) => (key === "sound-key" ? soundtrackRuns : []);
  const replanned = [];
  manager.encodeRuns.planEncodersSoon = () => replanned.push(true);
  return { manager, picture, soundtrack, replanned };
}

test("a corrected cut table stops only the run that begins at the corrected boundary", () => {
  const misplaced = fakeRun("at the boundary", INDEX);
  const nearViewer = fakeRun("near the viewer", 4);
  const { manager, picture } = fileWith([misplaced, nearViewer]);

  manager.outputTimes.correctBoundaryFromSegment(picture, INDEX, TRUE_START);

  assert.equal(picture.timeline.boundaries[INDEX], TRUE_START, "the table was corrected");
  assert.equal(misplaced.isAlive, false, "the misplaced run is stopped");
  assert.equal(misplaced.stops.length, 1);
  assert.match(misplaced.stops[0], /#2 really begins 1\.500s later than the table said/);
  assert.equal(nearViewer.isAlive, true, "the run near the viewer keeps producing");
  assert.deepEqual(nearViewer.stops, [], "and is not even asked to stop");
});

test("the stretch that was stopped is replanned, and an output with no run at the boundary is left alone", () => {
  const nearViewer = fakeRun("near the viewer", 4);
  const { manager, picture, replanned } = fileWith([nearViewer]);

  manager.outputTimes.correctBoundaryFromSegment(picture, INDEX, TRUE_START);

  assert.equal(nearViewer.isAlive, true, "no run begins at #2, so nothing is stopped");
  assert.deepEqual(nearViewer.stops, []);
  assert.equal(replanned.length, 1, "the plan places the replacement");
});

test("the picture's own runs are not stopped by its own correction", () => {
  const own = fakeRun("picture's own", INDEX);
  const { manager, picture } = fileWith([]);
  manager.encodeRuns.runsOf = (output) => (output === picture ? [own] : []);

  manager.outputTimes.correctBoundaryFromSegment(picture, INDEX, TRUE_START);

  assert.equal(own.isAlive, true);
});

test("stopEncodeRun still stops every live run of the output and leaves ended ones alone", () => {
  const first = fakeRun("first", 0);
  const second = fakeRun("second", 4);
  const ended = fakeRun("ended", 8);
  ended.isAlive = false;
  const { manager, soundtrack } = fileWith([first, second, ended]);

  manager.encodeRuns.stopEncodeRun(soundtrack, "a rung nobody is watching");

  assert.equal(first.isAlive, false);
  assert.equal(second.isAlive, false);
  assert.deepEqual(first.stops, ["a rung nobody is watching"]);
  assert.deepEqual(second.stops, ["a rung nobody is watching"]);
  assert.deepEqual(ended.stops, [], "a run that had already ended is not stopped again");
});

test("stopEncodeRun on an output with nothing live does nothing", () => {
  const { manager, soundtrack } = fileWith([]);
  assert.doesNotThrow(() => manager.encodeRuns.stopEncodeRun(soundtrack, "nothing to stop"));
});

test("stopRun stops the one run it is given, for the stated reason", () => {
  const target = fakeRun("target", INDEX);
  const other = fakeRun("other", 4);
  const { manager } = fileWith([target, other]);

  assert.equal(typeof manager.encodeRuns.stopRun, "function", "EncodeRuns offers the run-level form");
  manager.encodeRuns.stopRun(target, "this one is misplaced");

  assert.deepEqual(target.stops, ["this one is misplaced"]);
  assert.equal(other.isAlive, true);
});
