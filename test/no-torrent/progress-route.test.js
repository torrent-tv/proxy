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
    query: { consumer: "viewer-one" }
  }, reply, {
    viewerRequests: {
      async getSessionProgress() {
        return { playbackReadiness: { snapshotAtProxyMs: performance.now() } };
      }
    }
  });

  const timing = body.snapshotTransport;
  assert.ok(Number.isFinite(timing.requestReceivedAtProxyMs));
  assert.ok(Number.isFinite(timing.snapshotAtProxyMs));
  assert.ok(Number.isFinite(timing.responsePreparedAtProxyMs));
  assert.ok(timing.requestReceivedAtProxyMs <= timing.snapshotAtProxyMs);
  assert.ok(timing.snapshotAtProxyMs <= timing.responsePreparedAtProxyMs);
});
