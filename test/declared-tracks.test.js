/**
 * @file What the proxy promises the browser must be answerable.
 *
 * The session manager asks the planner's media-info cache which tracks the
 * output will carry. That cache never held the codecs — it holds dimensions,
 * duration, fps, start time and an HDR flag — so the read produced `undefined`
 * for both and the declaration came out `{video: false, audio: false}` for
 * EVERY session since the check existed. Measured 2026-08-11 in the field.
 *
 * Nothing caught it: the writer and the reader each looked correct alone, and
 * no test ever compared the shape of what is stored with the shape of what is
 * read. That comparison is this file's whole job.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const planner = readFileSync(new URL("../services/playback-planner.js", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../services/hls-session-manager.js", import.meta.url), "utf8");

test("every field the declaration reads is a field the cache stores", () => {
  // What `declaredTracks` reads off the cached media info.
  const read = [...sessions.matchAll(/probed\?\.([A-Za-z]+)/g)].map((match) => match[1]);
  assert.ok(read.length > 0, "the declaration must read something, or it declares nothing");

  const stored = planner.slice(planner.indexOf("mediaInfoCache.set("));
  for (const field of new Set(read)) {
    assert.ok(
      stored.includes(`${field}:`),
      `the declaration reads "${field}" and the media-info cache never stores it — ` +
      "the read yields undefined and the promise silently becomes false"
    );
  }
});
