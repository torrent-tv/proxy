import assert from "node:assert/strict";
import test from "node:test";

import { handleApiClientLogsPost } from "../../routes/api/client-logs/post.js";

/**
 * Post one body and return the lines the route wrote.
 *
 * @param {object} body
 * @returns {Promise<string[]>}
 */
async function linesWrittenFor(body) {
  /** @type {string[]} */
  const written = [];
  const reply = { code: () => reply, send: () => reply };
  await handleApiClientLogsPost({ body }, reply, {
    clientLogs: { write: (_session, lines) => written.push(...lines) }
  });
  return written;
}

const line = { level: "info", ts: "12:00:00.000", msg: "hello" };

test("each line names the page's send it came in, so the two receivers can be compared", async () => {
  assert.deepEqual(await linesWrittenFor({ tag: "Windows/Chrome", seq: 12, lines: [line] }), [
    "[Windows/Chrome batch=12] 12:00:00.000 info: hello"
  ]);
});

test("a page that numbers nothing is written as before", async () => {
  assert.deepEqual(await linesWrittenFor({ tag: "Windows/Chrome", seq: "12", lines: [line] }), [
    "[Windows/Chrome] 12:00:00.000 info: hello"
  ]);
});

test("a presented-frame measurement is tied to the viewer and viewing generation it names", async () => {
  let observation = null;
  const reply = { code: () => reply, send: () => reply };
  await handleApiClientLogsPost({ body: { lines: [{
    ...line,
    msg: "[first-frame-observation] consumer=consumer-123 generation=2 waitId=source:4:2 wait=4 audioReady=true elapsedMs=12500.500 " +
      "coldStartTotalMs=12000 transportMs=100 planMs=200 prepareMs=300 prebufferMs=11400 presentationMs=500.500"
  }] } }, reply, {
    clientLogs: null,
    viewerRequests: { noteFirstFrameObservation: value => { observation = value; } }
  });
  assert.deepEqual(observation, { consumerId: "consumer-123", generation: 2, waitId: "source:4:2", wait: 4,
    elapsedMs: 12500.5, stages: { totalMs: 12000, transportMs: 100, planMs: 200, prepareMs: 300,
      prebufferMs: 11400, presentationMs: 500.5 } });
});

test("a malformed presented-frame measurement is ignored", async () => {
  let called = false;
  const reply = { code: () => reply, send: () => reply };
  await handleApiClientLogsPost({ body: { lines: [{
    ...line,
    msg: "[first-frame-observation] consumer=consumer-123 generation=2 waitId=source:4:2 wait=4 audioReady=true elapsedMs=NaN"
  }] } }, reply, {
    clientLogs: null,
    viewerRequests: { noteFirstFrameObservation: () => { called = true; } }
  });
  assert.equal(called, false);
});

test("a video frame without its required audio is not learned as playback readiness", async () => {
  let called = false;
  const reply = { code: () => reply, send: () => reply };
  await handleApiClientLogsPost({ body: { lines: [{
    ...line,
    msg: "[first-frame-observation] consumer=consumer-123 generation=2 waitId=source:4:2 wait=4 audioReady=false elapsedMs=12500.500"
  }] } }, reply, {
    clientLogs: null,
    viewerRequests: { noteFirstFrameObservation: () => { called = true; } }
  });
  assert.equal(called, false);
});
