/**
 * @file Opening an output admits and places its viewer in one synchronous call.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EncodeAdmission } from "../../services/encode/EncodeAdmission.js";
import { ViewerRequests } from "../../services/server/ViewerRequests.js";
import { chooseAudioTrack, placeInitially } from "../../services/viewer/choices.js";
import { Viewers } from "../../services/viewer/Viewers.js";

test("the first opening holds capacity before a concurrent opening is admitted", async () => {
  const records = new Map();
  const outputCosts = new Map([
    ["source-a:0", 0.6],
    ["source-b:0", 0.6]
  ]);
  const viewers = {
    get(consumerId) {
      for (const members of records.values()) {
        if (members.has(consumerId)) return members.get(consumerId);
      }
      return null;
    },
    forOutput(output) {
      return new Set(records.get(output.outputKey)?.keys() ?? []);
    },
    of(output, consumerId) {
      let viewersOnOutput = records.get(output.outputKey);
      if (!viewersOnOutput) {
        viewersOnOutput = new Map();
        records.set(output.outputKey, viewersOnOutput);
      }
      let viewer = viewersOnOutput.get(consumerId);
      if (!viewer) {
        viewer = {
          position: null,
          linkReading: () => null,
          noteVisiblePicture: () => {},
          // What the request says about them, kept by the real viewer; what
          // this check is about is the place on the machine, not the report.
          report: () => {}
        };
        viewersOnOutput.set(consumerId, viewer);
      }
      return viewer;
    },
    watchedAddresses() {
      return new Set(
        [...records]
          .filter(([, members]) => [...members.values()].some((viewer) => viewer.position !== null))
          .map(([address]) => address)
      );
    }
  };
  const admission = new EncodeAdmission({
    liveRunsByAddress: () => new Map(),
    preparedAddresses: () => new Set(),
    watchedAddresses: () => viewers.watchedAddresses(),
    loadOf: (address) => {
      const costSec = outputCosts.get(address);
      return costSec === undefined ? null : { costSec, fileKey: address, fileCostSec: 0 };
    },
    availability: () => ({ share: 1, known: true }),
    finished: () => false
  });
  const opening = {
    async open({ sourceKey, fileIndex, claim }) {
      const output = { id: `${sourceKey}:${fileIndex}`, outputKey: `${sourceKey}:${fileIndex}` };
      const answer = claim(output);
      if (!answer.admitted) {
        const error = new Error(answer.reason);
        error.code = "OUTPUT_NO_CAPACITY";
        throw error;
      }
      return { output, existed: false, audio: null, verdict: null };
    }
  };
  const requests = new ViewerRequests({
    opening,
    viewers,
    admitsWatching: (output) => admission.admitsWatching(output.outputKey),
    placeViewerOn: (_output, _consumerId, seconds) => {
      const viewer = viewers.get(_consumerId);
      if (!viewer || viewer.position !== null) return false;
      viewer.position = { seconds, at: Date.now() };
      return true;
    },
    chooseAudioTrack: () => {},
    planEncodersSoon: () => {},
    outputs: { touch: () => {} },
    noteServingVerdict: () => {},
    waitUntilReady: async () => {}
  });

  const first = requests.createOrGetSession({ sourceKey: "source-a", fileIndex: 0, consumerId: "viewer-a" });
  const second = requests.createOrGetSession({ sourceKey: "source-b", fileIndex: 0, consumerId: "viewer-b" });
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);

  assert.equal(firstResult.status, "fulfilled");
  assert.equal(secondResult.status, "rejected");
  assert.match(secondResult.reason.message, /would make 0\.83x/);
  assert.equal(viewers.forOutput({ outputKey: "source-a:0" }).has("viewer-a"), true);
  assert.equal(viewers.forOutput({ outputKey: "source-b:0" }).has("viewer-b"), false);
});

test("returns an allocated output without waiting for its first playlist", async () => {
  let waitUntilReadyCalls = 0;
  const viewer = {
    position: null,
    linkReading: () => null,
    noteVisiblePicture: () => {},
    report: () => {}
  };
  const output = { id: "source:0", outputKey: "source:0" };
  let claimed = false;
  const viewers = {
    get: () => claimed ? viewer : null,
    of: () => { claimed = true; return viewer; },
    forOutput: () => new Set(["viewer"])
  };
  const requests = new ViewerRequests({
    opening: {
      async open({ claim }) {
        const answer = claim(output);
        assert.equal(answer.admitted, true);
        return { output, existed: false, audio: null, verdict: null };
      }
    },
    viewers,
    admitsWatching: () => ({ admitted: true, reason: "", speedX: 1 }),
    placeViewerOn: () => true,
    chooseAudioTrack: () => {},
    planEncodersSoon: () => {},
    outputs: { touch: () => {} },
    noteServingVerdict: () => {},
    waitUntilReady: async () => { waitUntilReadyCalls += 1; }
  });

  const result = await requests.createOrGetSession({ sourceKey: "source", fileIndex: 0, consumerId: "viewer" });

  assert.equal(result, output);
  assert.equal(waitUntilReadyCalls, 0,
    "the player must receive its session so it can poll the live forecast while segments are being prepared");
});

test("opening places once through viewer operations and copies the accepted audio choice", async () => {
  const viewers = new Viewers();
  const originalOf = viewers.of.bind(viewers);
  viewers.of = (...args) => {
    const viewer = originalOf(...args);
    if (!viewer.reportedOpeningPositions) {
      const report = viewer.report.bind(viewer);
      viewer.reportedOpeningPositions = [];
      viewer.report = (value, ...rest) => {
        viewer.reportedOpeningPositions.push(value);
        return report(value, ...rest);
      };
    }
    return viewer;
  };
  const outputs = new Map();
  const requests = new ViewerRequests({
    opening: {
      async open({ sourceKey, claim }) {
        const output = outputs.get(sourceKey) ?? { id: sourceKey, outputKey: sourceKey };
        outputs.set(sourceKey, output);
        claim(output);
        return {
          output,
          existed: true,
          audio: { trackIndex: sourceKey === "first" ? 1 : 2, transcode: sourceKey === "second" },
          verdict: null
        };
      }
    },
    viewers,
    admitsWatching: () => ({ admitted: true, reason: "", speedX: 1 }),
    placeViewerOn: (output, consumerId, seconds, now) => placeInitially(viewers, output, consumerId, seconds, now),
    chooseAudioTrack: (output, consumerId, choice) => chooseAudioTrack(viewers, output, consumerId, choice),
    planEncodersSoon: () => {},
    outputs: { touch: () => {} },
    noteServingVerdict: () => {}
  });

  const first = await requests.createOrGetSession({ sourceKey: "first", consumerId: "viewer", startPositionSeconds: 84 });
  const initialPosition = { ...viewers.get("viewer").position };
  const second = await requests.createOrGetSession({ sourceKey: "second", consumerId: "viewer", startPositionSeconds: 0 });

  const viewer = viewers.get("viewer");
  assert.equal(first.id, "first");
  assert.equal(second.id, "second");
  assert.deepEqual(viewer.position, initialPosition);
  assert.equal(viewer.position.seconds, 84);
  assert.equal(viewer.reportedOpeningPositions[0].positionSeconds, 84,
    "the successful initial placement is included in the opening report");
  assert.equal(Object.hasOwn(viewer.reportedOpeningPositions[1], "positionSeconds"), false,
    "opening another output does not report a position that would overwrite the existing one");
  assert.deepEqual(viewer.audio, { trackIndex: 2, transcode: true });
  assert.equal(viewer.outputs.has("first"), true);
  assert.equal(viewer.outputs.has("second"), true);
});
