/**
 * @file The output graph announces viewer changes as an event, after the
 * lifecycle and the encoder planning have seen them (design §6).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { managerWithOwnStore } from "./helpers/manager.js";

test("viewerChanges is an EventEmitter that emits change when a viewer becomes present", (t) => {
  const { manager, cleanup } = managerWithOwnStore();
  t.after(async () => { await manager.lifecycle.disposeAll(); cleanup(); });
  assert.ok(manager.viewerChanges instanceof EventEmitter);
  let calls = 0;
  manager.viewerChanges.on("change", () => { calls += 1; });
  manager.viewers.present("viewer-1");
  assert.equal(calls, 1);
});

test("wireOutputs takes no onViewerChanged option", () => {
  const source = readFileSync(new URL("../../services/server/wire-outputs.js", import.meta.url), "utf8");
  assert.equal(source.includes("onViewerChanged"), false);
});
