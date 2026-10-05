/**
 * @file Opening an output admits and places its viewer in one synchronous call.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EncodeAdmission } from "../../services/encode/EncodeAdmission.js";
import { ViewerRequests } from "../../services/server/ViewerRequests.js";

test("the first opening holds capacity before a concurrent opening is admitted", async () => {
  const records = new Map();
  const outputCosts = new Map([
    ["source-a:0", 0.6],
    ["source-b:0", 0.6]
  ]);
  const viewers = {
    get: () => null,
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
    outputTimes: { segmentIndexForTime: (_output, seconds) => Math.floor(seconds / 4) },
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
