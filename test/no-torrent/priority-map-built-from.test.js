/**
 * @file A priority map is built again only when what it is built from has
 * changed (torrent-tv/meta#178).
 *
 * It was built on every pass of the encoders' plan — every piece a soundtrack
 * copy closes — and was the same map 2.4 times a second on Home Assistant (r22).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mapInputsOf, PriorityOrchestrator } from "../../services/viewer/PriorityOrchestrator.js";
import { mapForViewer, mergeMaps } from "../../services/viewer/PriorityMap.js";

const params = (viewers, viewerCount) => ({ durationSeconds: 600, allowanceSeconds: 8, viewers, viewerCount });

test("the same inputs are the same map, and a map is a function of the second a viewer stands at", () => {
  const at = (atSeconds, extra = {}) => ({ id: "a", atSeconds, playing: true, ...extra });
  assert.deepEqual(mapInputsOf(params([at(100.2)])), mapInputsOf(params([at(100.9)])));
  assert.notDeepEqual(mapInputsOf(params([at(100.9)])), mapInputsOf(params([at(101.0)])));
  // The time paused matters only while it lowers the viewer's priorities.
  const paused = (pauseSeconds, urgentReady) => ({ id: "a", atSeconds: 100, playing: false, pauseSeconds, urgentReady });
  assert.deepEqual(mapInputsOf(params([paused(3, true)])), mapInputsOf(params([paused(30, true)])));
  const two = (pauseSeconds) => [paused(pauseSeconds, true), { id: "b", atSeconds: 300, playing: true }];
  assert.notDeepEqual(mapInputsOf(params(two(3))), mapInputsOf(params(two(30))));
  // Where the inputs agree, so do the maps.
  const build = (viewers) => mergeMaps(viewers.map(viewer => mapForViewer({ durationSeconds: 600, allowanceSeconds: 8,
    atSeconds: viewer.atSeconds, playing: viewer.playing !== false, pauseSeconds: viewer.pauseSeconds ?? 0,
    urgentReady: viewer.urgentReady === true, viewerCount: 1 })));
  assert.deepEqual(build([at(100.2)]), build([at(100.9)]));
  assert.deepEqual(build([paused(3, true)]), build([paused(30, true)]));
});

test("a file's map built from the same viewers and demands is neither built nor published again", () => {
  const published = [];
  const orchestrator = new PriorityOrchestrator({ publish: map => published.push(map), viewers: { forOutput: () => new Map() } });
  const file = { sourceKey: "s", fileIndex: 0, durationSeconds: 600, allowanceSeconds: 8, demandKey: [["out", "a"]] };
  const first = orchestrator.build({ ...file, viewers: [{ id: "a", atSeconds: 100.2, playing: true }] });
  const again = orchestrator.build({ ...file, viewers: [{ id: "a", atSeconds: 100.7, playing: true }] });
  assert.equal(again, first, "the same map is handed back");
  assert.equal(published.length, 1);
  // The viewer reached the next second.
  const moved = orchestrator.build({ ...file, viewers: [{ id: "a", atSeconds: 101.1, playing: true }] });
  assert.notEqual(moved, first);
  assert.equal(published.length, 2);
  // The same position with other demands is published.
  orchestrator.build({ ...file, demandKey: [["out", "a"], ["sound", "a"]], viewers: [{ id: "a", atSeconds: 101.1, playing: true }] });
  assert.equal(published.length, 3);
});
