import test from "node:test";
import assert from "node:assert/strict";

import { handleTranscodeAudioWarmGet } from "../../routes/transcode/audio-warm/get.js";

// Readiness confirms that the proxy recorded and produced the soundtrack.
// A failed preparation cannot be mistaken for an accepted warm-up.

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

test("an accepted soundtrack waits for its produced bytes before confirming readiness", async () => {
  let preparedFor = null;
  let ready = false, changed, closed = false, settled = false;
  const pending = handleTranscodeAudioWarmGet(request, reply(), {
    renditions: {
      prepareAudioTrack: async (...args) => {
        preparedFor = args;
        return { sessionId: "rendition", fileName: "segment-00268.mp4" };
      }
    },
    serving: {
      seekEpoch: () => 0,
      subscribeFileChange: () => ({ changed: new Promise(resolve => { changed = resolve; }), release() {} }),
      getFileStream: async () => ready ? { kind: "file", stream: { destroy: () => { closed = true; } } } : { kind: "warming-up" }
    }
  }).then(answer => { settled = true; return answer; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(preparedFor, ["base", 0, 1641.2, "viewer-1", false]);
  ready = true;
  changed();
  const answer = await pending;
  assert.equal(answer.statusCode, 204);
  assert.equal(closed, true);
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
  assert.equal(answer.statusCode, 500);
  assert.equal(answer.payload.warming, undefined);
  assert.equal(answer.payload.canRetry, false);
});
