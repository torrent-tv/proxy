/**
 * @file A held segment request must not outlive the position it was made for.
 *
 * hls.js keeps ONE fragment load outstanding. So a request being held for a
 * segment blocks the request for wherever the viewer has just moved to, and our
 * route held each one for 60 s. Measured 2026-08-04: a backward seek into fully
 * downloaded data waited 57 s for a held request for `#609` to run out its
 * timer, and the segment the viewer actually wanted was then served in 15 ms.
 *
 * `research/hls-seek-prior-art-2026-08-02.md` prescribed this guard from
 * `hls-media-server` — one outstanding wait per session — and it was never
 * built.
 *
 * WHAT IS LEFT HERE IS THE ROUTE'S OWN BEHAVIOUR: a segment that arrives while
 * a request is held must still be served. The release itself moved to
 * `test/seek-frees-the-viewers-requests.test.js`, and the check that stood here
 * is why: it replaced `waitForSegment` with a function returning true and moved
 * the epoch by hand, so it described the route against a stand-in and passed
 * for months while no seek moved that epoch at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { handleTranscodeSessionFileGet } from "../routes/transcode/session-file/get.js";

/**
 * A reply that records what the route answered.
 *
 * @returns {{ reply: object, sent: { code: number, headers: Record<string, string>, body: unknown } }}
 */
function recordingReply() {
  const sent = { code: 200, headers: {}, body: undefined };
  const reply = {
    code(value) {
      sent.code = value;
      return reply;
    },
    header(name, value) {
      sent.headers[name.toLowerCase()] = String(value);
      return reply;
    },
    send(body) {
      sent.body = body;
      return reply;
    }
  };
  return { reply, sent };
}

/**
 * What the file route asks of the viewer operations besides the hold itself:
 * whether the request's generation is still taken, the record of what answered
 * it, and the hold a response keeps. Everything is taken and recorded nowhere,
 * because these checks are about the hold.
 *
 * @param {object} serving
 * @returns {object}
 */
const routeViewerRequests = (serving) => ({
  ...serving,
  acceptsRequest: () => true,
  noteAnsweredDirectly: () => {},
  holdResponse: () => () => {}
});

const request = (fileName) => ({
  params: { sessionId: "1111111122223333", fileName },
  raw: { on() {}, off() {} }
});

test("without a seek the request is still held until the segment appears", async () => {
  let polls = 0;
  const serving = {
    seekEpoch: () => 7,
    // The segment is published between polls.
    waitForSegment: async () => true,
    async getFileStream() {
      polls += 1;
      if (polls < 3) {
        return { kind: "warming-up" };
      }
      return { kind: "ok", contentType: "video/mp4", stream: "bytes", isPlaylist: false };
    }
  };

  const { reply, sent } = recordingReply();
  await handleTranscodeSessionFileGet(request("segment-00610.mp4"), reply, { serving: serving, viewerRequests: routeViewerRequests(serving) });

  assert.equal(sent.body, "bytes", "a segment that arrives late must still be served");
  assert.equal(sent.headers["content-type"], "video/mp4");
});
