import assert from "node:assert/strict";
import test from "node:test";
import { handleApiSourceWarmPost } from "../../routes/api/sources/warm/post.js";

test("legacy warm requests cannot start independent downloads or metadata retries", async () => {
  const calls = [];
  const forbidden = new Proxy({}, { get: (_target, name) => { calls.push(name); throw new Error("Independent source operation"); } });
  const result = await handleApiSourceWarmPost({ params: { sourceKey: "source" }, body: { fileIndex: 7, positionSeconds: 300 } },
    { send: value => value }, { sourceRegistry: { get: () => ({}) }, viewers: { forSource: () => [{}] },
      torrentPool: forbidden, playbackPlanner: forbidden });
  assert.deepEqual(result, { started: true, swarm: true, edges: false, fill: false });
  assert.deepEqual(calls, []);
});
