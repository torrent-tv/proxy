import assert from "node:assert/strict";
import test from "node:test";

import { OutputLifecycle } from "../../services/server/OutputLifecycle.js";
import { ViewerRequests } from "../../services/server/ViewerRequests.js";
import { RateTrend, SessionRate } from "../../services/viewer/playback-readiness.js";
import { OutputForecastGeometry } from "../../services/viewer/OutputForecastGeometry.js";
import { ViewerPlaybackState } from "../../services/viewer/ViewerPlaybackState.js";

const playbackReadiness = { RateTrend, SessionRate };

test("viewer history is released on departure while another viewer keeps its samples", () => {
  const state = new ViewerPlaybackState();
  const output = { id: "shared-output" };
  const remainingViewer = {};
  const remaining = state.rateState(remainingViewer, output, playbackReadiness, 20);
  state.addLinkReading(remaining, 100, 25);
  const before = remaining.link.snapshot();

  for (let index = 0; index < 20; index++) {
    const viewer = {};
    const history = state.rateState(viewer, output, playbackReadiness, 20);
    state.addLinkReading(history, 100 + index, 10 + index);
    state.recordWaitSnapshot({ viewer, consumerId: `viewer-${index}`, generation: 1,
      sourceKey: "source", fileIndex: 0, waitId: `wait-${index}`, features: { linkMbps: 10 + index } });
    assert.equal(state.viewerCount(), 2);
    assert.equal(state.waitCount(viewer), 1);
    state.forgetViewer(viewer);
    assert.equal(state.viewerCount(), 1);
    assert.equal(state.waitCount(viewer), 0);
    assert.deepEqual(remaining.link.snapshot(), before);
  }
});

test("disposing an output drops cached geometry and its viewer samples; reusing the id starts empty", () => {
  const state = new ViewerPlaybackState();
  const geometry = new OutputForecastGeometry({
    lookaheadSeconds: 8,
    finishedMediaRangesOf: () => undefined,
    endsWithinPlayerSeekTolerance: () => false
  });
  const output = { id: "output", timeline: { segmentCount: 1, publishedStartOf: index => index * 4 } };
  const viewer = { id: "same-wire-id" };
  const history = state.rateState(viewer, output, playbackReadiness, 20);
  state.addLinkReading(history, 100, 30);
  geometry.segmentsOf(output, null, new Map(), 0);

  assert.equal(state.viewerCount(), 1);
  assert.equal(geometry.size(), 1);
  assert.notEqual(history.link.snapshot(), null);

  state.forgetOutput(output);
  geometry.forget(output);

  assert.equal(state.owns(viewer, output, history), false,
    "a late asynchronous result sees that its owner has ended and cannot reacquire state");
  assert.equal(state.viewerCount(), 0);
  assert.equal(geometry.get(output), null);
  assert.equal(geometry.size(), 0);

  const reopenedViewer = { id: "same-wire-id" };
  const reopened = state.rateState(reopenedViewer, output, playbackReadiness, 20);
  assert.deepEqual(reopened.link.snapshot(), null);
  assert.notEqual(reopened, history);
});

test("OutputLifecycle releases forecast owners before removing a session", async () => {
  const state = new ViewerPlaybackState();
  const geometry = new OutputForecastGeometry({
    lookaheadSeconds: 8,
    finishedMediaRangesOf: () => undefined,
    endsWithinPlayerSeekTolerance: () => false
  });
  const requests = new ViewerRequests({ viewerPlaybackState: state, outputForecastGeometry: geometry });
  const output = { id: "session", outputKey: "key", timeline: { segmentCount: 1, publishedStartOf: index => index * 4 } };
  const viewer = {};
  state.rateState(viewer, output, playbackReadiness, 20);
  geometry.segmentsOf(output, null, new Map(), 0);
  const outputs = new Map([[output.id, output]]);
  const lifecycle = new OutputLifecycle({
    outputs,
    invalidateWaits() {},
    forgetForecastOutput: session => requests.outputDisposed(session),
    outputTimes: { logIndexAccuracy() {} },
    viewers: { forOutput: () => new Map(), outputGone() {} },
    encodeRuns: { liveRunsOf: () => [], forgetEncodingOfGone() {} }
  });

  await lifecycle.disposeSession(output.id);

  assert.equal(outputs.has(output.id), false);
  assert.equal(state.viewerCount(), 0);
  assert.equal(geometry.get(output), null);
});

test("a final viewerLeaves transition releases wait history when the registry forgets that viewer", () => {
  const state = new ViewerPlaybackState();
  const viewer = { id: "viewer" };
  const output = { id: "output" };
  let registered = true;
  const viewers = {
    get: () => registered ? viewer : null,
    leaves: () => { registered = false; return true; }
  };
  const requests = new ViewerRequests({ viewers, viewerPlaybackState: state });
  state.rateState(viewer, output, playbackReadiness, 20);
  state.recordWaitSnapshot({ viewer, consumerId: viewer.id, generation: 0,
    sourceKey: "source", fileIndex: 0, waitId: "wait", features: {} });
  const lifecycle = new OutputLifecycle({ viewers, outputViewerDeparted: (owner, target) =>
    requests.outputViewerDeparted(owner, target), releasePlaybackStorageDemand() {} });

  assert.equal(lifecycle.viewerLeaves(output, viewer.id), true);
  assert.equal(state.viewerCount(), 0);
  assert.equal(state.waitCount(viewer), 0);
});
