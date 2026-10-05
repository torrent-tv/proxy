import assert from "node:assert/strict";
import test from "node:test";
import { readPlaybackDeclarations } from "../../services/media/read-playback-declarations.js";

test("an undeclared duration requests indexed timing and forwards missing input", async () => {
  let ready = false, complete = false;
  const statements = [];
  const orchestrator = { inspect: async (params, statement) => {
    statements.push(statement);
    if (statement === "tracks") return { kind: "result", value: [{ type: "video" }] };
    if (statement === "media-info") return { kind: "result", value: { durationSeconds: complete ? 12 : null } };
    assert.equal(params.packetInterval, undefined);
    if (!ready) return { kind: "needs-ranges", ranges: [[20, 39]] };
    complete = true;
    return { kind: "result", value: {} };
  } };
  const params = { sourceKey: "source", fileIndex: 0, packetInterval: { from: 0, to: 1 } };
  assert.deepEqual(await readPlaybackDeclarations(orchestrator, params), { kind: "needs-ranges", ranges: [[20, 39]] });
  ready = true;
  assert.equal((await readPlaybackDeclarations(orchestrator, params)).value.media.durationSeconds, 12);
  assert.deepEqual(statements, ["tracks", "media-info", "packets", "tracks", "media-info", "packets", "media-info"]);
});

test("a complete source without usable timing receives a terminal answer", async () => {
  const result = await readPlaybackDeclarations({ inspect: async (_params, statement) => ({ kind: "result",
    value: statement === "tracks" ? [] : { durationSeconds: null } }) }, {});
  assert.equal(result.kind, "terminal");
  assert.equal(result.reason, "media-duration-unavailable");
});

test("a declared duration needs no complete packet walk", async () => {
  const result = await readPlaybackDeclarations({ inspect: async (_params, statement) => {
    assert.notEqual(statement, "packets");
    return { kind: "result", value: statement === "tracks" ? [] : { durationSeconds: 12 } };
  } }, {});
  assert.equal(result.value.media.durationSeconds, 12);
});
