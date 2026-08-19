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

const request = (fileName) => ({
  params: { sessionId: "11111111-2222-3333-4444-555555555555", fileName },
  raw: { on() {}, off() {} }
});

test("a seek releases a held segment request instead of running out the hold", async () => {
  let epoch = 0;
  let polls = 0;
  const hlsSessionManager = {
    nextRequestSeq: () => 1,
    seekEpoch: () => epoch,
    // The viewer seeked AWAY from this segment, so it is genuinely stale. A
    // request for the segment they seeked TO is kept instead — see
    // `test/seek-target-not-superseded.test.js`.
    requestStillWanted: () => false,
    viewerPositionOf: () => 0,
    async getFileStream() {
      polls += 1;
      // The viewer moves while this request is being held.
      if (polls === 2) {
        epoch += 1;
      }
      return { kind: "warming-up" };
    }
  };

  const { reply, sent } = recordingReply();
  const startedAt = Date.now();
  await handleTranscodeSessionFileGet(request("segment-00609.mp4"), reply, { hlsSessionManager });
  const heldMs = Date.now() - startedAt;

  assert.equal(sent.code, 503, "the player must get a retryable answer, not a stream");
  assert.equal(sent.headers["retry-after"], "0", "nothing to wait for — this segment is not being watched");
  assert.ok(heldMs < 5_000, `the request was held ${heldMs}ms after the seek`);
});

test("without a seek the request is still held until the segment appears", async () => {
  let polls = 0;
  const hlsSessionManager = {
    nextRequestSeq: () => 1,
    seekEpoch: () => 7,
    async getFileStream() {
      polls += 1;
      if (polls < 3) {
        return { kind: "warming-up" };
      }
      return { kind: "ok", contentType: "video/mp4", stream: "bytes", isPlaylist: false };
    }
  };

  const { reply, sent } = recordingReply();
  await handleTranscodeSessionFileGet(request("segment-00610.mp4"), reply, { hlsSessionManager });

  assert.equal(sent.body, "bytes", "a segment that arrives late must still be served");
  assert.equal(sent.headers["content-type"], "video/mp4");
});
