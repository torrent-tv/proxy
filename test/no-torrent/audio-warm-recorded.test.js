import test from "node:test";
import assert from "node:assert/strict";

import { handleTranscodeAudioWarmGet } from "../../routes/transcode/audio-warm/get.js";

// A page restating its soundtrack after a reconnect has to know whether the
// proxy RECORDED it. Both answers below are 503; only one of them recorded.

function reply() {
  return {
    statusCode: 0,
    payload: undefined,
    header() {
      return this;
    },
    code(status) {
      this.statusCode = status;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    }
  };
}

const request = {
  params: { sessionId: "base", track: "0" },
  query: { position: "1641.2", consumer: "viewer-1", transcode: "1" }
};

test("a track still being made says it was recorded", async () => {
  let preparedFor = null;
  const answer = await handleTranscodeAudioWarmGet(request, reply(), {
    renditions: {
      prepareAudioTrack: async (...args) => {
        preparedFor = args;
        return { sessionId: "rendition", fileName: "segment-00268.mp4" };
      }
    },
    serving: {
      seekEpoch: () => 0,
      // Anything but a file or a failure is "not made yet".
      getFileStream: async () => ({ kind: "superseded" })
    }
  });
  assert.deepEqual(preparedFor, ["base", 0, 1641.2, "viewer-1", false]);
  assert.equal(answer.statusCode, 503);
  assert.equal(answer.payload.warming, true);
});

test("a preparation that failed says nothing was recorded", async () => {
  const answer = await handleTranscodeAudioWarmGet(request, reply(), {
    renditions: {
      prepareAudioTrack: async () => {
        throw new Error("no encoder");
      }
    },
    serving: {}
  });
  assert.equal(answer.statusCode, 503);
  assert.equal(answer.payload.warming, undefined);
});
