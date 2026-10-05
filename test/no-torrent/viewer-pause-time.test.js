import test from "node:test";
import assert from "node:assert/strict";
import { Viewer } from "../../services/viewer/Viewer.js";

test("pause time survives reports, restarts on paused seeking, and clears on resume", () => {
  const viewer = new Viewer("person", 0);
  viewer.report({ playing: false, waiting: true }, 100);
  assert.equal(viewer.pausedAt, null);
  viewer.report({ playing: false, waiting: false }, 200);
  assert.equal(viewer.pausedAt, 200);
  viewer.report({ playing: false, waiting: false }, 400);
  assert.equal(viewer.pausedAt, 200);
  viewer.moveTo(30, 500);
  assert.equal(viewer.pausedAt, 500);
  viewer.report({ playing: true, waiting: false }, 600);
  assert.equal(viewer.pausedAt, null);
});
