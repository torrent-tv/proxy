import assert from "node:assert/strict";
import test from "node:test";

import { handleApiTranscodeSessionsProgressGet } from "../../routes/api/transcode-sessions/progress/get.js";

test("progress response carries same-request proxy timing around its readiness snapshot", async () => {
  let body;
  const reply = {
    send(value) {
      body = value;
      return value;
    },
    code() {
      throw new Error("unexpected response status");
    }
  };
  await handleApiTranscodeSessionsProgressGet({
    params: { sessionId: "session-one" },
    query: { consumer: "viewer-one", generation: "4" }
  }, reply, {
    viewerRequests: {
      async getSessionProgress() {
        return { playbackReadiness: { snapshotAtProxyMs: performance.now(), snapshotClockEpoch: performance.timeOrigin } };
      }
    }
  });

  const timing = body.snapshotTransport;
  assert.equal(timing.clockEpoch, performance.timeOrigin);
  assert.equal(timing.snapshotClockEpoch, performance.timeOrigin);
  assert.equal(timing.generation, 4);
  assert.ok(Number.isFinite(timing.requestReceivedAtProxyMs));
  assert.ok(Number.isFinite(timing.snapshotAtProxyMs));
  assert.ok(Number.isFinite(timing.responsePreparedAtProxyMs));
  assert.ok(timing.requestReceivedAtProxyMs <= timing.snapshotAtProxyMs);
  assert.ok(timing.snapshotAtProxyMs <= timing.responsePreparedAtProxyMs);
});

test("a progress action replaced by a seek is answered as superseded", async () => {
  let status = 200;
  let body;
  let generation;
  const reply = {
    send(value) { body = value; return value; },
    code(value) { status = value; return this; }
  };
  await handleApiTranscodeSessionsProgressGet({ params: { sessionId: "session-one" },
    query: { consumer: "viewer-one", generation: "4" } }, reply, {
    viewerRequests: { async getSessionProgress(_sessionId, _consumerId, statedGeneration) {
      generation = statedGeneration;
      return { superseded: true };
    } }
  });
  assert.equal(generation, 4);
  assert.equal(status, 409);
  assert.deepEqual(body, { error: "Viewer action was superseded." });
});
