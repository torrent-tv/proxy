/**
 * @file The chosen subtitle as a term of playback readiness (torrent-tv/meta#8).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { withSubtitleReadiness } from "../../services/server/subtitle-readiness.js";

const ready = { version: 1, ready: true, delaySeconds: 0, reason: "ready" };

test("a chosen subtitle not yet read holds a forecast that is otherwise ready", () => {
  const answer = withSubtitleReadiness(ready, { fileIndex: 3, trackIndex: 1 }, false);
  assert.equal(answer.ready, false);
  assert.equal(answer.reason, "subtitles-pending");
  assert.equal(answer.delaySeconds, null);
  assert.deepEqual(answer.subtitles, { fileIndex: 3, trackIndex: 1, ready: false });
});

test("a chosen subtitle that has been read leaves the forecast as it was", () => {
  const answer = withSubtitleReadiness(ready, { fileIndex: 3, trackIndex: 1 }, true);
  assert.equal(answer.ready, true);
  assert.equal(answer.reason, "ready");
  assert.deepEqual(answer.subtitles, { fileIndex: 3, trackIndex: 1, ready: true });
});

test("the picture's own reason is kept while the picture is what is missing", () => {
  const waiting = { version: 1, ready: false, delaySeconds: 12, reason: "buffer-short" };
  const answer = withSubtitleReadiness(waiting, { fileIndex: 3, trackIndex: 1 }, false);
  assert.equal(answer.reason, "buffer-short");
  assert.equal(answer.delaySeconds, 12);
});

test("no chosen subtitle is stated as null, so the page knows the proxy weighed it", () => {
  const answer = withSubtitleReadiness(ready, null, true);
  assert.equal(answer.ready, true);
  assert.ok(Object.hasOwn(answer, "subtitles"));
  assert.equal(answer.subtitles, null);
});
